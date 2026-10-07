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
  revenueToken: 'revenue_token',
  buyback: 'buyback',
  buybackWsol: 'buyback_wsol',
  buybackTokens: 'buyback_tokens',
  partnerTreasury: 'treasury',
  treasuryWsol: 'treasury_wsol',
  history: 'history',
  scoreConfig: 'score_config',
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
  // Revenue tokens
  MIN_SHARE_BPS: 1,
  MAX_SHARE_BPS: 5000,
  MIN_TERM_EPOCHS: 10,
  MAX_TERM_EPOCHS: 1000,
  DEFAULT_BUYBACK_SLICES: 12,
  DEFAULT_BUYBACK_WINDOW_SLOTS: 9000,
  MAX_BUYBACK_SLICES: 32,
  DEFAULT_MAX_SLIPPAGE_BPS: 300,
  MIN_MAX_SLIPPAGE_BPS: 50,
  MAX_MAX_SLIPPAGE_BPS: 2000,
  DEFAULT_MAX_IMPACT_BPS: 100,
  MIN_MAX_IMPACT_BPS: 10,
  MAX_MAX_IMPACT_BPS: 1000,
  MAX_CLOSE_DUST_LAMPORTS: 100_000n,
  /** Epochs after the term for holders to redeem before a token closes whatever its escrow holds (rest: pool income). */
  REDEEM_GRACE_EPOCHS: 30n,
  // Treasury claims: DBC values the program checks before claiming
  /** DBC `migration_progress` once the DAMM v2 pool exists (`withdraw_leftover` needs it). */
  DBC_MIGRATION_PROGRESS_CREATED_POOL: 3,
  /** DBC `migration_fee_withdraw_status` bit set once the partner withdrew its migration fee. */
  DBC_PARTNER_MIGRATION_FEE_MASK: 0b100,
  /** Percent of a completed curve's surplus that partner and creator share (the protocol keeps the rest). */
  DBC_PARTNER_AND_CREATOR_SURPLUS_SHARE: 80,
  // Validator history and the permissionless score
  /** Epochs a `ValidatorHistory` keeps; the entry for epoch `e` is at `e % HISTORY_LEN`. */
  HISTORY_LEN: 64,
  TVC_CREDITS_PER_SLOT: 16n,
  DELINQUENT_SLOT_DISTANCE: 128n,
  HEDGE_EPOCHS_AHEAD: 5,
  HEDGE_MIN_NOTIONAL_BPS: 5000,
  DEFAULT_CREDITS_WINDOW_EPOCHS: 10,
  MAX_CREDITS_WINDOW_EPOCHS: 32,
  DEFAULT_CREDITS_REFERENCE_BPS: 9950,
  MIN_CREDITS_REFERENCE_BPS: 5000,
  DEFAULT_MAX_COPY_AGE_SLOTS: 9000,
  MIN_MAX_COPY_AGE_SLOTS: 150,
  MAX_MAX_COPY_AGE_SLOTS: 216_000,
} as const;

/** Jito's per-epoch distribution programs and seeds (mainnet; absent on devnet). */
export const JITO = Object.freeze({
  TIP_DISTRIBUTION_PROGRAM_ID: new PublicKey('4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7'),
  TIP_DISTRIBUTION_ACCOUNT_SEED: 'TIP_DISTRIBUTION_ACCOUNT',
  PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID: new PublicKey('Priority6weCZ5HwDn29NxLFpb7TDp2iLZ6XKc5e8d3'),
  PF_DISTRIBUTION_ACCOUNT_SEED: 'PF_DISTRIBUTION_ACCOUNT',
});

/**
 * The Meteora programs and fixed PDAs revenue tokens use (verified against the deployed programs and mainnet swaps;
 * the same addresses on devnet), plus the SPL addresses the buyback instructions name.
 */
export const METEORA = Object.freeze({
  DBC_PROGRAM_ID: new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'),
  /** DBC `["pool_authority"]`. */
  DBC_POOL_AUTHORITY: new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'),
  /** DBC `["__event_authority"]`. */
  DBC_EVENT_AUTHORITY: new PublicKey('8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF'),
  CP_AMM_PROGRAM_ID: new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'),
  /** DAMM v2 `["pool_authority"]`. */
  CP_AMM_POOL_AUTHORITY: new PublicKey('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC'),
  /** DAMM v2 `["__event_authority"]`. */
  CP_AMM_EVENT_AUTHORITY: new PublicKey('3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet'),
});

/** DAMM v2 `["position_nft_account", nft_mint]`: the Token-2022 account holding a position's NFT. */
export const CP_AMM_POSITION_NFT_ACCOUNT_SEED = 'position_nft_account';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
/** Token-2022: owns DAMM v2 position NFTs. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
/** Wrapped SOL: every revenue token is quoted in it. */
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const INSTRUCTIONS_SYSVAR_ID = new PublicKey('Sysvar1nstructions1111111111111111111111111');

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
/** Where a revenue token trades: its DBC curve, or the DAMM v2 pool it graduated to (once synced). */
export type RevenueTokenStatus = 'curve' | 'graduated';
/** The venue of one buyback slice (`BuybackExecuted.venue`). */
export type BuybackVenue = 'dbc' | 'dammV2';
/** `TreasuryClaimKind`: what a partner treasury claim collected. */
export type TreasuryClaimKind = 'tradingFee' | 'surplus' | 'migrationFee' | 'leftover' | 'lpFee';

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
export const REVENUE_TOKEN_STATUSES: readonly RevenueTokenStatus[] = Object.freeze(['curve', 'graduated'] as const);
export const BUYBACK_VENUES: readonly BuybackVenue[] = Object.freeze(['dbc', 'dammV2'] as const);
export const TREASURY_CLAIM_KINDS: readonly TreasuryClaimKind[] = Object.freeze([
  'tradingFee',
  'surplus',
  'migrationFee',
  'leftover',
  'lpFee',
] as const);

/** `RevenueToken.flags` bits (`configure_revenue_token`). */
export const REVENUE_TOKEN_FLAGS = Object.freeze({
  /** Buybacks paused by the pool admin; the escrow keeps filling. */
  buybacksPaused: 1,
  /** Holders may redeem during the term (the fallback when buybacks cannot run). */
  redeemDuringTerm: 2,
});

/** `update_commission` kinds (`CommissionKind` in cpi/vote.rs). */
export const COMMISSION_KIND = { inflationRewards: 0, blockRevenue: 1 } as const;
