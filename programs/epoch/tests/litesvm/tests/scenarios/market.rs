//! The Fee Index (post → dispute window → finalize, veto, the move limit,
//! history) and the fee market on top of it (quotes, swaps, settlement on
//! the finalized index, payoff clipping, quote withdrawal).

use anchor_lang::error::ErrorCode;
use epoch::errors::EpochError;
use epoch::events::{
    IndexFinalized, IndexProposed, IndexVetoed, QuotePosted, SwapOpened, SwapSettled,
};
use epoch::state::{FeeIndex, FeeQuote, Side};
use epoch::{accounts as a, instruction as i};
use epoch_litesvm_tests::context::{
    anchor_code, code, sol, TestContext, TxResult, SLOTS_PER_EPOCH,
};
use epoch_litesvm_tests::{ix, pda, ExpectErr};

/// Dispute window of the scenarios, in slots.
const WINDOW: u64 = 150;
/// The index may move at most 20% per finalized point.
const MAX_MOVE_BPS: u16 = 2_000;

/// A pool with the Fee Index initialised (`publisher` wallet proposes).
fn with_index(window: u64, max_move_bps: u16) -> TestContext {
    let mut ctx = TestContext::with_pool();
    let admin = ctx.key("admin");
    let publisher = ctx.wallet("publisher");
    ctx.send_as(
        &[ix::initialize_index(admin, publisher, window, max_move_bps)],
        &["admin"],
    )
    .expect("initialize_index");
    ctx
}

fn index(ctx: &TestContext) -> FeeIndex {
    ctx.get(&pda::fee_index())
}

fn post_as(ctx: &mut TestContext, who: &str, epoch: u64, value: u64) -> TxResult {
    let publisher = ctx.wallet(who);
    ctx.send_as(
        &[ix::post_index(publisher, epoch, value, [epoch as u8; 32])],
        &[who],
    )
}

fn post(ctx: &mut TestContext, epoch: u64, value: u64) -> TxResult {
    post_as(ctx, "publisher", epoch, value)
}

fn finalize(ctx: &mut TestContext) -> TxResult {
    let cranker = ctx.wallet("crank");
    ctx.send_as(&[ix::finalize_index(cranker)], &["crank"])
}

/// Post, wait out the window, finalize.
fn publish(ctx: &mut TestContext, epoch: u64, value: u64) {
    post(ctx, epoch, value).expect("post_index");
    let window = index(ctx).dispute_window_slots;
    ctx.advance_slots(window);
    finalize(ctx).expect("finalize_index");
}

fn veto_as(ctx: &mut TestContext, who: &str) -> TxResult {
    let signer = ctx.wallet(who);
    ctx.send_as(&[ix::veto_index(signer)], &[who])
}

