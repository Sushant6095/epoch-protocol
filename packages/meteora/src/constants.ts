/**
 * Epoch's revenue-token preset (ADR 0006, plan F13) and the few addresses the helpers need. Program IDs come from the
 * Meteora SDKs; the same IDs serve devnet and mainnet.
 */
import { PublicKey } from '@solana/web3.js';

/** Wrapped SOL: the quote mint of every Epoch launch. */
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000;

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
/** Size of an SPL Token account (the classic program has no extensions). */
export const TOKEN_ACCOUNT_SIZE = 165;

export const BPS_DENOMINATOR = 10_000;

/** The curve's price band per token, as % of the share's value (10-epoch average × share × term ÷ supply). */
export const BAND_LOW_PCT = 60;
export const BAND_HIGH_PCT = 95;

/**
 * DBC migration fee at graduation, % of the raise (`migrationFee.feePercentage`), all of it to the pool creator
 * (`creatorFeePercentage` 100): the validator gets 70% of the raise as SOL, the other 30% seeds the DAMM v2 pool.
 */
export const MIGRATION_FEE_PCT = 70;
export const CREATOR_MIGRATION_FEE_SHARE_PCT = 100;
/** DAMM v2 liquidity permanently locked at graduation (all of it held by the partner, Epoch). */
export const LOCKED_LIQUIDITY_PCT = 100;

/** Buyback slices across the first hour of each epoch (BuybackJob in cranks_app, plan F13). */
export const BUYBACK_SLICES_PER_EPOCH = 12;

/** The trade ticket's default slippage (1%). */
export const DEFAULT_SLIPPAGE_BPS = 100;
/** Curve trading fee for new launches (DBC minimum is 25 bps). */
export const DEFAULT_TRADING_FEE_BPS = 100;
/** DBC allows at most 16 curve segments, so at most 17 sqrt-price points. */
export const MAX_CURVE_POINTS = 17;
