//! Seeds, sizes and protocol-wide constants. Everything here is a plain
//! number the program never changes at runtime.

use anchor_lang::prelude::*;

// ── PDA seeds ──────────────────────────────────────────────────────────────
pub const POOL_SEED: &[u8] = b"pool";
pub const VAULT_SEED: &[u8] = b"vault";
pub const LENDER_SEED: &[u8] = b"lender";
pub const WITHDRAW_SEED: &[u8] = b"withdraw";
pub const POSITION_SEED: &[u8] = b"position";
pub const VOTE_AUTH_SEED: &[u8] = b"vote_auth";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const ADVANCE_SEED: &[u8] = b"advance";
pub const FEE_INDEX_SEED: &[u8] = b"fee_index";
pub const QUOTE_SEED: &[u8] = b"quote";
pub const SWAP_SEED: &[u8] = b"swap";

// ── Arithmetic ─────────────────────────────────────────────────────────────
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;
/// Highest Epoch Score.
pub const MAX_SCORE: u16 = 10_000;

/// Virtual shares and assets added to every share-price computation so the
/// first depositor cannot inflate the share price by donating to the vault
/// (the "decimals offset" defence). With these values a donation attack
/// costs the attacker roughly 1,000× what the victim can lose.
pub const VIRTUAL_SHARES: u128 = 1_000;
pub const VIRTUAL_ASSETS: u128 = 1;

// ── Credit ─────────────────────────────────────────────────────────────────
/// Epochs of revenue history kept per validator and used for the credit limit.
pub const REVENUE_WINDOW: usize = 10;
/// Epochs of history a validator needs before it can borrow.
pub const MIN_REVENUE_HISTORY: u8 = 3;
/// Consecutive epochs without revenue before an open advance may be marked
/// defaulted.
pub const DEFAULT_AFTER_LATE_EPOCHS: u8 = 3;

// ── Vote program ───────────────────────────────────────────────────────────
/// The vote program. Vote accounts are owned by it and every CPI targets it.
pub const VOTE_PROGRAM_ID: Pubkey = pubkey!("Vote111111111111111111111111111111111111111");
/// Size of a vote account since vote state v1.14.11 (unchanged by v4).
pub const VOTE_STATE_SIZE: usize = 3_762;

// ── Fee index ──────────────────────────────────────────────────────────────
/// Epochs of index history kept on-chain for readers that want a short series.
pub const INDEX_HISTORY: usize = 16;

// ── Revenue tokens (ADR 0006, plan F13) ────────────────────────────────────
/// `["revenue_token", vote]`: the `RevenueToken` account.
pub const REVENUE_TOKEN_SEED: &[u8] = b"revenue_token";
/// `["buyback", vote]`: system-owned escrow that holds the swept share, signs
/// the swaps as their `payer` and owns the buyback token accounts.
pub const BUYBACK_SEED: &[u8] = b"buyback";
/// `["buyback_wsol", vote]`: a wrapped-SOL token account that lives for one
/// slice (created, swapped from and closed in `execute_buyback`).
pub const BUYBACK_WSOL_SEED: &[u8] = b"buyback_wsol";
/// `["buyback_tokens", vote]`: the token account the swap pays into; every
/// slice burns what it holds.
pub const BUYBACK_TOKENS_SEED: &[u8] = b"buyback_tokens";
/// `["treasury", pool]`: the Epoch partner treasury. It is the `fee_claimer`
/// (and should be the `leftover_receiver`) of every revenue token's DBC
/// config, so DBC partner trading fees and the graduated DAMM v2 LP position
/// belong to Epoch. The `instructions/treasury` cranks claim them: the SOL
/// becomes pool income, the tokens are burned.
pub const PARTNER_TREASURY_SEED: &[u8] = b"treasury";
/// `["treasury_wsol", pool]`: a wrapped-SOL account owned by the treasury that
/// lives for one claim (created, paid by Meteora and closed into the vault
/// inside the instruction).
pub const TREASURY_WSOL_SEED: &[u8] = b"treasury_wsol";

