//! Credit: onboard → set_collectors → post_bond → revenue history → advance →
//! sweeps that repay it → release_validator, with the vote CPIs running
//! against the real vote program.

use epoch::errors::EpochError;
use epoch::events::{
    Accrued, AdvanceDefaulted, AdvanceOpened, AdvanceRepaid, BondPosted, CollectorsSet, Swept,
    ValidatorOnboarded,
};
use epoch::instructions::ScoreUpdate;
use epoch::state::{Advance, AdvanceState, PositionStatus, Tranche, ValidatorPosition};
use epoch_litesvm_tests::context::{code, sol, TestContext};
use epoch_litesvm_tests::vote::Validator;
use epoch_litesvm_tests::{ix, pda, ExpectErr};

pub(crate) const GOOD_SCORE: ScoreUpdate = ScoreUpdate {
    credits_ratio_bps: 9_800,
    commission_bps: 1_000,
    epochs_active: 45,
    delinquent: false,
    superminority: false,
    hedged: false,
};

/// A pool with 100 SOL of junior liquidity and validator `v1` (operator
/// `operator1`, payout `payout1`) onboarded with collectors and a 2 SOL bond,
/// its vote account topped up to the sweep floor.
pub(crate) fn onboarded() -> (TestContext, Validator) {
    let mut ctx = TestContext::with_pool();
    ctx.deposit("lender1", Tranche::Junior, sol(100.0)).unwrap();
    let v = ctx.create_vote_account("v1", "operator1", 500, 1_000);
    let payout = ctx.wallet_with("payout1", 1.0);

    let ok = ctx
        .send_as(
            &[
                ix::onboard_validator(v.withdrawer, v.withdrawer, v.vote, payout),
                ix::set_collectors(v.withdrawer, v.vote),
                ix::post_bond(v.withdrawer, v.vote, sol(2.0)),
            ],
            &["operator1"],
        )
        .unwrap();
    let onboarded: ValidatorOnboarded = ok.event();
    assert_eq!(
        (onboarded.vote, onboarded.identity, onboarded.operator),
        (v.vote, v.identity, v.withdrawer)
    );
    assert_eq!(ok.event::<CollectorsSet>().collector, pda::escrow(&v.vote));
    assert_eq!(ok.event::<BondPosted>().lamports, sol(2.0));

    // The program now holds the withdraw authority and both collectors point at the escrow.
    let state = ctx.vote_state(&v.vote);
    assert_eq!(state.authorized_withdrawer, pda::vote_auth(&v.vote));
    assert_eq!(state.inflation_rewards_collector, pda::escrow(&v.vote));
    assert_eq!(state.block_revenue_collector, pda::escrow(&v.vote));

    let pos: ValidatorPosition = ctx.get(&pda::position(&v.vote));
    assert_eq!(pos.status, PositionStatus::Active);
    assert_eq!(
        (pos.inflation_commission_bps, pos.block_commission_bps),
        (500, 1_000)
    );
    assert_eq!(pos.bond_lamports, sol(2.0));
    assert_eq!(ctx.pool().bond_total, sol(2.0));
    ctx.assert_ledger();

    // Top the vote account up to the sweep floor (rent + pending rewards + reserve), so every
    // lamport added later is revenue.
    let reserve = ctx.pool().params.vote_reserve_lamports;
    ctx.transfer(&v.vote, reserve);
    (ctx, v)
}

fn sweep(
    ctx: &mut TestContext,
    v: &Validator,
    advance: Option<anchor_lang::prelude::Pubkey>,
) -> Swept {
    let cranker = ctx.wallet("crank");
    let payout = ctx.key("payout1");
    ctx.send_as(&[ix::sweep(cranker, v.vote, payout, advance)], &["crank"])
        .unwrap()
        .event()
}

