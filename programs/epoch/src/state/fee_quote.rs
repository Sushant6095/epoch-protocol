use anchor_lang::prelude::*;

/// A market maker's fixed-rate quote for one epoch of the Fee Index
/// (seeds: `["quote", maker, epoch]`). The maker's collateral sits on this
/// account above its rent; each open swap locks the maker's maximum loss.
#[account]
#[derive(InitSpace)]
pub struct FeeQuote {
    pub pool: Pubkey,
    pub maker: Pubkey,
    pub epoch: u64,
    /// Fixed index level the maker will settle against.
    pub fixed_rate: u64,
    pub max_notional: u64,
    pub filled_notional: u64,
    /// Payoff is clipped to ±`max_move_bps` of notional, so collateral on
    /// both sides is exactly `notional × max_move_bps / 10_000`.
    pub max_move_bps: u16,
    pub expiry_slot: u64,
    /// Maker collateral held on this account (lamports above rent).
    pub collateral: u64,
    /// Part of `collateral` locked by open swaps.
    pub locked_collateral: u64,
    pub open_swaps: u32,
    pub bump: u8,
    pub _reserved: [u8; 16],
}
