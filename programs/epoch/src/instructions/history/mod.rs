//! Validator history on chain and the permissionless score. Every copy is
//! permissionless (the caller pays); `update_stake_info` is the one oracle
//! input left, signed by the pool's scorer.

pub(crate) mod common;
pub mod configure_scoring;
pub mod copy_priority_fee_distribution;
pub mod copy_tip_distribution;
pub mod copy_vote_account;
pub mod init_validator_history;
pub mod refresh_score;
pub mod update_stake_info;

pub use configure_scoring::*;
pub use copy_priority_fee_distribution::*;
pub use copy_tip_distribution::*;
pub use copy_vote_account::*;
pub use init_validator_history::*;
pub use refresh_score::*;
pub use update_stake_info::*;
