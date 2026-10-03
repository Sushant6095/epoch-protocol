/**
 * Reads a launch's Meteora pools: the Dynamic Bonding Curve pool and its config while the token is on the curve, and
 * the DAMM v2 pool it graduates to. Each read returns plain numbers in UI units next to the raw addresses.
 */
import { CpAmm, type PoolState as DammPoolAccount } from '@meteora-ag/cp-amm-sdk';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  DynamicBondingCurveClient,
  type PoolConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { type Connection, PublicKey } from '@solana/web3.js';

import { NATIVE_MINT, SOL_DECIMALS } from './constants';
import { sqrtPriceX64ToPrice } from './curve';
import { decodeMintAccount } from './token';
import { fromBaseUnits, toBigInt } from './units';

/** DBC fee numerators are out of 1e9. */
const FEE_DENOMINATOR = 1_000_000_000;

const dbcClients = new WeakMap<Connection, DynamicBondingCurveClient>();
const cpAmmClients = new WeakMap<Connection, CpAmm>();

/** One DBC client per connection (each builds five Anchor programs). */
export function dbcClient(connection: Connection): DynamicBondingCurveClient {
  let client = dbcClients.get(connection);
  if (!client) {
    client = DynamicBondingCurveClient.create(connection, 'confirmed');
    dbcClients.set(connection, client);
  }
  return client;
}

/** One DAMM v2 client per connection. */
export function cpAmmClient(connection: Connection): CpAmm {
  let client = cpAmmClients.get(connection);
  if (!client) {
    client = new CpAmm(connection);
    cpAmmClients.set(connection, client);
  }
  return client;
}

/** DBC `migration_progress`. */
export const MIGRATION_PROGRESS = ['preBondingCurve', 'postBondingCurve', 'lockedVesting', 'createdPool'] as const;
export type MigrationProgress = (typeof MIGRATION_PROGRESS)[number] | 'unknown';

/** A launch's bonding curve: the DBC pool and its config, in UI units. */
export interface LaunchPoolState {
  dbcPool: string;
  config: string;
  baseMint: string;
  quoteMint: string;
  baseVault: string;
  quoteVault: string;
  creator: string;
  /** The config's fee claimer: the DBC partner (Epoch's treasury). */
  partner: string;
  leftoverReceiver: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** Tokens still in the curve's vault (unsold, the DAMM v2 seed and any leftover). */
  baseReserve: number;
  /** Quote raised so far, SOL. */
  quoteReserveSol: number;
  /** Current price, SOL per token. */
  priceSol: number;
  /** The curve's start price (its band low), SOL per token. */
  startPriceSol: number;
  /** The migration price (its band high), SOL per token. */
  migrationPriceSol: number;
  /** quoteReserve ÷ migrationQuoteThreshold, 0–100: `getPoolQuoteTokenCurveProgress` × 100. */
  curveProgressPct: number;
  /** DBC `migrationQuoteThreshold`: the raise that graduates the token, SOL. */
  migrationThresholdSol: number;
  /** The raise is complete; trading on the curve has stopped. */
  curveComplete: boolean;
  migrated: boolean;
  migrationProgress: MigrationProgress;
  /** The DAMM v2 pool the curve graduated to (derived from the config's migration fee option); null before. */
  dammPool: string | null;
  /** Unix seconds when the curve completed, or null. */
  finishCurveTime: number | null;
  /** % of the raise taken as the migration fee, and the creator's % of that fee. */
  migrationFeePct: number;
  creatorMigrationFeeSharePct: number;
  /** DAMM v2 LP split at graduation, %. */
  liquidity: { partnerLockedPct: number; creatorLockedPct: number; partnerPct: number; creatorPct: number };
  /** DBC `TokenAuthorityOption`: 1 = immutable (no update or mint authority). */
  tokenUpdateAuthority: number;
  fees: {
    /** The curve's base (cliff) trading fee, bps. */
    tradingFeeBps: number;
    creatorTradingFeePct: number;
    /** Lifetime trading fees in SOL (quote side), split like `getPoolFeeBreakdown`. */
    partnerTotalSol: number;
    partnerUnclaimedSol: number;
    creatorTotalSol: number;
    totalTradingSol: number;
  };
  /** Fixed-supply configs: supply before and after migration, UI units. */
  supply: { preMigration: number; postMigration: number } | null;
  activationType: 'slot' | 'timestamp';
  activationPoint: number;
}

