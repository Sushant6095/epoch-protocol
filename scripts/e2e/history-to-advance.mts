/**
 * Validator history to an advance, end to end on a local validator. The local cluster's own bootstrap validator
 * (it votes every slot) is onboarded, gets a `ValidatorHistory`, and its Epoch Score comes from the chain instead of
 * the scorer: `init_validator_history` → `copy_vote_account` (credits backfilled from the vote account, the newest
 * vote, revenue by the sweep rule) → the Jito copies (clean no-ops: there is no Jito program locally) →
 * `update_stake_info` (the one oracle input) → `refresh_score` (hedge computed on chain from the derived swap PDAs)
 * → `request_advance` with that score. It also checks the trust rules: `refresh_score` refuses without this epoch's
 * stake info, and `update_score` (the scorer's fallback) refuses once the history is fresh. Finally the keeper's own
 * `HistoryJob` (cranks_app, through `ProgramClient`) runs the next epoch's copies, stake info and refresh.
 *
 *   pnpm build
 *   node scripts/e2e/history-to-advance.mts --program <epoch.so> --program-keypair <keypair.json> --work <scratch dir>
 *
 * The program must be built with `declare_id!` set to the keypair's address (a throwaway id). Options (defaults):
 *   --rpc-port 28899 (websocket = rpc + 1)   --faucet-port 29900   --gossip-port 28000   --dynamic-ports 28001-28100
 *   --slots-per-epoch 64   --solana-bin <dir of solana-test-validator, default from PATH>   --out <results.json>
 *   --keep (the validator and its ledger stay for inspection)
 *
 * It writes only to the scratch dir (ledger, logs, throwaway keys, results) and talks only to the local validator:
 * nothing touches devnet or mainnet. Node 22.18+ (type stripping); the exit code is 0 only when every check passed.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The workspace's own dependencies, resolved as the apps resolve them.
const cranks = createRequire(join(ROOT, 'packages', 'cranks_app', 'package.json'));
const web3 = cranks('@solana/web3.js');
const sdk = cranks('@epoch/epoch-sdk');
const solana = cranks('@epoch/solana');
const { ProgramClient } = cranks(join(ROOT, 'packages/cranks_app/dist/Chain/ProgramClient.js'));
const { HistoryJob } = cranks(join(ROOT, 'packages/cranks_app/dist/Jobs/HistoryJob.js'));

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
const rpcPort = Number(option('rpc-port', '28899'));
const faucetPort = Number(option('faucet-port', '29900'));
const gossipPort = Number(option('gossip-port', '28000'));
const dynamicPorts = option('dynamic-ports', '28001-28100');
const slotsPerEpoch = Number(option('slots-per-epoch', '64'));
const solanaBin = option('solana-bin', '');
const out = resolve(option('out', join(work, 'results.json')));
const ledger = join(work, 'ledger');

const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const SOL = 1_000_000_000n;

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

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (validator && validator.exitCode !== null) throw new Error(`the validator exited while waiting for ${what}`);
    const result = await probe().catch(() => null);
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

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
const loadKeypair = (path: string) =>
  web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
const programId = loadKeypair(programKeypair).publicKey;

async function send(label: string, instructions: unknown[], signers: unknown[], extra = {}): Promise<string> {
  const tx = new web3.Transaction().add(
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...instructions,
  );
  const signature = await web3.sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
  log(label, { signature, ...extra });
  return signature;
}

/** The Anchor error code a failed send carries (`custom program error: 0x…`), or null. */
function errorCode(error: unknown): number | null {
  const text = `${error instanceof Error ? error.message : String(error)} ${JSON.stringify((error as { logs?: unknown })?.logs ?? '')}`;
  const hexMatch = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (hexMatch) return parseInt(hexMatch[1], 16);
  const numMatch = /Error Number: (\d+)/.exec(text);
  return numMatch ? Number(numMatch[1]) : null;
}

async function expectError(label: string, name: string, instructions: unknown[], signers: unknown[]) {
  try {
    await send(label, instructions, signers);
    check(`${label} is refused with ${name}`, false, 'it succeeded');
  } catch (error) {
    const code = errorCode(error);
    const info = code === null ? undefined : sdk.epochErrorFromCode(code);
    check(`${label} is refused with ${name}`, info?.name === name, { code, name: info?.name });
  }
}

async function account(address: unknown) {
  return connection.getAccountInfo(address, 'confirmed');
}
const position = async (vote: unknown) =>
  sdk.decodeValidatorPosition((await account(sdk.findPositionPda(programId, vote)[0]))!.data);
