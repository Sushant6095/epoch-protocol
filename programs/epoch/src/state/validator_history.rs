//! Adapted from jito-foundation_stakenet/programs/validator-history/src/state.rs
//! (Apache-2.0): the zero-copy per-epoch entry whose fields start at an
//! all-ones "unknown" sentinel, with reserved bytes for later fields. Changed:
//! the ring is indexed by `epoch % HISTORY_LEN` instead of an append-ordered
//! `CircBuf` (no sorted insert or wraparound binary search; backfill in any
//! order is O(1)); epochs are `u64` (no `cast_epoch` limit); MEV is exact
//! lamports instead of 1/100 SOL; the entry carries the TVC maximum, revenue,
//! the last voted slot and Jito's priority-fee data; 64 entries keep the
//! account at 8 KiB (one instruction, ~0.059 SOL) instead of 64 KiB.

use anchor_lang::prelude::*;

use crate::{constants::HISTORY_LEN, errors::EpochError};

pub const UNKNOWN_U64: u64 = u64::MAX;
pub const UNKNOWN_U32: u32 = u32::MAX;
pub const UNKNOWN_U16: u16 = u16::MAX;
pub const UNKNOWN_U8: u8 = u8::MAX;

/// `HistoryEntry::sources` bits: what has been copied into the entry.
pub const SOURCE_VOTE: u8 = 1;
pub const SOURCE_TIP: u8 = 1 << 1;
pub const SOURCE_PRIORITY_FEE: u8 = 1 << 2;
pub const SOURCE_STAKE: u8 = 1 << 3;
/// Credits backfilled from the vote account's history (not a live copy).
pub const SOURCE_CREDITS: u8 = 1 << 4;

/// `ValidatorHistory::score_flags` bits for the last `refresh_score`.
pub const SCORE_FLAG_DELINQUENT: u8 = 1;
pub const SCORE_FLAG_SUPERMINORITY: u8 = 1 << 1;
pub const SCORE_FLAG_HEDGED: u8 = 1 << 2;
pub const SCORE_FLAG_SCORED: u8 = 1 << 3;

pub const VALIDATOR_HISTORY_VERSION: u8 = 1;

/// One epoch of a validator's record. 128 bytes, every field naturally
/// aligned. A field still at its type's maximum is unknown.
#[zero_copy]
#[derive(Debug, PartialEq, Eq)]
pub struct HistoryEntry {
    /// The epoch this entry describes; `UNKNOWN_U64` for an empty slot.
    pub epoch: u64,
    /// Vote credits earned in the epoch (final once the epoch is over).
    pub epoch_credits: u64,
    /// Slots in the epoch × 16: the timely-vote-credit maximum.
    pub max_credits: u64,
    /// Vote-account lamports at the latest copy in the epoch.
    pub vote_lamports: u64,
    /// Revenue by the sweep rule: the most seen above the sweep floor (rent +
    /// pending delegator rewards) in the vote account plus the escrow above
    /// rent, over the epoch's copies. It includes rewards for the previous
    /// epoch that land early in this one.
    pub revenue_lamports: u64,
    /// The tip-distribution merkle root's `max_total_claim`: every lamport of
    /// MEV tips the epoch pays out (stakers plus the validator's commission).
    pub mev_earned_lamports: u64,
    /// Lamports the validator sent to its priority-fee distribution account.
    pub priority_fees_lamports: u64,
    /// Oracle: activated stake.
    pub activated_stake_lamports: u64,
    /// Slot of the newest vote in the tower at the latest copy.
    pub last_voted_slot: u64,
    /// Slot of the latest write from any source.
    pub updated_slot: u64,
    /// Oracle: rank by activated stake (1 = largest).
    pub rank: u32,
    pub inflation_commission_bps: u16,
    pub block_commission_bps: u16,
    pub mev_commission_bps: u16,
    pub priority_fee_commission_bps: u16,
    /// Oracle: 1 when in the superminority, 0 when not.
    pub superminority: u8,
    /// `SOURCE_*` bits.
    pub sources: u8,
    pub _reserved0: [u8; 2],
    pub _reserved: [u8; 32],
}

impl HistoryEntry {
    /// An entry with every field unknown.
    pub const EMPTY: HistoryEntry = HistoryEntry {
        epoch: UNKNOWN_U64,
        epoch_credits: UNKNOWN_U64,
        max_credits: UNKNOWN_U64,
        vote_lamports: UNKNOWN_U64,
        revenue_lamports: UNKNOWN_U64,
        mev_earned_lamports: UNKNOWN_U64,
        priority_fees_lamports: UNKNOWN_U64,
        activated_stake_lamports: UNKNOWN_U64,
        last_voted_slot: UNKNOWN_U64,
        updated_slot: UNKNOWN_U64,
        rank: UNKNOWN_U32,
        inflation_commission_bps: UNKNOWN_U16,
        block_commission_bps: UNKNOWN_U16,
        mev_commission_bps: UNKNOWN_U16,
        priority_fee_commission_bps: UNKNOWN_U16,
        superminority: UNKNOWN_U8,
        sources: 0,
        _reserved0: [0; 2],
        _reserved: [0; 32],
    };

    pub fn empty_for(epoch: u64) -> Self {
        Self {
            epoch,
            ..Self::EMPTY
        }
    }

    pub fn has(&self, source: u8) -> bool {
        self.sources & source != 0
    }
}

pub fn known_u64(v: u64) -> Option<u64> {
    (v != UNKNOWN_U64).then_some(v)
}

pub fn known_u16(v: u16) -> Option<u16> {
    (v != UNKNOWN_U16).then_some(v)
}

