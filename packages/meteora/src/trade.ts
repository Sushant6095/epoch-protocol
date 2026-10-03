/**
 * Buy and sell quotes and transactions for a revenue token: DBC `swapQuote2` + `swap2` while it is on the curve, the
 * DAMM v2 quote (`getQuote2`) and `swap2` after it graduates. Everything a browser wallet needs; nothing is signed here.
 */
import {
  type ActivationType as DammActivationType,
  type CollectFeeMode as DammCollectFeeMode,
  getCurrentPoint as getDammCurrentPoint,
  getFeeMode as getDammFeeMode,
  getTokenProgram,
  type PoolState as DammPoolAccount,
  type Quote2Result,
  SwapMode as DammSwapMode,
  TradeDirection as DammTradeDirection,
} from '@meteora-ag/cp-amm-sdk';
import {
  type ActivationType,
  type CollectFeeMode,
  getCurrentPoint,
  getFeeMode,
  type PoolConfig,
  SwapMode,
  type SwapQuote2Result,
  TradeDirection,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import type BN from 'bn.js';
import { type Connection, PublicKey, type Transaction } from '@solana/web3.js';

import { DEFAULT_SLIPPAGE_BPS, NATIVE_MINT, SOL_DECIMALS } from './constants';
import { sqrtPriceX64ToPrice } from './curve';
import { cpAmmClient, dbcClient, graduatedDammPool, readCurveAccounts, readDammPoolAccount } from './pools';
import { fromBaseUnits, toBaseUnits, toBigInt, toBN } from './units';

export type TradeSide = 'buy' | 'sell';
export type TradeVenue = 'dbc' | 'damm-v2';

/** A buy or sell preview: the frontend contract's `LaunchTradeQuote` (handover `contracts/epoch-data.ts`). */
export interface LaunchTradeQuote {
  side: TradeSide;
  /** SOL in for a buy, tokens in for a sell. */
  amountIn: number;
  amountOut: number;
  /** amountOut after the slippage the ticket allows (default 1%). */
  minimumOut: number;
  priceImpactPct: number;
  tradingFeeSol: number;
  venue: TradeVenue;
}

/** Which launch to trade: its pools (from `GET /v1/launches/:mint`) and its token. */
export interface LaunchRef {
  /** The DBC pool (null for a launch that only has a DAMM v2 pool). */
  dbcPool?: PublicKey | string | null;
  /** Its config, when known (saves a round trip). */
  dbcConfig?: PublicKey | string | null;
  /** The DAMM v2 pool after graduation; derived from the curve when omitted. */
  dammPool?: PublicKey | string | null;
  mint: PublicKey | string;
  decimals: number;
}

export type LaunchTradeErrorCode =
  | 'NOT_LAUNCHED'
  | 'NOT_OPEN'
  | 'CURVE_COMPLETE'
  | 'NOT_TRADING'
  | 'AMOUNT_TOO_SMALL'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'WRONG_TOKEN';

/** Why a quote or trade cannot be built; `code` lets the ticket pick its message. */
export class LaunchTradeError extends Error {
  constructor(
    readonly code: LaunchTradeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LaunchTradeError';
  }
}

/** A swap's raw amounts (base units), before they become a `LaunchTradeQuote`. */
export interface RawSwapAmounts {
  side: TradeSide;
  venue: TradeVenue;
  /** Input the swap uses, fees included. */
  inputIncludingFee: bigint;
  /** Input after an input-side fee. */
  inputExcludingFee: bigint;
  /** Output after an output-side fee. */
  outputAmount: bigint;
  minimumOut: bigint;
  /** All fees (trading, protocol, referral), in the token they are charged in. */
  fee: bigint;
  feeOnInput: boolean;
  /** The fee is charged in the revenue token (else in SOL). */
  feeInBase: boolean;
  /** SOL per token before the trade. */
  spotPriceSol: number;
  baseDecimals: number;
  quoteDecimals: number;
}

const round = (value: number, decimals: number): number => Math.round(value * 10 ** decimals) / 10 ** decimals;

/**
 * Raw swap amounts → `LaunchTradeQuote` (pure). Price impact compares the execution price before fees with the spot
 * price, so it measures the pool's move alone; the fee is reported separately, in SOL.
 */
export function toTradeQuote(raw: RawSwapAmounts): LaunchTradeQuote {
  const inDecimals = raw.side === 'buy' ? raw.quoteDecimals : raw.baseDecimals;
  const outDecimals = raw.side === 'buy' ? raw.baseDecimals : raw.quoteDecimals;
  const feeUi = fromBaseUnits(raw.fee, raw.feeInBase ? raw.baseDecimals : raw.quoteDecimals);
  const grossOut = raw.outputAmount + (raw.feeOnInput ? 0n : raw.fee);
  const netIn = fromBaseUnits(raw.inputExcludingFee, inDecimals);
  const out = fromBaseUnits(grossOut, outDecimals);
  const executionPriceSol = raw.side === 'buy' ? (out > 0 ? netIn / out : 0) : netIn > 0 ? out / netIn : 0;
  const priceImpactPct =
    raw.spotPriceSol > 0 && executionPriceSol > 0
      ? (Math.abs(executionPriceSol - raw.spotPriceSol) / raw.spotPriceSol) * 100
      : 0;
  return {
    side: raw.side,
    amountIn: fromBaseUnits(raw.inputIncludingFee, inDecimals),
    amountOut: fromBaseUnits(raw.outputAmount, outDecimals),
    minimumOut: fromBaseUnits(raw.minimumOut, outDecimals),
    priceImpactPct: round(priceImpactPct, 4),
    tradingFeeSol: round(raw.feeInBase ? feeUi * raw.spotPriceSol : feeUi, 9),
    venue: raw.venue,
  };
}

const minimumWithSlippage = (amount: bigint, slippageBps: number): bigint =>
  (amount * BigInt(10_000 - slippageBps)) / 10_000n;

const checkSlippage = (slippageBps: number): void => {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new RangeError(`slippageBps must be an integer from 0 to 9,999, got ${slippageBps}`);
  }
};

