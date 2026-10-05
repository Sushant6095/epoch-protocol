/**
 * Pipeline to final, end to end on a local validator. A finished mainnet epoch's Fee Index goes from `epoch_index`
 * (computed) through publisher_app (`post_index`), the on-chain dispute window and cranks_app's FinalizeIndexJob
 * (`finalize_index`), and api_app's GET /v1/index/epochs/:N, the source Epoch's Panta markets resolve from, answers
 * `final` with the value and the signatures. Every step goes through the shipped code: the built apps run as processes
 * (publisher_app, api_app) or as their own modules (FinalizeIndexJob).
 *
 *   pnpm build
 *   node scripts/e2e/index-to-final.mts --program <epoch.so> --program-keypair <keypair.json> \
 *     --work <scratch dir> --database-url postgres://user:pass@127.0.0.1:5432/<test database>
 *
 * The program must be built with `declare_id!` set to the keypair's address (a throwaway id). Options (defaults):
 *   --rpc-port 19899 (websocket = rpc + 1)   --faucet-port 19901   --api-port 19902   --gossip-port 19905
 *   --dynamic-ports 19910-20010   --epoch 1051   --value 1400   --dispute-window 100 (slots, ~40 s)
 *   --solana-bin <dir of solana-test-validator, default from PATH>   --out <results.json>
 *   --keep (the validator and the schema stay for inspection)
 *
 * It writes only to the scratch dir and to its own Postgres schema (`e2e_index_to_final`, rebuilt from
 * packages/pg_models/migrations on every run and dropped at the end), so a shared test database is safe. Keys are
 * throwaway, and every RPC URL the apps get (DATA_RPC_URL included) is the local validator: nothing touches devnet or
 * mainnet. Node 22.18+ (type stripping); the exit code is 0 only when every check passed.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = 'e2e_index_to_final';
const SLOTS_PER_EPOCH = 32;

// The workspace's own dependencies, resolved as the apps resolve them.
const fromPackage = (pkg: string) => createRequire(join(ROOT, 'packages', pkg, 'package.json'));
const cranks = fromPackage('cranks_app');
const web3 = cranks('@solana/web3.js');
const sdk = cranks('@epoch/epoch-sdk');
const solana = cranks('@epoch/solana');
const pg = fromPackage('pg_models')('pg');
const { ProgramClient } = cranks(join(ROOT, 'packages/cranks_app/dist/Chain/ProgramClient.js'));
const { FinalizeIndexJob } = cranks(join(ROOT, 'packages/cranks_app/dist/Jobs/FinalizeIndexJob.js'));

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
const baseDbUrl = option('database-url');
const rpcPort = Number(option('rpc-port', '19899'));
const faucetPort = Number(option('faucet-port', '19901'));
const apiPort = Number(option('api-port', '19902'));
const gossipPort = Number(option('gossip-port', '19905'));
const dynamicPorts = option('dynamic-ports', '19910-20010');
const mainnetEpoch = Number(option('epoch', '1051'));
const value = Number(option('value', '1400'));
const disputeWindow = BigInt(option('dispute-window', '100'));
const solanaBin = option('solana-bin', '');
const out = resolve(option('out', join(work, 'results.json')));

const rpcUrl = `http://127.0.0.1:${rpcPort}`;
const wsUrl = `ws://127.0.0.1:${rpcPort + 1}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const dbUrl = `${baseDbUrl}${baseDbUrl.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;

// ── Record ─────────────────────────────────────────────────────────────────────────────────────────

const ist = (date = new Date()): string => new Date(date.getTime() + 19_800_000).toISOString().replace('Z', '+05:30');
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
const big = (_key: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Polls `probe` every second (its errors count as "not yet") until it returns something; a dead app fails at once. */
async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dead = children.find((child) => child.exitCode !== null && !stopping.has(child));
    if (dead) throw new Error(`${names.get(dead)} exited while waiting for ${what}:\n${tail(names.get(dead) ?? '')}`);
    const result = await probe().catch(() => null);
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1_000);
  }
}

// ── Processes ──────────────────────────────────────────────────────────────────────────────────────

const children: ChildProcess[] = [];
const names = new Map<ChildProcess, string>();
const stopping = new Set<ChildProcess>();
function start(name: string, command: string, args: string[], env: Record<string, string>): ChildProcess {
  const fd = openSync(join(work, `${name}.log`), 'w');
  const child = spawn(command, args, {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  children.push(child);
  names.set(child, name);
  return child;
}
async function stop(child: ChildProcess): Promise<void> {
  stopping.add(child);
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i++) await sleep(500);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}
const tail = (name: string): string =>
  readFileSync(join(work, `${name}.log`), 'utf8')
    .split('\n')
    .slice(-25)
    .join('\n');

async function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer()
      .once('error', () => done(false))
      .once('listening', () => server.close(() => done(true)))
      .listen(port, '127.0.0.1');
  });
}