const ratio = (part: bigint, whole: bigint): number => (whole === 0n ? 0 : Number((part * 1_000_000n) / whole) / 1e6);

/**
 * The DAMM v2 pool a migrated DBC pool graduated to: derived from the DAMM v2 config of the DBC config's migration fee
 * option (`DAMM_V2_MIGRATION_FEE_ADDRESS`), as DBC's `migrateToDammV2` does. Null before migration.
 */
export function graduatedDammPool(pool: VirtualPool, config: PoolConfig): PublicKey | null {
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (pool.poolState.isMigrated !== 1 || !dammConfig) return null;
  return deriveDammV2PoolAddress(dammConfig, pool.poolState.baseMint, config.quoteMint);
}

/**
 * Maps a DBC pool and its config to `LaunchPoolState` (pure). `quoteDecimals` is 9 for SOL-quoted launches.
 */
export function mapLaunchPool(
  dbcPool: string,
  pool: VirtualPool,
  config: PoolConfig,
  quoteDecimals = SOL_DECIMALS,
): LaunchPoolState {
  const state = pool.poolState;
  const baseDecimals = config.tokenDecimal;
  const quoteReserve = toBigInt(state.quoteReserve);
  const threshold = toBigInt(config.migrationQuoteThreshold);
  const migrated = state.isMigrated === 1;
  const totalTradingQuote = toBigInt(state.metrics.totalTradingQuoteFee);
  const creatorTotal = (totalTradingQuote * BigInt(config.creatorTradingFeePercentage)) / 100n;
  const quoteUnits = (value: bigint) => fromBaseUnits(value, quoteDecimals);
  const finish = Number(state.finishCurveTimestamp.toString());
  return {
    dbcPool,
    config: state.config.toBase58(),
    baseMint: state.baseMint.toBase58(),
    quoteMint: config.quoteMint.toBase58(),
    baseVault: state.baseVault.toBase58(),
    quoteVault: state.quoteVault.toBase58(),
    creator: state.creator.toBase58(),
    partner: config.feeClaimer.toBase58(),
    leftoverReceiver: config.leftoverReceiver.toBase58(),
    baseDecimals,
    quoteDecimals,
    baseReserve: fromBaseUnits(state.baseReserve, baseDecimals),
    quoteReserveSol: quoteUnits(quoteReserve),
    priceSol: sqrtPriceX64ToPrice(state.sqrtPrice, baseDecimals, quoteDecimals),
    startPriceSol: sqrtPriceX64ToPrice(config.sqrtStartPrice, baseDecimals, quoteDecimals),
    migrationPriceSol: sqrtPriceX64ToPrice(config.migrationSqrtPrice, baseDecimals, quoteDecimals),
    curveProgressPct: Math.min(1, Math.max(0, ratio(quoteReserve, threshold))) * 100,
    migrationThresholdSol: quoteUnits(threshold),
    curveComplete: migrated || state.migrationProgress > 0 || (threshold > 0n && quoteReserve >= threshold),
    migrated,
    migrationProgress: MIGRATION_PROGRESS[state.migrationProgress] ?? 'unknown',
    dammPool: graduatedDammPool(pool, config)?.toBase58() ?? null,
    finishCurveTime: finish > 0 ? finish : null,
    migrationFeePct: config.migrationFeePercentage,
    creatorMigrationFeeSharePct: config.creatorMigrationFeePercentage,
    liquidity: {
      partnerLockedPct: config.partnerPermanentLockedLiquidityPercentage,
      creatorLockedPct: config.creatorPermanentLockedLiquidityPercentage,
      partnerPct: config.partnerLiquidityPercentage,
      creatorPct: config.creatorLiquidityPercentage,
    },
    tokenUpdateAuthority: config.tokenUpdateAuthority,
    fees: {
      tradingFeeBps: (Number(config.poolFees.baseFee.cliffFeeNumerator.toString()) / FEE_DENOMINATOR) * 10_000,
      creatorTradingFeePct: config.creatorTradingFeePercentage,
      partnerTotalSol: quoteUnits(totalTradingQuote - creatorTotal),
      partnerUnclaimedSol: quoteUnits(toBigInt(state.partnerQuoteFee)),
      creatorTotalSol: quoteUnits(creatorTotal),
      totalTradingSol: quoteUnits(totalTradingQuote),
    },
    supply:
      config.fixedTokenSupplyFlag === 1
        ? {
            preMigration: fromBaseUnits(config.preMigrationTokenSupply, baseDecimals),
            postMigration: fromBaseUnits(config.postMigrationTokenSupply, baseDecimals),
          }
        : null,
    activationType: config.activationType === 0 ? 'slot' : 'timestamp',
    activationPoint: Number(state.activationPoint.toString()),
  };
}

