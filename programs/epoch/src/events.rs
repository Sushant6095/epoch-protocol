//! Every state change emits one event. The indexer replays these into
//! Postgres; the Terminal's live feed is a rendering of this file.

use anchor_lang::prelude::*;

use crate::state::{Side, Tranche};

// ── Pool ───────────────────────────────────────────────────────────────────

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub scorer: Pubkey,
}

#[event]
pub struct ParamsUpdated {
    pub pool: Pubkey,
}

#[event]
pub struct PauseToggled {
    pub pool: Pubkey,
    pub paused: bool,
}

#[event]
pub struct Deposited {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub tranche: Tranche,
    pub assets: u64,
    pub shares: u64,
    pub share_price_e9: u64,
}

#[event]
pub struct WithdrawRequested {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub tranche: Tranche,
    pub shares: u64,
    pub seq: u64,
}

#[event]
pub struct WithdrawCancelled {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub seq: u64,
}

#[event]
pub struct WithdrawProcessed {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub tranche: Tranche,
    pub shares: u64,
    pub assets: u64,
    pub seq: u64,
}

#[event]
pub struct Accrued {
    pub pool: Pubkey,
    pub epoch: u64,
    pub income: u64,
    pub protocol_fee: u64,
    pub senior_gain: u64,
    pub junior_gain: u64,
    pub senior_price_e9: u64,
    pub junior_price_e9: u64,
}

// ── Credit ─────────────────────────────────────────────────────────────────

#[event]
pub struct ValidatorOnboarded {
    pub pool: Pubkey,
    pub vote: Pubkey,
    pub identity: Pubkey,
    pub operator: Pubkey,
    pub original_withdrawer: Pubkey,
    pub epoch: u64,
}

#[event]
pub struct CollectorsSet {
    pub vote: Pubkey,
    pub collector: Pubkey,
}

#[event]
pub struct ScoreUpdated {
    pub vote: Pubkey,
    pub epoch: u64,
    pub score: u16,
    pub hedged: bool,
}

#[event]
pub struct BondPosted {
    pub vote: Pubkey,
    pub lamports: u64,
    pub bond_total: u64,
}

#[event]
pub struct BondWithdrawn {
    pub vote: Pubkey,
    pub lamports: u64,
    pub bond_total: u64,
}

#[event]
pub struct AdvanceOpened {
    pub pool: Pubkey,
    pub vote: Pubkey,
    pub advance: Pubkey,
    pub seq: u64,
    pub principal: u64,
    pub fee: u64,
    pub remit_bps: u16,
    pub epoch: u64,
}

#[event]
pub struct Swept {
    pub pool: Pubkey,
    pub vote: Pubkey,
    pub epoch: u64,
    /// Withdrawn from the vote account this sweep.
    pub from_vote: u64,
    /// Total gross revenue processed (vote withdrawal + collector deposits).
    pub gross: u64,
    pub remitted: u64,
    pub to_operator: u64,
}

#[event]
pub struct AdvanceRepaid {
    pub vote: Pubkey,
    pub advance: Pubkey,
    pub epoch: u64,
}

#[event]
pub struct AdvanceDefaulted {
    pub pool: Pubkey,
    pub vote: Pubkey,
    pub advance: Pubkey,
    pub principal_lost: u64,
    pub bond_applied: u64,
    pub epoch: u64,
}

#[event]
pub struct CommissionUpdated {
    pub vote: Pubkey,
    pub kind: u8,
    pub commission_bps: u16,
}

#[event]
pub struct IdentityUpdated {
    pub vote: Pubkey,
    pub new_identity: Pubkey,
}

#[event]
pub struct ValidatorReleased {
    pub pool: Pubkey,
    pub vote: Pubkey,
    pub new_withdrawer: Pubkey,
    pub epoch: u64,
}

// ── Fee index and market ───────────────────────────────────────────────────

#[event]
pub struct IndexProposed {
    pub epoch: u64,
    pub value: u64,
    pub inputs_hash: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct IndexFinalized {
    pub epoch: u64,
    pub value: u64,
    pub inputs_hash: [u8; 32],
    pub slot: u64,
}

#[event]
pub struct IndexVetoed {
    pub epoch: u64,
    pub value: u64,
}

#[event]
pub struct QuotePosted {
    pub quote: Pubkey,
    pub maker: Pubkey,
    pub epoch: u64,
    pub fixed_rate: u64,
    pub max_notional: u64,
    pub max_move_bps: u16,
}

#[event]
pub struct SwapOpened {
    pub quote: Pubkey,
    pub swap: Pubkey,
    pub taker: Pubkey,
    pub epoch: u64,
    pub side: Side,
    pub notional: u64,
    pub fixed_rate: u64,
    pub collateral: u64,
}

#[event]
pub struct SwapSettled {
    pub swap: Pubkey,
    pub epoch: u64,
    pub index_value: u64,
    pub taker_pnl: i64,
}
