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
