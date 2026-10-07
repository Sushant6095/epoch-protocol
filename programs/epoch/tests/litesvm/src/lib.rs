//! LiteSVM harness for the Epoch program.
//!
//! Loads the SBF build of `epoch` (`programs/epoch/tests/build-sbf.sh` →
//! `target/litesvm/epoch.so`) into an in-process SVM with the real vote,
//! system and SPL programs, and gives tests a [`TestContext`]: named role
//! wallets, typed account readers, an epoch/slot warp, one builder per
//! instruction ([`ix`]) built from the program's own Anchor `accounts::` and
//! `instruction::` types, real vote accounts ([`vote`]) and typed Anchor
//! events and errors on every transaction.
//!
//! Adapted from jito-foundation_stakenet/tests/src/steward_fixtures.rs and
//! jito-foundation_jito-tip-router/integration_tests/tests/fixtures/{mod.rs,test_builder.rs}
//! (Apache-2.0): the fixture/builder split, `advance_num_epochs` and
//! `assert_ix_error`, rewritten for LiteSVM (synchronous, no BanksClient or
//! tokio), with Anchor-typed events and error codes, a single epoch warp that
//! keeps `Clock` consistent, and instruction builders generated from the
//! program's IDL types instead of hand-written account lists.

pub mod context;
pub mod ix;
pub mod meteora;
pub mod pda;
pub mod setup;
pub mod vote;

pub use context::{ExpectErr, TestContext, TxErr, TxOk, TxResult};
