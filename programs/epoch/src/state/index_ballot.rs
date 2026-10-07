use anchor_lang::prelude::*;

use crate::{
    constants::MAX_INDEX_OPERATORS,
    errors::EpochError,
    math::{agrees, deviation_bps, meets_threshold, tally, WeightedVote},
    state::{FeeIndex, IndexOperators},
};

/// One operator's slot in a ballot round. `operator` and `weight` are copied
/// from the registry when the round opens; the rest is its vote.
#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, Debug, PartialEq, Eq, InitSpace,
)]
pub struct IndexVote {
    pub operator: Pubkey,
    pub weight: u32,
    pub voted: bool,
    /// µL/CU, as `post_index`'s `value`.
    pub value: u64,
    pub inputs_hash: [u8; 32],
    /// Slot of the operator's latest vote this round.
    pub slot: u64,
    /// Distance from the weighted median before consensus, from the agreed
    /// value after it; bps rounded up (`math::consensus::deviation_bps`).
    pub deviation_bps: u32,
    /// Within the tolerance of that same reference value.
    pub agrees: bool,
    /// Cast after consensus: on the record, never counted.
    pub late: bool,
}

/// Where a ballot's round stands against the `FeeIndex`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BallotStatus {
    /// No consensus yet.
    Voting,
    /// Consensus reached; the proposal waits until `FeeIndex` can take it
    /// (an earlier proposal in its window, or a move above `max_move_bps`).
    Queued,
    /// Its proposal is pending in `FeeIndex` (dispute window).
    Proposed,
    /// Its proposal was dropped by `veto_index`: the next vote (or the
    /// admin's reset) opens a new round.
    Vetoed,
    /// `FeeIndex` is final at this epoch or a later one; nothing can be
    /// proposed for it again.
    Settled,
}

/// What `IndexBallot::cast` did with a vote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CastOutcome {
    pub slot_index: usize,
    /// The operator replaced its earlier vote this round.
    pub changed: bool,
    pub late: bool,
    /// This vote made the round reach consensus.
    pub consensus_now: bool,
}

/// One epoch's Fee Index vote (seeds: `["index_ballot", fee_index, epoch]`).
///
/// Adapted from jito-foundation/jito-tip-router/core/src/ballot_box.rs
/// (MIT or Apache-2.0): a per-epoch box of operator votes tallied against the
/// TOTAL registered weight; an operator may change its vote until consensus,
/// its vote is locked after it, and operators that had not voted may still
/// vote late for the record. Changed for a numeric index: votes agree when
/// they fall within `tolerance_bps` of the weighted median instead of being
/// equal, each vote's deviation is stored, the operator set is snapshotted
/// into the ballot (no separate snapshot accounts), one fixed account holds
/// up to eight operators, and a vetoed round reopens in place (`round`).
#[account]
#[derive(InitSpace)]
pub struct IndexBallot {
    pub fee_index: Pubkey,
    pub epoch: u64,
    pub bump: u8,
    /// Paid the rent; `close_index_ballot` refunds it.
    pub payer: Pubkey,
    /// 0 for the first round, +1 for every reopening.
    pub round: u8,
    pub opened_slot: u64,
    /// Snapshot of the registry when the round opened.
    pub threshold_bps: u16,
    pub tolerance_bps: u16,
    pub total_weight: u64,
    pub operator_count: u8,
    pub votes_cast: u8,
    pub votes: [IndexVote; MAX_INDEX_OPERATORS],
    /// Weighted median of the votes cast; frozen at consensus.
    pub median_value: u64,
    /// Weight within the tolerance of the median (of the agreed value after
    /// consensus, late votes included).
    pub agreeing_weight: u64,
    /// 0 until the threshold is met.
    pub consensus_slot: u64,
    pub consensus_value: u64,
    pub consensus_inputs_hash: [u8; 32],
    /// Slot the proposal was written into `FeeIndex`; 0 while queued.
    pub proposed_slot: u64,
    pub _reserved: [u8; 32],
}

