/**
 * Launches a validator's revenue token on a Meteora Dynamic Bonding Curve with Epoch as the DBC partner (ADR 0006, plan
 * F13). Dry run by default; `--execute` sends. See scripts/README.md and docs/runbooks/meteora-mainnet-launch.md.
 *
 *   pnpm --filter @epoch/meteora launch -- --config <file> [--cluster devnet|mainnet] [--execute] [--yes]
 *
 * 1. Prices the share from the validator's revenue (the config's `avgRevenueSol`, mainnet RPC: inflation rewards plus
 *    sampled block revenue plus Jito MEV commission, or Epoch's API) and prints the math.
 * 2. Builds the revenue-anchored curve (60–95% of the share's value) with `buildCurveWithCustomSqrtPrices`: fixed
 *    supply, no mint authority, immutable metadata (`TokenAuthorityOption.Immutable`), graduation to DAMM v2 with a 70%
 *    migration fee to the pool creator and 100% of the DAMM v2 LP permanently locked with the partner.
 *    The DBC partner (fee claimer) and the leftover receiver are the Epoch program's treasury PDA `["treasury", pool]`,
 *    derived from EPOCH_PROGRAM_ID through `@epoch/epoch-sdk`: `register_revenue_token` refuses any other fee claimer,
 *    and the program burns the leftover it withdraws.
 * 3. Pre-flight: cluster (genesis hash), the Meteora programs and the DAMM v2 migration config, the Epoch program and its
 *    Pool, the terms the program accepts, the validator's position (onboarded, Active, no revenue token yet), registry
 *    conflicts, an existing DBC config to reuse (`--config-account`), the metadata URI, the payer's balance against the
 *    itemized cost, and a simulation of the transactions.
 * 4. With `--execute`: asks for the symbol (unless `--yes`), creates the config and the pool (with the creator's first
 *    buy when configured), hands the pool's creator role to the validator, waits for confirmations, verifies the
 *    result on chain and appends the launch record (public keys and signatures) to LAUNCHES_PATH.
 * 5. Registers the token with the program (`register_revenue_token`, signed by the validator's operator) when it holds
 *    the operator key (LAUNCH_OPERATOR_KEYPAIR_PATH); otherwise prints exactly what the operator signs and the command
 *    to run (`pnpm --filter @epoch/meteora register`).
 *
 * Keys come from paths only (LAUNCH_KEYPAIR_PATH, LAUNCH_CREATOR_KEYPAIR_PATH, LAUNCH_OPERATOR_KEYPAIR_PATH) and are
 * never printed. The new config and mint accounts get fresh signers in memory; only their public keys are shown.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseArgs } from 'util';

import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DAMM_V2_PROGRAM_ID,
  deriveDbcEventAuthority,
  deriveDbcPoolAddress,
  deriveDbcPoolAuthority,
  deriveDbcTokenVaultAddress,
  deriveMintMetadata,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
  SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, Keypair, PublicKey, SystemProgram, type Transaction } from '@solana/web3.js';
import BN from 'bn.js';

import {
  appendRegistryEntry,
  checkAccount,
  checkCluster,
  checkEpochPool,
  checkExistingConfig,
  checkInitialBuy,
  checkLeftoverReceiver,
  checkMetadataJson,
  checkPayerBalance,
  checkProgram,
  checkRegistry,
  checkRevenueTokenTerms,
  checkStartEpoch,
  checkValidatorPosition,
  dbcClient,
  type EpochRevenue,
  estimateLaunchCost,
  formatSol,
  type LaunchCluster,
  LaunchConfigError,
  type LaunchConfigInput,
  type LaunchPlan,
  launchPlanLines,
  launchRecordFor,
  NATIVE_MINT,
  parseLaunchConfig,
  planLaunch,
  type PreflightCheck,
  readLaunchPool,
  readRevenueHistory,
  readTokenMetadata,
  readTokenMint,
  revenueTableLines,
  type RevenueSummary,
  summarizePreflight,
  summarizeRevenue,
  toBaseUnits,
  TOKEN_PROGRAM_ID,
  treasuryMismatch,
  withRegistration,
} from '../src';
import {
  ask,
  DEFAULT_RPC,
  err,
  explorer,
  isoIst,
  loadKeypairFile,
  out,
  printable,
  readRegistryFile,
  replaceRegistryEntry,
  sendLabelled,
  simulate,
  transactionSize,
  waitFinalized,
  withPriorityFee,
  writeRegistryFile,
} from './cli';
import {
  type EpochProgramKeys,
  epochProgramKeys,
  type EpochProgramRead,
  planRegistration,
  readEpochProgram,
  readRegistered,
  REGISTRATION_RENT_LAMPORTS,
  type RegistrationPlan,
  registrationLabels,
  registrationLines,
  registrationTransaction,
  REVENUE_TOKEN_LIMITS,
  revenueTokenAccounts,
} from './epochProgram';

/** Transactions above this many bytes do not fit in a packet. */
const MAX_TX_BYTES = 1232;
const KOBE_API = 'https://kobe.mainnet.jito.network/api/v1/validators';

type RevenueSource = 'auto' | 'config' | 'rpc' | 'api';

interface Args {
  config: string;
  cluster: LaunchCluster;
  execute: boolean;
  yes: boolean;
  rpc: string;
  revenueRpc: string;
  revenue: RevenueSource;
  api?: string;
  registry?: string;
  configAccount?: string;
  priorityMicroLamports: number;
  blockSamples: number;
  includeBlocks: boolean;
  includeMev: boolean;
  allowUnknownGenesis: boolean;
  skipUriCheck: boolean;
  /** The Epoch program (`--program-id`, else EPOCH_PROGRAM_ID). */
  programId?: string;
}

