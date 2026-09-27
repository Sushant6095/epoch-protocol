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