// ── Chain ──────────────────────────────────────────────────────────────────────────────────────────

const connection = new web3.Connection(rpcUrl, 'confirmed');
const programId = web3.Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(programKeypair, 'utf8'))),
).publicKey;
const [pool] = sdk.findPoolPda(programId);
const [feeIndexPda] = sdk.findFeeIndexPda(programId, pool);

async function send(label: string, instructions: unknown[], signers: unknown[]): Promise<string> {
  const tx = new web3.Transaction().add(...instructions);
  const signature = await web3.sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
  log(label, { signature });
  return signature;
}

async function feeIndex() {
  const info = await connection.getAccountInfo(feeIndexPda, 'confirmed');
  return info ? sdk.decodeFeeIndex(info.data) : null;
}

/** Writes a throwaway keypair FILE (0600) for an app to load. */
function keyFile(name: string, keypair: { secretKey: Uint8Array }): string {
  const path = join(work, 'keys', `${name}.json`);
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  mkdirSync(join(work, 'keys'), { recursive: true, mode: 0o700 });
  if (!existsSync(programSo)) throw new Error(`no program at ${programSo}`);
  for (const dist of ['publisher_app', 'api_app', 'cranks_app']) {
    if (!existsSync(join(ROOT, 'packages', dist, 'dist/index.js'))) throw new Error(`build ${dist} first (pnpm build)`);
  }
  const [low, high] = dynamicPorts.split('-').map(Number);
  const ports = [rpcPort, rpcPort + 1, faucetPort, apiPort, gossipPort];
  for (let port = low; port <= high; port++) ports.push(port);
  const busy: number[] = [];
  for (const port of ports) if (!(await portFree(port))) busy.push(port);
  if (busy.length) throw new Error(`ports in use: ${busy.join(', ')}`);

  // 1. A local validator with the Epoch program at the throwaway id.
  const validatorBin = solanaBin ? join(solanaBin, 'solana-test-validator') : 'solana-test-validator';
  const validator = start(
    'validator',
    validatorBin,
    [
      '--ledger',
      join(work, 'ledger'),
      '--reset',
      '--quiet',
      '--bind-address',
      '127.0.0.1',
      '--rpc-port',
      String(rpcPort),
      '--faucet-port',
      String(faucetPort),
      '--gossip-port',
      String(gossipPort),
      '--dynamic-port-range',
      dynamicPorts,
      '--slots-per-epoch',
      String(SLOTS_PER_EPOCH),
      '--limit-ledger-size',
      '200000',
      '--bpf-program',
      programId.toBase58(),
      programSo,
    ],
    { RUST_LOG: 'warn' },
  );
  await until('the validator', 90_000, async () => (await connection.getSlot()) >= 1);
  log('validator up', { rpc: rpcUrl, programId: programId.toBase58(), slotsPerEpoch: SLOTS_PER_EPOCH });

  // 2. Throwaway roles, funded from the local faucet.
  const admin = web3.Keypair.generate();
  const publisher = web3.Keypair.generate();
  const cranker = web3.Keypair.generate();
  for (const key of [admin, publisher, cranker]) {
    const signature = await connection.requestAirdrop(key.publicKey, 10 * web3.LAMPORTS_PER_SOL);
    await connection.confirmTransaction(signature, 'confirmed');
  }

  // 3. The pool and the FeeIndex with a short dispute window.
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
  const ids = { programId, admin: admin.publicKey };
  await send(
    'initialize_pool',
    sdk.initializePool({ ...ids, treasury: admin.publicKey, scorer: admin.publicKey, params }),
    [admin],
  );
  await send(
    'initialize_index',
    sdk.initializeIndex({
      ...ids,
      publisher: publisher.publicKey,
      disputeWindowSlots: disputeWindow,
      maxMoveBps: 5_000,
    }),
    [admin],
  );

  // 4. Postgres: a schema of our own from the migrations, and a finished mainnet epoch the indexer computed.
  const db = new pg.Client({ connectionString: baseDbUrl });
  await db.connect();
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await db.query(`CREATE SCHEMA ${SCHEMA}`);
  await db.query(`SET search_path TO ${SCHEMA}`);
  const migrations = readdirSync(join(ROOT, 'packages/pg_models/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrations) {
    const text = readFileSync(join(ROOT, 'packages/pg_models/migrations', file), 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) if (statement.trim()) await db.query(statement);
  }
  await db.query('INSERT INTO epoch_index (epoch, value) VALUES ($1, $2)', [mainnetEpoch, value]);
  for (let i = 0; i < 8; i++) {
    await db.query(
      'INSERT INTO slot_fees (slot, epoch, leader, median_cu_price, tx_count) VALUES ($1, $2, $3, $4, $5)',
      [
        mainnetEpoch * 432_000 + i * 4,
        mainnetEpoch,
        web3.Keypair.generate().publicKey.toBase58(),
        value - 200 + i * 50,
        100 + i,
      ],
    );
  }
  await db.end();
  const probe = new pg.Client({ connectionString: dbUrl });
  await probe.connect();
  const searchPath = (await probe.query('SHOW search_path')).rows[0].search_path as string;
  await probe.end();
  check('apps see the e2e schema through DATABASE_URL', searchPath === SCHEMA, { searchPath });
  log('epoch_index row inserted', { mainnetEpoch, value, migrations: migrations.length, slotFees: 8 });

  // 5. publisher_app posts it. Mainnet epoch M goes under program epoch P = M + offset: here the local cluster's
  //    previous epoch (as FEE_INDEX_EPOCH_OFFSET does on devnet), so P has started, as the publisher requires.
  const { epoch: clusterEpoch } = await until('cluster epoch 2', 120_000, async () => {
    const info = await connection.getEpochInfo('confirmed');
    return info.epoch >= 2 ? info : null;
  });
  const programEpoch = clusterEpoch - 1;
  const offset = programEpoch - mainnetEpoch;
  const appDb = { DATABASE_URL: dbUrl, LOG_LEVEL: 'info' };
  const program = { EPOCH_CLUSTER: 'localnet', EPOCH_RPC_URL: rpcUrl, EPOCH_PROGRAM_ID: programId.toBase58() };
  const publisherEnv = {
    ...appDb,
    ...program,
    PUBLISHER_KEYPAIR_PATH: keyFile('publisher', publisher),
    PUBLISHER_INTERVAL_SECONDS: '5',
    FEE_INDEX_EPOCH_OFFSET: String(offset),
  };
  const envFile = join(work, 'publisher.env');
  writeFileSync(
    envFile,
    Object.entries(publisherEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    { mode: 0o600 },
  );
  const publisherApp = start(
    'publisher',
    process.execPath,
    [join(ROOT, 'packages/publisher_app/dist/index.js'), '--env', envFile],
    publisherEnv,
  );
  log('publisher_app started', { offset, programEpoch });
  const posted = await until('publisher_app to post the epoch', 180_000, async () => {
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    const { rows } = await client.query('SELECT posted_signature FROM epoch_index WHERE epoch = $1', [mainnetEpoch]);
    await client.end();
    return (rows[0]?.posted_signature as string | null) ?? null;
  });
  await stop(publisherApp);
  log('post_index landed (publisher_app)', { signature: posted });
  const proposed = await feeIndex();
  check('the FeeIndex holds the proposal', Boolean(proposed?.hasProposal) && proposed.proposedValue === BigInt(value), {
    proposedEpoch: proposed?.proposedEpoch,
    proposedValue: proposed?.proposedValue,
    proposedSlot: proposed?.proposedSlot,
  });
  check('posted under program epoch P = M + offset', proposed?.proposedEpoch === BigInt(programEpoch), {
    programEpoch,
  });

  // 6. The dispute window, then cranks_app's FinalizeIndexJob.
  const finalizableAt = (proposed.proposedSlot as bigint) + disputeWindow;
  const crankConnections = new solana.ConnectionManager(rpcUrl);
  const chain = new ProgramClient({
    programId,
    connections: crankConnections,
    sender: new solana.TransactionSender(crankConnections, cranker),
    computeUnitPriceMicroLamports: 0,
    dryRun: false,
  });
  const job = new FinalizeIndexJob(chain);
  const slotBefore = BigInt(await connection.getSlot('confirmed'));
  if (slotBefore + 5n < finalizableAt) {
    const beforeWindow = await job.run(0n);
    const stillPending = await feeIndex();
    check('FinalizeIndexJob waits while the dispute window is open', stillPending?.hasProposal === true, {
      outcome: beforeWindow,
      slot: slotBefore,
      finalizableAt,
    });
  }
  await until(
    'the dispute window to pass',
    120_000,
    async () => BigInt(await connection.getSlot('confirmed')) >= finalizableAt,
  );
  const outcome = await job.run(0n);
  const final = await feeIndex();
  const [finalizeTx] = await connection.getSignaturesForAddress(feeIndexPda, { limit: 1 }, 'confirmed');
  log('finalize_index landed (FinalizeIndexJob)', {
    outcome,
    signature: finalizeTx?.signature,
    slot: final?.finalizedSlot,
  });
  check(
    'the FeeIndex value is final',
    final?.hasProposal === false && final.epoch === BigInt(programEpoch) && final.value === BigInt(value),
    {
      epoch: final?.epoch,
      value: final?.value,
      finalizedSlot: final?.finalizedSlot,
    },
  );

  // 7. api_app: GET /v1/index/epochs/:M must say final, with the value and the signatures.
  const apiApp = start(
    'api',
    process.execPath,
    [join(ROOT, 'packages/api_app/dist/index.js'), '--env', join(work, 'none.env')],
    {
      ...appDb,
      ...program,
      LOG_LEVEL: 'warn',
      API_PORT: String(apiPort),
      EPOCH_RPC_WS_URL: wsUrl,
      DATA_RPC_URL: rpcUrl,
    },
  );
  const url = `${apiUrl}/v1/index/epochs/${mainnetEpoch}`;
  const view = await until(`${url} to say final`, 150_000, async () => {
    const data = await viewOf(mainnetEpoch, null);
    return data?.status === 'final' ? data : null;
  });
  log('api_app answers final', { url });
  check('status final, final: true', view.status === 'final' && view.final === true, { status: view.status });
  check('the value is the posted value', view.value === value && view.computedValue === value, { value: view.value });
  check('the post signature is the publisher’s', view.onChain?.postSignature === posted, view.onChain);
  check('the finalize signature is FinalizeIndexJob’s', view.onChain?.finalizeSignature === finalizeTx?.signature, {
    finalizeSignature: view.onChain?.finalizeSignature,
  });
  check('the program epoch is P', view.onChain?.programEpoch === programEpoch, {
    programEpoch: view.onChain?.programEpoch,
  });
  check(
    'the FeeIndex account and program are named',
    view.onChain?.feeIndexAccount === feeIndexPda.toBase58() && view.onChain?.programId === programId.toBase58(),
  );
  const next = await viewOf(mainnetEpoch + 1, null);
  check('the next epoch is pending', next?.status === 'pending' && next?.value === null, { status: next?.status });
  await stop(apiApp);

  // 8. panta_bot_app's strike source sees it as final too: epoch_index joined with the program events api_app recorded.
  process.env.DATABASE_URL = dbUrl;
  const bot = fromPackage('panta_bot_app');
  const { PostgresConnectionManager } = bot('@epoch/pg_models');
  const { PgIndexHistory } = bot(join(ROOT, 'packages/panta_bot_app/dist/Store/MarketStore.js'));
  const finals = await new PgIndexHistory(PostgresConnectionManager.getDb()).recentFinal(mainnetEpoch + 1, 10);
  await PostgresConnectionManager.close();
  check('panta_bot_app reads it as a final value for its strikes', finals.length === 1 && finals[0].value === value, {
    finals,
  });

  writeFileSync(
    out,
    `${JSON.stringify(
      {
        script: 'scripts/e2e/index-to-final.mts',
        ranAt: ist(),
        result: checks.every((c) => c.ok) ? 'PASS' : 'FAIL',
        cluster: {
          rpc: rpcUrl,
          slotsPerEpoch: SLOTS_PER_EPOCH,
          programId: programId.toBase58(),
          feeIndexAccount: feeIndexPda.toBase58(),
        },
        mainnetEpoch,
        programEpoch,
        offset,
        value,
        disputeWindowSlots: disputeWindow,
        postSignature: posted,
        finalizeSignature: finalizeTx?.signature ?? null,
        endpoint: { url: `/v1/index/epochs/${mainnetEpoch}`, data: view },
        next: { url: `/v1/index/epochs/${mainnetEpoch + 1}`, status: next?.status },
        steps,
        checks,
      },
      big,
      2,
    )}\n`,
  );
  console.log(`results: ${out}`);
  if (!flag('keep')) {
    await stop(validator);
    const cleanup = new pg.Client({ connectionString: baseDbUrl });
    await cleanup.connect();
    await cleanup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await cleanup.end();
  }
  if (!checks.every((c) => c.ok)) process.exitCode = 1;
}

/** GET /v1/index/epochs/:epoch's `data`, or the fallback when the API is not up yet. */
async function viewOf<T>(epoch: number, fallback: T) {
  try {
    const res = await fetch(`${apiUrl}/v1/index/epochs/${epoch}`);
    if (!res.ok) return fallback;
    return ((await res.json()) as { data: Record<string, any> }).data;
  } catch {
    return fallback;
  }
}

main()
  .catch((error: unknown) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const child of children.slice().reverse()) {
      if (flag('keep') && child.spawnfile.endsWith('solana-test-validator')) continue;
      await stop(child);
    }
  });