impl IndexBallot {
    /// Starts a round: copies the registry and clears every vote and the
    /// consensus. The caller sets `round`.
    pub fn open_round(&mut self, registry: &IndexOperators, slot: u64) -> Result<()> {
        let operators = registry.active();
        require!(!operators.is_empty(), EpochError::NoIndexOperators);
        self.opened_slot = slot;
        self.threshold_bps = registry.threshold_bps;
        self.tolerance_bps = registry.tolerance_bps;
        self.total_weight = registry.total_weight;
        self.operator_count = operators.len() as u8;
        self.votes_cast = 0;
        self.votes = [IndexVote::default(); MAX_INDEX_OPERATORS];
        for (vote, operator) in self.votes.iter_mut().zip(operators) {
            vote.operator = operator.key;
            vote.weight = operator.weight;
        }
        self.median_value = 0;
        self.agreeing_weight = 0;
        self.consensus_slot = 0;
        self.consensus_value = 0;
        self.consensus_inputs_hash = [0; 32];
        self.proposed_slot = 0;
        Ok(())
    }

    pub fn snapshot(&self) -> &[IndexVote] {
        let count = usize::from(self.operator_count).min(MAX_INDEX_OPERATORS);
        &self.votes[..count]
    }

    pub fn has_consensus(&self) -> bool {
        self.consensus_slot > 0
    }

    pub fn status(&self, index: &FeeIndex) -> BallotStatus {
        if index.epoch >= self.epoch {
            BallotStatus::Settled
        } else if !self.has_consensus() {
            BallotStatus::Voting
        } else if self.proposed_slot == 0 {
            BallotStatus::Queued
        } else if index.has_proposal
            && index.proposed_epoch == self.epoch
            && index.proposed_slot == self.proposed_slot
        {
            BallotStatus::Proposed
        } else {
            BallotStatus::Vetoed
        }
    }

    /// Records `operator`'s vote and re-tallies. Before consensus a vote may
    /// be replaced; after it, only an operator that had not voted may vote
    /// (late, for the record).
    pub fn cast(
        &mut self,
        operator: &Pubkey,
        value: u64,
        inputs_hash: [u8; 32],
        slot: u64,
    ) -> Result<CastOutcome> {
        let at = self
            .snapshot()
            .iter()
            .position(|v| v.operator == *operator)
            .ok_or(error!(EpochError::NotIndexOperator))?;
        let consensus_before = self.has_consensus();
        let changed = self.votes[at].voted;
        require!(!(consensus_before && changed), EpochError::VoteLocked);

        let vote = &mut self.votes[at];
        vote.voted = true;
        vote.value = value;
        vote.inputs_hash = inputs_hash;
        vote.slot = slot;
        vote.late = consensus_before;
        if !changed {
            self.votes_cast += 1;
        }

        let consensus_now = self.retally(slot)?;
        Ok(CastOutcome {
            slot_index: at,
            changed,
            late: consensus_before,
            consensus_now,
        })
    }

    /// Recomputes the median, agreement and deviations; sets the consensus
    /// fields when the threshold is first met. Returns whether it was met
    /// now.
    fn retally(&mut self, slot: u64) -> Result<bool> {
        if self.has_consensus() {
            // Everything is measured against the agreed value from here on.
            let reference = self.consensus_value;
            let mut agreeing: u64 = 0;
            for vote in self.votes.iter_mut().filter(|v| v.voted) {
                vote.deviation_bps = deviation_bps(vote.value, reference);
                vote.agrees = agrees(vote.value, reference, self.tolerance_bps);
                if vote.agrees {
                    agreeing = agreeing
                        .checked_add(u64::from(vote.weight))
                        .ok_or(EpochError::MathOverflow)?;
                }
            }
            self.agreeing_weight = agreeing;
            return Ok(false);
        }

        let mut cast = [WeightedVote {
            value: 0,
            weight: 0,
        }; MAX_INDEX_OPERATORS];
        for (out, vote) in cast.iter_mut().zip(self.snapshot()) {
            if vote.voted {
                *out = WeightedVote {
                    value: vote.value,
                    weight: u64::from(vote.weight),
                };
            }
        }
        let Some(result) = tally(&cast, self.tolerance_bps) else {
            return Ok(false);
        };
        self.median_value = result.median;
        self.agreeing_weight = result.agreeing_weight;
        for vote in self.votes.iter_mut().filter(|v| v.voted) {
            vote.deviation_bps = deviation_bps(vote.value, result.median);
            vote.agrees = agrees(vote.value, result.median, self.tolerance_bps);
        }

        if !meets_threshold(
            result.agreeing_weight,
            self.total_weight,
            self.threshold_bps,
        ) {
            return Ok(false);
        }
        // The median is a cast value, so some agreeing vote carries it: its
        // inputs hash is the one anyone can recompute the value from.
        let carrier = self
            .snapshot()
            .iter()
            .find(|v| v.voted && v.value == result.median)
            .ok_or(EpochError::MathOverflow)?;
        self.consensus_inputs_hash = carrier.inputs_hash;
        self.consensus_value = result.median;
        self.consensus_slot = slot.max(1);
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        constants::INDEX_HISTORY,
        state::{IndexOperator, IndexPoint},
    };