/**
 * Reads a launch's DBC pool and its config (two RPC reads; one round trip when `dbcConfig` is known). Returns null
 * when the pool account does not exist (not launched yet).
 */
export async function readLaunchPool(params: {
  connection: Connection;
  dbcPool: PublicKey | string;
  dbcConfig?: PublicKey | string | null;
}): Promise<LaunchPoolState | null> {
  const { connection } = params;
  const accounts = await readCurveAccounts(connection, params.dbcPool, params.dbcConfig);
  if (!accounts) return null;
  const { address, pool, config } = accounts;
  const quoteDecimals = config.quoteMint.equals(NATIVE_MINT)
    ? SOL_DECIMALS
    : await readDecimals(connection, config.quoteMint);
  return mapLaunchPool(address.toBase58(), pool, config, quoteDecimals);
}

/**
 * A DBC pool and its config through the SDK's state service. The config is read in parallel when `dbcConfig` is given
 * (and re-read if the pool names another one). Null when the pool does not exist.
 */
export async function readCurveAccounts(
  connection: Connection,
  dbcPool: PublicKey | string,
  dbcConfig?: PublicKey | string | null,
): Promise<{ address: PublicKey; pool: VirtualPool; config: PoolConfig } | null> {
  const client = dbcClient(connection);
  const address = new PublicKey(dbcPool);
  const hint = dbcConfig ? new PublicKey(dbcConfig) : null;
  const [pool, hinted] = await Promise.all([
    client.state.getPool(address),
    hint ? client.state.getPoolConfig(hint) : Promise.resolve(null),
  ]);
  if (!pool) return null;
  const config =
    hinted && hint?.equals(pool.poolState.config) ? hinted : await client.state.getPoolConfig(pool.poolState.config);
  if (!config) throw new Error(`DBC config ${pool.poolState.config.toBase58()} not found`);
  return { address, pool, config };
}

async function readDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const account = await connection.getAccountInfo(mint, 'confirmed');
  if (!account) throw new Error(`mint ${mint.toBase58()} not found`);
  return decodeMintAccount(account.data).decimals;
}

/** A DAMM v2 pool, oriented as revenue token (base) against SOL (quote). */
export interface DammPoolState {
  pool: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** Whether the base token is the pool's token A (DBC graduations put the launched token in A). */
  baseIsTokenA: boolean;
  tokenAMint: string;
  tokenBMint: string;
  tokenAVault: string;
  tokenBVault: string;
  /** Current price, SOL per token. */
  priceSol: number;
  /** Vault balances, UI units (they include fees not yet claimed). */
  baseReserve: number;
  quoteReserveSol: number;
  liquidity: string;
  /** Trading is enabled (pool status) — the activation point is checked when quoting. */
  enabled: boolean;
  activationType: 'slot' | 'timestamp';
  activationPoint: number;
}

