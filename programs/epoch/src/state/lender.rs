use anchor_lang::prelude::*;

use super::Tranche;

/// A lender's share balance in one tranche (seeds: `["lender", pool, owner, tranche]`).
/// Shares are an internal ledger, not SPL tokens, so no token program is
/// involved and a transfer of shares is not possible without going through
/// the withdrawal queue.
#[account]
#[derive(InitSpace)]
pub struct LenderShares {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub tranche: Tranche,
    /// Shares the lender can request to withdraw.
    pub shares: u64,
    /// Shares locked in open withdrawal requests.
    pub pending_shares: u64,
    /// Epoch of the most recent deposit; junior lock counts from here.
    pub last_deposit_epoch: u64,
    pub total_deposited: u64,
    pub total_withdrawn: u64,
    pub bump: u8,
    pub _reserved: [u8; 16],
}
