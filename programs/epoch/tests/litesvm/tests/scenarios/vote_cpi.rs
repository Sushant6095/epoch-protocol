//! The vote program LiteSVM ships (Agave 4.1.2 builtin, every feature on)
//! handles each vote instruction Epoch invokes. These run the instructions
//! directly; the Epoch scenarios then run them as CPIs signed by the
//! `vote_auth` PDA.

use anchor_lang::prelude::Pubkey;
use epoch_litesvm_tests::context::{sol, TestContext};
use solana_vote_interface::instruction::{self as vote_ix, CommissionKind};
use solana_vote_interface::state::VoteAuthorize;

#[test]
fn vote_program_handles_every_instruction_epoch_uses() {
    let mut ctx = TestContext::new();
    let v = ctx.create_vote_account("v1", "operator1", 500, 1_000);
    let state = ctx.vote_state(&v.vote);
    assert_eq!(state.node_pubkey, v.identity);
    assert_eq!(state.authorized_withdrawer, v.withdrawer);
    assert_eq!(
        (
            state.inflation_rewards_commission_bps,
            state.block_revenue_commission_bps
        ),
        (500, 1_000)
    );

    // UpdateCommissionCollector (SIMD-0232): a system-owned, rent-exempt collector.
    let collector = ctx.wallet_with("collector", 1.0);
    for kind in [
        CommissionKind::InflationRewards,
        CommissionKind::BlockRevenue,
    ] {
        ctx.send_as(
            &[vote_ix::update_commission_collector(
                &v.vote,
                &v.withdrawer,
                &collector,
                kind,
            )],
            &["operator1"],
        )
        .expect("UpdateCommissionCollector");
    }
    let state = ctx.vote_state(&v.vote);
    assert_eq!(
        (
            state.inflation_rewards_collector,
            state.block_revenue_collector
        ),
        (collector, collector)
    );

    // UpdateCommissionBps (SIMD-0291).
    ctx.send_as(
        &[vote_ix::update_commission_bps(
            &v.vote,
            &v.withdrawer,
            CommissionKind::BlockRevenue,
            750,
        )],
        &["operator1"],
    )
    .expect("UpdateCommissionBps");
    assert_eq!(ctx.vote_state(&v.vote).block_revenue_commission_bps, 750);

    // Withdraw down to rent exemption, signed by the withdrawer.
    ctx.transfer(&v.vote, sol(3.0));
    let to = ctx.wallet_with("payout", 1.0);
    let before = ctx.lamports(&to);
    ctx.send_as(
        &[vote_ix::withdraw(&v.vote, &v.withdrawer, sol(3.0), &to)],
        &["operator1"],
    )
    .expect("Withdraw");
    assert_eq!(ctx.lamports(&to), before + sol(3.0));

    // Authorize a new withdrawer; the old one can no longer withdraw.
    let new_withdrawer = ctx.wallet("new-withdrawer");
    ctx.send_as(
        &[vote_ix::authorize(
            &v.vote,
            &v.withdrawer,
            &new_withdrawer,
            VoteAuthorize::Withdrawer,
        )],
        &["operator1"],
    )
    .expect("Authorize");
    assert_eq!(
        ctx.vote_state(&v.vote).authorized_withdrawer,
        new_withdrawer
    );
    ctx.transfer(&v.vote, sol(1.0));
    assert!(ctx
        .send_as(
            &[vote_ix::withdraw(&v.vote, &v.withdrawer, sol(1.0), &to)],
            &["operator1"]
        )
        .is_err());
    let _: Pubkey = new_withdrawer;
}