#[test]
fn fee_index_post_dispute_window_finalize_veto_and_move_limit() {
    let mut ctx = TestContext::with_pool();
    // post_index refuses an epoch the cluster has not reached: every epoch posted below (800..=802) has started.
    ctx.warp_to_epoch(802);
    let admin = ctx.key("admin");
    let publisher = ctx.wallet("publisher");
    let intruder = ctx.wallet("intruder");

    // Initialisation: admin only, bounded move.
    ctx.send_as(
        &[ix::initialize_index(
            intruder,
            publisher,
            WINDOW,
            MAX_MOVE_BPS,
        )],
        &["intruder"],
    )
    .fails_with(code(EpochError::NotAdmin));
    ctx.send_as(
        &[ix::initialize_index(admin, publisher, WINDOW, 10_001)],
        &["admin"],
    )
    .fails_with(code(EpochError::BpsOutOfRange));
    ctx.send_as(
        &[ix::initialize_index(admin, publisher, WINDOW, MAX_MOVE_BPS)],
        &["admin"],
    )
    .unwrap();
    let fi = index(&ctx);
    assert_eq!(
        (fi.publisher, fi.dispute_window_slots, fi.max_move_bps),
        (publisher, WINDOW, MAX_MOVE_BPS)
    );
    assert_eq!((fi.finalized_slot, fi.has_proposal), (0, false));

    // Only the publisher proposes.
    post_as(&mut ctx, "intruder", 800, 10_000).fails_with(code(EpochError::NotPublisher));

    // Propose → the window is open → finalize is refused until it has passed.
    let ok = post(&mut ctx, 800, 10_000).unwrap();
    let proposed: IndexProposed = ok.event();
    let slot = ctx.clock().slot;
    assert_eq!(
        (proposed.epoch, proposed.value, proposed.slot),
        (800, 10_000, slot)
    );
    assert_eq!(proposed.inputs_hash, [800u64 as u8; 32]);
    let fi = index(&ctx);
    assert!(fi.has_proposal);
    assert_eq!(
        (fi.proposed_epoch, fi.proposed_value, fi.proposed_slot),
        (800, 10_000, slot)
    );
    assert_eq!(fi.value_for(800), None, "a proposal is not a value");

    finalize(&mut ctx).fails_with(code(EpochError::DisputeWindowOpen));
    // One proposal at a time.
    post(&mut ctx, 801, 10_000).fails_with(code(EpochError::DisputeWindowOpen));
    ctx.advance_slots(WINDOW - 1);
    finalize(&mut ctx).fails_with(code(EpochError::DisputeWindowOpen));
    ctx.advance_slots(1); // exactly proposed_slot + window
    let ok = finalize(&mut ctx).unwrap();
    let fin: IndexFinalized = ok.event();
    assert_eq!(
        (fin.epoch, fin.value, fin.slot),
        (800, 10_000, slot + WINDOW)
    );
    let fi = index(&ctx);
    assert_eq!(
        (fi.epoch, fi.value, fi.finalized_slot),
        (800, 10_000, slot + WINDOW)
    );
    assert!(!fi.has_proposal);
    assert_eq!(fi.history_count, 0, "the first point has no predecessor");
    assert_eq!(fi.value_for(800), Some(10_000));
    finalize(&mut ctx).fails_with(code(EpochError::NoProposal));

    // Epochs only move forward.
    post(&mut ctx, 800, 10_000).fails_with(code(EpochError::IndexEpochNotNewer));
    post(&mut ctx, 799, 10_000).fails_with(code(EpochError::IndexEpochNotNewer));

    // The move limit: at most 20% of 10,000 either way, the bound itself allowed.
    post(&mut ctx, 801, 12_001).fails_with(code(EpochError::IndexMoveTooLarge));
    post(&mut ctx, 801, 7_999).fails_with(code(EpochError::IndexMoveTooLarge));
    post(&mut ctx, 801, 12_000).unwrap();

    // Veto: admin only, inside the window; the finalized value is untouched.
    veto_as(&mut ctx, "intruder").fails_with(code(EpochError::NotAdmin));
    veto_as(&mut ctx, "publisher").fails_with(code(EpochError::NotAdmin));
    let ok = veto_as(&mut ctx, "admin").unwrap();
    let vetoed: IndexVetoed = ok.event();
    assert_eq!((vetoed.epoch, vetoed.value), (801, 12_000));
    let fi = index(&ctx);
    assert!(!fi.has_proposal);
    assert_eq!(
        (fi.proposed_epoch, fi.proposed_value, fi.proposed_slot),
        (0, 0, 0)
    );
    assert_eq!((fi.epoch, fi.value), (800, 10_000));
    veto_as(&mut ctx, "admin").fails_with(code(EpochError::NoProposal));
    ctx.advance_slots(WINDOW);
    finalize(&mut ctx).fails_with(code(EpochError::NoProposal));

    // A corrected proposal finalizes; the previous point moves to history.
    publish(&mut ctx, 801, 8_000);
    let fi = index(&ctx);
    assert_eq!((fi.epoch, fi.value, fi.history_count), (801, 8_000, 1));
    assert_eq!((fi.history[0].epoch, fi.history[0].value), (800, 10_000));
    assert_eq!(fi.value_for(800), Some(10_000));
    assert_eq!(fi.value_for(801), Some(8_000));

    // Reconfiguration: admin only; a new publisher and a tighter bound apply at once.
    let publisher2 = ctx.wallet("publisher2");
    ctx.send_as(
        &[ix::configure_index(intruder, publisher2, 10, 500)],
        &["intruder"],
    )
    .fails_with(code(EpochError::NotAdmin));
    ctx.send_as(
        &[ix::configure_index(admin, publisher2, 10, 10_001)],
        &["admin"],
    )
    .fails_with(code(EpochError::BpsOutOfRange));
    ctx.send_as(
        &[ix::configure_index(admin, publisher2, 10, 500)],
        &["admin"],
    )
    .unwrap();
    post(&mut ctx, 802, 8_000).fails_with(code(EpochError::NotPublisher));
    post_as(&mut ctx, "publisher2", 802, 8_401).fails_with(code(EpochError::IndexMoveTooLarge));
    post_as(&mut ctx, "publisher2", 802, 8_400).unwrap();
    ctx.advance_slots(10);
    finalize(&mut ctx).unwrap();
    assert_eq!(index(&ctx).value, 8_400);
}