/** The SDKs throw plain Errors; give the ticket a code. */
function tradeError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (/completed/i.test(message))
    return new LaunchTradeError('CURVE_COMPLETE', 'The raise is complete: the curve no longer trades');
  if (/insufficient liquidity/i.test(message)) {
    return new LaunchTradeError('INSUFFICIENT_LIQUIDITY', 'Not enough liquidity for this amount');
  }
  if (/amount is zero|must be greater than 0/i.test(message)) {
    return new LaunchTradeError('AMOUNT_TOO_SMALL', 'The amount rounds to zero');
  }
  if (/swap.*disabled/i.test(message))
    return new LaunchTradeError('NOT_TRADING', 'Trading on this pool is not enabled');
  return error;
}

type Venue =
  | { venue: 'dbc'; address: PublicKey; pool: VirtualPool; config: PoolConfig }
  | { venue: 'damm-v2'; address: PublicKey; pool: DammPoolAccount };

/** Finds where the token trades now: the DAMM v2 pool once graduated, else the curve. */
async function resolveVenue(connection: Connection, launch: LaunchRef): Promise<Venue> {
  const mint = new PublicKey(launch.mint);
  if (launch.dammPool) return dammVenue(connection, new PublicKey(launch.dammPool), mint);
  if (!launch.dbcPool) throw new LaunchTradeError('NOT_LAUNCHED', 'This token has no pool yet');
  const accounts = await readCurveAccounts(connection, launch.dbcPool, launch.dbcConfig);
  if (!accounts) throw new LaunchTradeError('NOT_LAUNCHED', 'The curve pool does not exist yet');
  const { address, pool, config } = accounts;
  if (!pool.poolState.baseMint.equals(mint)) throw new LaunchTradeError('WRONG_TOKEN', 'The pool trades another token');
  if (pool.poolState.isMigrated === 1) {
    const graduated = graduatedDammPool(pool, config);
    if (!graduated) throw new LaunchTradeError('NOT_TRADING', 'The token graduated, but its DAMM v2 pool is unknown');
    return dammVenue(connection, graduated, mint);
  }
  if (toBigInt(pool.poolState.quoteReserve) >= toBigInt(config.migrationQuoteThreshold)) {
    throw new LaunchTradeError(
      'CURVE_COMPLETE',
      'The raise is complete: the token trades again once it graduates to DAMM v2',
    );
  }
  return { venue: 'dbc', address, pool, config };
}

async function dammVenue(connection: Connection, address: PublicKey, mint: PublicKey): Promise<Venue> {
  const pool = await readDammPoolAccount(connection, address);
  if (!pool) throw new LaunchTradeError('NOT_LAUNCHED', 'The DAMM v2 pool does not exist yet');
  if (!pool.tokenAMint.equals(mint) && !pool.tokenBMint.equals(mint)) {
    throw new LaunchTradeError('WRONG_TOKEN', 'The pool trades another token');
  }
  return { venue: 'damm-v2', address, pool };
}