/// Revenue share bounds, bps of gross revenue.
pub const MIN_SHARE_BPS: u16 = 1;
pub const MAX_SHARE_BPS: u16 = 5_000;
/// Term bounds, epochs.
pub const MIN_TERM_EPOCHS: u16 = 10;
pub const MAX_TERM_EPOCHS: u16 = 1_000;

/// Default buyback schedule: 12 slices over the first ~9,000 slots (~1 hour)
/// of every epoch.
pub const DEFAULT_BUYBACK_SLICES: u8 = 12;
pub const DEFAULT_BUYBACK_WINDOW_SLOTS: u32 = 9_000;
pub const MAX_BUYBACK_SLICES: u8 = 32;
/// Default floor on `min_amount_out`, bps below the pool's fee-free output.
/// Must exceed the pool fee (100 bps on Epoch's preset) plus slippage.
pub const DEFAULT_MAX_SLIPPAGE_BPS: u16 = 300;
pub const MIN_MAX_SLIPPAGE_BPS: u16 = 50;
pub const MAX_MAX_SLIPPAGE_BPS: u16 = 2_000;
/// Default cap on how far one slice may move the pool price, bps. Keeping it
/// at or below twice the pool fee makes sandwiching a slice unprofitable.
pub const DEFAULT_MAX_IMPACT_BPS: u16 = 100;
pub const MIN_MAX_IMPACT_BPS: u16 = 10;
pub const MAX_MAX_IMPACT_BPS: u16 = 1_000;
/// `close_revenue_token` accepts an escrow with at most this much above rent
/// (what a last slice or redemption can leave behind); it goes to the operator
/// with the rent.
pub const MAX_CLOSE_DUST_LAMPORTS: u64 = 100_000;
/// Epochs after the term during which holders can redeem before
/// `close_revenue_token` may close a token whose escrow still holds more than
/// dust (the rest then becomes pool income). About two months on mainnet.
pub const REDEEM_GRACE_EPOCHS: u64 = 30;

// ── Meteora (verified against the deployed programs and mainnet swaps) ─────
/// Dynamic Bonding Curve program.
pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
/// DBC `["pool_authority"]`: owns the curve vaults; the only key allowed to
/// create DAMM v2 pools from DBC's DAMM v2 configs.
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// DBC `["__event_authority"]` (Anchor `emit_cpi!`).
pub const DBC_EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
/// DAMM v2 (cp-amm) program.
pub const CP_AMM_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// DAMM v2 `["pool_authority"]`.
pub const CP_AMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
/// DAMM v2 `["__event_authority"]`.
pub const CP_AMM_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
/// DAMM v2 `["position_nft_account", nft_mint]`: the Token-2022 account that
/// holds a position's NFT; whoever owns it owns the position.
pub const CP_AMM_POSITION_NFT_ACCOUNT_SEED: &[u8] = b"position_nft_account";
/// DBC `migration_progress` once the DAMM v2 pool exists (`CreatedPool`).
pub const DBC_MIGRATION_PROGRESS_CREATED_POOL: u8 = 3;
/// DBC `migration_fee_withdraw_status` bit set once the partner withdrew its
/// migration fee (`PARTNER_MIGRATION_FEE_MASK`).
pub const DBC_PARTNER_MIGRATION_FEE_MASK: u8 = 0b100;
/// Share of a completed curve's surplus that goes to partner and creator
/// (the protocol keeps the rest), percent.
pub const DBC_PARTNER_AND_CREATOR_SURPLUS_SHARE: u64 = 80;

/// The instructions sysvar (forwarded to a venue whose rate limiter needs it).
pub const INSTRUCTIONS_SYSVAR_ID: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");
/// The associated token account program (the treasury's leftover account).
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey =
    pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ── SPL Token ──────────────────────────────────────────────────────────────
pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/// Token-2022: owns DAMM v2 position NFT mints and accounts.
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/// Wrapped SOL: the quote mint of every revenue token.
pub const NATIVE_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// Size of an SPL Token account.
pub const TOKEN_ACCOUNT_LEN: usize = 165;
/// Size of an SPL Token mint.
pub const MINT_LEN: usize = 82;