const history = async (vote: unknown) =>
  sdk.decodeValidatorHistory((await account(sdk.findValidatorHistoryPda(programId, vote)[0]))!.data);

async function epochInfo() {
  return connection.getEpochInfo('confirmed');
}

/** Waits for the next epoch to start, then until the stake rewards for it are paid (a few slots in). */
async function nextEpoch(): Promise<number> {
  const { epoch } = await epochInfo();
  const next = await until(`epoch ${epoch + 1}`, 120_000, async () => {
    const info = await epochInfo();
    return info.epoch > epoch && info.slotIndex >= 4 ? info : null;
  });
  return next.epoch;
}

/** Runs `fn` in one epoch; when the epoch turns over before it finishes, starts again in the next one. */
async function inOneEpoch<T>(what: string, fn: (epoch: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { epoch, slotIndex, slotsInEpoch } = await epochInfo();
    if (slotIndex > slotsInEpoch - 24) {
      await nextEpoch();
      continue;
    }
    try {
      const result = await fn(epoch);
      if ((await epochInfo()).epoch === epoch) return result;
      log(`${what}: the epoch turned over mid-way; again`, { epoch });
    } catch (error) {
      if ((await epochInfo()).epoch === epoch) throw error;
      log(`${what}: the epoch turned over mid-way; again`, { epoch });
    }
  }
  throw new Error(`${what} never fit in one epoch`);
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(join(work, 'keys'), { recursive: true, mode: 0o700 });
  if (!existsSync(programSo)) throw new Error(`no program at ${programSo}`);
  if (!existsSync(join(ROOT, 'packages/epoch-sdk/dist/index.js'))) throw new Error('build the SDK first (pnpm build)');
  const [low, high] = dynamicPorts.split('-').map(Number);
  const ports = [rpcPort, rpcPort + 1, faucetPort, gossipPort];
  for (let port = low; port <= high; port++) ports.push(port);
  const busy: number[] = [];
  for (const port of ports) if (!(await portFree(port))) busy.push(port);
  if (busy.length) throw new Error(`ports in use: ${busy.join(', ')}`);

  // 1. A local validator with the Epoch program at the throwaway id.
  const fd = openSync(join(work, 'validator.log'), 'w');
  validator = spawn(
    solanaBin ? join(solanaBin, 'solana-test-validator') : 'solana-test-validator',
    [
      ...['--ledger', ledger, '--reset', '--quiet', '--bind-address', '127.0.0.1'],
      ...['--rpc-port', String(rpcPort), '--faucet-port', String(faucetPort), '--gossip-port', String(gossipPort)],
      ...['--dynamic-port-range', dynamicPorts, '--slots-per-epoch', String(slotsPerEpoch)],
      ...['--limit-ledger-size', '50000', '--bpf-program', programId.toBase58(), programSo],
    ],
    {
      cwd: work,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', RUST_LOG: 'warn' },
      stdio: ['ignore', fd, fd],
    },
  );
  closeSync(fd);
  await until('the validator', 90_000, async () => (await connection.getSlot()) >= 1);
  log('validator up', { rpc: rpcUrl, programId: programId.toBase58(), slotsPerEpoch });

  // 2. The bootstrap validator. Its vote account's withdraw authority is one of the keypairs the test validator
  //    writes into its ledger (which one depends on the Agave version), so find it by public key.
  const vote = loadKeypair(join(ledger, 'vote-account-keypair.json')).publicKey;
  const voteInfo = await until('the vote account', 30_000, () => account(vote));
  const state = solana.parseVoteState(voteInfo.data);
  const ledgerKeys = readdirSync(ledger)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [{ file: f, keypair: loadKeypair(join(ledger, f)) }];
      } catch {
        return [];
      }
    });
  const withdrawer = ledgerKeys.find((k) => k.keypair.publicKey.toBase58() === state.authorizedWithdrawer);
  check("the bootstrap vote account's withdraw authority is a ledger keypair", !!withdrawer, {
    version: state.version,
    withdrawer: state.authorizedWithdrawer,
    file: withdrawer?.file,
    identity: state.nodePubkey,
    commissionBps: state.inflationRewardsCommissionBps,
  });
  if (!withdrawer) throw new Error("cannot onboard: the vote account's withdraw authority is not in the ledger");
  const currentWithdrawer = withdrawer.keypair;

  // 3. Throwaway roles, funded from the local faucet.
  const admin = web3.Keypair.generate(); // admin and scorer
  const operator = web3.Keypair.generate();
  const lender = web3.Keypair.generate();
  const maker = web3.Keypair.generate();
  for (const key of [admin, operator, lender]) {
    const signature = await connection.requestAirdrop(key.publicKey, 200 * web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature, 'confirmed');
  }

  // 4. The pool (a single-validator cluster is its own superminority, capped at 5,000: min_score fits that),
  //    the scoring settings and lender money.
  const params = {
    seniorRateBpsPerEpoch: 3,
    protocolFeeBps: 1_000,
    advanceBpsUnhedged: 2_500,
    advanceBpsHedged: 4_000,
    bondMultiplier: 4,
    feeBps: 200,
    remitBps: 5_000,
    minScore: 5_000,
    scoreTtlEpochs: 3,
    minAdvanceLamports: SOL / 10n,
    maxAdvanceLamports: 500n * SOL,
    maxPoolAssets: 0n,
    maxUtilizationBps: 6_000,
    minJuniorBps: 2_000,
    juniorLockEpochs: 10,
    maxAdvanceEpochs: 20,
    voteReserveLamports: SOL,
    minCommissionBps: 0,
  };
  await send(
    'initialize_pool',
    sdk.initializePool({
      programId,
      admin: admin.publicKey,
      treasury: admin.publicKey,
      scorer: admin.publicKey,
      params,
    }),
    [admin],
  );
  const scoring = { ...sdk.DEFAULT_SCORING_PARAMS, marketMaker: maker.publicKey };
  await send(
    'configure_scoring',
    sdk.configureScoring({ programId, admin: admin.publicKey, params: scoring }),
    [admin],
    {
      marketMaker: maker.publicKey.toBase58(),
    },
  );
  await send(
    'deposit junior',
    sdk.deposit({ programId, owner: lender.publicKey, tranche: 'junior', lamports: 30n * SOL }),
    [lender],
  );
  await send(
    'deposit senior',
    sdk.deposit({ programId, owner: lender.publicKey, tranche: 'senior', lamports: 70n * SOL }),
    [lender],
  );

  // 5. Onboard the bootstrap validator (withdraw authority → the vote_auth PDA, collectors → the escrow, a bond).
  const onboard = {
    programId,
    operator: operator.publicKey,
    currentWithdrawer: currentWithdrawer.publicKey,
    vote,
    payout: operator.publicKey,
  };
  try {
    await send(
      'onboard_validator + set_collectors + post_bond',
      sdk.onboardWithBond({ ...onboard, bondLamports: SOL }),
      [operator, currentWithdrawer],
    );
  } catch (error) {
    log('set_collectors refused on this cluster (SIMD-0232 inactive?): onboarding without it', {
      error: String(error).slice(0, 200),
    });
    await send(
      'onboard_validator + post_bond',
      sdk.onboardWithBond({ ...onboard, bondLamports: SOL, setCollectors: false }),
      [operator, currentWithdrawer],
    );
  }

  // 6. The history: anyone can create it and copy the chain into it.
  await send('init_validator_history', sdk.initValidatorHistory({ programId, cranker: operator.publicKey, vote }), [
    operator,
  ]);
  const created = await history(vote);
  check('a fresh history has no entries', created.entries.length === 0 && created.vote.equals(vote));

  // 7. Three epochs of revenue (lamports sent to the vote account stand in for commission), each copied before the
  //    sweep the way the keeper does it, so the history sees the epoch's revenue by the sweep rule.
  for (let i = 0; i < 3; i++) {
    const epoch = await nextEpoch();
    await send(
      `revenue ${i + 1}: 2 SOL into the vote account`,
      [web3.SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: vote, lamports: 2n * SOL })],
      [operator],
    );
    await send(
      `copy_vote_account (epoch ${epoch})`,
      sdk.copyVoteAccount({ programId, cranker: operator.publicKey, vote }),
      [operator],
    );
    const sweepIx = sdk.sweep({
      programId,
      cranker: operator.publicKey,
      vote,
      payout: operator.publicKey,
      openAdvance: null,
    });
    await until(`sweep in epoch ${epoch}`, 30_000, async () => {
      try {
        return await send(`sweep (epoch ${epoch})`, sweepIx, [operator]);
      } catch (error) {
        if (sdk.epochErrorFromCode(errorCode(error) ?? 0)?.name === 'RewardsInProgress') return null;
        throw error;
      }
    });
  }
  const swept = await position(vote);
  check('three epochs of swept revenue', swept.revenueCount === 3, { revenue: swept.revenue.map(String) });

  // 8. The score from the chain, all in one epoch.
  const result = await inOneEpoch('score round', async (epoch) => {
    const E = BigInt(epoch);
    await send('copy_vote_account', sdk.copyVoteAccount({ programId, cranker: operator.publicKey, vote }), [operator]);
    for (const e of [E - 1n, E]) {
      const tip = await send(
        `copy_tip_distribution_account(${e})`,
        sdk.copyTipDistributionAccount({ programId, cranker: operator.publicKey, vote, epoch: e }),
        [operator],
      );
      const pf = await send(
        `copy_priority_fee_distribution(${e})`,
        sdk.copyPriorityFeeDistribution({ programId, cranker: operator.publicKey, vote, epoch: e }),
        [operator],
      );
      for (const [label, signature] of [
        ['tip', tip],
        ['priority fee', pf],
      ] as const) {
        const tx = await connection.getTransaction(signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        const event = sdk.parseEventsFromLogs(tx?.meta?.logMessages ?? [], programId)[0];
        check(`no Jito ${label} account locally: a clean no-op (epoch ${e})`, event?.data.found === false, event?.name);
      }
    }
    const refresh = sdk.refreshScore({
      programId,
      cranker: operator.publicKey,
      vote,
      operator: operator.publicKey,
      marketMaker: maker.publicKey,
      currentEpoch: E,
    });
    await expectError("refresh_score without this epoch's stake info", 'StakeInfoStale', refresh, [operator]);

    const { current } = await connection.getVoteAccounts('confirmed');
    const stake = BigInt(
      current.find((v: { votePubkey: string }) => v.votePubkey === vote.toBase58())?.activatedStake ?? 0,
    );
    await send(
      'update_stake_info (scorer)',
      sdk.updateStakeInfo({
        programId,
        scorer: admin.publicKey,
        vote,
        info: { epoch: E, activatedStakeLamports: stake, rank: 1, superminority: true },
      }),
      [admin],
      { stake },
    );

    const fallback = sdk.updateScore({
      programId,
      scorer: admin.publicKey,
      vote,
      update: {
        creditsRatioBps: 10_000,
        commissionBps: 0,
        epochsActive: 60,
        delinquent: false,
        superminority: false,
        hedged: true,
      },
    });
    await expectError('update_score while the history is fresh', 'HistoryIsFresh', fallback, [admin]);

    const signature = await send('refresh_score', refresh, [operator]);
    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    return {
      epoch,
      signature,
      events: sdk.parseEventsFromLogs(tx?.meta?.logMessages ?? [], programId),
      cu: tx?.meta?.computeUnitsConsumed,
    };
  });

  const scored = await position(vote);
  const h = await history(vote);
  const refreshed = result.events.find((e: { name: string }) => e.name === 'ScoreRefreshed')?.data;
  log('score from history', { refreshed, computeUnits: result.cu });
  check(
    'refresh_score wrote the score this epoch',
    scored.lastScoredEpoch === BigInt(result.epoch) && scored.score === h.score,
  );
  check(
    'the score is the on-chain formula of the history inputs',
    scored.score ===
      sdk.computeScore({
        creditsRatioBps: h.creditsRatioBps,
        commissionBps: h.commissionBps,
        epochsActive: h.epochsActive,
        delinquent: (h.scoreFlags & sdk.HISTORY_SCORE_FLAGS.delinquent) !== 0,
        superminority: (h.scoreFlags & sdk.HISTORY_SCORE_FLAGS.superminority) !== 0,
      }),
    { score: scored.score },
  );
  check(
    'ScoreRefreshed and ScoreUpdated were emitted',
    !!refreshed && result.events.some((e: { name: string }) => e.name === 'ScoreUpdated'),
  );
  check('the validator votes: not delinquent', (h.scoreFlags & sdk.HISTORY_SCORE_FLAGS.delinquent) === 0);
  check('no swaps against the maker: not hedged', scored.hedged === false && h.hedgeRequiredNotional > 0n, {
    required: h.hedgeRequiredNotional,
  });
  const past = h.entries.filter((e: { epoch: bigint }) => e.epoch < BigInt(result.epoch));
  check(
    'credits were backfilled for every past epoch from the vote account',
    past.length === result.epoch &&
      past.every(
        (e: { epochCredits: bigint | null; maxCredits: bigint | null }) =>
          (e.epochCredits ?? 0n) > 0n && e.maxCredits === BigInt(slotsPerEpoch) * 16n,
      ),
    {
      epochs: past.map((e: { epoch: bigint; epochCredits: bigint | null }) => `${e.epoch}:${e.epochCredits}`),
    },
  );
  // The window is the last `creditsWindowEpochs` finished epochs (fewer on a young cluster); epoch 0 is partial
  // (the validator starts voting a few slots in), so the ratio is recomputed from the decoded entries.
  const first = BigInt(Math.max(0, result.epoch - scoring.creditsWindowEpochs));
  const window = past.filter((e: { epoch: bigint }) => e.epoch >= first);
  const earned = window.reduce((sum: bigint, e: { epochCredits: bigint | null }) => sum + (e.epochCredits ?? 0n), 0n);
  const max = window.reduce((sum: bigint, e: { maxCredits: bigint | null }) => sum + (e.maxCredits ?? 0n), 0n);
  const raw = Number((earned * 10_000n) / max);
  check(
    'the credits ratio is Σ credits ÷ Σ TVC maximum over the window, rescaled by the reference',
    h.creditsRatioRawBps === raw && h.creditsRatioBps === Math.floor((raw * 10_000) / scoring.creditsReferenceBps),
    {
      raw: h.creditsRatioRawBps,
      expected: raw,
      scaled: h.creditsRatioBps,
    },
  );
  check('the score clears min_score (superminority cap 5,000)', scored.score >= params.minScore, {
    score: scored.score,
  });
  check('refresh_score fits the compute budget with room to spare', (result.cu ?? Infinity) < 200_000, {
    cu: result.cu,
  });

  // 9. The advance, sized by the swept revenue, approved on the history's score.
  const amount = SOL;
  await send(
    'request_advance (1 SOL)',
    sdk.requestAdvance({
      programId,
      operator: operator.publicKey,
      vote,
      payout: operator.publicKey,
      advanceSeq: scored.advanceSeq,
      lamports: amount,
    }),
    [operator],
  );
  const after = await position(vote);
  const [advanceKey] = sdk.findAdvancePda(programId, vote, scored.advanceSeq);
  const advance = sdk.decodeAdvance((await account(advanceKey))!.data);
  check(
    'the advance is open for 1 SOL',
    after.openAdvance?.equals(advanceKey) === true && advance.principal === amount && advance.state === 'open',
    {
      advance: advanceKey.toBase58(),
    },
  );

  // 10. The keeper: cranks_app's HistoryJob through the real ProgramClient, in the next epoch.
  const connections = new solana.ConnectionManager(rpcUrl);
  const chain = new ProgramClient({
    programId,
    connections,
    sender: new solana.TransactionSender(connections, operator),
    scorer: admin,
    computeUnitPriceMicroLamports: 0,
    dryRun: false,
  });
  const keeperEpoch = await nextEpoch();
  const outcome = await until('HistoryJob done', 60_000, async () => {
    const result = await new HistoryJob(chain).run(BigInt(keeperEpoch));
    return result === 'done' ? result : null;
  });
  const kept = await history(vote);
  const keptEntry = kept.entries.find((e: { epoch: bigint }) => e.epoch === BigInt(keeperEpoch));
  check(
    'HistoryJob copied the vote account, posted stake info and refreshed the score',
    outcome === 'done' &&
      (keptEntry?.sources & sdk.HISTORY_SOURCES.vote) !== 0 &&
      keptEntry?.superminority === true &&
      kept.refreshedEpoch === BigInt(keeperEpoch) &&
      (await position(vote)).lastScoredEpoch === BigInt(keeperEpoch),
    {
      epoch: keeperEpoch,
      score: kept.score,
      rank: keptEntry?.rank,
    },
  );

  writeFileSync(
    out,
    `${JSON.stringify(
      {
        script: 'scripts/e2e/history-to-advance.mts',
        ranAt: ist(),
        result: checks.every((c) => c.ok) ? 'PASS' : 'FAIL',
        cluster: { rpc: rpcUrl, slotsPerEpoch, programId: programId.toBase58(), vote: vote.toBase58() },
        score: { epoch: result.epoch, signature: result.signature, computeUnits: result.cu, refreshed },
        history: { vote: h.vote.toBase58(), entries: h.entries.length, latest: h.entries.at(-1) },
        advance: { address: advanceKey.toBase58(), principal: advance.principal },
        steps,
        checks,
      },
      big,
      2,
    )}\n`,
  );
  console.log(`results: ${out}`);
  if (!checks.every((c) => c.ok)) process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void stopValidator().finally(() => process.exit(130));
  });
}

main()
  .catch((error: unknown) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (!flag('keep')) {
      await stopValidator();
      rmSync(ledger, { recursive: true, force: true });
    }
    // web3.js keeps reconnecting its websocket to a stopped validator; nothing else is pending.
    process.exit(process.exitCode ?? 0);
  });