#[test]
fn fee_index_history_keeps_the_last_sixteen_points() {
    let mut ctx = with_index(1, 10_000);
    ctx.warp_to_epoch(817); // the newest epoch posted below has started
    for e in 0..18u64 {
        publish(&mut ctx, 800 + e, 1_000 + e);
    }
    let fi = index(&ctx);
    assert_eq!((fi.epoch, fi.value), (817, 1_017));
    assert_eq!(
        usize::from(fi.history_count),
        epoch::constants::INDEX_HISTORY
    );
    // 817 is current, 801..=816 are history, 800 has been overwritten.
    assert_eq!(fi.value_for(800), None);
    for e in 801..=817u64 {
        assert_eq!(fi.value_for(e), Some(1_000 + e - 800), "epoch {e}");
    }
}

/// Open a swap from the named taker (created with 100 SOL on first use).
fn open(
    ctx: &mut TestContext,
    taker: &str,
    quote: anchor_lang::prelude::Pubkey,
    notional: u64,
    side: Side,
) -> TxResult {
    let key = ctx.wallet(taker);
    ctx.send_as(&[ix::open_swap(key, quote, notional, side)], &[taker])
}

fn settle(ctx: &mut TestContext, quote: anchor_lang::prelude::Pubkey, taker: &str) -> TxResult {
    let cranker = ctx.wallet("crank");
    let taker = ctx.key(taker);
    ctx.send_as(&[ix::settle_swap(cranker, quote, taker)], &["crank"])
}