async function currentPointOrNow(read: () => Promise<BN>, activationType: number): Promise<BN> {
  try {
    return await read();
  } catch {
    // getBlockTime can lag the newest slot; the local clock is close enough for a fee schedule.
    if (activationType === 1) return toBN(Math.floor(Date.now() / 1000));
    throw new Error('could not read the current slot');
  }
}

interface PreparedSwap {
  raw: RawSwapAmounts;
  /** What the transaction sends (base units) and its swap mode. */
  amountIn: bigint;
  swapMode: 'exactIn' | 'partialFill';
}

async function prepareDbcSwap(
  connection: Connection,
  venue: Extract<Venue, { venue: 'dbc' }>,
  side: TradeSide,
  amount: number,
  slippageBps: number,
): Promise<PreparedSwap> {
  const { pool, config } = venue;
  const baseDecimals = config.tokenDecimal;
  const amountIn = toBaseUnits(amount, side === 'buy' ? SOL_DECIMALS : baseDecimals);
  if (amountIn === 0n) throw new LaunchTradeError('AMOUNT_TOO_SMALL', 'The amount rounds to zero');
  const currentPoint = await currentPointOrNow(
    () => getCurrentPoint(connection, config.activationType as ActivationType),
    config.activationType,
  );
  if (currentPoint.lt(pool.poolState.activationPoint)) {
    throw new LaunchTradeError('NOT_OPEN', 'The curve has not opened yet');
  }
  const swapBaseForQuote = side === 'sell';
  // A buy may complete the raise: PartialFill fills up to the threshold and returns the rest of the SOL.
  const swapMode = side === 'buy' ? SwapMode.PartialFill : SwapMode.ExactIn;
  let result;
  try {
    result = dbcClient(connection).pool.swapQuote2({
      virtualPool: pool,
      config,
      swapBaseForQuote,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint,
      slippageBps,
      swapMode,
      amountIn: toBN(amountIn),
    });
  } catch (error) {
    throw tradeError(error);
  }
  return {
    amountIn,
    swapMode: swapMode === SwapMode.PartialFill ? 'partialFill' : 'exactIn',
    raw: dbcSwapAmounts({
      side,
      result,
      collectFeeMode: config.collectFeeMode,
      spotPriceSol: sqrtPriceX64ToPrice(pool.poolState.sqrtPrice, baseDecimals, SOL_DECIMALS),
      baseDecimals,
      slippageBps,
    }),
  };
}

/** The fields of a DBC quote (`swapQuote2`, `getQuoteFromInputAmount`) the ticket needs. */
export type DbcQuoteResult = Pick<
  SwapQuote2Result,
  'includedFeeInputAmount' | 'excludedFeeInputAmount' | 'outputAmount' | 'tradingFee' | 'protocolFee' | 'referralFee'
> & { minimumAmountOut?: BN };

/** A DBC quote's amounts, with its fee side from the config's collect-fee mode (pure). */
export function dbcSwapAmounts(input: {
  side: TradeSide;
  result: DbcQuoteResult;
  collectFeeMode: number;
  spotPriceSol: number;
  baseDecimals: number;
  slippageBps: number;
}): RawSwapAmounts {
  const { side, result } = input;
  const feeMode = getFeeMode(
    input.collectFeeMode as CollectFeeMode,
    side === 'sell' ? TradeDirection.BaseToQuote : TradeDirection.QuoteToBase,
    false,
  );
  const outputAmount = toBigInt(result.outputAmount);
  return {
    side,
    venue: 'dbc',
    inputIncludingFee: toBigInt(result.includedFeeInputAmount),
    inputExcludingFee: toBigInt(result.excludedFeeInputAmount),
    outputAmount,
    minimumOut: result.minimumAmountOut
      ? toBigInt(result.minimumAmountOut)
      : minimumWithSlippage(outputAmount, input.slippageBps),
    fee: toBigInt(result.tradingFee) + toBigInt(result.protocolFee) + toBigInt(result.referralFee),
    feeOnInput: feeMode.feesOnInput,
    feeInBase: feeMode.feesOnBaseToken,
    spotPriceSol: input.spotPriceSol,
    baseDecimals: input.baseDecimals,
    quoteDecimals: SOL_DECIMALS,
  };
}

/** The fields of a DAMM v2 quote (`getQuote2`) the ticket needs. */
export type DammQuoteResult = Pick<
  Quote2Result,
  | 'includedFeeInputAmount'
  | 'excludedFeeInputAmount'
  | 'outputAmount'
  | 'claimingFee'
  | 'compoundingFee'
  | 'protocolFee'
  | 'referralFee'
