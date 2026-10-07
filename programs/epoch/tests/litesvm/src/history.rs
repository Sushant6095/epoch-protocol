//! What the validator-history copies read, put where the program looks:
//!
//! - a vote record on a real vote account (created through the vote program,
//!   then given credits and a newest vote with the vote interface's own
//!   `VoteStateV4` serializer, as if it had voted for those epochs);
//! - Jito's `TipDistributionAccount` and `PriorityFeeDistributionAccount` at
//!   their `["TIP_DISTRIBUTION_ACCOUNT" | "PF_DISTRIBUTION_ACCOUNT", vote,
//!   epoch]` addresses under Jito's program ids, from the real mainnet
//!   accounts in `programs/epoch/fixtures/mainnet` (the bytes the program's
//!   own parser tests read), with the validator's vote key written in.

use anchor_lang::prelude::Pubkey;
use epoch::constants::{
    JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID, JITO_TIP_DISTRIBUTION_PROGRAM_ID,
    TVC_CREDITS_PER_SLOT,
};
use solana_vote_interface::state::{LandedVote, Lockout, VoteStateV4, VoteStateVersions};

use crate::context::{TestContext, SLOTS_PER_EPOCH};
use crate::pda;

/// Mainnet `TipDistributionAccount` of CcaHc2… for epoch 1050, merkle root uploaded:
/// commission 700 bps, `max_total_claim` 106,700,426,062 lamports.
pub const TDA_1050: &[u8] = include_bytes!("../../../fixtures/mainnet/tda-CcaHc2-1050.bin");
pub const TDA_1050_COMMISSION_BPS: u16 = 700;
pub const TDA_1050_MAX_TOTAL_CLAIM: u64 = 106_700_426_062;
/// The same account for epoch 1051, before the root: commission only.
pub const TDA_1051: &[u8] = include_bytes!("../../../fixtures/mainnet/tda-CcaHc2-1051.bin");
/// Mainnet `PriorityFeeDistributionAccount` of B1rsc6… for epoch 1048: commission 0,
/// 2,614,950,335 lamports transferred.
pub const PFDA_1048: &[u8] = include_bytes!("../../../fixtures/mainnet/pfda-okdUoq-1048.bin");
pub const PFDA_1048_TRANSFERRED: u64 = 2_614_950_335;

/// Where `validator_vote_account` sits in both Jito layouts (after the discriminator).
const JITO_VOTE_AT: usize = 8;

/// The TVC maximum of one of the harness's 432,000-slot epochs.
pub const MAX_CREDITS: u64 = SLOTS_PER_EPOCH * TVC_CREDITS_PER_SLOT;

/// A mainnet Jito account's bytes with `vote` as its validator.
pub fn jito_account_for(fixture: &[u8], vote: &Pubkey) -> Vec<u8> {
    let mut data = fixture.to_vec();
    data[JITO_VOTE_AT..JITO_VOTE_AT + 32].copy_from_slice(vote.as_ref());
    data
}

impl TestContext {
    /// Give `vote` credits of `earned` for each epoch in `epochs` and a newest vote at
    /// `last_voted_slot`, keeping everything else the vote program wrote.
    pub fn set_vote_record(
        &mut self,
        vote: &Pubkey,
        epochs: std::ops::Range<u64>,
        earned: u64,
        last_voted_slot: u64,
    ) {
        let mut acc = self.account(vote).expect("vote account");
        let mut state = VoteStateV4::deserialize(&acc.data, vote).expect("a VoteStateV4 account");
        let mut credits = 0u64;
        state.epoch_credits = epochs
            .map(|e| {
                let prev = credits;
                credits += earned;
                (e, credits, prev)
            })
            .collect();
        state.votes.clear();
        state
            .votes
            .push_back(LandedVote::from(Lockout::new(last_voted_slot)));
        VoteStateV4::serialize(&VoteStateVersions::new_v4(state), &mut acc.data)
            .expect("serialize the vote state");
        self.svm
            .set_account(*vote, acc)
            .expect("set the vote account");
    }

    /// `fixture` (a mainnet Jito account) at Jito's tip-distribution address for (vote, epoch).
    pub fn set_tip_distribution(&mut self, vote: &Pubkey, epoch: u64, fixture: &[u8]) -> Pubkey {
        let key = pda::tip_distribution(vote, epoch);
        self.set_raw(
            key,
            JITO_TIP_DISTRIBUTION_PROGRAM_ID,
            jito_account_for(fixture, vote),
        );
        key
    }

    /// `fixture` at Jito's priority-fee-distribution address for (vote, epoch).
    pub fn set_priority_fee_distribution(
        &mut self,
        vote: &Pubkey,
        epoch: u64,
        fixture: &[u8],
    ) -> Pubkey {
        let key = pda::priority_fee_distribution(vote, epoch);
        self.set_raw(
            key,
            JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID,
            jito_account_for(fixture, vote),
        );
        key
    }
}