#[test]
fn full_credit_cycle_with_real_vote_cpis() {
    let (mut ctx, v) = onboarded();
    let payout = ctx.key("payout1");
    let floor = ctx.lamports(&v.vote);

    // Onboarding epoch: already swept.
    let cranker = ctx.wallet("crank");
    ctx.send_as(&[ix::sweep(cranker, v.vote, payout, None)], &["crank"])
        .fails_with(code(EpochError::AlreadySweptThisEpoch));

    // Three epochs of revenue build the history; no advance yet, so all of it goes to the operator.
    for _ in 0..3 {
        ctx.advance_epochs(1);
        ctx.transfer(&v.vote, sol(6.0));
        let before = ctx.lamports(&payout);
        let s = sweep(&mut ctx, &v, None);
        assert_eq!(
            (s.from_vote, s.gross, s.remitted, s.to_operator),
            (sol(6.0), sol(6.0), 0, sol(6.0))
        );
        assert_eq!(ctx.lamports(&payout), before + sol(6.0));
        // The reserve and rent stay in the vote account.
        assert_eq!(ctx.lamports(&v.vote), floor);
    }

    // A double sweep in the same epoch is rejected.
    ctx.send_as(&[ix::sweep(cranker, v.vote, payout, None)], &["crank"])
        .fails_with(code(EpochError::AlreadySweptThisEpoch));

    // Score, then an advance within the limit (25% of 18 SOL trailing revenue = 4.5 SOL).
    let scorer = ctx.key("scorer");
    ctx.send_as(&[ix::update_score(scorer, v.vote, GOOD_SCORE)], &["scorer"])
        .unwrap();
    let seq = ctx
        .get::<ValidatorPosition>(&pda::position(&v.vote))
        .advance_seq;
    ctx.send_as(
        &[ix::request_advance(
            v.withdrawer,
            v.vote,
            payout,
            seq,
            sol(5.0),
        )],
        &["operator1"],
    )
    .fails_with(code(EpochError::OverLimit));
    let before = ctx.lamports(&payout);
    let ok = ctx
        .send_as(
            &[ix::request_advance(
                v.withdrawer,
                v.vote,
                payout,
                seq,
                sol(4.0),
            )],
            &["operator1"],
        )
        .unwrap();
    let opened: AdvanceOpened = ok.event();
    assert_eq!((opened.principal, opened.fee), (sol(4.0), sol(0.08)));
    assert_eq!(ctx.lamports(&payout), before + sol(4.0));
    let advance = pda::advance(&v.vote, seq);
    assert_eq!(ctx.pool().outstanding_principal, sol(4.0));
    ctx.assert_ledger();

    // Two sweeps repay 4.08 SOL at 50% of gross.
    ctx.advance_epochs(1);
    ctx.transfer(&v.vote, sol(6.0));
    let s = sweep(&mut ctx, &v, Some(advance));
    assert_eq!(
        (s.gross, s.remitted, s.to_operator),
        (sol(6.0), sol(3.0), sol(3.0))
    );
    assert_eq!(ctx.get::<Advance>(&advance).state, AdvanceState::Open);

    ctx.advance_epochs(1);
    ctx.transfer(&v.vote, sol(6.0));
    let cranker = ctx.key("crank");
    let ok = ctx
        .send_as(
            &[ix::sweep(cranker, v.vote, payout, Some(advance))],
            &["crank"],
        )
        .unwrap();
    let s: Swept = ok.event();
    assert_eq!((s.remitted, s.to_operator), (sol(1.08), sol(4.92)));
    let _: AdvanceRepaid = ok.event();
    let adv: Advance = ctx.get(&advance);
    assert_eq!(
        (adv.state, adv.repaid, adv.principal_repaid, adv.fee_repaid),
        (AdvanceState::Repaid, sol(4.08), sol(4.0), sol(0.08))
    );
    let pos: ValidatorPosition = ctx.get(&pda::position(&v.vote));
    assert_eq!(pos.open_advance, None);
    assert_eq!(ctx.pool().outstanding_principal, 0);
    ctx.assert_ledger();

    // Release: the withdraw authority goes back to the operator, the position closes.
    ctx.advance_epochs(1);
    let ok = ctx
        .send_as(
            &[ix::release_validator(
                v.withdrawer,
                v.vote,
                v.withdrawer,
                v.identity,
                None,
            )],
            &["operator1"],
        )
        .unwrap();
    assert!(ok
        .logs()
        .iter()
        .any(|l| l.contains("Vote111111111111111111111111111111111111111 success")));
    assert_eq!(ctx.vote_state(&v.vote).authorized_withdrawer, v.withdrawer);
    assert!(!ctx.exists(&pda::position(&v.vote)));
    assert_eq!(ctx.pool().bond_total, 0);
    ctx.assert_ledger();
}

