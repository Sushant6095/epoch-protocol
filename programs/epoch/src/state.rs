use anchor_lang::prelude::*;

use crate::constants::REVENUE_WINDOW;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, Default)]
pub struct PoolParams {
    /// Annualised senior target rate, basis points.
    pub senior_target_bps: u16,
    /// Advance rate as a share of trailing revenue (2500 = 25%).
    pub max_advance_bps_unhedged: u16,
    pub max_advance_bps_hedged: u16,
    /// Share of each epoch's revenue swept to lenders (5000 = 50%).
    pub sweep_bps: u16,
    /// Flat fee on principal (200 = 2%).
    pub fee_bps: u16,
    /// Per-validator cap, lamports.
    pub max_per_validator: u64,
    /// Bond multiplier for the bond cap.
    pub bond_multiplier: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub params: PoolParams,
    pub senior_assets: u64,
    pub junior_assets: u64,
    pub senior_shares: u64,
    pub junior_shares: u64,
    pub outstanding_principal: u64,
    pub loss_reserve: u64,
    pub last_accrued_epoch: u64,
    pub paused: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum PositionStatus {
    Onboarded,
    Active,
    Late,
    Defaulted,
    Closed,
}

#[account]
#[derive(InitSpace)]
pub struct ValidatorPosition {
    pub vote: Pubkey,
    pub identity: Pubkey,
    /// Returned to this key on `release`.
    pub original_withdrawer: Pubkey,
    pub bond_stake_account: Option<Pubkey>,
    /// Ring buffer of revenue per epoch, lamports.
    pub revenue: [u64; REVENUE_WINDOW],
    pub revenue_head: u8,
    pub balance_after_last_sweep: u64,
    pub last_scored_epoch: u64,
    pub last_swept_epoch: u64,
    /// 0 to 10,000.
    pub score: u16,
    pub credit_limit: u64,
    pub hedged: bool,
    pub open_advance: Option<Pubkey>,
    pub status: PositionStatus,
    pub late_epochs: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum AdvanceState {
    Active,
    Closed,
    Default,
}

#[account]
#[derive(InitSpace)]
pub struct Advance {
    pub vote: Pubkey,
    pub principal: u64,
    pub fee: u64,
    pub repaid: u64,
    pub sweep_bps: u16,
    pub opened_epoch: u64,
    pub state: AdvanceState,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct FeeIndex {
    pub epoch: u64,
    /// Stake-weighted median priority fee, micro-lamports per compute unit.
    pub value: u64,
    pub posted_slot: u64,
    pub disputed: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Side {
    PayFixed,
    ReceiveFixed,
}

#[account]
#[derive(InitSpace)]
pub struct SwapPosition {
    pub owner: Pubkey,
    pub epoch: u64,
    pub side: Side,
    pub notional: u64,
    pub fixed_rate: u64,
    pub margin: u64,
    pub settled: bool,
    pub bump: u8,
}
