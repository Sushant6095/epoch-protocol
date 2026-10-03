/**
 * Launches a validator's revenue token on a Meteora Dynamic Bonding Curve with Epoch as the DBC partner
 * (request #24, ADR 0006, plan F13). See scripts/README.md.
 *
 *   pnpm --filter @epoch/meteora launch -- --config <file> [--dry-run] [--registry <path>] [--rpc <url>]
 *
 * Reads the launch config, prices the share from the validator's 10-epoch average revenue (the config's
 * `avgRevenueSol`, or mainnet `getInflationReward` for its vote account), builds the curve between 60% and 95% of the
 * share's value with `buildCurveWithCustomSqrtPrices`, then creates the DBC config and pool in one transaction (partner
 * and fee claimer: Epoch's treasury) and appends the launch to the registry the API reads (`LAUNCHES_PATH`).
 * `--dry-run` prints every account and parameter and sends nothing.
 *
 * Keys: the payer keypair is read from the file at LAUNCH_KEYPAIR_PATH when sending (never written or printed). The new
 * config and mint accounts get fresh signers in memory at send time; only their public keys are printed.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { parseArgs } from 'util';

import {
  deriveDbcEventAuthority,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  deriveMintMetadata,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SendTransactionError,
  SystemProgram,
  type Transaction,
} from '@solana/web3.js';
import BN from 'bn.js';

import {
  averageRevenueSol,
  dbcClient,
  type LaunchCluster,
  LaunchConfigError,
  type LaunchPlan,
  type LaunchRegistryEntry,
  appendRegistryEntry,
  NATIVE_MINT,
  parseLaunchConfig,
  planLaunch,
  registryEntryFor,
  TOKEN_PROGRAM_ID,
} from '../src';

const DEFAULT_RPC: Record<LaunchCluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};
/** Transactions above this many bytes do not fit in a packet. */
const MAX_TX_BYTES = 1232;
const REVENUE_WINDOW = 10;

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

/** ISO 8601 in India Standard Time, as everything shown to users. */
const isoIst = (date: Date = new Date()): string =>
  `${new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 19)}+05:30`;

const fmt = (value: number, digits = 6): string =>
  value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** BN and bigint values as decimal strings and keys as base58, for printing parameters (BN's own JSON is hex). */
function printable(value: unknown): unknown {
  if (typeof value === 'bigint' || BN.isBN(value)) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(printable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, printable(inner)]));
  }
  return value;
}

interface Args {
  config: string;
  dryRun: boolean;
  registry?: string;
  rpc: string;
  revenueRpc: string;
  cluster: LaunchCluster;
}

function readArgs(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      config: { type: 'string', short: 'c' },
      'dry-run': { type: 'boolean', default: false },
      registry: { type: 'string' },
      rpc: { type: 'string' },
      'revenue-rpc': { type: 'string' },
      cluster: { type: 'string', default: 'devnet' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help || !values.config) {
    out('Usage: pnpm --filter @epoch/meteora launch -- --config <file> [--dry-run] [--registry <path>] [--rpc <url>]');
    out('       [--revenue-rpc <mainnet url>] [--cluster devnet|mainnet]');
    out('Env:   LAUNCH_KEYPAIR_PATH (payer, needed to send), EPOCH_TREASURY (partner), LAUNCHES_PATH (registry),');
    out('       LAUNCH_RPC_URL / EPOCH_RPC_URL (launch cluster), DATA_RPC_URL (mainnet revenue)');
    process.exit(values.help ? 0 : 2);
  }
  const cluster = values.cluster as LaunchCluster;
  if (cluster !== 'devnet' && cluster !== 'mainnet') throw new Error('--cluster must be devnet or mainnet');
  const env = process.env;
  return {
    config: values.config,
    dryRun: values['dry-run'] ?? false,
    registry: values.registry ?? env.LAUNCHES_PATH,
    rpc: values.rpc ?? env.LAUNCH_RPC_URL ?? env.EPOCH_RPC_URL ?? DEFAULT_RPC[cluster],
    revenueRpc: values['revenue-rpc'] ?? env.DATA_RPC_URL ?? DEFAULT_RPC.mainnet,
    cluster,
  };
}

const expandHome = (path: string): string => path.replace(/^~(?=$|\/)/, homedir());