/// Three epochs of 6 SOL revenue, an advance of 4 SOL (fee 0.08 SOL) and two sweeps that repay it.
fn borrow_and_repay(ctx: &mut TestContext, v: &Validator) {
    for _ in 0..3 {
        ctx.advance_epochs(1);
        ctx.transfer(&v.vote, sol(6.0));
        sweep(ctx, v, None);
    }
    let scorer = ctx.key("scorer");
    ctx.send_as(&[ix::update_score(scorer, v.vote, GOOD_SCORE)], &["scorer"])
        .unwrap();
    let payout = ctx.key("payout1");
    let seq = ctx
        .get::<ValidatorPosition>(&pda::position(&v.vote))
        .advance_seq;
    ctx.send_as(
        &[ix::request_advance(
            v.withdrawer,
            v.vote,
            payout,
            seq,
            sol(4.0),
        )],
        &["operator1"],
    )
    .unwrap();
    let advance = pda::advance(&v.vote, seq);
    for _ in 0..2 {
        ctx.advance_epochs(1);
        ctx.transfer(&v.vote, sol(6.0));
        sweep(ctx, v, Some(advance));
    }
    assert_eq!(ctx.get::<Advance>(&advance).state, AdvanceState::Repaid);
}

#[test]
fn fee_income_accrues_protocol_fee_then_senior_coupon_then_junior() {
    let (mut ctx, v) = onboarded();
    ctx.deposit("senior1", Tranche::Senior, sol(50.0)).unwrap();
    borrow_and_repay(&mut ctx, &v);

    let before = ctx.pool();
    assert_eq!(before.income_unallocated, sol(0.08));
    let treasury = before.treasury;
    let treasury_before = ctx.lamports(&treasury);

    let ok = ctx.accrue().unwrap();
    let ev: Accrued = ok.event();
    // 10% protocol fee, then the senior coupon (50 SOL × 3 bps × 1 epoch), the rest to junior.
    assert_eq!(ev.income, sol(0.08));
    assert_eq!(ev.protocol_fee, sol(0.008));
    assert_eq!(ev.senior_gain, sol(0.015));
    assert_eq!(ev.junior_gain, sol(0.08) - sol(0.008) - sol(0.015));
    assert_eq!(ctx.lamports(&treasury), treasury_before + sol(0.008));

    let after = ctx.pool();
    assert_eq!(after.income_unallocated, 0);
    assert_eq!(after.senior_assets, before.senior_assets + ev.senior_gain);
    assert_eq!(after.junior_assets, before.junior_assets + ev.junior_gain);
    assert!(ev.senior_price_e9 > 0 && ev.junior_price_e9 > 0);
    ctx.assert_ledger();

    // Once per epoch.
    ctx.accrue().fails_with(code(EpochError::AlreadyAccrued));
    // Two epochs later with no new income: nothing moves, the clock does.
    ctx.advance_epochs(2);
    let ev: Accrued = ctx.accrue().unwrap().event();
    assert_eq!((ev.income, ev.senior_gain, ev.junior_gain), (0, 0, 0));
    assert_eq!(ctx.pool().last_accrued_epoch, ctx.epoch());
}

