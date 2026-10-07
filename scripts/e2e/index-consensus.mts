/**
 * Fee Index operator consensus, end to end on a local validator, through the SDK's builders and decoders only (no
 * apps, no database). Every rule DESIGN/FEE_INDEX_METHODOLOGY states is exercised against the real program:
 *
 *   1. legacy: one publisher key, no registry: post_index → dispute window → finalize_index (unchanged behaviour)
 *   2. initialize_index_operators + three add_index_operator (weights 1/1/1, threshold 6,667, tolerance 100 bps):
 *      FeeIndex.publisher becomes the registry PDA and the old publisher can no longer post
 *   3. a dissenter: votes 1,000 and 1,500 do not agree (no proposal); 1,004 makes two of three agree on the weighted
 *      median 1,004 → proposal; the dissenter's deviation (4,941 bps) is on the record
 *   4. a queued consensus: the next epoch agrees while the previous proposal is still in its window → queued, then
 *      submit_index_ballot after finalize_index
 *   5. a veto: veto_index drops that proposal, the next vote opens round 1 with a fresh snapshot, consensus again,
 *      finalize after the window
 *   6. close_index_ballot: refused for an epoch that is still open, accepted for final ones (rent back to the payer)
 *   7. the one-operator shortcut: with a single registered operator, post_index by that operator is accepted (the
 *      registry in remaining_accounts) and a removed operator is refused; the skipped-over ballot becomes closable
 *
 *   pnpm --filter @epoch/epoch-sdk build
 *   node scripts/e2e/index-consensus.mts --program <epoch.so> --program-keypair <keypair.json> --work <scratch dir>
 *
 * The program must be built with `declare_id!` set to the keypair's address (a throwaway id). Options (defaults):
 *   --rpc-port 19899 (websocket = rpc + 1)   --faucet-port 19901   --gossip-port 19905   --dynamic-ports 19910-20010
 *   --dispute-window 10 (slots)   --solana-bin <dir of solana-test-validator, default from PATH>
 *   --out <results.json>   --keep (the validator and its ledger stay for inspection)
 *
 * It writes only to the scratch dir; keys are throwaway and the only RPC is the local validator. Node 22.18+ (type
 * stripping); the exit code is 0 only when every check passed.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SLOTS_PER_EPOCH = 32;

const fromSdk = createRequire(join(ROOT, 'packages', 'epoch-sdk', 'package.json'));
const web3 = fromSdk('@solana/web3.js');
const sdk = fromSdk(join(ROOT, 'packages/epoch-sdk/dist/index.js'));

// ── Options ────────────────────────────────────────────────────────────────────────────────────────

function option(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : fallback;
  if (value === undefined) throw new Error(`--${name} is required (see the header of this script)`);
  return value;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const programSo = resolve(option('program'));
const programKeypair = resolve(option('program-keypair'));
const work = resolve(option('work'));
const rpcPort = Number(option('rpc-port', '19899'));
const faucetPort = Number(option('faucet-port', '19901'));
const gossipPort = Number(option('gossip-port', '19905'));
const dynamicPorts = option('dynamic-ports', '19910-20010');
const disputeWindow = BigInt(option('dispute-window', '10'));
const solanaBin = option('solana-bin', '');
const out = resolve(option('out', join(work, 'consensus-results.json')));
const ledger = join(work, 'consensus-ledger');
const rpcUrl = `http://127.0.0.1:${rpcPort}`;

// ── Record ─────────────────────────────────────────────────────────────────────────────────────────

const ist = (date = new Date()): string => new Date(date.getTime() + 19_800_000).toISOString().replace('Z', '+05:30');
const big = (_key: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
const steps: { step: string; at: string; [key: string]: unknown }[] = [];
const checks: { check: string; ok: boolean; detail?: unknown }[] = [];
function log(message: string, extra: Record<string, unknown> = {}): void {
  steps.push({ step: message, at: ist(), ...extra });
  console.log(
    `[${ist().slice(11, 19)}] ${message}${Object.keys(extra).length ? ` ${JSON.stringify(extra, big)}` : ''}`,
  );
}
function check(name: string, ok: boolean, detail?: unknown): void {
  checks.push({ check: name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` ${JSON.stringify(detail, big)}`}`);
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// ── Validator ──────────────────────────────────────────────────────────────────────────────────────

let validator: ChildProcess | null = null;
async function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer()
      .once('error', () => done(false))
      .once('listening', () => server.close(() => done(true)))
      .listen(port, '127.0.0.1');
  });
}
async function stopValidator(): Promise<void> {
  const child = validator;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await sleep(500);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

// ── Chain ──────────────────────────────────────────────────────────────────────────────────────────

const connection = new web3.Connection(rpcUrl, 'confirmed');
const programId = web3.Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(programKeypair, 'utf8'))),
).publicKey;
const [pool] = sdk.findPoolPda(programId);
const [feeIndexPda] = sdk.findFeeIndexPda(programId, pool);
const [registryPda] = sdk.findIndexOperatorsPda(programId, feeIndexPda);
const ballotPda = (epoch: bigint) => sdk.findIndexBallotPda(programId, feeIndexPda, epoch)[0];

interface Sent {
  signature: string;
  events: { name: string; data: Record<string, unknown> }[];
}

async function send(label: string, instructions: unknown[], signers: unknown[]): Promise<Sent> {
  const tx = new web3.Transaction().add(...instructions);
  const signature = await web3.sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
  const info = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  const events = sdk.parseEventsFromLogs(info?.meta?.logMessages ?? [], programId).map(sdk.eventToJson);
  log(label, { signature, events: events.map((e: { name: string }) => e.name) });
  return { signature, events };
}

/** Sends and expects the program to refuse with `errorName` (Anchor's `Error Code: <name>` log line). */
async function refused(label: string, instructions: unknown[], signers: unknown[], errorName: string): Promise<void> {
  try {
    await send(label, instructions, signers);
    check(`${label} is refused with ${errorName}`, false, 'the transaction succeeded');
  } catch (error) {
    const logs: string[] = (error as { logs?: string[] }).logs ?? [];
    const text = `${error instanceof Error ? error.message : String(error)}\n${logs.join('\n')}`;
    check(`${label} is refused with ${errorName}`, text.includes(`Error Code: ${errorName}`), {
      error: text.split('\n').find((line) => line.includes('Error Code')) ?? text.slice(0, 200),
    });
  }
}

