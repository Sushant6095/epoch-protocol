//! Real vote accounts, created and read through the vote program's own
//! interface crate, so every Epoch vote CPI (`Authorize`, `Withdraw`,
//! `UpdateValidatorIdentity`, `UpdateCommissionCollector`,
//! `UpdateCommissionBps`) runs against the real builtin.

use anchor_lang::prelude::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_vote_interface::instruction::{
    self as vote_ix, CommissionKind, CreateVoteAccountConfig,
};
use solana_vote_interface::state::{VoteInit, VoteStateV4};

use crate::context::TestContext;

/// The wallets behind one validator: `vote:<name>`, `identity:<name>`, and
/// the withdrawer (an existing wallet, usually the operator).
#[derive(Debug, Clone, Copy)]
pub struct Validator {
    pub vote: Pubkey,
    pub identity: Pubkey,
    pub withdrawer: Pubkey,
}

impl TestContext {
    /// Create `vote:<name>` through the vote program: `CreateAccount` sized for
    /// `VoteStateV4`, `InitializeAccount` signed by `identity:<name>`, then
    /// `UpdateCommissionBps` for inflation and block revenue signed by the
    /// withdrawer wallet `withdrawer`.
    pub fn create_vote_account(
        &mut self,
        name: &str,
        withdrawer: &str,
        inflation_bps: u16,
        block_bps: u16,
    ) -> Validator {
        let withdrawer_key = self.wallet(withdrawer);
        let identity = self.wallet_with(&format!("identity:{name}"), 1.0);
        let vote = self.wallet_with(&format!("vote:{name}"), 0.0);
        let space = VoteStateV4::size_of();
        let lamports = self.rent_exempt(space);
        let init = VoteInit {
            node_pubkey: identity,
            authorized_voter: identity,
            authorized_withdrawer: withdrawer_key,
            commission: u8::try_from(inflation_bps / 100).unwrap_or(100),
        };
        let mut ixs = vote_ix::create_account_with_config(
            &self.payer.pubkey(),
            &vote,
            &init,
            lamports,
            CreateVoteAccountConfig {
                space: space as u64,
                ..Default::default()
            },
        );
        ixs.push(vote_ix::update_commission_bps(
            &vote,
            &withdrawer_key,
            CommissionKind::InflationRewards,
            inflation_bps,
        ));
        ixs.push(vote_ix::update_commission_bps(
            &vote,
            &withdrawer_key,
            CommissionKind::BlockRevenue,
            block_bps,
        ));
        let signers: Vec<Keypair> = [
            format!("vote:{name}"),
            format!("identity:{name}"),
            withdrawer.to_string(),
        ]
        .iter()
        .map(|n| self.keypair(n).insecure_clone())
        .collect();
        let refs: Vec<&Keypair> = signers.iter().collect();
        self.send(&ixs, &refs)
            .expect("create the vote account through the vote program");
        let state = self.vote_state(&vote);
        assert_eq!(state.inflation_rewards_commission_bps, inflation_bps);
        assert_eq!(state.block_revenue_commission_bps, block_bps);
        Validator {
            vote,
            identity,
            withdrawer: withdrawer_key,
        }
    }

    /// The vote account's state, decoded by the vote interface (not by the program's own reader).
    #[track_caller]
    pub fn vote_state(&self, vote: &Pubkey) -> VoteStateV4 {
        let acc = self
            .account(vote)
            .unwrap_or_else(|| panic!("vote account {vote} does not exist"));
        VoteStateV4::deserialize(&acc.data, vote).expect("a VoteStateV4 account")
    }
}
