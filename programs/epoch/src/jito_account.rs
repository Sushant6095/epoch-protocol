//! Readers for Jito's per-epoch distribution accounts: the
//! `TipDistributionAccount` (MEV tips) and the `PriorityFeeDistributionAccount`
//! (block rewards a validator shares with its stakers). Both are Anchor
//! accounts serialized with Borsh, so every field after the
//! `Option<MerkleRoot>` moves by 64 bytes once the root is uploaded; the
//! reader walks the layout instead of using fixed offsets.
//!
//! Implements the public layouts in jito-foundation_jito-programs
//! `mev-programs/programs/tip-distribution/src/state.rs` and
//! `priority-fee-distribution/src/state.rs` (Apache-2.0) in order to read the
//! accounts; no code is copied.
//!
//! ```text
//! [u8; 8]  discriminator
//! Pubkey   validator_vote_account
//! Pubkey   merkle_root_upload_authority
//! Option<MerkleRoot { root: [u8; 32], max_total_claim: u64, max_num_nodes: u64,
//!                     total_funds_claimed: u64, num_nodes_claimed: u64 }>
//! u64      epoch_created_at
//! u16      validator_commission_bps
//! u64      expires_at
//! u64      total_lamports_transferred     (priority-fee account only)
//! u8       bump
//! ```

use anchor_lang::prelude::*;

/// `sha256("account:TipDistributionAccount")[..8]`.
pub const TIP_DISTRIBUTION_DISCRIMINATOR: [u8; 8] = [85, 64, 113, 198, 234, 94, 120, 123];
/// `sha256("account:PriorityFeeDistributionAccount")[..8]`.
pub const PRIORITY_FEE_DISTRIBUTION_DISCRIMINATOR: [u8; 8] = [163, 183, 254, 12, 121, 137, 235, 27];

const MERKLE_ROOT_LEN: usize = 32 + 4 * 8;

/// Which of the two accounts is being read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DistributionKind {
    Tip,
    PriorityFee,
}

impl DistributionKind {
    fn discriminator(self) -> [u8; 8] {
        match self {
            DistributionKind::Tip => TIP_DISTRIBUTION_DISCRIMINATOR,
            DistributionKind::PriorityFee => PRIORITY_FEE_DISTRIBUTION_DISCRIMINATOR,
        }
    }
}

/// The fields Epoch uses from either account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DistributionAccount {
    pub validator_vote_account: Pubkey,
    /// `merkle_root.max_total_claim`: every lamport the epoch's tree pays out
    /// (stakers and the validator's commission). `None` until the root is
    /// uploaded, early in the next epoch.
    pub max_total_claim: Option<u64>,
    pub epoch_created_at: u64,
    pub validator_commission_bps: u16,
    /// Priority-fee account only: lamports the validator sent to it so far.
    pub total_lamports_transferred: Option<u64>,
}

fn read_u64(data: &[u8], at: usize) -> Option<u64> {
    data.get(at..at + 8)
        .and_then(|b| <[u8; 8]>::try_from(b).ok())
        .map(u64::from_le_bytes)
}