/** Loads the payer from a Solana CLI keypair file. The secret stays in memory and is never printed. */
function loadPayer(path: string): Keypair {
  const file = resolve(expandHome(path));
  if (!existsSync(file)) throw new Error(`LAUNCH_KEYPAIR_PATH: no file at ${file}`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8')) as number[]));
}

/** The 10-epoch average of the vote account's inflation commission on mainnet (one call per epoch). */
async function mainnetAverageRevenue(vote: string, rpc: string): Promise<{ avgRevenueSol: number; epochs: number[] }> {
  const connection = new Connection(rpc, 'confirmed');
  const { epoch } = await connection.getEpochInfo();
  const epochs = Array.from({ length: REVENUE_WINDOW }, (_, i) => epoch - REVENUE_WINDOW + i);
  const lamports: (number | null)[] = [];
  for (const e of epochs) {
    const [reward] = await connection.getInflationReward([new PublicKey(vote)], e);
    lamports.push(reward ? reward.amount : null);
  }
  return { avgRevenueSol: averageRevenueSol(lamports), epochs };
}

function readRegistry(path: string): LaunchRegistryEntry[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.some((row) => typeof (row as { mint?: unknown })?.mint !== 'string')) {
    throw new Error(`${path}: expected a JSON array of launches`);
  }
  return parsed as LaunchRegistryEntry[];
}

/** Writes the registry through a temporary file, so a reader never sees half a file. */
function writeRegistry(path: string, entries: LaunchRegistryEntry[]): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(temporary, path);
}

interface LaunchKeys {
  payer: PublicKey;
  partner: PublicKey;
  config: PublicKey;
  mint: PublicKey;
  /** Names of the keys that are placeholders (a dry run without keys). */
  placeholders: string[];
}

function configAccounts(plan: LaunchPlan, keys: LaunchKeys) {
  return {
    config: keys.config,
    feeClaimer: keys.partner,
    leftoverReceiver: keys.partner,
    quoteMint: NATIVE_MINT,
    payer: keys.payer,
    ...plan.curve.config,
  };
}

function poolParams(plan: LaunchPlan, keys: LaunchKeys) {
  return {
    baseMint: keys.mint,
    name: plan.config.name,
    symbol: plan.config.symbol,
    uri: plan.config.uri,
    poolCreator: keys.payer,
  };
}

/**
 * Wire size of a transaction: one signature per required signer plus the message. Sets the fee payer and, until the
 * real one is fetched, a stand-in blockhash (same size).
 */
function transactionSize(tx: Transaction, feePayer: PublicKey): number {
  tx.feePayer = feePayer;
  tx.recentBlockhash ??= PublicKey.default.toBase58();
  const message = tx.compileMessage();
  return 1 + message.header.numRequiredSignatures * 64 + message.serialize().length;
}

/** `createConfigAndPool` builds these two DBC instructions, in this order. */
const DBC_INSTRUCTIONS = ['createConfig', 'initializeVirtualPoolWithSplToken'];
const DAMM_FEE_BPS = [25, 30, 100, 200, 400, 600];

/** Names for every account the launch touches, for the dry run. */
function accountLabels(keys: LaunchKeys, pool: PublicKey): Map<string, string> {
  const placeholder = (name: string) => (keys.placeholders.includes(name) ? ' — placeholder' : '');
  return new Map([
    [keys.payer.toBase58(), `payer and pool creator${placeholder('payer')}`],
    [keys.partner.toBase58(), `partner: fee claimer and leftover receiver${placeholder('partner')}`],
    [keys.config.toBase58(), `DBC config, new account${placeholder('config')}`],
    [keys.mint.toBase58(), `base mint, new account${placeholder('mint')}`],
    [pool.toBase58(), 'DBC pool'],
    [deriveDbcTokenVaultAddress(pool, keys.mint).toBase58(), 'base vault'],
    [deriveDbcTokenVaultAddress(pool, NATIVE_MINT).toBase58(), 'quote vault'],
    [deriveMintMetadata(keys.mint).toBase58(), 'mint metadata'],
    [NATIVE_MINT.toBase58(), 'quote mint (SOL)'],
    [deriveDbcPoolAuthority().toBase58(), 'DBC pool authority'],
    [deriveDbcEventAuthority().toBase58(), 'DBC event authority'],
    [DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(), 'DBC program'],
    [METAPLEX_PROGRAM_ID.toBase58(), 'Metaplex token metadata program'],
    [TOKEN_PROGRAM_ID.toBase58(), 'SPL Token program'],
    [SystemProgram.programId.toBase58(), 'System program'],
  ]);
}

