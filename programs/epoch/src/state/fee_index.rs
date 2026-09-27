use anchor_lang::prelude::*;

use crate::constants::INDEX_HISTORY;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, InitSpace)]
pub struct IndexPoint {
    pub epoch: u64,
    /// Stake-weighted median priority fee, micro-lamports per compute unit.
    pub value: u64,
}

/// The Solana Fee Index (seeds: `["fee_index", pool]`).
///
/// The program is its own oracle: the publisher proposes a value with the
/// hash of its inputs, anyone can finalize it after `dispute_window_slots`,
/// and the admin can veto inside the window. A proposal that moves more than
/// `max_move_bps` from the last finalized value is rejected outright.
/// Readers take `value`/`epoch` directly; a CPI read is `get_sfi`.
#[account]
#[derive(InitSpace)]
pub struct FeeIndex {
    pub pool: Pubkey,
    pub publisher: Pubkey,
    pub bump: u8,

    /// Last finalized point.
    pub epoch: u64,
    pub value: u64,
    pub inputs_hash: [u8; 32],
    pub finalized_slot: u64,

    /// Pending proposal, valid when `has_proposal`.
    pub has_proposal: bool,
    pub proposed_epoch: u64,
    pub proposed_value: u64,
    pub proposed_inputs_hash: [u8; 32],
    pub proposed_slot: u64,

    pub dispute_window_slots: u64,
    pub max_move_bps: u16,

    pub history: [IndexPoint; INDEX_HISTORY],
    pub history_head: u8,
    pub history_count: u8,
    pub _reserved: [u8; 32],
}

impl FeeIndex {
    pub fn push_history(&mut self, point: IndexPoint) {
        let head = usize::from(self.history_head) % INDEX_HISTORY;
        self.history[head] = point;
        self.history_head = ((head + 1) % INDEX_HISTORY) as u8;
        if usize::from(self.history_count) < INDEX_HISTORY {
            self.history_count += 1;
        }
    }

    /// The finalized value for `epoch`, if it is the current one or still in
    /// the on-chain history.
    pub fn value_for(&self, epoch: u64) -> Option<u64> {
        if self.epoch == epoch && self.finalized_slot > 0 {
            return Some(self.value);
        }
        self.history
            .iter()
            .take(usize::from(self.history_count))
            .find(|p| p.epoch == epoch)
            .map(|p| p.value)
    }
}
