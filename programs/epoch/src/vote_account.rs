//! Reads the head of a vote account without deserializing the whole state.
//!
//! Full `VoteStateV4` deserialization walks the vote tower and 60+ epochs of
//! credits; the program only needs the fields at the front of the buffer,
//! which sit at fixed offsets in every supported version:
//!
//! ```text
//! u32 version         1 = V1_14_11, 2 = V3, 3 = V4
//! [u8; 32] node_pubkey
//! [u8; 32] authorized_withdrawer
//! V4:  [u8;32] inflation_rewards_collector, [u8;32] block_revenue_collector,
//!      u16 inflation_rewards_commission_bps, u16 block_revenue_commission_bps,
//!      u64 pending_delegator_rewards, ...
//! V3 / V1_14_11: u8 commission (percent), ...
//! ```
//!
//! The layout is pinned by unit tests against `solana-vote-interface`'s own
//! serializer, so a change upstream fails the build's test run, not mainnet.

use anchor_lang::prelude::*;

use crate::{constants::VOTE_PROGRAM_ID, errors::EpochError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoteStateVersion {
    V1_14_11,
    V3,
    V4,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoteHeader {
    pub version: VoteStateVersion,
    pub node_pubkey: Pubkey,
    pub authorized_withdrawer: Pubkey,
    /// `None` before v4 (the runtime then uses the vote account itself).
    pub inflation_rewards_collector: Option<Pubkey>,
    /// `None` before v4 (the runtime then uses the identity).
    pub block_revenue_collector: Option<Pubkey>,
    pub inflation_rewards_commission_bps: u16,
    pub block_revenue_commission_bps: u16,
    /// Lamports in the vote account that belong to delegators (SIMD-0123).
    /// Zero before v4.
    pub pending_delegator_rewards: u64,
}

const PUBKEY_LEN: usize = 32;

fn read_pubkey(data: &[u8], at: usize) -> Option<Pubkey> {
    data.get(at..at + PUBKEY_LEN)
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .map(Pubkey::new_from_array)
}

fn read_u16(data: &[u8], at: usize) -> Option<u16> {
    data.get(at..at + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
}

fn read_u32(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 4)
        .and_then(|b| <[u8; 4]>::try_from(b).ok())
        .map(u32::from_le_bytes)
}

fn read_u64(data: &[u8], at: usize) -> Option<u64> {
    data.get(at..at + 8)
        .and_then(|b| <[u8; 8]>::try_from(b).ok())
        .map(u64::from_le_bytes)
}

impl VoteHeader {
    /// Parse the head of `data`. Returns `None` for an unsupported or
    /// truncated buffer.
    pub fn parse(data: &[u8]) -> Option<Self> {
        let version = read_u32(data, 0)?;
        let node_pubkey = read_pubkey(data, 4)?;
        let authorized_withdrawer = read_pubkey(data, 36)?;
        match version {
            1 | 2 => {
                let commission_pct = *data.get(68)?;
                let bps = u16::from(commission_pct).saturating_mul(100);
                Some(Self {
                    version: if version == 1 {
                        VoteStateVersion::V1_14_11
                    } else {
                        VoteStateVersion::V3
                    },
                    node_pubkey,
                    authorized_withdrawer,
                    inflation_rewards_collector: None,
                    block_revenue_collector: None,
                    inflation_rewards_commission_bps: bps,
                    block_revenue_commission_bps: 10_000,
                    pending_delegator_rewards: 0,
                })
            }
            3 => Some(Self {
                version: VoteStateVersion::V4,
                node_pubkey,
                authorized_withdrawer,
                inflation_rewards_collector: Some(read_pubkey(data, 68)?),
                block_revenue_collector: Some(read_pubkey(data, 100)?),
                inflation_rewards_commission_bps: read_u16(data, 132)?,
                block_revenue_commission_bps: read_u16(data, 134)?,
                pending_delegator_rewards: read_u64(data, 136)?,
            }),
            _ => None,
        }
    }

    /// Load from an account, checking the owner first.
    pub fn load(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*account.owner, VOTE_PROGRAM_ID, EpochError::NotAVoteAccount);
        let data = account.try_borrow_data()?;
        Self::parse(&data).ok_or_else(|| error!(EpochError::UnsupportedVoteState))
    }

    /// Effective commission for scoring: the higher of the two rates.
    pub fn max_commission_bps(&self) -> u16 {
        self.inflation_rewards_commission_bps
            .max(self.block_revenue_commission_bps)
    }
}

// ── Voting record: the newest vote and the per-epoch credits ───────────────
//
// Adapted from jito-foundation_stakenet/utils/vote-state/src/lib.rs
// (`VoteStateVersions::deserialize_epoch_credits`, Apache-2.0): the same walk
// over the bincode layout to the credit list, changed to borrow instead of
// allocating a `Vec`, to bounds-check every read (the original indexes
// `data[i]` and can panic on a short buffer), to cap the list at the runtime's
// 64 epochs, and to also return the slot of the newest vote.

/// Most votes a tower holds (`MAX_LOCKOUT_HISTORY`).
pub const MAX_TOWER_VOTES: u64 = 31;
/// Most epochs of credits a vote account keeps (`MAX_EPOCH_CREDITS_HISTORY`).
pub const MAX_EPOCH_CREDITS: u64 = 64;

const U64_LEN: usize = 8;
/// One `(epoch, credits, prev_credits)` row.
const CREDITS_ROW_LEN: usize = 24;
/// `Lockout { slot: u64, confirmation_count: u32 }`.
const LOCKOUT_LEN: usize = 12;
/// `LandedVote { latency: u8, lockout: Lockout }`.
const LANDED_VOTE_LEN: usize = 13;
/// `(Epoch, Pubkey)` in `AuthorizedVoters`.
const AUTHORIZED_VOTER_LEN: usize = 40;
/// `CircBuf<(Pubkey, Epoch, Epoch)>`: 32 × 48 bytes + `idx: usize` + `is_empty: bool`.
const PRIOR_VOTERS_LEN: usize = 32 * 48 + 8 + 1;
/// Compressed BLS public key in `VoteStateV4`.
const BLS_PUBKEY_LEN: usize = 48;
/// Offset of the vote list before V4: tag + node + withdrawer + commission (u8).
const PRE_V4_VOTES_AT: usize = 4 + 32 + 32 + 1;
/// Offset of V4's `Option<bls_pubkey>` tag: tag + 4 keys + 2 × u16 + u64.
const V4_BLS_OPTION_AT: usize = 4 + 4 * 32 + 2 + 2 + 8;

/// One row of the vote account's credit history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EpochCredits {
    pub epoch: u64,
    /// Cumulative credits at the end of `epoch` (or now, for the current one).
    pub credits: u64,
    /// Cumulative credits at the start of `epoch`.
    pub prev_credits: u64,
}

