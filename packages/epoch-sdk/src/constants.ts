/**
 * Seeds, program constants and enum spellings, mirrored from `programs/epoch/src/constants.rs` and `state/*.rs`.
 * The program ID is not here: it is still a placeholder on-chain, so every SDK function takes `programId`.
 */
import { PublicKey } from '@solana/web3.js';

/** PDA seed prefixes (`*_SEED` in constants.rs). */
export const SEEDS = {
  pool: 'pool',
  vault: 'vault',
  lender: 'lender',
  withdraw: 'withdraw',
  position: 'position',
  voteAuth: 'vote_auth',
  escrow: 'escrow',
  advance: 'advance',
  feeIndex: 'fee_index',
  quote: 'quote',
  swap: 'swap',
} as const;

export const VOTE_PROGRAM_ID = new PublicKey('Vote111111111111111111111111111111111111111');

export const PROGRAM_CONSTANTS = {
  BPS_DENOMINATOR: 10000,
  MAX_SCORE: 10000,
  VIRTUAL_SHARES: 1000n,
  VIRTUAL_ASSETS: 1n,
  REVENUE_WINDOW: 10,
  MIN_REVENUE_HISTORY: 3,
  DEFAULT_AFTER_LATE_EPOCHS: 3,
  INDEX_HISTORY: 16,
} as const;

/** Raw shares per UI share: the first deposit mints 1,000 shares per lamport, so 1 SOL at par = 1e12 shares. */
export const RAW_SHARES_PER_UI_SHARE = 1_000_000_000_000n;

const PRICE_E9_PER_SOL = 1_000_000n;

/**
 * A `share_price_e9` (lamports per raw share × 1e9, as in `Deposited`/`Accrued` events) as SOL per UI share.
 * Par is 1e6 → 1.0. The integer part is converted exactly before the fraction, so large prices keep precision.
 */
export const sharePriceE9ToSol = (priceE9: bigint): number =>
  Number(priceE9 / PRICE_E9_PER_SOL) + Number(priceE9 % PRICE_E9_PER_SOL) / 1e6;

/** Raw on-chain shares as UI shares (÷ 1e12). */
export const rawSharesToUi = (shares: bigint): number =>
  Number(shares / RAW_SHARES_PER_UI_SHARE) + Number(shares % RAW_SHARES_PER_UI_SHARE) / 1e12;

export type Tranche = 'senior' | 'junior';
/** Rust: `PayFixed = 0`, `ReceiveFixed = 1`. */
export type Side = 'payFixed' | 'receiveFixed';
export type PositionStatus = 'active' | 'late' | 'defaulted' | 'released';
export type AdvanceState = 'open' | 'repaid' | 'defaulted';

/** Variants in Rust declaration order: the index is the Borsh byte. */
export const TRANCHES: readonly Tranche[] = Object.freeze(['senior', 'junior'] as const);
export const SIDES: readonly Side[] = Object.freeze(['payFixed', 'receiveFixed'] as const);
export const POSITION_STATUSES: readonly PositionStatus[] = Object.freeze([
  'active',
  'late',
  'defaulted',
  'released',
] as const);
export const ADVANCE_STATES: readonly AdvanceState[] = Object.freeze(['open', 'repaid', 'defaulted'] as const);

/** `update_commission` kinds (`CommissionKind` in cpi/vote.rs). */
export const COMMISSION_KIND = { inflationRewards: 0, blockRevenue: 1 } as const;
