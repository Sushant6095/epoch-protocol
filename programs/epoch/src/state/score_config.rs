use anchor_lang::prelude::*;

/// Governance settings for `refresh_score` (seeds: `["score_config", pool]`).
#[account]
#[derive(InitSpace, Debug)]
pub struct ScoreConfig {
    pub pool: Pubkey,
    /// Epoch's market maker: only swaps against its quotes count as a hedge
    /// (`post_quote` is open to any key). Default: nobody is hedged.
    pub market_maker: Pubkey,
    /// Finished epochs the credits ratio and the commission look back over.
    pub credits_window_epochs: u8,
    /// Count the vote account's block-revenue commission (turn on once
    /// SIMD-0123 makes it binding).
    pub count_block_commission: bool,
    /// Credits ÷ TVC maximum, bps, that scores as the cluster average.
    pub credits_reference_bps: u16,
    /// The vote copy `refresh_score` uses must be at most this many slots old.
    pub max_copy_age_slots: u32,
    pub bump: u8,
    pub _reserved: [u8; 64],
}