impl EpochCredits {
    /// Credits earned during `epoch`.
    pub fn earned(&self) -> u64 {
        self.credits.saturating_sub(self.prev_credits)
    }
}

/// The back half of a vote account: the newest vote in the tower and the
/// credit history, borrowed from the account data.
#[derive(Debug, Clone, Copy)]
pub struct VoteRecord<'a> {
    pub version: VoteStateVersion,
    /// Slot of the newest vote in the tower; `None` for an empty tower.
    pub last_voted_slot: Option<u64>,
    pub root_slot: Option<u64>,
    /// `len × 24` bytes of `(epoch, credits, prev_credits)`, oldest first.
    credit_rows: &'a [u8],
}

impl<'a> VoteRecord<'a> {
    /// Parse the voting record of a V1_14_11, V3 or V4 vote state. Returns
    /// `None` for any other version or a malformed or truncated buffer.
    pub fn parse(data: &'a [u8]) -> Option<Self> {
        let (version, votes_at, vote_len, slot_in_vote, prior_voters) = match read_u32(data, 0)? {
            1 => (
                VoteStateVersion::V1_14_11,
                PRE_V4_VOTES_AT,
                LOCKOUT_LEN,
                0,
                PRIOR_VOTERS_LEN,
            ),
            2 => (
                VoteStateVersion::V3,
                PRE_V4_VOTES_AT,
                LANDED_VOTE_LEN,
                1,
                PRIOR_VOTERS_LEN,
            ),
            3 => {
                let votes_at = match *data.get(V4_BLS_OPTION_AT)? {
                    0 => V4_BLS_OPTION_AT + 1,
                    1 => V4_BLS_OPTION_AT + 1 + BLS_PUBKEY_LEN,
                    _ => return None,
                };
                (VoteStateVersion::V4, votes_at, LANDED_VOTE_LEN, 1, 0)
            }
            _ => return None,
        };

        let votes = read_u64(data, votes_at)?;
        if votes > MAX_TOWER_VOTES {
            return None;
        }
        let votes = votes as usize;
        let last_voted_slot = match votes {
            0 => None,
            n => Some(read_u64(
                data,
                votes_at + U64_LEN + (n - 1) * vote_len + slot_in_vote,
            )?),
        };

        let root_at = votes_at + U64_LEN + votes * vote_len;
        let (root_slot, voters_at) = match *data.get(root_at)? {
            0 => (None, root_at + 1),
            1 => (Some(read_u64(data, root_at + 1)?), root_at + 1 + U64_LEN),
            _ => return None,
        };

        let voters = usize::try_from(read_u64(data, voters_at)?).ok()?;
        let credits_at = voters
            .checked_mul(AUTHORIZED_VOTER_LEN)?
            .checked_add(voters_at + U64_LEN + prior_voters)?;
        let rows = read_u64(data, credits_at)?;
        if rows > MAX_EPOCH_CREDITS {
            return None;
        }
        let start = credits_at + U64_LEN;
        let credit_rows = data.get(start..start + rows as usize * CREDITS_ROW_LEN)?;

        Some(Self {
            version,
            last_voted_slot,
            root_slot,
            credit_rows,
        })
    }