const amountOfTokenAccount = (data: Uint8Array): bigint =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);

/** Maps a DAMM v2 pool account plus its vault balances and mint decimals to `DammPoolState` (pure). */
export function mapDammPool(
  pool: string,
  state: DammPoolAccount,
  reads: { vaultA: bigint; vaultB: bigint; decimalsA: number; decimalsB: number },
): DammPoolState {
  const baseIsTokenA = !state.tokenAMint.equals(NATIVE_MINT) || state.tokenBMint.equals(NATIVE_MINT);
  const priceAinB = sqrtPriceX64ToPrice(state.sqrtPrice, reads.decimalsA, reads.decimalsB);
  const [baseMint, quoteMint] = baseIsTokenA
    ? [state.tokenAMint, state.tokenBMint]
    : [state.tokenBMint, state.tokenAMint];
  const [baseDecimals, quoteDecimals] = baseIsTokenA
    ? [reads.decimalsA, reads.decimalsB]
    : [reads.decimalsB, reads.decimalsA];
  const [baseVaultAmount, quoteVaultAmount] = baseIsTokenA
    ? [reads.vaultA, reads.vaultB]
    : [reads.vaultB, reads.vaultA];
  return {
    pool,
    baseMint: baseMint.toBase58(),
    quoteMint: quoteMint.toBase58(),
    baseDecimals,
    quoteDecimals,
    baseIsTokenA,
    tokenAMint: state.tokenAMint.toBase58(),
    tokenBMint: state.tokenBMint.toBase58(),
    tokenAVault: state.tokenAVault.toBase58(),
    tokenBVault: state.tokenBVault.toBase58(),
    priceSol: baseIsTokenA ? priceAinB : priceAinB > 0 ? 1 / priceAinB : 0,
    baseReserve: fromBaseUnits(baseVaultAmount, baseDecimals),
    quoteReserveSol: fromBaseUnits(quoteVaultAmount, quoteDecimals),
    liquidity: state.liquidity.toString(),
    enabled: state.poolStatus === 0,
    activationType: state.activationType === 0 ? 'slot' : 'timestamp',
    activationPoint: Number(state.activationPoint.toString()),
  };
}

/** Reads the DAMM v2 pool account (cp-amm SDK). Null when it does not exist. */
export async function readDammPoolAccount(connection: Connection, pool: PublicKey): Promise<DammPoolAccount | null> {
  try {
    return await cpAmmClient(connection).fetchPoolState(pool);
  } catch (error) {
    if ((await connection.getAccountInfo(pool, 'confirmed')) === null) return null;
    throw error;
  }
}

/**
 * Reads a DAMM v2 pool: price and reserves (the pool account, then its two vaults and two mints in one call). Null
 * when the pool does not exist.
 */
export async function readDammPool(params: {
  connection: Connection;
  pool: PublicKey | string;
}): Promise<DammPoolState | null> {
  const { connection } = params;
  const pool = new PublicKey(params.pool);
  const state = await readDammPoolAccount(connection, pool);
  if (!state) return null;
  const [vaultA, vaultB, mintA, mintB] = await connection.getMultipleAccountsInfo(
    [state.tokenAVault, state.tokenBVault, state.tokenAMint, state.tokenBMint],
    'confirmed',
  );
  if (!vaultA || !vaultB || !mintA || !mintB)
    throw new Error(`DAMM v2 pool ${pool.toBase58()}: a vault or mint is missing`);
  return mapDammPool(pool.toBase58(), state, {
    vaultA: amountOfTokenAccount(vaultA.data),
    vaultB: amountOfTokenAccount(vaultB.data),
    decimalsA: decodeMintAccount(mintA.data).decimals,
    decimalsB: decodeMintAccount(mintB.data).decimals,
  });
}