/// A validator's on-chain record (seeds: `["history", vote]`). Anyone may
/// create it and copy chain state into it; only `update_stake_info` (the
/// pool's scorer) writes oracle fields.
#[account(zero_copy)]
#[derive(Debug)]
pub struct ValidatorHistory {
    pub vote: Pubkey,
    pub created_epoch: u64,
    /// Slot of the latest `copy_vote_account`.
    pub last_vote_copy_slot: u64,
    /// Epoch and slot of the latest `refresh_score` (0 = never).
    pub refreshed_epoch: u64,
    pub refreshed_slot: u64,
    /// Receive-fixed notional the hedge rule required at the last refresh.
    pub hedge_required_notional: u64,
    /// Epochs with credits in the vote account's own history (≤ 64) at the
    /// latest copy.
    pub epochs_voted: u16,
    // ── Breakdown of the latest `refresh_score` ──
    pub score: u16,
    /// Credits ratio on the score's scale (10,000 = the cluster reference).
    pub credits_ratio_bps: u16,
    /// Credits earned ÷ the TVC maximum over the window, bps.
    pub credits_ratio_raw_bps: u16,
    pub commission_bps: u16,
    pub epochs_active: u16,
    pub bump: u8,
    pub version: u8,
    /// `SCORE_FLAG_*` bits.
    pub score_flags: u8,
    pub _padding: u8,
    pub _reserved: [u8; 64],
    /// Entry for epoch `e` lives at `e % HISTORY_LEN`.
    pub entries: [HistoryEntry; HISTORY_LEN],
}

impl ValidatorHistory {
    pub const SPACE: usize = 8 + core::mem::size_of::<ValidatorHistory>();

    pub fn slot_of(epoch: u64) -> usize {
        (epoch % HISTORY_LEN as u64) as usize
    }

    /// The entry for `epoch`, if the ring holds it.
    pub fn entry(&self, epoch: u64) -> Option<&HistoryEntry> {
        let e = &self.entries[Self::slot_of(epoch)];
        (e.epoch == epoch).then_some(e)
    }

    /// The entry for `epoch`, claiming its slot when it holds an older epoch
    /// (or nothing). Refuses when the slot already holds a newer epoch, so a
    /// late backfill can never overwrite fresher data.
    pub fn entry_mut(&mut self, epoch: u64) -> Result<&mut HistoryEntry> {
        let e = &mut self.entries[Self::slot_of(epoch)];
        if e.epoch != epoch {
            require!(
                e.epoch == UNKNOWN_U64 || e.epoch < epoch,
                EpochError::HistoryEpochOutOfRange
            );
            *e = HistoryEntry::empty_for(epoch);
        }
        Ok(e)
    }

    /// The oldest epoch a write may target when the current epoch is
    /// `current`: the ring holds `current − 63 ..= current`.
    pub fn oldest_writable(current: u64) -> u64 {
        current.saturating_sub(HISTORY_LEN as u64 - 1)
    }

    pub fn set_flag(&mut self, flag: u8, on: bool) {
        if on {
            self.score_flags |= flag;
        } else {
            self.score_flags &= !flag;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> ValidatorHistory {
        ValidatorHistory {
            vote: Pubkey::default(),
            created_epoch: 0,
            last_vote_copy_slot: 0,
            refreshed_epoch: 0,
            refreshed_slot: 0,
            hedge_required_notional: 0,
            epochs_voted: 0,
            score: 0,
            credits_ratio_bps: 0,
            credits_ratio_raw_bps: 0,
            commission_bps: 0,
            epochs_active: 0,
            bump: 0,
            version: VALIDATOR_HISTORY_VERSION,
            score_flags: 0,
            _padding: 0,
            _reserved: [0; 64],
            entries: [HistoryEntry::EMPTY; HISTORY_LEN],
        }
    }

    #[test]
    fn sizes_are_pinned() {
        assert_eq!(core::mem::size_of::<HistoryEntry>(), 128);
        assert_eq!(core::mem::size_of::<ValidatorHistory>(), 152 + 64 * 128);
        assert_eq!(ValidatorHistory::SPACE, 8_352);
        // Created by CPI in one instruction: under the 10 KiB limit.
        assert!(ValidatorHistory::SPACE <= 10_240);
    }

    #[test]
    fn ring_is_indexed_by_epoch() {
        let mut h = blank();
        assert!(h.entry(5).is_none());
        h.entry_mut(5).unwrap().epoch_credits = 42;
        assert_eq!(h.entry(5).unwrap().epoch_credits, 42);
        assert!(h.entry(5 + 64).is_none());
        // A newer epoch claims the slot and starts unknown.
        let e = h.entry_mut(5 + 64).unwrap();
        assert_eq!(e.epoch_credits, UNKNOWN_U64);
        assert!(h.entry(5).is_none());
        // An older epoch can no longer claim it back.
        assert!(h.entry_mut(5).is_err());
        // Backfill in any order.
        for epoch in [100u64, 90, 120, 101] {
            h.entry_mut(epoch).unwrap().epoch_credits = epoch;
        }
        for epoch in [100u64, 90, 120, 101] {
            assert_eq!(h.entry(epoch).unwrap().epoch_credits, epoch);
        }
    }

    #[test]
    fn oldest_writable_epoch() {
        assert_eq!(ValidatorHistory::oldest_writable(1_051), 988);
        assert_eq!(ValidatorHistory::oldest_writable(10), 0);
    }

    #[test]
    fn flags() {
        let mut h = blank();
        h.set_flag(SCORE_FLAG_HEDGED, true);
        h.set_flag(SCORE_FLAG_DELINQUENT, true);
        h.set_flag(SCORE_FLAG_HEDGED, false);
        assert_eq!(h.score_flags, SCORE_FLAG_DELINQUENT);
    }
}
