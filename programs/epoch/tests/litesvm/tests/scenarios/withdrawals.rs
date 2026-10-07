//! The FIFO withdrawal queue for both tranches: request, cancel, process in
//! order, the junior lock, and a junior request that would breach the floor
//! bouncing instead of blocking the queue.

use epoch::errors::EpochError;
use epoch::events::{WithdrawCancelled, WithdrawProcessed, WithdrawRequested};
use epoch::state::{Tranche, WithdrawRequest};
use epoch_litesvm_tests::context::{code, sol, TestContext};
use epoch_litesvm_tests::{ix, pda, ExpectErr};

#[test]
fn fifo_queue_cancel_lock_and_floor_bounce() {
    let mut ctx = TestContext::with_pool();
    ctx.deposit("junior", Tranche::Junior, sol(20.0)).unwrap();
    ctx.deposit("senior", Tranche::Senior, sol(80.0)).unwrap();
    let senior = ctx.key("senior");
    let junior = ctx.key("junior");
    let senior_shares = ctx.lender(&senior, Tranche::Senior).shares;

    // seq 0: half of the senior position.
    let seq0 = ctx
        .request_withdraw("senior", Tranche::Senior, senior_shares / 2)
        .unwrap();
    assert_eq!(seq0, 0);
    let l = ctx.lender(&senior, Tranche::Senior);
    assert_eq!(
        (l.shares, l.pending_shares),
        (senior_shares - senior_shares / 2, senior_shares / 2)
    );

    // Junior money is locked for `junior_lock_epochs` after the deposit.
    let junior_shares = ctx.lender(&junior, Tranche::Junior).shares;
    let tail = ctx.pool().withdraw_tail;
    ctx.send_as(
        &[ix::request_withdraw(
            junior,
            Tranche::Junior,
            tail,
            junior_shares,
        )],
        &["junior"],
    )
    .fails_with(code(EpochError::JuniorLocked));
    // More shares than held.
    ctx.send_as(
        &[ix::request_withdraw(
            senior,
            Tranche::Senior,
            tail,
            senior_shares,
        )],
        &["senior"],
    )
    .fails_with(code(EpochError::InsufficientShares));

    // seq 1: requested, then cancelled by its owner (a stranger cannot).
    let seq1 = ctx
        .request_withdraw("senior", Tranche::Senior, senior_shares / 4)
        .unwrap();
    let stranger = ctx.wallet("stranger");
    assert!(ctx
        .send_as(
            &[ix::cancel_withdraw(stranger, Tranche::Senior, seq1)],
            &["stranger"]
        )
        .is_err());
    ctx.send_as(
        &[ix::cancel_withdraw(senior, Tranche::Senior, seq1)],
        &["senior"],
    )
    .unwrap();
    assert!(
        ctx.get::<WithdrawRequest>(&pda::withdraw_request(seq1))
            .cancelled
    );

    // Strict FIFO: seq 1 cannot go before seq 0.
    ctx.process_withdrawal(&senior, Tranche::Senior, seq1)
        .fails_with(code(EpochError::NotHeadOfQueue));

    // seq 0 pays the owner its assets plus the request's rent.
    let rent = ctx.lamports(&pda::withdraw_request(seq0));
    let before = ctx.lamports(&senior);
    let ok = ctx
        .process_withdrawal(&senior, Tranche::Senior, seq0)
        .unwrap();
    let ev: WithdrawProcessed = ok.event();
    assert_eq!((ev.seq, ev.shares), (seq0, senior_shares / 2));
    assert!(ev.assets <= sol(40.0) && ev.assets > sol(39.99));
    assert_eq!(ctx.lamports(&senior), before + ev.assets + rent);
    assert!(!ctx.exists(&pda::withdraw_request(seq0)));
    ctx.assert_ledger();

    // The cancelled seq 1 only moves the head.
    let cash = ctx.pool().cash;
    ctx.process_withdrawal(&senior, Tranche::Senior, seq1)
        .unwrap();
    assert_eq!(ctx.pool().cash, cash);
    assert_eq!(ctx.pool().withdraw_head, 2);

    // After the lock, all of junior would leave senior uncovered: the request bounces.
    ctx.advance_epochs(2);
    let seq2 = ctx
        .request_withdraw("junior", Tranche::Junior, junior_shares)
        .unwrap();
    let ok = ctx
        .process_withdrawal(&junior, Tranche::Junior, seq2)
        .unwrap();
    let bounced: WithdrawCancelled = ok.event();
    assert_eq!((bounced.seq, bounced.reason), (seq2, 1));
    let l = ctx.lender(&junior, Tranche::Junior);
    assert_eq!((l.shares, l.pending_shares), (junior_shares, 0));

    // Half of junior keeps the floor (10 of 50 = 20%) and is paid.
    let seq3 = ctx
        .request_withdraw("junior", Tranche::Junior, junior_shares / 2)
        .unwrap();
    let ok = ctx
        .process_withdrawal(&junior, Tranche::Junior, seq3)
        .unwrap();
    let _: WithdrawProcessed = ok.event();
    let pool = ctx.pool();
    assert_eq!(pool.withdraw_head, pool.withdraw_tail);
    ctx.assert_ledger();
}

#[test]
fn request_withdraw_emits_and_rejects_zero() {
    let mut ctx = TestContext::with_pool();
    ctx.deposit("junior", Tranche::Junior, sol(10.0)).unwrap();
    ctx.advance_epochs(2);
    let junior = ctx.key("junior");
    ctx.send_as(
        &[ix::request_withdraw(junior, Tranche::Junior, 0, 0)],
        &["junior"],
    )
    .fails_with(code(EpochError::ZeroAmount));
    let ok = ctx
        .send_as(
            &[ix::request_withdraw(junior, Tranche::Junior, 0, 1_000)],
            &["junior"],
        )
        .unwrap();
    let ev: WithdrawRequested = ok.event();
    assert_eq!((ev.owner, ev.seq, ev.shares), (junior, 0, 1_000));
}