fn read_u16(data: &[u8], at: usize) -> Option<u16> {
    data.get(at..at + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
}

impl DistributionAccount {
    /// Parse `data` as `kind`. `None` for a wrong discriminator or a
    /// malformed buffer.
    pub fn parse(kind: DistributionKind, data: &[u8]) -> Option<Self> {
        if data.get(..8)? != kind.discriminator() {
            return None;
        }
        let validator_vote_account =
            Pubkey::new_from_array(<[u8; 32]>::try_from(data.get(8..40)?).ok()?);
        let root_tag_at = 8 + 32 + 32;
        let (max_total_claim, after_root) = match *data.get(root_tag_at)? {
            0 => (None, root_tag_at + 1),
            1 => (
                Some(read_u64(data, root_tag_at + 1 + 32)?),
                root_tag_at + 1 + MERKLE_ROOT_LEN,
            ),
            _ => return None,
        };
        let epoch_created_at = read_u64(data, after_root)?;
        let validator_commission_bps = read_u16(data, after_root + 8)?;
        let total_lamports_transferred = match kind {
            DistributionKind::Tip => None,
            // after `expires_at`
            DistributionKind::PriorityFee => Some(read_u64(data, after_root + 8 + 2 + 8)?),
        };
        Some(Self {
            validator_vote_account,
            max_total_claim,
            epoch_created_at,
            validator_commission_bps,
            total_lamports_transferred,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Borsh bytes of an account, as the Jito programs write them.
    pub fn encode(
        kind: DistributionKind,
        vote: Pubkey,
        root: Option<u64>,
        commission_bps: u16,
        transferred: u64,
    ) -> Vec<u8> {
        let mut d = kind.discriminator().to_vec();
        d.extend_from_slice(vote.as_ref());
        d.extend_from_slice(&[7u8; 32]); // upload authority
        match root {
            None => d.push(0),
            Some(max_total_claim) => {
                d.push(1);
                d.extend_from_slice(&[1u8; 32]);
                d.extend_from_slice(&max_total_claim.to_le_bytes());
                d.extend_from_slice(&9u64.to_le_bytes()); // max_num_nodes
                d.extend_from_slice(&0u64.to_le_bytes());
                d.extend_from_slice(&0u64.to_le_bytes());
            }
        }
        d.extend_from_slice(&1_050u64.to_le_bytes()); // epoch_created_at
        d.extend_from_slice(&commission_bps.to_le_bytes());
        d.extend_from_slice(&1_053u64.to_le_bytes()); // expires_at
        if kind == DistributionKind::PriorityFee {
            d.extend_from_slice(&transferred.to_le_bytes());
        }
        d.push(254); // bump
        d
    }

    // Real mainnet accounts, fetched once from api.mainnet-beta.solana.com on
    // 7 Oct 2026 (slot 454,151,080 for the tip accounts, 454,151,146 for the
    // priority-fee account); expected values decoded independently.
    // Tip: ["TIP_DISTRIBUTION_ACCOUNT", CcaHc2…TN1, 1050 | 1051].
    const TDA_1050: &[u8] = include_bytes!("../fixtures/mainnet/tda-CcaHc2-1050.bin");
    const TDA_1051: &[u8] = include_bytes!("../fixtures/mainnet/tda-CcaHc2-1051.bin");
    // okdUoqkhr3UfzFWdUHAK236XR7nTrXK9dZgND945W5e =
    // ["PF_DISTRIBUTION_ACCOUNT", B1rsc6jv3RsFpkak8qvJN3PfGYSg9E3Uw1joaV1EoiFj, 1048].
    const PFDA_1048: &[u8] = include_bytes!("../fixtures/mainnet/pfda-okdUoq-1048.bin");

    #[test]
    fn mainnet_tip_distribution_accounts() {
        let ccahc2 = pubkey!("CcaHc2L43ZWjwCHART3oZoJvHLAe9hzT2DJNUpBzoTN1");
        let a = DistributionAccount::parse(DistributionKind::Tip, TDA_1050).unwrap();
        assert_eq!(a.validator_vote_account, ccahc2);
        assert_eq!(a.max_total_claim, Some(106_700_426_062));
        assert_eq!(a.epoch_created_at, 1_050);
        assert_eq!(a.validator_commission_bps, 700);

        let a = DistributionAccount::parse(DistributionKind::Tip, TDA_1051).unwrap();
        assert_eq!(a.validator_vote_account, ccahc2);
        assert_eq!(a.max_total_claim, None);
        assert_eq!(a.epoch_created_at, 1_051);
        assert_eq!(a.validator_commission_bps, 700);
    }

    #[test]
    fn mainnet_priority_fee_distribution_account() {
        let a = DistributionAccount::parse(DistributionKind::PriorityFee, PFDA_1048).unwrap();
        assert_eq!(
            a.validator_vote_account,
            pubkey!("B1rsc6jv3RsFpkak8qvJN3PfGYSg9E3Uw1joaV1EoiFj")
        );
        assert_eq!(a.epoch_created_at, 1_048);
        assert_eq!(a.validator_commission_bps, 0);
        assert_eq!(a.total_lamports_transferred, Some(2_614_950_335));
        assert_eq!(a.max_total_claim, Some(2_614_950_335));
        assert!(DistributionAccount::parse(DistributionKind::Tip, PFDA_1048).is_none());
    }

    #[test]
    fn mainnet_addresses_match_the_seeds() {
        let ccahc2 = pubkey!("CcaHc2L43ZWjwCHART3oZoJvHLAe9hzT2DJNUpBzoTN1");
        let (tda, _) = Pubkey::find_program_address(
            &[
                crate::constants::TIP_DISTRIBUTION_ACCOUNT_SEED,
                ccahc2.as_ref(),
                &1_050u64.to_le_bytes(),
            ],
            &crate::constants::JITO_TIP_DISTRIBUTION_PROGRAM_ID,
        );
        assert_eq!(tda, pubkey!("8LpeJwvZxerRJPMq7nbZgnHoGXJSvQa8JdGzhyAYs7nC"));
        let (pfda, _) = Pubkey::find_program_address(
            &[
                crate::constants::PF_DISTRIBUTION_ACCOUNT_SEED,
                pubkey!("B1rsc6jv3RsFpkak8qvJN3PfGYSg9E3Uw1joaV1EoiFj").as_ref(),
                &1_048u64.to_le_bytes(),
            ],
            &crate::constants::JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID,
        );
        assert_eq!(pfda, pubkey!("okdUoqkhr3UfzFWdUHAK236XR7nTrXK9dZgND945W5e"));
    }

    #[test]
    fn reads_tip_account_before_and_after_the_root() {
        let vote = Pubkey::new_from_array([3; 32]);
        let before = encode(DistributionKind::Tip, vote, None, 800, 0);
        let a = DistributionAccount::parse(DistributionKind::Tip, &before).unwrap();
        assert_eq!(a.validator_vote_account, vote);
        assert_eq!(a.max_total_claim, None);
        assert_eq!(a.validator_commission_bps, 800);
        assert_eq!(a.epoch_created_at, 1_050);
        assert_eq!(a.total_lamports_transferred, None);

        let after = encode(DistributionKind::Tip, vote, Some(12_345_678_901), 800, 0);
        let a = DistributionAccount::parse(DistributionKind::Tip, &after).unwrap();
        assert_eq!(a.max_total_claim, Some(12_345_678_901));
        assert_eq!(a.validator_commission_bps, 800);
    }

    #[test]
    fn reads_priority_fee_account() {
        let vote = Pubkey::new_from_array([4; 32]);
        let d = encode(DistributionKind::PriorityFee, vote, Some(5), 5_000, 777);
        let a = DistributionAccount::parse(DistributionKind::PriorityFee, &d).unwrap();
        assert_eq!(a.validator_commission_bps, 5_000);
        assert_eq!(a.total_lamports_transferred, Some(777));
        assert_eq!(a.max_total_claim, Some(5));
    }

    #[test]
    fn rejects_wrong_kind_bad_tags_and_truncation() {
        let vote = Pubkey::new_from_array([3; 32]);
        let tip = encode(DistributionKind::Tip, vote, Some(1), 800, 0);
        assert!(DistributionAccount::parse(DistributionKind::PriorityFee, &tip).is_none());
        let mut bad = tip.clone();
        bad[72] = 2;
        assert!(DistributionAccount::parse(DistributionKind::Tip, &bad).is_none());
        // Everything up to the commission is required.
        let needed = 8 + 32 + 32 + 1 + MERKLE_ROOT_LEN + 8 + 2;
        for len in 0..needed {
            assert!(
                DistributionAccount::parse(DistributionKind::Tip, &tip[..len]).is_none(),
                "len {len}"
            );
        }
        assert!(DistributionAccount::parse(DistributionKind::Tip, &tip[..needed]).is_some());
    }
}