    /// Parse, mapping failure to `UnsupportedVoteState`. The caller checks the
    /// owner (the `Accounts` constraint) and holds the data borrow.
    pub fn parse_or_err(data: &'a [u8]) -> Result<Self> {
        Self::parse(data).ok_or_else(|| error!(EpochError::UnsupportedVoteState))
    }

    /// Number of epochs in the credit history.
    pub fn credit_epochs(&self) -> usize {
        self.credit_rows.len() / CREDITS_ROW_LEN
    }

    /// The credit history, oldest first.
    pub fn epoch_credits(&self) -> impl Iterator<Item = EpochCredits> + 'a {
        self.credit_rows
            .chunks_exact(CREDITS_ROW_LEN)
            .map(|row| EpochCredits {
                epoch: u64_at(row, 0),
                credits: u64_at(row, 8),
                prev_credits: u64_at(row, 16),
            })
    }

    /// Credits earned in `epoch`, if the history holds it.
    pub fn earned_in(&self, epoch: u64) -> Option<u64> {
        self.epoch_credits()
            .find(|row| row.epoch == epoch)
            .map(|row| row.earned())
    }

    /// Epochs in the history in which the validator earned credits.
    pub fn epochs_with_credits(&self) -> u16 {
        self.epoch_credits().filter(|row| row.earned() > 0).count() as u16
    }
}