> & { minimumAmountOut?: BN };

/** A DAMM v2 quote's amounts, oriented around the revenue token (pure). */
export function dammSwapAmounts(input: {
  side: TradeSide;
  result: DammQuoteResult;
  collectFeeMode: number;
  /** The revenue token is the pool's token A. */
  baseIsTokenA: boolean;
  spotPriceSol: number;
  baseDecimals: number;
  quoteDecimals: number;
  slippageBps: number;
}): RawSwapAmounts {
  const { side, result } = input;
  // Selling the token is A → B when the token is A.
  const aToB = (side === 'sell') === input.baseIsTokenA;
  const feeMode = getDammFeeMode(
    input.collectFeeMode as DammCollectFeeMode,
    aToB ? DammTradeDirection.AtoB : DammTradeDirection.BtoA,
    false,
  );
  const outputAmount = toBigInt(result.outputAmount);
  return {
    side,
    venue: 'damm-v2',
    inputIncludingFee: toBigInt(result.includedFeeInputAmount),
    inputExcludingFee: toBigInt(result.excludedFeeInputAmount),
    outputAmount,
    minimumOut: result.minimumAmountOut
      ? toBigInt(result.minimumAmountOut)
      : minimumWithSlippage(outputAmount, input.slippageBps),
    fee:
      toBigInt(result.claimingFee) +
      toBigInt(result.compoundingFee) +
      toBigInt(result.protocolFee) +
      toBigInt(result.referralFee),
    feeOnInput: feeMode.feesOnInput,
    feeInBase: feeMode.feesOnTokenA === input.baseIsTokenA,
    spotPriceSol: input.spotPriceSol,
    baseDecimals: input.baseDecimals,
    quoteDecimals: input.quoteDecimals,
  };
}

interface DammSides {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseIsTokenA: boolean;
  decimalsA: number;
  decimalsB: number;
}

/** Orients a SOL-quoted DAMM v2 pool around the launch's token (decimals from the launch, 9 for SOL: no RPC). */
function dammSides(pool: DammPoolAccount, launch: LaunchRef): DammSides {
  const mint = new PublicKey(launch.mint);
  const baseIsTokenA = pool.tokenAMint.equals(mint);
  const quoteMint = baseIsTokenA ? pool.tokenBMint : pool.tokenAMint;
  if (!quoteMint.equals(NATIVE_MINT)) throw new LaunchTradeError('WRONG_TOKEN', 'The pool is not quoted in SOL');
  return {
    baseMint: mint,
    quoteMint,
    baseIsTokenA,
    decimalsA: baseIsTokenA ? launch.decimals : SOL_DECIMALS,
    decimalsB: baseIsTokenA ? SOL_DECIMALS : launch.decimals,
  };
}

async function prepareDammSwap(
  connection: Connection,
  venue: Extract<Venue, { venue: 'damm-v2' }>,
  sides: DammSides,
  side: TradeSide,
  amount: number,
  slippageBps: number,
): Promise<PreparedSwap> {
  const { pool } = venue;
  const [baseDecimals, quoteDecimals] = sides.baseIsTokenA
    ? [sides.decimalsA, sides.decimalsB]
    : [sides.decimalsB, sides.decimalsA];
  const amountIn = toBaseUnits(amount, side === 'buy' ? quoteDecimals : baseDecimals);
  if (amountIn === 0n) throw new LaunchTradeError('AMOUNT_TOO_SMALL', 'The amount rounds to zero');
  const inputTokenMint = side === 'buy' ? sides.quoteMint : sides.baseMint;
  const currentPoint = await currentPointOrNow(
    () => getDammCurrentPoint(connection, pool.activationType as DammActivationType),
    pool.activationType,
  );
  let result;
  try {
    result = cpAmmClient(connection).getQuote2({
      inputTokenMint,
      slippage: slippageBps,
      currentPoint,
      poolState: pool,
      tokenADecimal: sides.decimalsA,
      tokenBDecimal: sides.decimalsB,
      hasReferral: false,
      swapMode: DammSwapMode.ExactIn,
      amountIn: toBN(amountIn),
    });
  } catch (error) {
    throw tradeError(error);
  }
  const priceAinB = sqrtPriceX64ToPrice(pool.sqrtPrice, sides.decimalsA, sides.decimalsB);
  return {
    amountIn,
    swapMode: 'exactIn',
    raw: dammSwapAmounts({
      side,
      result,
      collectFeeMode: pool.collectFeeMode,
      baseIsTokenA: sides.baseIsTokenA,
      spotPriceSol: sides.baseIsTokenA ? priceAinB : priceAinB > 0 ? 1 / priceAinB : 0,
      baseDecimals,
      quoteDecimals,
      slippageBps,
    }),
  };
}