#[test]
fn late_three_epochs_then_default_hits_bond_then_junior() {
    let (mut ctx, v) = onboarded();
    ctx.deposit("senior1", Tranche::Senior, sol(50.0)).unwrap();
    for _ in 0..3 {
        ctx.advance_epochs(1);
        ctx.transfer(&v.vote, sol(6.0));
        sweep(&mut ctx, &v, None);
    }
    let scorer = ctx.key("scorer");
    ctx.send_as(&[ix::update_score(scorer, v.vote, GOOD_SCORE)], &["scorer"])
        .unwrap();
    let payout = ctx.key("payout1");
    let advance = pda::advance(&v.vote, 0);
    ctx.send_as(
        &[ix::request_advance(
            v.withdrawer,
            v.vote,
            payout,
            0,
            sol(4.0),
        )],
        &["operator1"],
    )
    .unwrap();
    let cranker = ctx.wallet("crank");

    // Revenue stops: each empty sweep is a late epoch; two are not enough to default.
    for late in 1..=3u8 {
        ctx.advance_epochs(1);
        let s = sweep(&mut ctx, &v, Some(advance));
        assert_eq!(s.gross, 0);
        let pos: ValidatorPosition = ctx.get(&pda::position(&v.vote));
        assert_eq!((pos.status, pos.late_epochs), (PositionStatus::Late, late));
        if late < 3 {
            ctx.send_as(&[ix::mark_default(cranker, v.vote, advance)], &["crank"])
                .fails_with(code(EpochError::NotDefaultable));
        }
    }

    let before = ctx.pool();
    let ok = ctx
        .send_as(&[ix::mark_default(cranker, v.vote, advance)], &["crank"])
        .unwrap();
    let ev: AdvanceDefaulted = ok.event();
    // `principal_lost` is the write-off left after the bond: 4 SOL owed − 2 SOL bond.
    assert_eq!((ev.principal_lost, ev.bond_applied), (sol(2.0), sol(2.0)));

    // The bond covers 2 SOL; the other 2 SOL is junior's loss, senior is untouched.
    let after = ctx.pool();
    assert_eq!(after.senior_assets, before.senior_assets);
    assert_eq!(after.junior_assets, before.junior_assets - sol(2.0));
    assert_eq!(after.bond_total, before.bond_total - sol(2.0));
    assert_eq!(after.outstanding_principal, 0);
    assert_eq!(ctx.get::<Advance>(&advance).state, AdvanceState::Defaulted);
    let pos: ValidatorPosition = ctx.get(&pda::position(&v.vote));
    assert_eq!(
        (pos.status, pos.bond_lamports),
        (PositionStatus::Defaulted, 0)
    );
    ctx.assert_ledger();
}

#[test]
fn commission_and_identity_updates_run_through_the_vote_program() {
    let (mut ctx, v) = onboarded();
    let mallory = ctx.wallet("mallory");

    // Commission: operator only, kind 0/1, at most 10,000 bps; lands in the vote account.
    ctx.send_as(
        &[ix::update_commission(mallory, v.vote, 1, 800, None)],
        &["mallory"],
    )
    .fails_with(code(EpochError::NotOperator));
    ctx.send_as(
        &[ix::update_commission(v.withdrawer, v.vote, 2, 800, None)],
        &["operator1"],
    )
    .fails_with(code(EpochError::InvalidParams));
    ctx.send_as(
        &[ix::update_commission(v.withdrawer, v.vote, 1, 10_001, None)],
        &["operator1"],
    )
    .fails_with(code(EpochError::BpsOutOfRange));
    ctx.send_as(
        &[ix::update_commission(v.withdrawer, v.vote, 1, 800, None)],
        &["operator1"],
    )
    .unwrap();
    assert_eq!(ctx.vote_state(&v.vote).block_revenue_commission_bps, 800);

    // Identity: the new identity co-signs; the vote account and the position follow.
    let new_identity = ctx.wallet_with("identity:v1b", 1.0);
    ctx.send_as(
        &[ix::update_identity(mallory, new_identity, v.vote)],
        &["mallory", "identity:v1b"],
    )
    .fails_with(code(EpochError::NotOperator));
    ctx.send_as(
        &[ix::update_identity(v.withdrawer, new_identity, v.vote)],
        &["operator1", "identity:v1b"],
    )
    .unwrap();
    assert_eq!(ctx.vote_state(&v.vote).node_pubkey, new_identity);
    let pos: ValidatorPosition = ctx.get(&pda::position(&v.vote));
    assert_eq!(pos.identity, new_identity);
}
