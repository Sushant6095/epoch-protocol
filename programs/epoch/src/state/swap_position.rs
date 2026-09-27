use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    /// Taker pays the fixed rate and receives the index: gains if fees rise.
    PayFixed,
    /// Taker receives the fixed rate and pays the index: gains if fees fall.
    /// This is the validator's hedge.
    ReceiveFixed,
}

/// A taker's side of one quote (seeds: `["swap", quote, taker]`). The taker's
/// collateral sits on this account above its rent until settlement.
#[account]
#[derive(InitSpace)]
pub struct SwapPosition {
    pub quote: Pubkey,
    pub taker: Pubkey,
    pub epoch: u64,
    pub side: Side,
    pub notional: u64,
    pub fixed_rate: u64,
    pub max_move_bps: u16,
    pub collateral: u64,
    pub settled: bool,
    /// Taker's realised profit (positive) or loss (negative), lamports.
    pub pnl: i64,
    pub bump: u8,
    pub _reserved: [u8; 16],
}