export interface QuoteTradeParams {
  connection: Connection;
  launch: LaunchRef;
  side: TradeSide;
  /** SOL to spend for a buy, tokens to sell for a sell (UI units). */
  amount: number;
  /** Default 100 (1%). */
  slippageBps?: number;
}

/**
 * A buy or sell quote on the venue the token trades on now: DBC `swapQuote2` on the curve (PartialFill for buys, so the
 * last buy can complete the raise), the DAMM v2 `getQuote2` after graduation. A few RPC reads (pool, config, clock).
 */
export async function quoteTrade(params: QuoteTradeParams): Promise<LaunchTradeQuote> {
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  checkSlippage(slippageBps);
  const venue = await resolveVenue(params.connection, params.launch);
  const prepared =
    venue.venue === 'dbc'
      ? await prepareDbcSwap(params.connection, venue, params.side, params.amount, slippageBps)
      : await prepareDammSwap(
          params.connection,
          venue,
          dammSides(venue.pool, params.launch),
          params.side,
          params.amount,
          slippageBps,
        );
  return toTradeQuote(prepared.raw);
}

export interface BuildTradeTxParams extends QuoteTradeParams {
  /** The trader's wallet: signs, pays the fee and owns the token accounts. */
  owner: PublicKey | string;
  /**
   * The reviewed quote's `minimumOut` (UI units), so the transaction enforces exactly what the review showed. Omitted:
   * a fresh quote's minimum.
   */
  minimumOut?: number;
}

/**
 * The unsigned swap transaction for a buy or sell: DBC `swap2` on the curve, DAMM v2 `swap2` after graduation, with
 * associated-token-account setup and SOL wrapping as needed. The recent blockhash, its last valid block height and the
 * fee payer (the owner) are set; the wallet signs and sends it.
 */
export async function buildTradeTx(params: BuildTradeTxParams): Promise<Transaction> {
  const { connection, side } = params;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  checkSlippage(slippageBps);
  const owner = new PublicKey(params.owner);
  const venue = await resolveVenue(connection, params.launch);
  let transaction: Transaction;
  if (venue.venue === 'dbc') {
    const prepared = await prepareDbcSwap(connection, venue, side, params.amount, slippageBps);
    const minimumAmountOut =
      params.minimumOut !== undefined
        ? toBaseUnits(params.minimumOut, side === 'buy' ? venue.config.tokenDecimal : SOL_DECIMALS)
        : prepared.raw.minimumOut;
    transaction = await dbcClient(connection).pool.swap2({
      owner,
      payer: owner,
      pool: venue.address,
      swapBaseForQuote: side === 'sell',
      referralTokenAccount: null,
      swapMode: prepared.swapMode === 'partialFill' ? SwapMode.PartialFill : SwapMode.ExactIn,
      amountIn: toBN(prepared.amountIn),
      minimumAmountOut: toBN(minimumAmountOut),
    });
  } else {
    const sides = dammSides(venue.pool, params.launch);
    const prepared = await prepareDammSwap(connection, venue, sides, side, params.amount, slippageBps);
    const minimumAmountOut =
      params.minimumOut !== undefined
        ? toBaseUnits(params.minimumOut, side === 'buy' ? prepared.raw.baseDecimals : prepared.raw.quoteDecimals)
        : prepared.raw.minimumOut;
    const [inputTokenMint, outputTokenMint] =
      side === 'buy' ? [sides.quoteMint, sides.baseMint] : [sides.baseMint, sides.quoteMint];
    const pool = venue.pool;
    transaction = await cpAmmClient(connection).swap2({
      payer: owner,
      pool: venue.address,
      inputTokenMint,
      outputTokenMint,
      tokenAMint: pool.tokenAMint,
      tokenBMint: pool.tokenBMint,
      tokenAVault: pool.tokenAVault,
      tokenBVault: pool.tokenBVault,
      tokenAProgram: getTokenProgram(pool.tokenAFlag),
      tokenBProgram: getTokenProgram(pool.tokenBFlag),
      referralTokenAccount: null,
      poolState: pool,
      swapMode: DammSwapMode.ExactIn,
      amountIn: toBN(prepared.amountIn),
      minimumAmountOut: toBN(minimumAmountOut),
    });
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = owner;
  return transaction;
}
