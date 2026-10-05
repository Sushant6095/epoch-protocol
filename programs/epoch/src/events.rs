//! Every state change emits one event. The indexer replays these into
//! Postgres; the Terminal's live feed is a rendering of this file.

use anchor_lang::prelude::*;

use crate::state::{BuybackVenue, Side, Tranche};

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

/// `reason`: 0 = cancelled by the owner, 1 = bounced by the junior floor
/// when it reached the head of the queue (shares returned to the owner).
#[event]
pub struct WithdrawCancelled {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub seq: u64,
    pub reason: u8,
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

// ── Revenue tokens ─────────────────────────────────────────────────────────

#[event]
pub struct RevenueTokenRegistered {
    pub pool: Pubkey,
    pub vote: Pubkey,
    pub revenue_token: Pubkey,
    pub mint: Pubkey,
    pub dbc_pool: Pubkey,
    pub share_bps: u16,
    pub term_epochs: u16,
    pub start_epoch: u64,
    pub term_end_epoch: u64,
    pub inflation_commission_bps: u16,
    pub block_commission_bps: u16,
}

/// The revenue share a sweep moved into the buyback escrow (emitted next to
/// `Swept`, whose `gross` includes it).
#[event]
pub struct RevenueShareSwept {
    pub vote: Pubkey,
    pub mint: Pubkey,
    pub epoch: u64,
    pub gross: u64,
    pub share: u64,
    /// The share came after a pre-registration advance's remittance.
    pub after_senior_advance: bool,
    /// Escrow balance above rent after the sweep.
    pub escrow_balance: u64,
}

#[event]
pub struct RevenueTokenPoolSynced {
    pub vote: Pubkey,
    pub mint: Pubkey,
    pub dbc_pool: Pubkey,
    pub damm_pool: Pubkey,
    pub damm_config: Pubkey,
}

#[event]
pub struct BuybackExecuted {
    pub vote: Pubkey,
    pub mint: Pubkey,
    pub venue: BuybackVenue,
    pub epoch: u64,
    pub slice: u8,
    /// SOL the swap used (a partial fill returns the rest to the escrow).
    pub lamports_in: u64,
    pub tokens_bought: u64,
    pub tokens_burned: u64,
    pub min_amount_out: u64,
    /// The pool's output for `lamports_in` before fees, from its state at
    /// execution: the protocol's reference for the min-out floor.
    pub fee_free_out: u64,
    /// Escrow balance above rent after the slice.
    pub escrow_balance: u64,
}

#[event]
pub struct RevenueTokenRedeemed {
    pub vote: Pubkey,
    pub mint: Pubkey,
    pub holder: Pubkey,
    pub tokens_burned: u64,
    pub lamports_out: u64,
    pub circulating_supply: u64,
    pub epoch: u64,
}

#[event]
pub struct RevenueTokenConfigured {
    pub vote: Pubkey,
    pub slices_per_epoch: u8,
    pub window_slots: u32,
    pub max_slippage_bps: u16,
    pub max_impact_bps: u16,
    pub flags: u8,
}

#[event]
pub struct RevenueTokenClosed {
    pub vote: Pubkey,
    pub mint: Pubkey,
    pub total_escrowed: u64,
    pub total_spent: u64,
    pub total_burned: u64,
    pub total_redeemed: u64,
    /// Escrow left unclaimed after the redemption grace period, booked as
    /// pool income (0 when the escrow was spent). Appended: older decoders
    /// that ignore trailing bytes still read the fields above.
    pub lamports_to_pool: u64,
}

// ── Partner treasury claims ────────────────────────────────────────────────

/// What a treasury claim collected (`TreasuryClaimed.kind`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum TreasuryClaimKind {
    /// DBC partner trading fees (`claim_trading_fee`): SOL and, on a pool that
    /// collects fees in the output token, revenue tokens.
    TradingFee,
    /// The partner's share of a completed curve's surplus (SOL).
    Surplus,
    /// The partner's share of the DBC migration fee (SOL).
    MigrationFee,
    /// Unsold supply of a fixed-supply curve after graduation (tokens, all burned).
    Leftover,
    /// Fees of a DAMM v2 position the treasury owns: SOL and revenue tokens.
    LpFee,
}

/// The partner treasury claimed from Meteora. SOL went to the vault as pool
/// income (`income_unallocated`, paid out at the next `accrue`: protocol fee,
/// senior coupon, then junior); tokens were burned.
#[event]
pub struct TreasuryClaimed {
    pub pool: Pubkey,
    pub kind: TreasuryClaimKind,
    /// The token (DBC base mint / DAMM v2 token A).
    pub mint: Pubkey,
    /// The DBC pool, or the DAMM v2 pool for `LpFee`.
    pub source: Pubkey,
    /// The DAMM v2 position for `LpFee`, the default key otherwise.
    pub position: Pubkey,
    pub cranker: Pubkey,
    /// Wrapped SOL Meteora paid to the treasury.
    pub lamports_claimed: u64,
    /// Lamports added to the pool's cash and income (the claim plus anything
    /// already sitting on the claim account's address).
    pub lamports_to_pool: u64,
    /// Tokens Meteora paid to the treasury.
    pub tokens_claimed: u64,
    /// Tokens burned: the claim plus anything already in the treasury's
    /// token account.
    pub tokens_burned: u64,
    /// The pool's cash and undistributed income after the claim.
    pub pool_cash: u64,
    pub income_unallocated: u64,
}
