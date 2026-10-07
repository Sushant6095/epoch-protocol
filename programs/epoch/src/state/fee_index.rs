use anchor_lang::prelude::*;

use crate::{constants::INDEX_HISTORY, errors::EpochError, math::bps_of};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, InitSpace)]
pub struct IndexPoint {
    pub epoch: u64,
    /// Stake-weighted median priority fee, micro-lamports per compute unit.
    pub value: u64,
}

/// The Solana Fee Index (seeds: `["fee_index", pool]`).
///
/// The program is its own oracle: a proposal carries a value and the hash of
/// its inputs, anyone can finalize it after `dispute_window_slots`, and the
/// admin can veto inside the window. A proposal that moves more than
/// `max_move_bps` from the last finalized value is rejected outright.
/// Readers take `value`/`epoch` directly; a CPI read is `get_sfi`.
///
/// Who proposes: `publisher`. With operator consensus on, `publisher` is the
/// `IndexOperators` PDA (no key can sign for it), and proposals come from
/// `IndexBallot`s that reached consensus, or from `post_index` by the sole
/// operator of a one-operator registry. The layout is unchanged.
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
    /// Why a proposal for `epoch` at `value` cannot be written now, if it
    /// cannot, in `post_index`'s order of checks: a pending proposal, an epoch
    /// that is not newer than the last final one, a move above
    /// `max_move_bps`.
    pub fn proposal_blocker(&self, epoch: u64, value: u64) -> Option<EpochError> {
        if self.has_proposal {
            return Some(EpochError::DisputeWindowOpen);
        }
        if epoch <= self.epoch {
            return Some(EpochError::IndexEpochNotNewer);
        }
        if self.finalized_slot > 0 && self.value > 0 {
            let Some(bound) = bps_of(self.value, self.max_move_bps) else {
                return Some(EpochError::MathOverflow);
            };
            if value.abs_diff(self.value) > bound {
                return Some(EpochError::IndexMoveTooLarge);
            }
        }
        None
    }

    /// Why `epoch` cannot be proposed or voted yet on a cluster at `clock_epoch`: it has not started there. The
    /// publisher maps mainnet epoch M to program epoch P = M + FEE_INDEX_EPOCH_OFFSET, or P = the cluster's epoch - 1
    /// (`auto`, devnet), and posts only once P has started, so an honest post is never ahead of the cluster. A future
    /// epoch would reveal a value while its quotes still trade, and once final it would block every later post
    /// (`IndexEpochNotNewer`).
    pub fn start_blocker(epoch: u64, clock_epoch: u64) -> Option<EpochError> {
        (epoch > clock_epoch).then_some(EpochError::IndexEpochNotStarted)
    }

    /// Writes a proposal, the one way every path (`post_index`, ballots)
    /// proposes. The caller emits `IndexProposed`.
    pub fn propose(
        &mut self,
        epoch: u64,
        value: u64,
        inputs_hash: [u8; 32],
        slot: u64,
    ) -> Result<()> {
        if let Some(blocker) = self.proposal_blocker(epoch, value) {
            return Err(blocker.into());
        }
        self.has_proposal = true;
        self.proposed_epoch = epoch;
        self.proposed_value = value;
        self.proposed_inputs_hash = inputs_hash;
        self.proposed_slot = slot;
        Ok(())
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_program_epoch_that_has_not_started_is_refused() {
        // Started: the cluster's previous epoch (`auto`) and its current one.
        assert!(FeeIndex::start_blocker(41, 42).is_none());
        assert!(FeeIndex::start_blocker(42, 42).is_none());
        assert!(FeeIndex::start_blocker(0, 0).is_none());
        // Not started: the next epoch, a far-future one and the largest.
        for future in [43, 1_000_000, u64::MAX] {
            assert!(matches!(
                FeeIndex::start_blocker(future, 42),
                Some(EpochError::IndexEpochNotStarted)
            ));
        }
    }
}