function printPlan(plan: LaunchPlan, args: Args, revenueSource: string, labels: Map<string, string>): void {
  const { config, band, curve } = plan;
  const feeBps = Number(curve.config.poolFees.baseFee.cliffFeeNumerator.toString()) / 1e5;
  out(`Cluster            ${args.cluster} (${new URL(args.rpc).host})`);
  out(`Validator          ${config.validator.name} (vote ${config.validator.vote ?? '—'})`);
  out(
    `Token              ${config.symbol} · ${config.name} · ${fmt(config.supply, 0)} tokens · ${config.decimals} decimals`,
  );
  out(`Metadata URI       ${config.uri}`);
  out(
    `Share              ${fmt(config.shareBps / 100, 2)}% of commission for ${config.termEpochs} epochs ` +
      `(${plan.startEpoch}–${plan.endEpoch})`,
  );
  out(`Revenue            ${fmt(plan.avgRevenueSol, 6)} SOL an epoch (10-epoch average; ${revenueSource})`);
  out(`Share revenue      ${fmt(band.shareRevenuePerEpochSol, 6)} SOL an epoch (the buyback per epoch)`);
  out(`Share value        ${fmt(band.shareValueSol, 4)} SOL → ${fmt(band.valuePerTokenSol, 9)} SOL per token`);
  out(
    `Curve band         ${fmt(band.bandLowSol, 9)} → ${fmt(band.bandHighSol, 9)} SOL per token (60%–95% of the value)`,
  );
  out(
    `Raise              ${fmt(curve.migrationThresholdSol, 6)} SOL (DBC migrationQuoteThreshold); ` +
      `the whole supply on the band would raise ${fmt(curve.fullSupplyRaiseSol, 3)} SOL`,
  );
  out(`On the curve       ${fmt(curve.tokensOnCurve, 2)} tokens`);
  out(
    `Leftover           ${fmt(curve.leftoverTokens, 0)} tokens (withdrawable by the leftover receiver after graduation)`,
  );
  out(
    `Graduation         ${fmt(curve.upfrontToValidatorSol, 6)} SOL to the pool creator (70%), ` +
      `${fmt(curve.dammSeedSol, 6)} SOL seeds DAMM v2 (100% of its LP locked, held by the partner)`,
  );
  out(
    `Fees               curve ${fmt(feeBps, 2)} bps (all to the partner); ` +
      `DAMM v2 pool ${DAMM_FEE_BPS[curve.config.migrationFeeOption] ?? '?'} bps after graduation`,
  );
  if (config.creator) out(`Pool creator →     ${config.creator} (transferPoolCreator after the launch)`);
  out();
  out('Accounts');
  for (const [address, label] of labels) out(`  ${address.padEnd(44)}  ${label}`);
  out();
  out('DBC config parameters (createConfig)');
  out(JSON.stringify(printable(curve.config), null, 2));
}

function printTransaction(tx: Transaction, size: number, labels: Map<string, string>): void {
  out();
  out(`Transaction        ${tx.instructions.length} instructions, ${size} bytes (limit ${MAX_TX_BYTES})`);
  let dbcIndex = 0;
  tx.instructions.forEach((ix, i) => {
    const known = ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) ? DBC_INSTRUCTIONS[dbcIndex++] : undefined;
    out(`  #${i + 1} ${known ?? 'instruction'} · program ${ix.programId.toBase58()} · ${ix.data.length} data bytes`);
    for (const meta of ix.keys) {
      const flags = [meta.isSigner ? 'signer' : '', meta.isWritable ? 'writable' : ''].filter(Boolean).join(', ');
      const label = labels.get(meta.pubkey.toBase58());
      out(`      ${meta.pubkey.toBase58().padEnd(44)}  ${[label, flags].filter(Boolean).join(' · ')}`);
    }
  });
}

