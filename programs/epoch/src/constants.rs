pub const POOL_SEED: &[u8] = b"pool";
pub const VALIDATOR_SEED: &[u8] = b"validator";
pub const ADVANCE_SEED: &[u8] = b"advance";
pub const INDEX_SEED: &[u8] = b"index";
pub const BOOK_SEED: &[u8] = b"book";
pub const POSITION_SEED: &[u8] = b"pos";

/// Epochs of revenue history used for the credit limit.
pub const REVENUE_WINDOW: usize = 10;

/// Alpenglow admission ticket: 1.6 SOL per epoch, charged from the vote account.
pub const ADMISSION_FEE_RESERVE_LAMPORTS: u64 = 1_600_000_000;

/// Consecutive late epochs before an advance can be marked defaulted.
pub const DEFAULT_AFTER_LATE_EPOCHS: u8 = 3;

pub const BPS_DENOMINATOR: u64 = 10_000;