/// `row` is always a 24-byte chunk, so the reads cannot fail.
fn u64_at(row: &[u8], at: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&row[at..at + 8]);
    u64::from_le_bytes(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_vote_interface::state::{VoteStateV3, VoteStateV4, VoteStateVersions};

    fn key(n: u8) -> [u8; 32] {
        [n; 32]
    }

    #[test]
    fn parses_v4_head_exactly_as_the_vote_crate_serializes_it() {
        let v4 = VoteStateV4 {
            node_pubkey: key(1).into(),
            authorized_withdrawer: key(2).into(),
            inflation_rewards_collector: key(3).into(),
            block_revenue_collector: key(4).into(),
            inflation_rewards_commission_bps: 550,
            block_revenue_commission_bps: 9_000,
            pending_delegator_rewards: 123_456_789,
            ..VoteStateV4::default()
        };
        let bytes = bincode::serialize(&VoteStateVersions::new_v4(v4)).unwrap();
        let h = VoteHeader::parse(&bytes).unwrap();
        assert_eq!(h.version, VoteStateVersion::V4);
        assert_eq!(h.node_pubkey, Pubkey::new_from_array(key(1)));
        assert_eq!(h.authorized_withdrawer, Pubkey::new_from_array(key(2)));
        assert_eq!(
            h.inflation_rewards_collector,
            Some(Pubkey::new_from_array(key(3)))
        );
        assert_eq!(
            h.block_revenue_collector,
            Some(Pubkey::new_from_array(key(4)))
        );
        assert_eq!(h.inflation_rewards_commission_bps, 550);
        assert_eq!(h.block_revenue_commission_bps, 9_000);
        assert_eq!(h.pending_delegator_rewards, 123_456_789);
        assert_eq!(h.max_commission_bps(), 9_000);
    }

    #[test]
    fn parses_v3_head_and_scales_commission_to_bps() {
        let v3 = VoteStateV3 {
            node_pubkey: key(7).into(),
            authorized_withdrawer: key(8).into(),
            commission: 7,
            ..VoteStateV3::default()
        };
        let bytes = bincode::serialize(&VoteStateVersions::new_v3(v3)).unwrap();
        let h = VoteHeader::parse(&bytes).unwrap();
        assert_eq!(h.version, VoteStateVersion::V3);
        assert_eq!(h.node_pubkey, Pubkey::new_from_array(key(7)));
        assert_eq!(h.authorized_withdrawer, Pubkey::new_from_array(key(8)));
        assert_eq!(h.inflation_rewards_commission_bps, 700);
        assert_eq!(h.pending_delegator_rewards, 0);
        assert_eq!(h.inflation_rewards_collector, None);
    }

    // ── Voting record against real mainnet bytes ──
    //
    // `programs/epoch/fixtures/mainnet/vote-<address>.bin`: raw account data
    // fetched once from api.mainnet-beta.solana.com (`getMultipleAccounts`,
    // base64, finalized) on 7 Oct 2026 at slot 454,150,230 (epoch 1051); the
    // V1_14_11 account at slot 454,150,293. Expected values were decoded
    // independently (a Python walk of the bincode layout).

    const V4_CCAHC2: &[u8] =
        include_bytes!("../fixtures/mainnet/vote-CcaHc2L43ZWjwCHART3oZoJvHLAe9hzT2DJNUpBzoTN1.bin");
    const V4_HELIUS: &[u8] =
        include_bytes!("../fixtures/mainnet/vote-he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk.bin");
    const V4_NO_BLS_NO_VOTES: &[u8] =
        include_bytes!("../fixtures/mainnet/vote-DCKzmGmerGSkxFD7hXBdYx9s6m1xQdHa5DnG2FdJog6M.bin");
    const V3_R1VAO: &[u8] =
        include_bytes!("../fixtures/mainnet/vote-R1vAoSPFQdCc6wsAEMtxWXjqptSeN1YUiq2Zni1of21.bin");
    const V1_14_11_8ELJ: &[u8] =
        include_bytes!("../fixtures/mainnet/vote-8ELJd5pyMH6VGpFjpDTMFiPVi1VxCpnqWy3B81nL5eTt.bin");

    fn rows(r: &VoteRecord) -> Vec<EpochCredits> {
        r.epoch_credits().collect()
    }

    #[test]
    fn mainnet_v4_with_bls_key() {
        let r = VoteRecord::parse(V4_CCAHC2).unwrap();
        assert_eq!(r.version, VoteStateVersion::V4);
        assert_eq!(r.last_voted_slot, Some(454_150_229));
        assert_eq!(r.root_slot, Some(454_150_198));
        assert_eq!(r.credit_epochs(), 64);
        let rows = rows(&r);
        assert_eq!(
            rows[0],
            EpochCredits {
                epoch: 988,
                credits: 2_225_316_225,
                prev_credits: 2_218_419_240
            }
        );
        assert_eq!(rows[63].epoch, 1_051);
        assert_eq!(r.earned_in(1_050), Some(6_899_849));
        assert_eq!(r.earned_in(1_051), Some(1_891_189));
        assert_eq!(r.earned_in(987), None);
        assert_eq!(r.epochs_with_credits(), 64);
        // The head parser agrees on the same bytes.
        let h = VoteHeader::parse(V4_CCAHC2).unwrap();
        assert_eq!(h.inflation_rewards_commission_bps, 700);
        assert_eq!(h.block_revenue_commission_bps, 10_000);

        let helius = VoteRecord::parse(V4_HELIUS).unwrap();
        assert_eq!(helius.last_voted_slot, Some(454_150_229));
        assert_eq!(helius.earned_in(1_049), Some(6_903_666));
        assert_eq!(
            VoteHeader::parse(V4_HELIUS)
                .unwrap()
                .inflation_rewards_commission_bps,
            0
        );
    }

    #[test]
    fn mainnet_v4_without_bls_key_or_votes() {
        let r = VoteRecord::parse(V4_NO_BLS_NO_VOTES).unwrap();
        assert_eq!(r.version, VoteStateVersion::V4);
        assert_eq!(r.last_voted_slot, None);
        assert_eq!(r.root_slot, None);
        assert_eq!(r.credit_epochs(), 0);
        assert_eq!(r.epochs_with_credits(), 0);
    }

    #[test]
    fn mainnet_v3() {
        let r = VoteRecord::parse(V3_R1VAO).unwrap();
        assert_eq!(r.version, VoteStateVersion::V3);
        assert_eq!(r.last_voted_slot, Some(384_048_870));
        assert_eq!(r.root_slot, Some(384_048_839));
        assert_eq!(r.credit_epochs(), 64);
        assert_eq!(rows(&r)[0].epoch, 826);
        assert_eq!(r.earned_in(888), Some(6_878_144));
        assert_eq!(r.earned_in(889), Some(13_952));
    }

    #[test]
    fn mainnet_v1_14_11() {
        let r = VoteRecord::parse(V1_14_11_8ELJ).unwrap();
        assert_eq!(r.version, VoteStateVersion::V1_14_11);
        assert_eq!(r.last_voted_slot, Some(187_098_831));
        assert_eq!(r.root_slot, Some(187_098_799));
        assert_eq!(r.credit_epochs(), 64);
        assert_eq!(
            rows(&r)[0],
            EpochCredits {
                epoch: 370,
                credits: 9_262_719,
                prev_credits: 8_932_693
            }
        );
        assert_eq!(r.earned_in(432), Some(419_800));
        assert_eq!(r.earned_in(433), Some(41_604));
    }

    #[test]
    fn every_truncation_of_real_accounts_is_rejected_not_panicking() {
        for data in [V4_CCAHC2, V3_R1VAO, V1_14_11_8ELJ] {
            let full = VoteRecord::parse(data).unwrap();
            // The record ends at the credit list; anything shorter must fail.
            let needed = full.credit_rows.as_ptr() as usize - data.as_ptr() as usize
                + full.credit_rows.len();
            for len in 0..needed {
                assert!(VoteRecord::parse(&data[..len]).is_none(), "len {len}");
            }
            assert!(VoteRecord::parse(&data[..needed]).is_some());
        }
    }

    #[test]
    fn corrupted_lengths_are_rejected() {
        // A tower longer than 31 votes.
        let mut d = V4_CCAHC2.to_vec();
        d[V4_BLS_OPTION_AT + 1 + BLS_PUBKEY_LEN..][..8].copy_from_slice(&32u64.to_le_bytes());
        assert!(VoteRecord::parse(&d).is_none());
        // An invalid Option tag for the BLS key.
        let mut d = V4_CCAHC2.to_vec();
        d[V4_BLS_OPTION_AT] = 2;
        assert!(VoteRecord::parse(&d).is_none());
        // A huge authorized-voter count cannot overflow the offset maths.
        let r = VoteRecord::parse(V1_14_11_8ELJ).unwrap();
        let voters_at = PRE_V4_VOTES_AT + 8 + 31 * LOCKOUT_LEN + 1 + 8;
        assert_eq!(r.root_slot, Some(187_098_799));
        let mut d = V1_14_11_8ELJ.to_vec();
        d[voters_at..][..8].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(VoteRecord::parse(&d).is_none());
    }

    // ── Voting record against the vote crate's own serializer ──

    fn landed(slot: u64) -> solana_vote_interface::state::LandedVote {
        solana_vote_interface::state::LandedVote {
            latency: 3,
            lockout: solana_vote_interface::state::Lockout::new(slot),
        }
    }

    fn credits() -> Vec<(u64, u64, u64)> {
        vec![(10, 100, 40), (11, 250, 100), (12, 260, 250)]
    }

    #[test]
    fn round_trips_every_supported_version() {
        use solana_vote_interface::state::{VoteState1_14_11, VoteStateV4};

        let mut v3 = VoteStateV3 {
            node_pubkey: key(1).into(),
            authorized_withdrawer: key(2).into(),
            commission: 5,
            ..VoteStateV3::default()
        };
        v3.votes = (100..110).map(landed).collect();
        v3.root_slot = Some(99);
        v3.epoch_credits = credits();

        let v1 = VoteState1_14_11::from(v3.clone());
        let v4 = VoteStateV4 {
            node_pubkey: key(1).into(),
            authorized_withdrawer: key(2).into(),
            votes: (200..231).map(landed).collect(),
            root_slot: None,
            epoch_credits: credits(),
            bls_pubkey_compressed: Some([9u8; 48]),
            ..VoteStateV4::default()
        };
        let v4_no_bls = VoteStateV4 {
            bls_pubkey_compressed: None,
            ..v4.clone()
        };

        let cases = [
            (
                bincode::serialize(&VoteStateVersions::V1_14_11(Box::new(v1))).unwrap(),
                VoteStateVersion::V1_14_11,
                Some(109),
                Some(99),
            ),
            (
                bincode::serialize(&VoteStateVersions::new_v3(v3)).unwrap(),
                VoteStateVersion::V3,
                Some(109),
                Some(99),
            ),
            (
                bincode::serialize(&VoteStateVersions::new_v4(v4)).unwrap(),
                VoteStateVersion::V4,
                Some(230),
                None,
            ),
            (
                bincode::serialize(&VoteStateVersions::new_v4(v4_no_bls)).unwrap(),
                VoteStateVersion::V4,
                Some(230),
                None,
            ),
        ];
        for (bytes, version, last, root) in cases {
            let r = VoteRecord::parse(&bytes).unwrap();
            assert_eq!(r.version, version);
            assert_eq!(r.last_voted_slot, last, "{version:?}");
            assert_eq!(r.root_slot, root, "{version:?}");
            let got: Vec<_> = r
                .epoch_credits()
                .map(|c| (c.epoch, c.credits, c.prev_credits))
                .collect();
            assert_eq!(got, credits(), "{version:?}");
            assert_eq!(r.earned_in(11), Some(150));
            assert_eq!(r.epochs_with_credits(), 3);
        }
    }

    #[test]
    fn rejects_uninitialized_and_truncated() {
        assert!(VoteHeader::parse(&[]).is_none());
        assert!(VoteHeader::parse(&0u32.to_le_bytes()).is_none()); // V0_23_5 tag
        let mut short = 3u32.to_le_bytes().to_vec();
        short.extend_from_slice(&[0u8; 60]);
        assert!(VoteHeader::parse(&short).is_none());
        assert!(VoteHeader::parse(&99u32.to_le_bytes()).is_none());
    }
}