#[test]
fn quotes_and_swaps_settle_on_the_finalized_index() {
    let mut ctx = with_index(WINDOW, MAX_MOVE_BPS);
    publish(&mut ctx, 800, 10_000);
    let maker = ctx.wallet("maker");
    let maker2 = ctx.wallet("maker2");
    let epoch = 802;
    let expiry = epoch * SLOTS_PER_EPOCH; // trading closes when 802 starts

    // Quote validation.
    let now = ctx.clock().slot;
    for (args, err) in [
        (
            (800, 10_000, sol(10.0), 2_000, expiry),
            EpochError::QuoteEpochMismatch,
        ), // current epoch
        ((epoch, 0, sol(10.0), 2_000, expiry), EpochError::ZeroAmount),
        ((epoch, 10_000, 0, 2_000, expiry), EpochError::ZeroAmount),
        (
            (epoch, 10_000, sol(10.0), 0, expiry),
            EpochError::BpsOutOfRange,
        ),
        (
            (epoch, 10_000, sol(10.0), 10_001, expiry),
            EpochError::BpsOutOfRange,
        ),
        (
            (epoch, 10_000, sol(10.0), 2_000, now),
            EpochError::QuoteExpired,
        ),
    ] {
        let (e, rate, notional, bps, exp) = args;
        ctx.send_as(
            &[ix::post_quote(maker, e, rate, notional, bps, exp)],
            &["maker"],
        )
        .fails_with(code(err));
    }

    // Maker 1: fixed 10,000, 10 SOL capacity, ±20% → 2 SOL collateral on the quote.
    let maker_before = ctx.lamports(&maker);
    let ok = ctx
        .send_as(
            &[ix::post_quote(
                maker,
                epoch,
                10_000,
                sol(10.0),
                2_000,
                expiry,
            )],
            &["maker"],
        )
        .unwrap();
    let quote = pda::quote(&maker, epoch);
    let posted: QuotePosted = ok.event();
    assert_eq!(
        (posted.quote, posted.maker, posted.epoch),
        (quote, maker, epoch)
    );
    let q: FeeQuote = ctx.get(&quote);
    assert_eq!(
        (q.collateral, q.locked_collateral, q.open_swaps),
        (sol(2.0), 0, 0)
    );
    let quote_rent = ctx.rent_exempt(ctx.account(&quote).unwrap().data.len());
    assert_eq!(ctx.lamports(&quote), quote_rent + sol(2.0));
    assert_eq!(maker_before - ctx.lamports(&maker), quote_rent + sol(2.0));

    // Maker 2: same level, ±5% → payoffs beyond 5% are clipped.
    ctx.send_as(
        &[ix::post_quote(maker2, epoch, 10_000, sol(4.0), 500, expiry)],
        &["maker2"],
    )
    .unwrap();
    let quote2 = pda::quote(&maker2, epoch);

    // Takers: A pays fixed 4 SOL, B receives fixed 6 SOL (fills maker 1), C pays fixed 2 SOL on maker 2.
    let before: Vec<u64> = ["alice", "bob", "carol"]
        .iter()
        .map(|n| {
            let k = ctx.wallet(n);
            ctx.lamports(&k)
        })
        .collect();
    let ok = open(&mut ctx, "alice", quote, sol(4.0), Side::PayFixed).unwrap();
    let opened: SwapOpened = ok.event();
    assert_eq!(
        (opened.notional, opened.collateral, opened.fixed_rate),
        (sol(4.0), sol(0.8), 10_000)
    );
    open(&mut ctx, "bob", quote, sol(6.0), Side::ReceiveFixed).unwrap();
    let q: FeeQuote = ctx.get(&quote);
    assert_eq!(
        (q.filled_notional, q.locked_collateral, q.open_swaps),
        (sol(10.0), sol(2.0), 2)
    );
    open(&mut ctx, "carol", quote, sol(1.0), Side::PayFixed)
        .fails_with(code(EpochError::QuoteCapacityExceeded));
    open(&mut ctx, "carol", quote, 0, Side::PayFixed).fails_with(code(EpochError::ZeroAmount));
    open(&mut ctx, "carol", quote2, sol(2.0), Side::PayFixed).unwrap();

    // Nothing settles before the index for 802 is final, and the maker cannot leave.
    settle(&mut ctx, quote, "alice").fails_with(code(EpochError::IndexMissing));
    ctx.send_as(&[ix::withdraw_quote(maker, epoch)], &["maker"])
        .fails_with(code(EpochError::QuoteHasOpenSwaps));

    // Trading closes when the quoted epoch starts.
    ctx.warp_to_epoch(epoch);
    open(&mut ctx, "dave", quote2, sol(1.0), Side::ReceiveFixed)
        .fails_with(code(EpochError::QuoteExpired));

    // A proposed (not finalized) value does not settle anything.
    post(&mut ctx, epoch, 11_000).unwrap();
    settle(&mut ctx, quote, "alice").fails_with(code(EpochError::IndexMissing));
    ctx.advance_slots(WINDOW);
    finalize(&mut ctx).unwrap();

    // Index 11,000 vs fixed 10,000: +10%.
    let ok = settle(&mut ctx, quote, "alice").unwrap();
    let s: SwapSettled = ok.event();
    assert_eq!(
        (s.epoch, s.index_value, s.taker_pnl),
        (epoch, 11_000, sol(0.4) as i64)
    );
    let ok = settle(&mut ctx, quote, "bob").unwrap();
    assert_eq!(ok.event::<SwapSettled>().taker_pnl, -(sol(0.6) as i64));
    // Carol: +10% on 2 SOL would be 0.2 SOL; clipped to her 5% collateral.
    let ok = settle(&mut ctx, quote2, "carol").unwrap();
    assert_eq!(ok.event::<SwapSettled>().taker_pnl, sol(0.1) as i64);
    // A settled swap is closed; settling again finds no account.
    settle(&mut ctx, quote, "alice").fails_with(anchor_code(ErrorCode::AccountNotInitialized));
    assert!(!ctx.exists(&pda::swap(&quote, &ctx.key("alice"))));

    // Takers got their collateral ± pnl and the swap rent back: net, exactly the pnl.
    let after: Vec<u64> = ["alice", "bob", "carol"]
        .iter()
        .map(|n| ctx.lamports(&ctx.key(n)))
        .collect();
    assert_eq!(after[0], before[0] + sol(0.4));
    assert_eq!(after[1], before[1] - sol(0.6));
    assert_eq!(after[2], before[2] + sol(0.1));

    // Quote: 2 − 0.4 + 0.6 = 2.2 SOL, nothing locked.
    let q: FeeQuote = ctx.get(&quote);
    assert_eq!(
        (q.collateral, q.locked_collateral, q.open_swaps),
        (sol(2.2), 0, 0)
    );
    assert_eq!(ctx.lamports(&quote), quote_rent + sol(2.2));

    // Only the maker withdraws (the quote's seeds bind it to the maker).
    let intruder = ctx.wallet("intruder");
    let stolen = epoch_litesvm_tests::ix::build(
        a::WithdrawQuote {
            maker: intruder,
            fee_index: pda::fee_index(),
            quote,
        },
        i::WithdrawQuote {},
    );
    ctx.send_as(&[stolen], &["intruder"])
        .fails_with(anchor_code(ErrorCode::ConstraintSeeds));
    ctx.send_as(&[ix::withdraw_quote(maker, epoch)], &["maker"])
        .unwrap();
    assert!(!ctx.exists(&quote));
    assert_eq!(ctx.lamports(&maker), maker_before + sol(0.2));
    ctx.send_as(&[ix::withdraw_quote(maker2, epoch)], &["maker2"])
        .unwrap();
}