async function feeIndex() {
  const info = await connection.getAccountInfo(feeIndexPda, 'confirmed');
  if (!info) throw new Error('no FeeIndex account');
  return sdk.decodeFeeIndex(info.data);
}
async function ballot(epoch: bigint) {
  const info = await connection.getAccountInfo(ballotPda(epoch), 'confirmed');
  return info ? { ...sdk.decodeIndexBallot(info.data), lamports: BigInt(info.lamports) } : null;
}
async function waitForSlot(slot: bigint): Promise<void> {
  while (BigInt(await connection.getSlot('confirmed')) < slot) await sleep(400);
}
async function waitForEpoch(epoch: number): Promise<void> {
  while ((await connection.getEpochInfo('confirmed')).epoch < epoch) await sleep(1_000);
}
const hashOf = (n: number) => new Uint8Array(32).fill(n);
const event = (sent: Sent, name: string) => sent.events.find((e) => e.name === name)?.data;

// ── Run ────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(work, { recursive: true });
  if (!existsSync(programSo)) throw new Error(`no program at ${programSo}`);
  const [low, high] = dynamicPorts.split('-').map(Number);
  const ports = [rpcPort, rpcPort + 1, faucetPort, gossipPort];
  for (let port = low; port <= high; port++) ports.push(port);
  const busy: number[] = [];
  for (const port of ports) if (!(await portFree(port))) busy.push(port);
  if (busy.length) throw new Error(`ports in use: ${busy.join(', ')}`);

  const fd = openSync(join(work, 'consensus-validator.log'), 'w');
  validator = spawn(
    solanaBin ? join(solanaBin, 'solana-test-validator') : 'solana-test-validator',
    [
      ...['--ledger', ledger, '--reset', '--quiet', '--bind-address', '127.0.0.1'],
      ...['--rpc-port', String(rpcPort), '--faucet-port', String(faucetPort), '--gossip-port', String(gossipPort)],
      ...['--dynamic-port-range', dynamicPorts, '--slots-per-epoch', String(SLOTS_PER_EPOCH)],
      ...['--limit-ledger-size', '50000', '--bpf-program', programId.toBase58(), programSo],
    ],
    {
      cwd: work,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', RUST_LOG: 'warn' },
      stdio: ['ignore', fd, fd],
    },
  );
  closeSync(fd);
  for (let i = 0; ; i++) {
    if (validator.exitCode !== null) throw new Error('the validator exited; see consensus-validator.log');
    if ((await connection.getSlot().catch(() => 0)) >= 1) break;
    if (i > 90) throw new Error('timed out waiting for the validator');
    await sleep(1_000);
  }
  log('validator up', { rpc: rpcUrl, programId: programId.toBase58(), slotsPerEpoch: SLOTS_PER_EPOCH });

  const [admin, legacyPublisher, cranker, op1, op2, op3] = Array.from({ length: 6 }, () => web3.Keypair.generate());
  for (const key of [admin, legacyPublisher, cranker, op1, op2, op3]) {
    const signature = await connection.requestAirdrop(key.publicKey, 10 * web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature, 'confirmed');
  }
  const ids = { programId, admin: admin.publicKey };
  const params = {
    seniorRateBpsPerEpoch: 3,
    protocolFeeBps: 1_000,
    advanceBpsUnhedged: 2_500,
    advanceBpsHedged: 4_000,
    bondMultiplier: 4,
    feeBps: 200,
    remitBps: 5_000,
    minScore: 6_000,
    scoreTtlEpochs: 3,
    minAdvanceLamports: 1_000_000_000n,
    maxAdvanceLamports: 500_000_000_000n,
    maxPoolAssets: 5_000_000_000_000n,
    maxUtilizationBps: 6_000,
    minJuniorBps: 2_000,
    juniorLockEpochs: 10,
    maxAdvanceEpochs: 20,
    voteReserveLamports: 1_600_000_000n,
    minCommissionBps: 0,
  };
  await send(
    'initialize_pool',
    sdk.initializePool({ ...ids, treasury: admin.publicKey, scorer: admin.publicKey, params }),
    [admin],
  );
  await send(
    'initialize_index',
    sdk.initializeIndex({
      ...ids,
      publisher: legacyPublisher.publicKey,
      disputeWindowSlots: disputeWindow,
      maxMoveBps: 5_000,
    }),
    [admin],
  );

  /** Waits out the pending proposal's window and finalizes it. */
  async function finalize(label: string): Promise<Sent> {
    const index = await feeIndex();
    await waitForSlot(BigInt(index.proposedSlot) + disputeWindow + 1n);
    return send(label, sdk.finalizeIndex({ programId, cranker: cranker.publicKey }), [cranker]);
  }
  const vote = (op: { publicKey: unknown }, epoch: bigint, value: bigint, hash: number) =>
    sdk.castIndexVote({ programId, operator: op.publicKey, epoch, value, inputsHash: hashOf(hash) });

  // 1. Legacy: a single publisher key, no registry. A program epoch must have started on the cluster: a far-future
  //    one (which, once final, would block every later post) is refused.
  await waitForEpoch(1);
  await refused(
    'post_index for an epoch that has not started',
    sdk.postIndex({
      programId,
      publisher: legacyPublisher.publicKey,
      epoch: 1_000_000n,
      value: 1_000n,
      inputsHash: hashOf(9),
    }),
    [legacyPublisher],
    'IndexEpochNotStarted',
  );
  await send(
    'legacy post_index (epoch 1)',
    sdk.postIndex({ programId, publisher: legacyPublisher.publicKey, epoch: 1n, value: 1_000n, inputsHash: hashOf(1) }),
    [legacyPublisher],
  );
  await refused(
    'finalize_index inside the window',
    sdk.finalizeIndex({ programId, cranker: cranker.publicKey }),
    [cranker],
    'DisputeWindowOpen',
  );
  await finalize('finalize_index (epoch 1)');
  let index = await feeIndex();
  check(
    'legacy post_index → finalize_index still works without a registry',
    index.epoch === 1n && index.value === 1_000n,
    {
      epoch: index.epoch,
      value: index.value,
    },
  );

  // 2. Consensus on: the registry, three operators of weight 1.
  const setup = await send(
    'initialize_index_operators + 3 × add_index_operator',
    [
      ...sdk.initializeIndexOperators({ ...ids, thresholdBps: 6_667, toleranceBps: 100 }),
      ...[op1, op2, op3].flatMap((op) => sdk.addIndexOperator({ ...ids, operator: op.publicKey, weight: 1 })),
    ],
    [admin],
  );
  index = await feeIndex();
  const registry = sdk.decodeIndexOperators((await connection.getAccountInfo(registryPda, 'confirmed')).data);
  check('FeeIndex.publisher is the registry PDA (no key can sign for it)', index.publisher.equals(registryPda));
  check(
    'registry: 3 operators, total weight 3, threshold 6,667, tolerance 100',
    registry.operatorCount === 3 &&
      registry.totalWeight === 3n &&
      registry.thresholdBps === 6_667 &&
      registry.toleranceBps === 100,
    { operators: sdk.activeIndexOperators(registry).map((o: { key: { toBase58(): string } }) => o.key.toBase58()) },
  );
  check(
    'one event per registry change',
    setup.events.filter((e) => e.name === 'IndexOperatorAdded').length === 3 &&
      !!event(setup, 'IndexOperatorsInitialized'),
  );
  await refused(
    'the old publisher posts epoch 2',
    sdk.postIndex({ programId, publisher: legacyPublisher.publicKey, epoch: 2n, value: 1_000n, inputsHash: hashOf(2) }),
    [legacyPublisher],
    'NotPublisher',
  );

  // 3. A dissenter (epoch 2). The ballot can only open for an epoch that has started on the cluster.
  await waitForEpoch(4);
  const opened = await send('op1 votes 1,000 (epoch 2)', vote(op1, 2n, 1_000n, 21), [op1]);
  check(
    'the first vote opens round 0 with the 3-operator snapshot',
    (event(opened, 'IndexBallotOpened')?.operators as unknown[])?.length === 3,
    event(opened, 'IndexBallotOpened'),
  );
  await send('op3 votes 1,500 (epoch 2)', vote(op3, 2n, 1_500n, 23), [op3]);
  index = await feeIndex();
  let b2 = await ballot(2n);
  check('1,000 and 1,500 do not agree: no consensus, no proposal', !index.hasProposal && b2?.consensusSlot === 0n, {
    median: b2?.medianValue,
    agreeingWeight: b2?.agreeingWeight,
  });
  await refused(
    'op3 posts epoch 2 directly (3 operators: no shortcut)',
    sdk.postIndex({
      programId,
      publisher: op3.publicKey,
      epoch: 2n,
      value: 1_500n,
      inputsHash: hashOf(23),
      soleOperator: true,
    }),
    [op3],
    'NotPublisher',
  );
  const agreed = await send('op2 votes 1,004 (epoch 2)', vote(op2, 2n, 1_004n, 22), [op2]);
  index = await feeIndex();
  b2 = await ballot(2n);
  const dissent = b2?.votes.find((v: { operator: { equals(k: unknown): boolean } }) =>
    v.operator.equals(op3.publicKey),
  );
  check(
    'two of three agree on the weighted median 1,004 → proposal',
    index.hasProposal && index.proposedEpoch === 2n && index.proposedValue === 1_004n,
    {
      consensus: event(agreed, 'IndexConsensusReached'),
    },
  );
  check(
    'the dissenter is on the record: 4,941 bps away, not agreeing',
    dissent?.deviationBps === 4_941 && dissent?.agrees === false,
    dissent,
  );
  check(
    'the consensus inputs hash is the hash of the vote at the median',
    Buffer.from(b2?.consensusInputsHash ?? []).equals(Buffer.from(hashOf(22))),
  );
  await refused('op1 changes its vote after consensus', vote(op1, 2n, 1_001n, 21), [op1], 'VoteLocked');

  // 4. A queued consensus (epoch 3) while epoch 2's proposal is in its window.
  await send('op1 votes 1,100 (epoch 3)', vote(op1, 3n, 1_100n, 31), [op1]);
  const queued = await send('op2 votes 1,100 (epoch 3)', vote(op2, 3n, 1_100n, 32), [op2]);
  check(
    'consensus while FeeIndex is busy is queued',
    event(queued, 'IndexConsensusReached')?.proposed === false && (await ballot(3n))?.proposedSlot === 0n,
  );
  await refused(
    'submit_index_ballot while the window is open',
    sdk.submitIndexBallot({ programId, cranker: cranker.publicKey, epoch: 3n }),
    [cranker],
    'DisputeWindowOpen',
  );
  await finalize('finalize_index (epoch 2)');
  index = await feeIndex();
  check('epoch 2 final at the agreed 1,004', index.epoch === 2n && index.value === 1_004n);
  const submitted = await send(
    'submit_index_ballot (epoch 3)',
    sdk.submitIndexBallot({ programId, cranker: cranker.publicKey, epoch: 3n }),
    [cranker],
  );
  index = await feeIndex();
  check(
    'the queued consensus becomes the proposal',
    !!event(submitted, 'IndexBallotSubmitted') && index.proposedEpoch === 3n && index.proposedValue === 1_100n,
  );

  // 5. A veto reopens the ballot: round 1, fresh snapshot, consensus again.
  await send('veto_index (epoch 3)', sdk.vetoIndex({ ...ids }), [admin]);
  const reopened = await send('op3 votes 1,101 (epoch 3, after the veto)', vote(op3, 3n, 1_101n, 33), [op3]);
  check(
    'a vote on a vetoed ballot opens round 1',
    event(reopened, 'IndexBallotOpened')?.round === 1 && (await ballot(3n))?.round === 1,
  );
  await send('op1 votes 1,102 (epoch 3, round 1)', vote(op1, 3n, 1_102n, 34), [op1]);
  index = await feeIndex();
  check(
    'round 1 reaches consensus at 1,101 → proposal',
    index.hasProposal && index.proposedEpoch === 3n && index.proposedValue === 1_101n,
  );
  await finalize('finalize_index (epoch 3)');
  index = await feeIndex();
  check('epoch 3 final at 1,101', index.epoch === 3n && index.value === 1_101n);

  // 6. close_index_ballot: an open ballot stays; final ones refund their payer.
  await send('op2 votes 1,200 (epoch 4)', vote(op2, 4n, 1_200n, 42), [op2]);
  await refused(
    'close_index_ballot (epoch 4, still open)',
    sdk.closeIndexBallot({ programId, cranker: cranker.publicKey, epoch: 4n, payer: op2.publicKey }),
    [cranker],
    'BallotNotClosable',
  );
  await refused(
    'close_index_ballot (epoch 2) refunding the wrong payer',
    sdk.closeIndexBallot({ programId, cranker: cranker.publicKey, epoch: 2n, payer: op2.publicKey }),
    [cranker],
    'BallotPayerMismatch',
  );
  for (const epoch of [2n, 3n]) {
    const before = BigInt(await connection.getBalance(op1.publicKey, 'confirmed'));
    const rent = (await ballot(epoch))!.lamports;
    await send(
      `close_index_ballot (epoch ${epoch})`,
      sdk.closeIndexBallot({ programId, cranker: cranker.publicKey, epoch, payer: op1.publicKey }),
      [cranker],
    );
    const after = BigInt(await connection.getBalance(op1.publicKey, 'confirmed'));
    check(
      `ballot ${epoch} closed, ${rent} lamports back to its payer`,
      (await ballot(epoch)) === null && after - before === rent,
      { rent },
    );
  }

  // 7. The one-operator shortcut: remove op2 and op3; op1 posts epoch 5 with post_index (once epoch 5 has started).
  await waitForEpoch(5);
  await send(
    'remove_index_operator × 2',
    [op2, op3].flatMap((op) => sdk.removeIndexOperator({ ...ids, operator: op.publicKey })),
    [admin],
  );
  await refused(
    'a removed operator posts epoch 5',
    sdk.postIndex({
      programId,
      publisher: op2.publicKey,
      epoch: 5n,
      value: 1_110n,
      inputsHash: hashOf(52),
      soleOperator: true,
    }),
    [op2],
    'NotPublisher',
  );
  await refused(
    'the sole operator posts without the registry',
    sdk.postIndex({ programId, publisher: op1.publicKey, epoch: 5n, value: 1_110n, inputsHash: hashOf(51) }),
    [op1],
    'NotPublisher',
  );
  await send(
    'the sole operator posts epoch 5 (post_index + registry)',
    sdk.postIndex({
      programId,
      publisher: op1.publicKey,
      epoch: 5n,
      value: 1_110n,
      inputsHash: hashOf(51),
      soleOperator: true,
    }),
    [op1],
  );
  await finalize('finalize_index (epoch 5)');
  index = await feeIndex();
  check('one-operator post_index → finalize_index', index.epoch === 5n && index.value === 1_110n);
  const rent4 = (await ballot(4n))!.lamports;
  const before4 = BigInt(await connection.getBalance(op2.publicKey, 'confirmed'));
  await send(
    'close_index_ballot (epoch 4, skipped over by epoch 5)',
    sdk.closeIndexBallot({ programId, cranker: cranker.publicKey, epoch: 4n, payer: op2.publicKey }),
    [cranker],
  );
  check(
    'a ballot skipped over by a later final epoch is closable',
    (await ballot(4n)) === null && BigInt(await connection.getBalance(op2.publicKey, 'confirmed')) - before4 === rent4,
  );
  check(
    'FeeIndex.valueFor still answers every final epoch',
    [1n, 2n, 3n, 5n].every((e) => sdk.feeIndexValueFor(index, e) !== null),
    {
      values: [1n, 2n, 3n, 5n].map((e) => sdk.feeIndexValueFor(index, e)),
    },
  );
}

main()
  .catch((error: unknown) => {
    console.error(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    checks.push({ check: 'the run completed', ok: false, detail: String(error) });
  })
  .finally(async () => {
    writeFileSync(out, `${JSON.stringify({ programId: programId.toBase58(), steps, checks }, big, 2)}\n`);
    const failed = checks.filter((c) => !c.ok);
    console.log(`${checks.length - failed.length}/${checks.length} checks passed; results: ${out}`);
    if (failed.length || checks.length === 0) process.exitCode = 1;
    if (!flag('keep')) {
      await stopValidator();
      rmSync(ledger, { recursive: true, force: true });
    }
    // web3.js keeps reconnecting its signature-subscription websocket to the stopped validator, which would hold
    // the event loop open forever: leave explicitly.
    process.exit();
  });