/** Sends one transaction and waits for confirmation; prints the program logs when the preflight fails. */
async function send(connection: Connection, label: string, tx: Transaction, signers: Keypair[], cluster: string) {
  try {
    const signature = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
    out(`${label.padEnd(19)}${signature}`);
    out(`${''.padEnd(19)}https://explorer.solana.com/tx/${signature}?cluster=${cluster}`);
    return signature;
  } catch (error) {
    if (error instanceof SendTransactionError) {
      const logs = await error.getLogs(connection).catch(() => undefined);
      if (logs?.length) out(logs.join('\n'));
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const configPath = resolve(args.config);
  const launch = parseLaunchConfig(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
  const connection = new Connection(args.rpc, 'confirmed');
  const env = process.env;

  out(`Epoch revenue-token launch${args.dryRun ? ' — DRY RUN: nothing is signed or sent' : ''}`);
  out(`Config             ${configPath} · ${isoIst()}`);
  if (args.cluster === 'mainnet')
    out('WARNING            mainnet: a public launch needs legal review first (ADR 0006).');
  if (!args.dryRun) {
    if (!env.LAUNCH_KEYPAIR_PATH) throw new Error('LAUNCH_KEYPAIR_PATH is not set: it names the payer keypair file');
    if (!env.EPOCH_TREASURY) throw new Error("EPOCH_TREASURY is not set: it is Epoch's partner address");
    if (!args.registry) throw new Error('LAUNCHES_PATH (or --registry) is not set: the launch must be recorded');
  }

  let avgRevenueSol = launch.avgRevenueSol;
  let revenueSource = 'from the config';
  if (avgRevenueSol === undefined) {
    const read = await mainnetAverageRevenue(launch.validator.vote as string, args.revenueRpc);
    avgRevenueSol = read.avgRevenueSol;
    revenueSource = `mainnet getInflationReward for epochs ${read.epochs[0]}–${read.epochs[read.epochs.length - 1]}, inflation commission only`;
  }
  const startEpoch = launch.startEpoch ?? (await connection.getEpochInfo()).epoch + 1;
  const plan = planLaunch({ config: launch, avgRevenueSol, startEpoch, cluster: args.cluster });

  const placeholders: string[] = [];
  const placeholder = (name: string): PublicKey => {
    placeholders.push(name);
    return PublicKey.unique();
  };
  const payer = !args.dryRun && env.LAUNCH_KEYPAIR_PATH ? loadPayer(env.LAUNCH_KEYPAIR_PATH) : undefined;
  // Fresh signers for the two new accounts, in memory and only when sending; a dry run uses placeholder addresses.
  const configSigner = args.dryRun ? undefined : Keypair.generate();
  const mintSigner = args.dryRun ? undefined : Keypair.generate();
  const keys: LaunchKeys = {
    payer: payer?.publicKey ?? placeholder('payer'),
    partner: env.EPOCH_TREASURY ? new PublicKey(env.EPOCH_TREASURY) : placeholder('partner'),
    config: configSigner?.publicKey ?? placeholder('config'),
    mint: mintSigner?.publicKey ?? placeholder('mint'),
    placeholders,
  };
  const pool = deriveDbcPoolAddress(NATIVE_MINT, keys.mint, keys.config);
  const labels = accountLabels(keys, pool);

  out();
  printPlan(plan, args, revenueSource, labels);
  const client = dbcClient(connection);
  const tx = await client.partner.createConfigAndPool({
    ...configAccounts(plan, keys),
    preCreatePoolParam: poolParams(plan, keys),
  });
  const size = transactionSize(tx, keys.payer);
  printTransaction(tx, size, labels);
  const split = size > MAX_TX_BYTES;
  if (split) out('Too large for one transaction: it is sent as createConfig, then createPool.');

  const entry = registryEntryFor(
    plan,
    { mint: keys.mint.toBase58(), dbcPool: pool.toBase58(), dbcConfig: keys.config.toBase58() },
    isoIst(),
  );
  out();
  out(`Registry entry (${args.registry ?? 'LAUNCHES_PATH not set'})`);
  out(JSON.stringify(entry, null, 2));
  out();
  out(
    'Pending program work: register_revenue_token is not in the Epoch program yet, so the registry stands in for it;',
  );
  out('execute_buyback and redeem follow (plan F13).');

  if (args.dryRun) {
    out();
    out('Dry run: nothing was signed or sent.');
    return;
  }
  if (!payer || !configSigner || !mintSigner || !args.registry) throw new Error('missing signers or registry');
  const registry = readRegistry(args.registry);
  out();
  if (split) {
    await send(
      connection,
      'Config created',
      await client.partner.createConfig(configAccounts(plan, keys)),
      [payer, configSigner],
      args.cluster,
    );
    const createPool = await client.creator.createPool({
      ...poolParams(plan, keys),
      config: keys.config,
      payer: keys.payer,
    });
    await send(connection, 'Pool created', createPool, [payer, mintSigner], args.cluster);
  } else {
    await send(connection, 'Launched', tx, [payer, configSigner, mintSigner], args.cluster);
  }
  writeRegistry(args.registry, appendRegistryEntry(registry, entry));
  out(`Registry           ${args.registry} (${registry.length + 1} launches)`);

  if (launch.creator) {
    const transfer = await client.creator.transferPoolCreator({
      pool,
      creator: payer.publicKey,
      newCreator: new PublicKey(launch.creator),
    });
    await send(connection, 'Creator transferred', transfer, [payer], args.cluster);
  }
}

main().catch((error: unknown) => {
  if (error instanceof LaunchConfigError) {
    process.stderr.write(`Invalid launch config:\n${error.problems.map((p) => `  - ${p}`).join('\n')}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
