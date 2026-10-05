/**
 * Buyback quotes for the revenue-token crank (`execute_buyback`, ADR 0006): what spending exactly `lamportsIn` SOL on
 * the token's venue returns, in base units, with the pool fee — DBC `swapQuote2` in partial-fill mode while the token
 * is on its curve, DAMM v2 `getQuote2` once it graduated — and the venue's raw state, field for field what the program
 * reads to compute its own min-out floor (`BuybackVenueState` / `planBuybackSlice` in @epoch/epoch-sdk).
 */
import {
  type ActivationType as DammActivationType,
  getCurrentPoint as getDammCurrentPoint,
  type PoolState as DammPoolAccount,
  SwapMode as DammSwapMode,
} from '@meteora-ag/cp-amm-sdk';
import {
  type ActivationType,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  getCurrentPoint,
  type PoolConfig,
  SwapMode,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type BN from 'bn.js';
import { type Connection, PublicKey } from '@solana/web3.js';

import { BPS_DENOMINATOR, NATIVE_MINT, SOL_DECIMALS } from './constants';
import { cpAmmClient, dbcClient, readCurveAccounts, readDammPoolAccount } from './pools';
import { toBigInt, toBN } from './units';

/** Where a buyback slice swaps: the DBC curve, or the DAMM v2 pool the token graduated to. */
export type BuybackVenueKind = 'dbc' | 'dammV2';

/** A venue's accounts as the Meteora SDKs decode them. */
export type BuybackVenueAccounts =
  | { kind: 'dbc'; address: PublicKey; pool: VirtualPool; config: PoolConfig }
  | { kind: 'dammV2'; address: PublicKey; pool: DammPoolAccount };

/** One DBC curve segment (Q64.64 sqrt price, liquidity). */
export interface RawCurvePoint {
  sqrtPrice: bigint;
  liquidity: bigint;
}

/**
 * The raw state `execute_buyback` reads, structurally identical to `BuybackVenueState` in @epoch/epoch-sdk (pass it to
 * `planBuybackSlice` for the program's slice amount and floor).
 */
export type BuybackVenueState =
  | {
      kind: 'dbc';
      sqrtPrice: bigint;
      quoteReserve: bigint;
      isMigrated: boolean;
      migrationSqrtPrice: bigint;
      migrationQuoteThreshold: bigint;
      curve: RawCurvePoint[];
    }
  | {
      kind: 'dammV2';
      sqrtPrice: bigint;
      liquidity: bigint;
      sqrtMaxPrice: bigint;
      collectFeeMode: number;
      tokenAAmount: bigint;
      tokenBAmount: bigint;
      poolStatus: number;
    };

/**
 * Reads a buyback venue: the DBC pool and its config, or the DAMM v2 pool. Null when the pool does not exist. A DBC
 * read throws when the pool trades another mint.
 */
export async function readBuybackVenue(params: {
  connection: Connection;
  kind: BuybackVenueKind;
  pool: PublicKey | string;
  /** The DBC config (saves a round trip). */
  dbcConfig?: PublicKey | string | null;
  /** The revenue token, checked against the pool. */
  mint?: PublicKey | string;
}): Promise<BuybackVenueAccounts | null> {
  const { connection } = params;
  const mint = params.mint ? new PublicKey(params.mint) : null;
  if (params.kind === 'dbc') {
    const accounts = await readCurveAccounts(connection, params.pool, params.dbcConfig);
    if (!accounts) return null;
    if (mint && !accounts.pool.poolState.baseMint.equals(mint)) {
      throw new Error(`DBC pool ${accounts.address.toBase58()} trades ${accounts.pool.poolState.baseMint.toBase58()}`);
    }
    return { kind: 'dbc', ...accounts };
  }
  const address = new PublicKey(params.pool);
  const pool = await readDammPoolAccount(connection, address);
  if (!pool) return null;
  if (mint && !pool.tokenAMint.equals(mint)) {
    throw new Error(`DAMM v2 pool ${address.toBase58()} has ${pool.tokenAMint.toBase58()} as token A`);
  }
  return { kind: 'dammV2', address, pool };
}

/** The raw state the program reads (pure). The DBC curve ends at its first all-zero point. */
export function buybackVenueState(accounts: BuybackVenueAccounts): BuybackVenueState {
  if (accounts.kind === 'dbc') {
    const state = accounts.pool.poolState;
    const config = accounts.config;
    const points = config.curve.map((p) => ({ sqrtPrice: toBigInt(p.sqrtPrice), liquidity: toBigInt(p.liquidity) }));
    const end = points.findIndex((p) => p.sqrtPrice === 0n || p.liquidity === 0n);
    return {
      kind: 'dbc',
      sqrtPrice: toBigInt(state.sqrtPrice),
      quoteReserve: toBigInt(state.quoteReserve),
      isMigrated: state.isMigrated === 1,
      migrationSqrtPrice: toBigInt(config.migrationSqrtPrice),
      migrationQuoteThreshold: toBigInt(config.migrationQuoteThreshold),
      curve: end === -1 ? points : points.slice(0, end),
    };
  }
  const pool = accounts.pool;
  return {
    kind: 'dammV2',
    sqrtPrice: toBigInt(pool.sqrtPrice),
    liquidity: toBigInt(pool.liquidity),
    sqrtMaxPrice: toBigInt(pool.sqrtMaxPrice),
    collectFeeMode: pool.collectFeeMode,
    tokenAAmount: toBigInt(pool.tokenAAmount),
    tokenBAmount: toBigInt(pool.tokenBAmount),
    poolStatus: pool.poolStatus,
  };
}

/**
 * For a DBC pool that migrated: the DAMM v2 config DBC used (`DAMM_V2_MIGRATION_FEE_ADDRESS[migrationFeeOption]`) and
 * the pool it created, which `sync_revenue_token_pool` takes. Null while the token is on its curve (pure).
 */
export function buybackGraduation(
  accounts: Extract<BuybackVenueAccounts, { kind: 'dbc' }>,
): { dammConfig: PublicKey; dammPool: PublicKey } | null {
  const { pool, config } = accounts;
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (pool.poolState.isMigrated !== 1 || !dammConfig) return null;
  return { dammConfig, dammPool: deriveDammV2PoolAddress(dammConfig, pool.poolState.baseMint, config.quoteMint) };
}

/** A buyback quote in base units. */
export interface BuybackQuote {
  kind: BuybackVenueKind;
  /** SOL the swap uses, fee included (a DBC partial fill that completes the curve uses less than offered). */
  lamportsIn: bigint;
  /** Tokens out, after the pool fee. */
  amountOut: bigint;
  /** `amountOut × (1 − slippageBps)`, rounded down: the crank's `min_amount_out`. */
  minimumOut: bigint;
  /** The pool fee (trading, protocol and referral) in the token it is charged in. */
  fee: bigint;
}

/** `amount × (10,000 − slippageBps) / 10,000`, rounded down. */
export function buybackMinimumOut(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= BPS_DENOMINATOR) {
    throw new RangeError(`slippageBps must be an integer from 0 to 9,999, got ${slippageBps}`);
  }
  return (amountOut * BigInt(BPS_DENOMINATOR - slippageBps)) / BigInt(BPS_DENOMINATOR);
}