const USAGE = `Usage: pnpm --filter @epoch/meteora launch -- --config <file> [options]

  --cluster devnet|mainnet     launch cluster (default devnet); written to the launch record
  --execute                    send the transactions (default: dry run, nothing is signed or sent)
  --yes                        skip the "type the symbol" confirmation (scripts and rehearsals)
  --rpc <url>                  launch cluster RPC (default LAUNCH_RPC_URL, else the public RPC of --cluster)
  --revenue auto|config|rpc|api  revenue source (auto: the config's avgRevenueSol, else mainnet RPC)
  --revenue-rpc <url>          mainnet RPC for revenue (default DATA_RPC_URL, else the public mainnet RPC)
  --api <url>                  Epoch API for --revenue api (default EPOCH_API_URL)
  --block-samples <n>          blocks read per epoch for the block revenue estimate (default 6; 0 = leave it out)
  --no-mev                     leave Jito MEV commission out of the revenue
  --registry <path>            launch registry to append to (default LAUNCHES_PATH)
  --config-account <pubkey>    reuse an existing DBC config (must match the plan) instead of creating one
  --priority-fee <µlamports>   compute-unit price (default 100000 on mainnet, 0 on devnet)
  --allow-unknown-genesis      accept an RPC that is not the public cluster (a local stand-in for rehearsals)
  --skip-uri-check             do not fetch the metadata URI
  --program-id <pubkey>        the Epoch program (default EPOCH_PROGRAM_ID); its treasury PDA is the fee claimer

Env: LAUNCH_KEYPAIR_PATH (payer, initial pool creator), EPOCH_PROGRAM_ID (the fee claimer and leftover receiver are
     its treasury PDA ["treasury", pool]), EPOCH_TREASURY (optional; must equal that PDA), LAUNCH_LEFTOVER_RECEIVER
     (default the treasury PDA), LAUNCH_CREATOR_KEYPAIR_PATH (the validator co-signs as pool creator),
     LAUNCH_OPERATOR_KEYPAIR_PATH (the validator's operator: registers the token at the end), LAUNCHES_PATH,
     LAUNCH_RPC_URL, DATA_RPC_URL, EPOCH_API_URL`;