    fn registry(weights: &[u32]) -> (IndexOperators, Vec<Pubkey>) {
        let keys: Vec<Pubkey> = weights.iter().map(|_| Pubkey::new_unique()).collect();
        let mut r = IndexOperators {
            fee_index: Pubkey::new_unique(),
            bump: 255,
            threshold_bps: 6_667,
            tolerance_bps: 100,
            operator_count: 0,
            total_weight: 0,
            operators: [IndexOperator::default(); MAX_INDEX_OPERATORS],
            _reserved: [0; 64],
        };
        for (key, weight) in keys.iter().zip(weights) {
            r.add(*key, *weight).unwrap();
        }
        (r, keys)
    }

    fn ballot(r: &IndexOperators, epoch: u64) -> IndexBallot {
        let mut b = IndexBallot {
            fee_index: r.fee_index,
            epoch,
            bump: 255,
            payer: Pubkey::new_unique(),
            round: 0,
            opened_slot: 0,
            threshold_bps: 0,
            tolerance_bps: 0,
            total_weight: 0,
            operator_count: 0,
            votes_cast: 0,
            votes: [IndexVote::default(); MAX_INDEX_OPERATORS],
            median_value: 0,
            agreeing_weight: 0,
            consensus_slot: 0,
            consensus_value: 0,
            consensus_inputs_hash: [0; 32],
            proposed_slot: 0,
            _reserved: [0; 32],
        };
        b.open_round(r, 10).unwrap();
        b
    }

    fn fee_index(epoch: u64) -> FeeIndex {
        FeeIndex {
            pool: Pubkey::new_unique(),
            publisher: Pubkey::new_unique(),
            bump: 255,
            epoch,
            value: 1_000,
            inputs_hash: [0; 32],
            finalized_slot: if epoch > 0 { 5 } else { 0 },
            has_proposal: false,
            proposed_epoch: 0,
            proposed_value: 0,
            proposed_inputs_hash: [0; 32],
            proposed_slot: 0,
            dispute_window_slots: 100,
            max_move_bps: 2_000,
            history: [IndexPoint::default(); INDEX_HISTORY],
            history_head: 0,
            history_count: 0,
            _reserved: [0; 32],
        }
    }

    #[test]
    fn layout_size() {
        assert_eq!(IndexVote::INIT_SPACE, 91);
        assert_eq!(8 + IndexBallot::INIT_SPACE, 936);
    }

    #[test]
    fn two_of_three_reach_consensus_and_the_third_votes_late() {
        let (r, k) = registry(&[1, 1, 1]);
        let mut b = ballot(&r, 7);
        let first = b.cast(&k[0], 1_000, [1; 32], 11).unwrap();
        assert!(!first.consensus_now && !first.changed);
        assert_eq!(b.agreeing_weight, 1);
        let second = b.cast(&k[1], 1_004, [2; 32], 12).unwrap();
        assert!(second.consensus_now);
        assert_eq!((b.consensus_value, b.consensus_slot), (1_000, 12));
        assert_eq!(b.consensus_inputs_hash, [1; 32]);
        assert_eq!(b.votes[1].deviation_bps, 40);

        // A cast vote is locked after consensus.
        assert!(b.cast(&k[0], 999, [9; 32], 13).is_err());
        // The third operator votes late: recorded, measured against the
        // agreed value, never counted.
        let late = b.cast(&k[2], 1_500, [3; 32], 14).unwrap();
        assert!(late.late && !late.consensus_now);
        assert_eq!(b.consensus_value, 1_000);
        assert_eq!(b.votes[2].deviation_bps, 5_000);
        assert!(!b.votes[2].agrees && b.votes[2].late);
        assert_eq!(b.votes_cast, 3);
        assert_eq!(b.agreeing_weight, 2);
    }