async function pointNow(read: () => Promise<BN>, activationType: number): Promise<BN> {
  try {
    return await read();
  } catch {
    // getBlockTime can lag the newest slot; the local clock is close enough for a fee schedule.
    if (activationType === 1) return toBN(Math.floor(Date.now() / 1000));
    throw new Error('could not read the current slot');
  }
}

/**
 * Quotes a buyback of exactly `lamportsIn` SOL on the venue, from accounts read just before (`readBuybackVenue`). The
 * DBC quote uses partial-fill mode, like the program's swap. One RPC read for the current slot or block time unless
 * `currentPoint` is given.
 */
export async function quoteBuyback(params: {
  connection: Connection;
  accounts: BuybackVenueAccounts;
  lamportsIn: bigint;
  slippageBps: number;
  /** The revenue token's decimals (DAMM v2 quotes ask for them). */
  tokenDecimals: number;
  currentPoint?: BN;
}): Promise<BuybackQuote> {
  const { connection, accounts, lamportsIn, slippageBps } = params;
  if (lamportsIn <= 0n) throw new RangeError('lamportsIn must be positive');
  if (accounts.kind === 'dbc') {
    const { pool, config } = accounts;
    const currentPoint =
      params.currentPoint ??
      (await pointNow(
        () => getCurrentPoint(connection, config.activationType as ActivationType),
        config.activationType,
      ));
    const result = dbcClient(connection).pool.swapQuote2({
      virtualPool: pool,
      config,
      swapBaseForQuote: false,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint,
      slippageBps,
      swapMode: SwapMode.PartialFill,
      amountIn: toBN(lamportsIn),
    });
    const amountOut = toBigInt(result.outputAmount);
    return {
      kind: 'dbc',
      lamportsIn: toBigInt(result.includedFeeInputAmount),
      amountOut,
      minimumOut: buybackMinimumOut(amountOut, slippageBps),
      fee: toBigInt(result.tradingFee) + toBigInt(result.protocolFee) + toBigInt(result.referralFee),
    };
  }
  const { pool } = accounts;
  const currentPoint =
    params.currentPoint ??
    (await pointNow(
      () => getDammCurrentPoint(connection, pool.activationType as DammActivationType),
      pool.activationType,
    ));
  const result = cpAmmClient(connection).getQuote2({
    inputTokenMint: NATIVE_MINT,
    slippage: slippageBps,
    currentPoint,
    poolState: pool,
    tokenADecimal: params.tokenDecimals,
    tokenBDecimal: SOL_DECIMALS,
    hasReferral: false,
    swapMode: DammSwapMode.ExactIn,
    amountIn: toBN(lamportsIn),
  });
  const amountOut = toBigInt(result.outputAmount);
  return {
    kind: 'dammV2',
    lamportsIn: toBigInt(result.includedFeeInputAmount),
    amountOut,
    minimumOut: buybackMinimumOut(amountOut, slippageBps),
    fee:
      toBigInt(result.claimingFee) +
      toBigInt(result.compoundingFee) +
      toBigInt(result.protocolFee) +
      toBigInt(result.referralFee),
  };
}