function readArgs(argv: string[]): Args {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      config: { type: 'string', short: 'c' },
      cluster: { type: 'string', default: 'devnet' },
      execute: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      rpc: { type: 'string' },
      revenue: { type: 'string', default: 'auto' },
      'revenue-rpc': { type: 'string' },
      api: { type: 'string' },
      'block-samples': { type: 'string', default: '6' },
      'no-mev': { type: 'boolean', default: false },
      registry: { type: 'string' },
      'config-account': { type: 'string' },
      'priority-fee': { type: 'string' },
      'allow-unknown-genesis': { type: 'boolean', default: false },
      'skip-uri-check': { type: 'boolean', default: false },
      'program-id': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help || !values.config) {
    out(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const cluster = values.cluster as LaunchCluster;
  if (cluster !== 'devnet' && cluster !== 'mainnet') throw new Error('--cluster must be devnet or mainnet');
  if (values.execute && values['dry-run']) throw new Error('--execute and --dry-run contradict each other');
  const revenue = values.revenue as RevenueSource;
  if (!['auto', 'config', 'rpc', 'api'].includes(revenue))
    throw new Error('--revenue must be auto, config, rpc or api');
  const blockSamples = Number(values['block-samples']);
  if (!Number.isInteger(blockSamples) || blockSamples < 0 || blockSamples > 50) {
    throw new Error('--block-samples must be a whole number from 0 to 50');
  }
  const priority =
    values['priority-fee'] !== undefined ? Number(values['priority-fee']) : cluster === 'mainnet' ? 100_000 : 0;
  if (!Number.isInteger(priority) || priority < 0 || priority > 10_000_000) {
    throw new Error('--priority-fee must be micro-lamports per compute unit, 0–10,000,000');
  }
  const env = process.env;
  return {
    config: values.config,
    cluster,
    execute: values.execute ?? false,
    yes: values.yes ?? false,
    rpc: values.rpc ?? env.LAUNCH_RPC_URL ?? DEFAULT_RPC[cluster],
    revenueRpc: values['revenue-rpc'] ?? env.DATA_RPC_URL ?? DEFAULT_RPC.mainnet,
    revenue,
    api: values.api ?? env.EPOCH_API_URL,
    registry: values.registry ?? env.LAUNCHES_PATH,
    configAccount: values['config-account'],
    priorityMicroLamports: priority,
    blockSamples,
    includeBlocks: blockSamples > 0,
    includeMev: !values['no-mev'],
    allowUnknownGenesis: values['allow-unknown-genesis'] ?? false,
    skipUriCheck: values['skip-uri-check'] ?? false,
    programId: values['program-id'] ?? env.EPOCH_PROGRAM_ID,
  };
}

// ── Revenue ─────────────────────────────────────────────────────────────────────────────────────────

interface RevenueRead {
  avgRevenueSol: number;
  source: string;
  rows: EpochRevenue[];
  summary: RevenueSummary | null;
  lines: string[];
}

async function jitoMevCommission(vote: string): Promise<Map<number, number>> {
  const response = await fetch(`${KOBE_API}/${vote}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Jito Kobe HTTP ${response.status}`);
  const rows = (await response.json()) as {
    epoch: number;
    mev_commission_bps: number | null;
    mev_rewards: number | null;
  }[];
  // mev_rewards is the epoch's tips for the validator's stake; the validator keeps mev_commission_bps of them.
  return new Map(rows.map((row) => [row.epoch, ((row.mev_rewards ?? 0) * (row.mev_commission_bps ?? 0)) / 10_000]));
}

async function readRevenue(args: Args, launch: LaunchConfigInput): Promise<RevenueRead> {
  const source = args.revenue === 'auto' ? (launch.avgRevenueSol !== undefined ? 'config' : 'rpc') : args.revenue;
  if (source === 'config') {
    if (launch.avgRevenueSol === undefined)
      throw new Error('--revenue config needs avgRevenueSol in the launch config');
    return {
      avgRevenueSol: launch.avgRevenueSol,
      source: 'the launch config (avgRevenueSol)',
      rows: [],
      summary: null,
      lines: [`Revenue            ${launch.avgRevenueSol} SOL an epoch, from the launch config (avgRevenueSol)`],
    };
  }
  const vote = launch.validator.vote;
  if (!vote) throw new Error(`--revenue ${source} needs validator.vote in the launch config`);
  if (source === 'api') {
    if (!args.api) throw new Error('--revenue api needs --api or EPOCH_API_URL');
    const response = await fetch(`${args.api.replace(/\/+$/, '')}/v1/validators/${vote}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Epoch API HTTP ${response.status}`);
    const { data } = (await response.json()) as {
      data: {
        name: string;
        revenueEpoch: number;
        revenueLastEpochSol: { inflationCommission: number; tipsCommission: number; blockFeesEstimate: number };
        creditEstimate: { sweepableLast10EpochsSol: number };
      };
    };
    const sweepable = data.creditEstimate.sweepableLast10EpochsSol / 10;
    const blocks = args.includeBlocks ? data.revenueLastEpochSol.blockFeesEstimate : 0;
    return {
      avgRevenueSol: sweepable + blocks,
      source: `Epoch API ${args.api} (${data.name})`,
      rows: [],
      summary: null,
      lines: [
        `Revenue source     Epoch API: GET /v1/validators/${vote} (${data.name})`,
        `  inflation + MEV commission, last 10 epochs: ${data.creditEstimate.sweepableLast10EpochsSol.toFixed(6)} SOL ÷ 10 = ${sweepable.toFixed(6)} SOL an epoch`,
        `  block revenue estimate (epoch ${data.revenueEpoch}): ${args.includeBlocks ? `${blocks.toFixed(6)} SOL` : 'left out (--block-samples 0)'}`,
        `  average ${(sweepable + blocks).toFixed(6)} SOL an epoch`,
      ],
    };
  }
  // RPC: inflation rewards (exact) + block revenue (sampled) + Jito MEV commission (Kobe), last 10 finished epochs.
  // Rate limits are retried by readRevenueHistory with longer waits than web3.js's own retry.
  const connection = new Connection(args.revenueRpc, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  let mev: Map<number, number> | undefined;
  const notes: string[] = [];
  if (args.includeMev) {
    try {
      mev = await jitoMevCommission(vote);
    } catch (error) {
      notes.push(`  (Jito MEV commission left out: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  out(`Reading 10 epochs of revenue for ${vote} from ${new URL(args.revenueRpc).host} …`);
  const rows = await readRevenueHistory({
    connection,
    vote,
    epochs: 10,
    blockSamples: args.blockSamples,
    mevCommissionLamports: mev,
    delayMs: 250,
  });
  const summary = summarizeRevenue(rows, { blocks: args.includeBlocks, mev: args.includeMev && !!mev });
  return {
    avgRevenueSol: summary.avgRevenueSol,
    source: `mainnet RPC (${new URL(args.revenueRpc).host})`,
    rows,
    summary,
    lines: [
      ...revenueTableLines(
        rows,
        summary,
        `mainnet RPC ${new URL(args.revenueRpc).host}: getInflationReward (exact), getLeaderSchedule + getBlock (block revenue, sampled), Jito Kobe (MEV commission)`,
      ),
      ...notes,
    ],
  };
}

// ── Accounts and transactions ───────────────────────────────────────────────────────────────────────

interface LaunchKeys {
  payer: PublicKey;
  /** The DBC partner and fee claimer: the Epoch program's treasury PDA `["treasury", pool]`. */
  partner: PublicKey;
  leftoverReceiver: PublicKey;
  config: PublicKey;
  mint: PublicKey;
  /** Pool creator at creation: the validator when it co-signs, else the payer. */
  poolCreator: PublicKey;
  /** The validator's wallet the creator role ends with (null: stays with the payer). */
  finalCreator: PublicKey | null;
  placeholders: string[];
}

function accountLabels(keys: LaunchKeys, pool: PublicKey): Map<string, string> {
  const tag = (name: string) => (keys.placeholders.includes(name) ? ' — placeholder (dry run)' : '');
  const labels = new Map<string, string>([
    [keys.payer.toBase58(), `payer${keys.poolCreator.equals(keys.payer) ? ' and pool creator' : ''}${tag('payer')}`],
    [keys.partner.toBase58(), `partner: fee claimer (Epoch treasury PDA)${tag('partner')}`],
    [keys.config.toBase58(), `DBC config${keys.placeholders.includes('config') ? ', new account' : ''}`],
    [keys.mint.toBase58(), 'token mint, new account'],
    [pool.toBase58(), 'DBC pool'],
    [deriveDbcTokenVaultAddress(pool, keys.mint).toBase58(), 'curve token vault'],
    [deriveDbcTokenVaultAddress(pool, NATIVE_MINT).toBase58(), 'curve SOL vault'],
    [deriveMintMetadata(keys.mint).toBase58(), 'token metadata'],
    [NATIVE_MINT.toBase58(), 'quote mint (SOL)'],
    [deriveDbcPoolAuthority().toBase58(), 'DBC pool authority'],
    [deriveDbcEventAuthority().toBase58(), 'DBC event authority'],
    [DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(), 'DBC program'],
    [METAPLEX_PROGRAM_ID.toBase58(), 'Metaplex token metadata program'],
    [TOKEN_PROGRAM_ID.toBase58(), 'SPL Token program'],
    [SystemProgram.programId.toBase58(), 'System program'],
  ]);
  if (!keys.leftoverReceiver.equals(keys.partner)) labels.set(keys.leftoverReceiver.toBase58(), 'leftover receiver');
  else
    labels.set(
      keys.partner.toBase58(),
      `partner: fee claimer and leftover receiver (Epoch treasury PDA)${tag('partner')}`,
    );
  if (!keys.poolCreator.equals(keys.payer)) labels.set(keys.poolCreator.toBase58(), 'pool creator (the validator)');
  if (keys.finalCreator && !keys.finalCreator.equals(keys.poolCreator)) {
    labels.set(keys.finalCreator.toBase58(), 'the validator: pool creator after the hand-over');
  }
  return labels;
}

function printTransaction(title: string, tx: Transaction, size: number, labels: Map<string, string>): void {
  out(`${title}: ${tx.instructions.length} instructions, ${size} bytes (limit ${MAX_TX_BYTES})`);
  tx.instructions.forEach((ix, i) => {
    out(
      `  #${i + 1} program ${ix.programId.toBase58()} (${labels.get(ix.programId.toBase58()) ?? 'program'}) · ${ix.data.length} data bytes`,
    );
    for (const meta of ix.keys) {
      const flags = [meta.isSigner ? 'signer' : '', meta.isWritable ? 'writable' : ''].filter(Boolean).join(', ');
      const label = labels.get(meta.pubkey.toBase58());
      out(`      ${meta.pubkey.toBase58().padEnd(44)}  ${[label, flags].filter(Boolean).join(' · ')}`);
    }
  });
}

interface PlannedTx {
  label: string;
  tx: Transaction;
  /** Who signs, by role. */
  signers: ('payer' | 'config' | 'mint' | 'creator')[];
  /** It needs an earlier transaction on chain first (cannot be simulated in advance). */
  dependsOnPrevious: boolean;
}

async function buildLaunchTransactions(
  connection: Connection,
  plan: LaunchPlan,
  keys: LaunchKeys,
  reuseConfig: boolean,
): Promise<PlannedTx[]> {
  const client = dbcClient(connection);
  const { config: launch, curve } = plan;
  const configAccounts = {
    config: keys.config,
    feeClaimer: keys.partner,
    leftoverReceiver: keys.leftoverReceiver,
    quoteMint: NATIVE_MINT,
    payer: keys.payer,
    ...curve.config,
  };
  const poolParams = {
    baseMint: keys.mint,
    name: launch.name,
    symbol: launch.symbol,
    uri: launch.uri,
    poolCreator: keys.poolCreator,
  };
  const creatorSigns = !keys.poolCreator.equals(keys.payer);
  const poolSigners: PlannedTx['signers'] = creatorSigns ? ['payer', 'mint', 'creator'] : ['payer', 'mint'];
  const buyLamports = launch.initialBuySol ? toBaseUnits(launch.initialBuySol, 9) : 0n;
  const firstBuyParam =
    buyLamports > 0n
      ? {
          buyer: keys.poolCreator,
          buyAmount: new BN(buyLamports.toString()),
          minimumAmountOut: firstBuyMinimum(connection, plan, buyLamports),
          referralTokenAccount: null,
        }
      : undefined;

  if (reuseConfig) {
    const tx = firstBuyParam
      ? await client.creator.createPoolWithFirstBuy({
          createPoolParam: { ...poolParams, config: keys.config, payer: keys.payer },
          firstBuyParam,
        })
      : await client.creator.createPool({ ...poolParams, config: keys.config, payer: keys.payer });
    return [{ label: 'createPool', tx, signers: poolSigners, dependsOnPrevious: false }];
  }
  if (firstBuyParam) {
    const { createConfigTx, createPoolWithFirstBuyTx } = await client.partner.createConfigAndPoolWithFirstBuy({
      ...configAccounts,
      preCreatePoolParam: poolParams,
      firstBuyParam,
    });
    return [
      { label: 'createConfig', tx: createConfigTx, signers: ['payer', 'config'], dependsOnPrevious: false },
      { label: 'createPool', tx: createPoolWithFirstBuyTx, signers: poolSigners, dependsOnPrevious: true },
    ];
  }
  const combined = await client.partner.createConfigAndPool({ ...configAccounts, preCreatePoolParam: poolParams });
  if (transactionSize(combined, keys.payer) + 64 <= MAX_TX_BYTES) {
    const signers: PlannedTx['signers'] = creatorSigns
      ? ['payer', 'config', 'mint', 'creator']
      : ['payer', 'config', 'mint'];
    return [{ label: 'launch', tx: combined, signers, dependsOnPrevious: false }];
  }
  const createPool = await client.creator.createPool({ ...poolParams, config: keys.config, payer: keys.payer });
  return [
    {
      label: 'createConfig',
      tx: await client.partner.createConfig(configAccounts),
      signers: ['payer', 'config'],
      dependsOnPrevious: false,
    },
    { label: 'createPool', tx: createPool, signers: poolSigners, dependsOnPrevious: true },
  ];
}

/** The first buy executes at the curve's start: quote it on the planned config and allow 1%. */
function firstBuyMinimum(connection: Connection, plan: LaunchPlan, lamports: bigint): BN {
  const quote = dbcClient(connection).pool.getQuoteFromInputAmount({
    config: plan.curve.config,
    swapBaseForQuote: false,
    amountIn: new BN(lamports.toString()),
    swapMode: SwapMode.ExactIn,
    slippageBps: 100,
  });
  const out = BigInt(quote.outputAmount.toString());
  return new BN(((out * 99n) / 100n).toString());
}

// ── Pre-flight ──────────────────────────────────────────────────────────────────────────────────────

async function fetchMetadataJson(
  uri: string,
): Promise<{ ok: boolean; status?: number; json?: unknown; error?: string }> {
  try {
    const response = await fetch(uri, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { ok: false, status: response.status };
    return { ok: true, json: (await response.json()) as unknown };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function printChecks(checks: readonly PreflightCheck[]): void {
  out('Pre-flight');
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
  for (const check of checks) out(`  ${mark[check.status]}  ${check.name.padEnd(28)} ${check.detail}`);
}

// ── Verification ────────────────────────────────────────────────────────────────────────────────────

async function verifyLaunch(
  connection: Connection,
  plan: LaunchPlan,
  keys: LaunchKeys,
  pool: PublicKey,
): Promise<boolean> {
  const [state, mint, metadata] = await Promise.all([
    readLaunchPool({ connection, dbcPool: pool, dbcConfig: keys.config }),
    readTokenMint({ connection, mint: keys.mint }),
    readTokenMetadata({ connection, mint: keys.mint }),
  ]);
  const expectedCreator = keys.finalCreator ?? keys.poolCreator;
  const rows: [string, boolean, string][] = [
    ['pool exists', !!state, pool.toBase58()],
    ['partner = Epoch treasury PDA', state?.partner === keys.partner.toBase58(), state?.partner ?? '—'],
    ['leftover receiver', state?.leftoverReceiver === keys.leftoverReceiver.toBase58(), state?.leftoverReceiver ?? '—'],
    ['pool creator', state?.creator === expectedCreator.toBase58(), state?.creator ?? '—'],
    [
      'raise (migrationQuoteThreshold)',
      !!state && Math.abs(state.migrationThresholdSol - plan.curve.migrationThresholdSol) < 1e-9,
      `${state?.migrationThresholdSol ?? '—'} SOL`,
    ],
    [
      'migration fee 70%, creator 100%',
      state?.migrationFeePct === 70 && state?.creatorMigrationFeeSharePct === 100,
      `${state?.migrationFeePct}% / ${state?.creatorMigrationFeeSharePct}%`,
    ],
    [
      'DAMM v2 LP locked 100%',
      state?.liquidity.partnerLockedPct === 100,
      `partner ${state?.liquidity.partnerLockedPct}%`,
    ],
    ['fixed supply', mint?.uiSupply === plan.config.supply, `${mint?.uiSupply ?? '—'} tokens`],
    ['no mint authority', mint?.mintAuthority === null, String(mint?.mintAuthority ?? 'none')],
    ['no freeze authority', mint?.freezeAuthority === null, String(mint?.freezeAuthority ?? 'none')],
    [
      'metadata immutable',
      metadata?.locked === true && metadata?.isMutable === false,
      `is_mutable ${metadata?.isMutable}, update authority ${metadata?.updateAuthority ?? '—'}`,
    ],
    [
      'metadata name and symbol',
      metadata?.name === plan.config.name && metadata?.symbol === plan.config.symbol,
      `${metadata?.name} · ${metadata?.symbol}`,
    ],
  ];
  out('Verification');
  for (const [name, ok, detail] of rows) out(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(32)} ${detail}`);
  return rows.every(([, ok]) => ok);
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = readArgs(process.argv.slice(2));
  const env = process.env;
  const configPath = resolve(args.config);
  const launch = parseLaunchConfig(JSON.parse(readFileSync(configPath, 'utf8')) as unknown);
  const connection = new Connection(args.rpc, 'confirmed');

  out(`Epoch revenue-token launch on ${args.cluster}${args.execute ? '' : ' — DRY RUN: nothing is signed or sent'}`);
  out(`Config             ${configPath} · ${isoIst()}`);
  out(`RPC                ${new URL(args.rpc).host}`);
  if (args.cluster === 'mainnet') {
    out(
      'WARNING            MAINNET, REAL SOL. Revenue tokens can be securities: a public launch needs legal review and a',
    );
    out('                   region-restricted front end first (ADR 0006). Small size, no marketing.');
  }
  if (args.execute) {
    if (!env.LAUNCH_KEYPAIR_PATH) throw new Error('LAUNCH_KEYPAIR_PATH is not set: it names the payer keypair file');
    if (!args.programId) {
      throw new Error(
        "EPOCH_PROGRAM_ID (or --program-id) is not set: the fee claimer must be the Epoch program's treasury PDA",
      );
    }
    if (!args.registry) throw new Error('LAUNCHES_PATH (or --registry) is not set: the launch must be recorded');
  }

  // The Epoch program: its treasury PDA ["treasury", pool] is the fee claimer and the default leftover receiver.
  const program = args.programId ? epochProgramKeys(new PublicKey(args.programId)) : null;
  if (program) {
    const refusal = treasuryMismatch(env.EPOCH_TREASURY, program.treasury.toBase58());
    if (refusal) throw new Error(refusal);
  }

  // Keys (public keys only are printed; a dry run without keys uses placeholders).
  const placeholders: string[] = [];
  const placeholder = (name: string): PublicKey => {
    placeholders.push(name);
    return PublicKey.unique();
  };
  const payerKeypair = env.LAUNCH_KEYPAIR_PATH
    ? loadKeypairFile(env.LAUNCH_KEYPAIR_PATH, 'LAUNCH_KEYPAIR_PATH')
    : undefined;
  const creatorKeypair = env.LAUNCH_CREATOR_KEYPAIR_PATH
    ? loadKeypairFile(env.LAUNCH_CREATOR_KEYPAIR_PATH, 'LAUNCH_CREATOR_KEYPAIR_PATH')
    : undefined;
  const validatorWallet = launch.creator ? new PublicKey(launch.creator) : null;
  if (creatorKeypair && validatorWallet && !creatorKeypair.publicKey.equals(validatorWallet)) {
    throw new Error('LAUNCH_CREATOR_KEYPAIR_PATH does not hold the launch config\'s "creator" wallet');
  }
  const operatorKeypair = env.LAUNCH_OPERATOR_KEYPAIR_PATH
    ? loadKeypairFile(env.LAUNCH_OPERATOR_KEYPAIR_PATH, 'LAUNCH_OPERATOR_KEYPAIR_PATH')
    : undefined;
  const partner = program?.treasury ?? placeholder('partner');
  const leftoverReceiver = launch.leftoverReceiver
    ? new PublicKey(launch.leftoverReceiver)
    : env.LAUNCH_LEFTOVER_RECEIVER
      ? new PublicKey(env.LAUNCH_LEFTOVER_RECEIVER)
      : partner;
  const configSigner = args.configAccount ? undefined : Keypair.generate();
  const mintSigner = Keypair.generate();
  const payer = payerKeypair?.publicKey ?? placeholder('payer');
  const poolCreator = creatorKeypair?.publicKey ?? payer;
  const keys: LaunchKeys = {
    payer,
    partner,
    leftoverReceiver,
    config: args.configAccount ? new PublicKey(args.configAccount) : (configSigner as Keypair).publicKey,
    mint: mintSigner.publicKey,
    poolCreator,
    finalCreator: validatorWallet,
    placeholders,
  };
  if (!args.configAccount) placeholders.push('config');
  const pool = deriveDbcPoolAddress(NATIVE_MINT, keys.mint, keys.config);

  // 1. Revenue and the plan.
  const vote = launch.validator.vote ? new PublicKey(launch.validator.vote) : null;
  const programState = program ? await readEpochProgram(connection, program, vote) : null;
  const revenue = await readRevenue(args, launch);
  const epochInfo = await connection.getEpochInfo('confirmed');
  // The program starts the term with the epoch after registration (right after the launch).
  const startEpoch = programState ? programState.epoch + 1 : (launch.startEpoch ?? epochInfo.epoch + 1);
  const plan = planLaunch({ config: launch, avgRevenueSol: revenue.avgRevenueSol, startEpoch, cluster: args.cluster });
  out();
  out(`Validator          ${launch.validator.name} (vote ${launch.validator.vote ?? '—'})`);
  out(
    `Token              ${launch.symbol} · ${launch.name} · ${launch.supply.toLocaleString('en-US')} tokens · ${launch.decimals} decimals · ${launch.uri}`,
  );
  out(`Share              ${launch.shareBps / 100}% of gross revenue for ${launch.termEpochs} epochs`);
  out(
    program
      ? `Epoch program      ${program.programId.toBase58()} · Pool ${program.pool.toBase58()} · treasury PDA ${program.treasury.toBase58()} (fee claimer${leftoverReceiver.equals(program.treasury) ? ' and leftover receiver' : ''})`
      : 'Epoch program      not set (EPOCH_PROGRAM_ID): the fee claimer is a placeholder',
  );
  for (const line of revenue.lines) out(line);
  for (const line of launchPlanLines(plan)) out(line);
  if (launch.initialBuySol)
    out(
      `Initial buy        ${launch.initialBuySol} SOL by the pool creator (${poolCreator.equals(payer) ? 'the payer' : 'the validator'}), in the pool's creation transaction`,
    );
  out(
    `Creator role       ${validatorWallet ? `${validatorWallet.toBase58()} (the validator)${poolCreator.equals(payer) ? ': handed over after the launch (transferPoolCreator)' : ': co-signs as pool creator'}` : 'stays with the payer (no "creator" in the config)'}`,
  );

  // 2. Transactions.
  const reuseConfig = !!args.configAccount;
  const planned = await buildLaunchTransactions(connection, plan, keys, reuseConfig);
  const handOver = validatorWallet && !validatorWallet.equals(poolCreator);
  const labels = accountLabels(keys, pool);
  out();
  out('Accounts');
  for (const [address, label] of labels) out(`  ${address.padEnd(44)}  ${label}`);
  out();
  for (const step of planned) {
    withPriorityFee(step.tx, args.priorityMicroLamports);
    printTransaction(`Transaction "${step.label}"`, step.tx, transactionSize(step.tx, keys.payer), labels);
  }
  if (handOver)
    out(
      `Transaction "transferCreator": DBC transferPoolCreator ${poolCreator.toBase58()} → ${validatorWallet.toBase58()}`,
    );
  out();
  out('DBC config parameters (createConfig)');
  out(JSON.stringify(printable(plan.curve.config)));

  // The registration: register_revenue_token, signed by the validator's operator once the pool exists.
  const operator =
    operatorKeypair?.publicKey ?? (programState?.position ? new PublicKey(programState.position.operator) : null);
  const registration =
    program && vote && operator
      ? planRegistration({
          keys: program,
          operator,
          vote,
          mint: keys.mint,
          dbcPool: pool,
          dbcConfig: keys.config,
          shareBps: launch.shareBps,
          termEpochs: launch.termEpochs,
        })
      : null;
  out();
  printRegistrationPlan({
    program,
    programState,
    registration,
    operatorKeypairLoaded: !!operatorKeypair,
    args,
    launch,
  });

  // 3. Pre-flight.
  out();
  const [genesis, programs, registry] = await Promise.all([
    connection.getGenesisHash(),
    connection.getMultipleAccountsInfo([
      DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      DAMM_V2_PROGRAM_ID,
      METAPLEX_PROGRAM_ID,
      DAMM_V2_MIGRATION_FEE_ADDRESS[plan.curve.config.migrationFeeOption],
      deriveDbcPoolAuthority(),
      keys.config,
      keys.mint,
    ]),
    Promise.resolve(args.registry ? readRegistryFile(args.registry) : []),
  ]);
  const [dbcProgram, dammProgram, metaplexProgram, dammConfig, poolAuthority, configAccount, mintAccount] = programs;
  const signatureCount = planned.reduce((sum, step) => sum + step.signers.length, 0) + (handOver ? 1 : 0);
  const cost = estimateLaunchCost({
    newConfig: !reuseConfig,
    signatures: signatureCount,
    transactions: planned.length + (handOver ? 1 : 0),
    priorityFeeLamports: Math.ceil((args.priorityMicroLamports * 400_000) / 1_000_000),
    initialBuyLamports: launch.initialBuySol ? Number(toBaseUnits(launch.initialBuySol, 9)) : 0,
  });
  const balance = payerKeypair ? await connection.getBalance(payer, 'confirmed') : null;
  const checks: PreflightCheck[] = [
    checkCluster(args.cluster, genesis, args.allowUnknownGenesis),
    checkProgram('DBC', dbcProgram),
    checkProgram('DAMM v2', dammProgram),
    checkProgram('Metaplex', metaplexProgram),
    checkAccount(
      'DAMM v2 migration config',
      !!dammConfig,
      `${DAMM_V2_MIGRATION_FEE_ADDRESS[plan.curve.config.migrationFeeOption].toBase58()} is missing: graduation would fail`,
    ),
    (poolAuthority?.lamports ?? 0) > 0
      ? {
          name: 'DBC pool authority',
          status: 'pass',
          detail: `holds ${formatSol(poolAuthority?.lamports ?? 0)} (it fronts the DAMM v2 rent at graduation)`,
        }
      : {
          name: 'DBC pool authority',
          status: 'fail',
          detail: "holds no SOL: migration to DAMM v2 would fail (it fronts the new pool's rent)",
        },
    ...programChecks({
      program,
      programState,
      launch,
      cluster: args.cluster,
      leftoverReceiver,
      operatorKey: operatorKeypair?.publicKey ?? null,
    }),
    ...checkRegistry(registry, {
      symbol: launch.symbol,
      vote: launch.validator.vote,
      cluster: args.cluster,
      currentEpoch: epochInfo.epoch,
    }),
    reuseConfig
      ? checkExistingConfig(
          configAccount ? await dbcClient(connection).state.getPoolConfig(keys.config) : null,
          plan.curve.config,
          { feeClaimer: partner.toBase58(), leftoverReceiver: leftoverReceiver.toBase58() },
        )
      : {
          name: 'DBC config',
          status: configAccount ? 'fail' : 'pass',
          detail: configAccount ? 'the fresh config address is taken' : `new account ${keys.config.toBase58()}`,
        },
    ...(reuseConfig ? [await checkPoolsOfConfig(connection, keys.config)] : []),
    {
      name: 'Token mint',
      status: mintAccount ? 'fail' : 'pass',
      detail: mintAccount ? 'the fresh mint address is taken' : `new account ${keys.mint.toBase58()}`,
    },
    checkInitialBuy(launch.initialBuySol, plan.curve.migrationThresholdSol),
    args.skipUriCheck
      ? {
          name: 'Metadata URI',
          status: args.cluster === 'mainnet' ? 'fail' : 'warn',
          detail: 'not checked (--skip-uri-check)',
        }
      : checkMetadataJson(await fetchMetadataJson(launch.uri), {
          name: launch.name,
          symbol: launch.symbol,
          cluster: args.cluster,
        }),
    checkPayerBalance(balance, cost.totalLamports),
  ];
  if (args.cluster === 'mainnet' && launch.validator.vote) {
    const voteInfo = await connection.getAccountInfo(new PublicKey(launch.validator.vote));
    checks.push(
      voteInfo?.owner.toBase58() === 'Vote111111111111111111111111111111111111111'
        ? { name: 'Vote account', status: 'pass', detail: `${launch.validator.vote} is a vote account` }
        : { name: 'Vote account', status: 'fail', detail: `${launch.validator.vote} is not a mainnet vote account` },
    );
  }
  if (args.cluster === 'mainnet' && !validatorWallet) {
    checks.push({
      name: 'Creator',
      status: 'warn',
      detail: 'no "creator" wallet: the 70% at graduation goes to the payer',
    });
  }
  // Simulate what can be simulated now (a pool after a new config needs the config on chain first).
  if (payerKeypair && balance !== null && balance > 0) {
    for (const step of planned) {
      if (step.dependsOnPrevious) {
        checks.push({
          name: `Simulation: ${step.label}`,
          status: 'warn',
          detail: 'needs the previous transaction on chain; simulated at send time',
        });
        continue;
      }
      const result = await simulate(connection, step.tx, payer);
      const spent = result.payerLamportsAfter !== null ? balance - result.payerLamportsAfter : null;
      checks.push(
        result.ok
          ? {
              name: `Simulation: ${step.label}`,
              status: 'pass',
              detail: `ok, ${result.unitsConsumed} compute units${spent !== null ? `, payer spends ${formatSol(spent)} (fees included)` : ''}`,
            }
          : {
              name: `Simulation: ${step.label}`,
              status: 'fail',
              detail: `${result.error}; ${result.logs.slice(-3).join(' | ')}`,
            },
      );
    }
  }
  out('Cost (estimate)');
  for (const item of cost.items) out(`  ${item.label.padEnd(46)} ${formatSol(item.lamports)}`);
  out(`  ${'Total'.padEnd(46)} ${formatSol(cost.totalLamports)}`);
  out(
    `  ${'Registration rent (the operator pays)'.padEnd(46)} ${formatSol(REGISTRATION_RENT_LAMPORTS)} (returned by close_revenue_token after the term)`,
  );
  out();
  printChecks(checks);
  const summary = summarizePreflight(checks);

  if (!args.execute) {
    out();
    out(
      summary.ok
        ? 'Dry run: every check passed; add --execute to launch.'
        : `Dry run: ${summary.failures.length} check(s) failed.`,
    );
    out('Nothing was signed or sent.');
    if (!summary.ok) process.exitCode = 1;
    return;
  }
  if (!summary.ok) throw new Error(`pre-flight failed: ${summary.failures.map((check) => check.name).join(', ')}`);
  if (!payerKeypair || !args.registry) throw new Error('missing payer or registry');

  // 4. Confirm, send, verify, record.
  if (!args.yes) {
    out();
    const answer = await ask(`Type the symbol (${launch.symbol}) to launch on ${args.cluster.toUpperCase()}: `);
    if (answer !== launch.symbol) throw new Error('confirmation did not match the symbol: nothing was sent');
  }
  out();
  const signerFor = { payer: payerKeypair, config: configSigner, mint: mintSigner, creator: creatorKeypair } as const;
  const signatures: Record<string, string> = {};
  for (const step of planned) {
    const signers = step.signers.map((role) => {
      const signer = signerFor[role];
      if (!signer) throw new Error(`no ${role} key for ${step.label}`);
      return signer;
    });
    signatures[step.label] = await sendLabelled({
      connection,
      tx: step.tx,
      signers,
      label: step.label,
      cluster: args.cluster,
      rpc: args.rpc,
    });
  }
  if (handOver && validatorWallet) {
    const transfer = await dbcClient(connection).creator.transferPoolCreator({
      pool,
      creator: poolCreator,
      newCreator: validatorWallet,
    });
    withPriorityFee(transfer, args.priorityMicroLamports);
    signatures.transferCreator = await sendLabelled({
      connection,
      tx: transfer,
      signers: [payerKeypair],
      label: 'transferCreator',
      cluster: args.cluster,
      rpc: args.rpc,
    });
  }

  const record = launchRecordFor(plan, {
    mint: keys.mint.toBase58(),
    dbcPool: pool.toBase58(),
    dbcConfig: keys.config.toBase58(),
    creator: (validatorWallet ?? poolCreator).toBase58(),
    feeClaimer: partner.toBase58(),
    leftoverReceiver: leftoverReceiver.toBase58(),
    signatures,
    launchedAt: isoIst(),
    ...(program && vote
      ? {
          program: {
            programId: program.programId.toBase58(),
            revenueToken: revenueTokenAccounts(program, vote).revenueToken.toBase58(),
            escrow: revenueTokenAccounts(program, vote).escrow.toBase58(),
          },
        }
      : {}),
  });
  try {
    writeRegistryFile(args.registry, appendRegistryEntry(readRegistryFile(args.registry), record));
    out(`Launch record      appended to ${args.registry}`);
  } catch (error) {
    err(
      `Could not write the launch record (${error instanceof Error ? error.message : String(error)}); add it by hand:`,
    );
  }
  out(JSON.stringify(record, null, 2));
  out();
  out(`Pool               ${explorer('address', pool.toBase58(), args.cluster, args.rpc)}`);
  out(`Mint               ${explorer('address', keys.mint.toBase58(), args.cluster, args.rpc)}`);
  out();
  const verified = await verifyLaunch(connection, plan, keys, pool);

  // 5. Register the token with the program (the operator signs), or say exactly how.
  out();
  if (
    registration &&
    operatorKeypair &&
    program &&
    programState &&
    registrationReady(programState, operatorKeypair.publicKey)
  ) {
    try {
      const signature = await sendLabelled({
        connection,
        tx: withPriorityFee(registrationTransaction(registration), args.priorityMicroLamports),
        signers: [operatorKeypair],
        label: 'registerRevenueToken',
        cluster: args.cluster,
        rpc: args.rpc,
      });
      signatures.registerRevenueToken = signature;
      const registered = await readRegistered(connection, registration.revenueToken);
      if (registered) {
        const updated = withRegistration(record, {
          programId: program.programId.toBase58(),
          revenueToken: registration.revenueToken.toBase58(),
          escrow: registration.escrow.toBase58(),
          epoch: Number(registered.registeredEpoch),
          startEpoch: Number(registered.startEpoch),
          signature,
        });
        replaceRegistryEntry(args.registry, updated);
        out(`Registered         ${explorer('address', registration.revenueToken.toBase58(), args.cluster, args.rpc)}`);
        out(
          `Term               epochs ${registered.startEpoch}–${registered.termEndEpoch - 1n} (registered in ${registered.registeredEpoch}); the launch record is updated`,
        );
      }
    } catch (error) {
      err(
        `Registration failed (${error instanceof Error ? error.message : String(error)}): the token is launched but not registered. Run:`,
      );
      err(registerCommand(args, launch));
      process.exitCode = 1;
    }
  } else {
    out('Registration       not sent by this run: the validator\'s operator signs it (see "Registration" above):');
    out(`  ${registerCommand(args, launch)}`);
  }
  out();
  out('Waiting for finalization …');
  const pending = await waitFinalized(connection, Object.values(signatures));
  out(
    pending.length === 0
      ? 'Finalized          every launch transaction'
      : `Not finalized yet  ${pending.join(', ')} (check the explorer)`,
  );
  if (!verified) process.exitCode = 1;
}

// ── The Epoch program ───────────────────────────────────────────────────────────────────────────────

/** The program's side of the pre-flight: deployed, its Pool, the treasury PDA, the terms, the validator's position. */
function programChecks(input: {
  program: EpochProgramKeys | null;
  programState: EpochProgramRead | null;
  launch: LaunchConfigInput;
  cluster: LaunchCluster;
  leftoverReceiver: PublicKey;
  operatorKey: PublicKey | null;
}): PreflightCheck[] {
  const { program, programState, launch } = input;
  if (!program || !programState) {
    return [
      {
        name: 'Epoch program',
        status: 'fail',
        detail: "EPOCH_PROGRAM_ID (or --program-id) is not set: the fee claimer must be the program's treasury PDA",
      },
    ];
  }
  const checks: PreflightCheck[] = [
    checkProgram('Epoch', programState.program),
    checkEpochPool(programState.pool),
    {
      name: 'Partner (treasury PDA)',
      status: 'pass',
      detail: `${program.treasury.toBase58()} = ["treasury", pool]: the fee claimer register_revenue_token requires`,
    },
    checkLeftoverReceiver(input.leftoverReceiver.toBase58(), program.treasury.toBase58()),
    checkRevenueTokenTerms(launch, REVENUE_TOKEN_LIMITS),
    ...checkValidatorPosition(programState.position, {
      cluster: input.cluster,
      vote: launch.validator.vote,
      operatorKey: input.operatorKey?.toBase58() ?? null,
    }),
    checkStartEpoch(launch.startEpoch, programState.epoch + 1),
  ];
  if (programState.revenueToken) {
    checks.push({
      name: 'RevenueToken',
      status: 'fail',
      detail: `the vote account already has a revenue token (mint ${programState.revenueToken.account.mint.toBase58()}): one per vote account`,
    });
  }
  return checks;
}

/** The position can register now with this operator key (the program's own checks, read before sending). */
function registrationReady(state: EpochProgramRead, operator: PublicKey): boolean {
  const position = state.position;
  return (
    !!position &&
    position.status === 'active' &&
    !position.revenueToken &&
    position.authorityHeld &&
    position.operator === operator.toBase58() &&
    !state.revenueToken &&
    state.pool.exists &&
    state.pool.paused === false
  );
}

/** The command the validator's operator runs to register the token with its own key. */
function registerCommand(args: Args, launch: LaunchConfigInput): string {
  const flags = [
    `--symbol ${launch.symbol}`,
    `--cluster ${args.cluster}`,
    args.rpc !== DEFAULT_RPC[args.cluster] ? `--rpc ${args.rpc}` : '',
    args.allowUnknownGenesis ? '--allow-unknown-genesis' : '',
    '--execute',
  ].filter(Boolean);
  return `LAUNCH_OPERATOR_KEYPAIR_PATH=<operator keypair> EPOCH_PROGRAM_ID=${args.programId ?? '<program id>'} LAUNCHES_PATH=${args.registry ?? '<registry>'} pnpm --filter @epoch/meteora register -- ${flags.join(' ')}`;
}

/** How the token gets registered: sent by this run, or what the operator signs (every account and the data). */
function printRegistrationPlan(input: {
  program: EpochProgramKeys | null;
  programState: EpochProgramRead | null;
  registration: RegistrationPlan | null;
  operatorKeypairLoaded: boolean;
  args: Args;
  launch: LaunchConfigInput;
}): void {
  const { program, programState, registration, args, launch } = input;
  if (!program || !programState) {
    out('Registration       needs EPOCH_PROGRAM_ID: register_revenue_token is the program instruction that makes the');
    out('                   share and the buybacks binding.');
    return;
  }
  if (!registration) {
    out(
      `Registration       not possible yet: ${launch.validator.vote ? `${launch.validator.vote} is not onboarded with Epoch (no position, so no operator)` : 'no validator.vote in the launch config'}.`,
    );
    out(`                   After onboarding, the operator runs: ${registerCommand(args, launch)}`);
    return;
  }
  out(
    input.operatorKeypairLoaded
      ? `Registration       sent after the launch: register_revenue_token(${launch.shareBps}, ${launch.termEpochs}) signed by the operator ${registration.operator.toBase58()} (LAUNCH_OPERATOR_KEYPAIR_PATH)`
      : `Registration       the validator's operator ${registration.operator.toBase58()} signs register_revenue_token(${launch.shareBps}, ${launch.termEpochs}) after the launch:`,
  );
  out(
    `                   rent ${formatSol(REGISTRATION_RENT_LAMPORTS)} from the operator; the term starts with epoch ${programState.epoch + 1} if registered in epoch ${programState.epoch}`,
  );
  for (const line of registrationLines(registration, registrationLabels(registration, program))) out(line);
}

/**
 * A config reused after a partly finished launch (`--config-account`) may already have its pool: a send that timed out
 * can still land. One config per launch, so any pool means this launch happened; never create a second token.
 */
async function checkPoolsOfConfig(connection: Connection, config: PublicKey): Promise<PreflightCheck> {
  try {
    const pools = await dbcClient(connection).state.getPoolsByConfig(config);
    return pools.length === 0
      ? { name: 'Pools of the config', status: 'pass', detail: 'none yet' }
      : {
          name: 'Pools of the config',
          status: 'fail',
          detail: `${pools.map((entry) => entry.publicKey.toBase58()).join(', ')} already use it: the launch happened (add its record by hand)`,
        };
  } catch (error) {
    return {
      name: 'Pools of the config',
      status: 'warn',
      detail: `could not list them (${error instanceof Error ? error.message : String(error)}): check the explorer first`,
    };
  }
}

main().catch((error: unknown) => {
  if (error instanceof LaunchConfigError) {
    err(`Invalid launch config:\n${error.problems.map((p) => `  - ${p}`).join('\n')}`);
  } else {
    err(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