    #[test]
    fn a_vote_may_change_before_consensus() {
        let (r, k) = registry(&[1, 1, 1]);
        let mut b = ballot(&r, 7);
        b.cast(&k[0], 1_000, [1; 32], 11).unwrap();
        b.cast(&k[1], 2_000, [2; 32], 12).unwrap();
        assert!(!b.has_consensus());
        assert_eq!(b.agreeing_weight, 1);
        let changed = b.cast(&k[1], 1_002, [4; 32], 13).unwrap();
        assert!(changed.changed && changed.consensus_now);
        assert_eq!(b.votes_cast, 2);
        assert_eq!(b.consensus_value, 1_000);
    }

    #[test]
    fn dissent_is_recorded() {
        let (r, k) = registry(&[1, 1, 1]);
        let mut b = ballot(&r, 7);
        b.cast(&k[2], 1_500, [3; 32], 11).unwrap();
        b.cast(&k[0], 1_000, [1; 32], 12).unwrap();
        assert!(!b.has_consensus(), "1,000 and 1,500 do not agree");
        let third = b.cast(&k[1], 1_004, [2; 32], 13).unwrap();
        assert!(third.consensus_now);
        assert_eq!(b.consensus_value, 1_004);
        assert_eq!(b.consensus_inputs_hash, [2; 32]);
        assert!(!b.votes[2].agrees);
        assert_eq!(b.votes[2].deviation_bps, 4_941);
        assert_eq!(b.agreeing_weight, 2);
    }

    #[test]
    fn strangers_are_refused_and_rounds_reset() {
        let (r, k) = registry(&[1, 1, 1]);
        let mut b = ballot(&r, 7);
        assert!(b.cast(&Pubkey::new_unique(), 1, [0; 32], 11).is_err());
        b.cast(&k[0], 1_000, [1; 32], 11).unwrap();
        b.cast(&k[1], 1_000, [1; 32], 11).unwrap();
        assert!(b.has_consensus());
        b.round += 1;
        b.open_round(&r, 50).unwrap();
        assert!(!b.has_consensus());
        assert_eq!((b.votes_cast, b.agreeing_weight, b.opened_slot), (0, 0, 50));
        assert!(b.snapshot().iter().all(|v| !v.voted));
    }

    #[test]
    fn single_operator_is_consensus_alone() {
        let (r, k) = registry(&[3]);
        let mut b = ballot(&r, 7);
        assert!(b.cast(&k[0], 777, [7; 32], 11).unwrap().consensus_now);
        assert_eq!(b.consensus_value, 777);
    }

    #[test]
    fn status_against_the_fee_index() {
        let (r, k) = registry(&[1, 1, 1]);
        let mut b = ballot(&r, 7);
        let mut index = fee_index(6);
        assert_eq!(b.status(&index), BallotStatus::Voting);
        b.cast(&k[0], 1_000, [1; 32], 11).unwrap();
        b.cast(&k[1], 1_000, [1; 32], 11).unwrap();
        assert_eq!(b.status(&index), BallotStatus::Queued);
        b.proposed_slot = 20;
        index.has_proposal = true;
        index.proposed_epoch = 7;
        index.proposed_slot = 20;
        assert_eq!(b.status(&index), BallotStatus::Proposed);
        index.has_proposal = false;
        assert_eq!(b.status(&index), BallotStatus::Vetoed);
        index.epoch = 7;
        assert_eq!(b.status(&index), BallotStatus::Settled);
        index.epoch = 9;
        assert_eq!(b.status(&index), BallotStatus::Settled);
    }
}
