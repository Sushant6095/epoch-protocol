//! Validator history and the permissionless score: `init_validator_history`
//! → `copy_vote_account` (a real vote account with credits and a recent vote)
//! → the two Jito copies (mainnet account bytes at Jito's addresses) →
//! `update_stake_info` → `refresh_score` → `request_advance` on the score the
//! chain computed. Also: stale history refused, `update_score` refused once the
//! history is fresh, the Jito copies' address/owner/vote checks, and the hedge
//! rule read from the operator's swaps in `remaining_accounts`.

use anchor_lang::prelude::Pubkey;
use epoch::constants::{
    DEFAULT_CREDITS_REFERENCE_BPS, DEFAULT_CREDITS_WINDOW_EPOCHS, DEFAULT_MAX_COPY_AGE_SLOTS,
    TOKEN_PROGRAM_ID,
};
use epoch::errors::EpochError;
use epoch::events::{
    AdvanceOpened, HistoryInitialized, PriorityFeeDistributionCopied, ScoreRefreshed, ScoreUpdated,
    ScoringConfigured, StakeInfoUpdated, TipDistributionCopied, VoteAccountCopied,
};
use epoch::instructions::ScoringParams;
use epoch::state::{ScoreConfig, Side, ValidatorHistory, ValidatorPosition};
use epoch_litesvm_tests::context::{code, sol, TestContext, SLOTS_PER_EPOCH};
use epoch_litesvm_tests::history::{
    jito_account_for, MAX_CREDITS, PFDA_1048, PFDA_1048_TRANSFERRED, TDA_1050,
    TDA_1050_COMMISSION_BPS, TDA_1050_MAX_TOTAL_CLAIM, TDA_1051,
};
use epoch_litesvm_tests::vote::Validator;
use epoch_litesvm_tests::{ix, pda, ExpectErr};
use solana_account::Account;

use crate::credit::{onboarded, GOOD_SCORE};

/// Credits at 99.50% of the TVC maximum: the default reference, so the credits ratio reads 10,000.
const EARNED: u64 = MAX_CREDITS * DEFAULT_CREDITS_REFERENCE_BPS as u64 / 10_000;
/// Epochs the vote account has credits for, oldest first (41, the current one included).
const FIRST_VOTED_EPOCH: u64 = 763;

fn scoring(market_maker: Pubkey) -> ScoringParams {
    ScoringParams {
        market_maker,
        credits_window_epochs: DEFAULT_CREDITS_WINDOW_EPOCHS,
        count_block_commission: false,
        credits_reference_bps: DEFAULT_CREDITS_REFERENCE_BPS,
        max_copy_age_slots: DEFAULT_MAX_COPY_AGE_SLOTS,
    }
}

/// `onboarded()` (v1 at epoch 800), three epochs of 6 SOL revenue swept into the position's
/// history (now epoch 803), scoring configured with `market_maker`, and v1's vote account given
/// 41 epochs of 99.5% credits and a vote at the current slot.
fn with_revenue(market_maker: Pubkey) -> (TestContext, Validator) {
    let (mut ctx, v) = onboarded();
    let cranker = ctx.wallet("crank");
    let payout = ctx.key("payout1");
    for _ in 0..3 {
        ctx.advance_epochs(1);
        ctx.transfer(&v.vote, sol(6.0));
        ctx.send_as(&[ix::sweep(cranker, v.vote, payout, None)], &["crank"])
            .unwrap();
    }
    let admin = ctx.key("admin");
    let ok = ctx
        .send_as(
            &[ix::configure_scoring(admin, scoring(market_maker))],
            &["admin"],
        )
        .unwrap();
    assert_eq!(ok.event::<ScoringConfigured>().market_maker, market_maker);
    let cfg: ScoreConfig = ctx.get(&pda::score_config());
    assert_eq!(
        (cfg.pool, cfg.credits_window_epochs, cfg.max_copy_age_slots),
        (
            pda::pool(),
            DEFAULT_CREDITS_WINDOW_EPOCHS,
            DEFAULT_MAX_COPY_AGE_SLOTS
        )
    );
    voted_until_now(&mut ctx, &v);
    (ctx, v)
}

/// v1 earned 99.5% of the credits every epoch since `FIRST_VOTED_EPOCH` and voted this slot.
fn voted_until_now(ctx: &mut TestContext, v: &Validator) {
    let (epoch, slot) = (ctx.epoch(), ctx.clock().slot);
    ctx.set_vote_record(&v.vote, FIRST_VOTED_EPOCH..epoch + 1, EARNED, slot);
}

/// `init_validator_history` (first time only), then this epoch's copy and stake info.
fn copy_and_stake(ctx: &mut TestContext, v: &Validator) {
    let keeper = ctx.wallet("keeper");
    if !ctx.exists(&pda::validator_history(&v.vote)) {
        ctx.send_as(&[ix::init_validator_history(keeper, v.vote)], &["keeper"])
            .unwrap();
    }
    let scorer = ctx.key("scorer");
    let epoch = ctx.epoch();
    ctx.send_as(
        &[
            ix::copy_vote_account(keeper, v.vote),
            ix::update_stake_info(scorer, v.vote, epoch, sol(1_000_000.0), 120, false),
        ],
        &["keeper", "scorer"],
    )
    .unwrap();
}

fn refresh(
    ctx: &mut TestContext,
    v: &Validator,
    hedges: &[Pubkey],
) -> epoch_litesvm_tests::TxResult {
    let keeper = ctx.wallet("keeper");
    ctx.send_as(&[ix::refresh_score(keeper, v.vote, hedges)], &["keeper"])
}

fn position(ctx: &TestContext, v: &Validator) -> ValidatorPosition {
    ctx.get(&pda::position(&v.vote))
}

fn request_advance(
    ctx: &mut TestContext,
    v: &Validator,
    amount: u64,
) -> epoch_litesvm_tests::TxResult {
    let payout = ctx.key("payout1");
    let seq = position(ctx, v).advance_seq;
    ctx.send_as(
        &[ix::request_advance(
            v.withdrawer,
            v.vote,
            payout,
            seq,
            amount,
        )],
        &["operator1"],
    )
}

#[test]
fn history_to_an_advance_on_the_score_the_chain_computed() {
    let (mut ctx, v) = with_revenue(Pubkey::default());
    let epoch = ctx.epoch();
    assert_eq!(epoch, 803);
    // Never scored: the advance is refused.
    request_advance(&mut ctx, &v, sol(4.0)).fails_with(code(EpochError::ScoreTooLow));

    // init: anyone pays the rent; every entry starts unknown.
    let keeper = ctx.wallet("keeper");
    let before = ctx.lamports(&keeper);
    let ok = ctx
        .send_as(&[ix::init_validator_history(keeper, v.vote)], &["keeper"])
        .unwrap();
    let init: HistoryInitialized = ok.event();
    assert_eq!(
        (init.vote, init.history, init.payer, init.epoch),
        (v.vote, pda::validator_history(&v.vote), keeper, epoch)
    );
    let space = ValidatorHistory::SPACE;
    assert_eq!(
        ctx.account(&pda::validator_history(&v.vote))
            .unwrap()
            .data
            .len(),
        space
    );
    assert_eq!(ctx.lamports(&keeper), before - ctx.rent_exempt(space));
    // Twice: the account exists.
    ctx.send_as(&[ix::init_validator_history(keeper, v.vote)], &["keeper"])
        .expect_err("a second init_validator_history");

    // copy_vote_account: 40 finished epochs backfilled, this epoch's credits, commissions, the
    // newest vote.
    let slot = ctx.clock().slot;
    let ok = ctx
        .send_as(&[ix::copy_vote_account(keeper, v.vote)], &["keeper"])
        .unwrap();
    let copied: VoteAccountCopied = ok.event();
    assert_eq!(
        (
            copied.epoch,
            copied.epoch_credits,
            copied.epochs_backfilled,
            copied.last_voted_slot
        ),
        (epoch, EARNED, 40, Some(slot))
    );
    assert_eq!(
        (copied.inflation_commission_bps, copied.block_commission_bps),
        (500, 1_000)
    );

    // Jito: the previous epoch's tip account (merkle root uploaded) and priority-fee account, at
    // Jito's addresses, carrying the mainnet bytes; this epoch's tip account does not exist yet
    // (a clean no-op).
    ctx.set_tip_distribution(&v.vote, epoch - 1, TDA_1050);
    ctx.set_priority_fee_distribution(&v.vote, epoch - 1, PFDA_1048);
    let ok = ctx
        .send_as(
            &[
                ix::copy_tip_distribution_account(keeper, v.vote, epoch - 1),
                ix::copy_priority_fee_distribution(keeper, v.vote, epoch - 1),
                ix::copy_tip_distribution_account(keeper, v.vote, epoch),
            ],
            &["keeper"],
        )
        .unwrap();
    let tips: Vec<TipDistributionCopied> = ok.events();
    assert_eq!(
        (
            tips[0].found,
            tips[0].mev_commission_bps,
            tips[0].mev_earned_lamports
        ),
        (
            true,
            Some(TDA_1050_COMMISSION_BPS),
            Some(TDA_1050_MAX_TOTAL_CLAIM)
        )
    );
    assert_eq!(
        (tips[1].epoch, tips[1].found, tips[1].mev_commission_bps),
        (epoch, false, None)
    );
    let pf: PriorityFeeDistributionCopied = ok.event();
    assert_eq!(
        (
            pf.found,
            pf.priority_fee_commission_bps,
            pf.priority_fees_lamports
        ),
        (true, Some(0), Some(PFDA_1048_TRANSFERRED))
    );

    // The one oracle input: stake info, signed by the scorer.
    let scorer = ctx.key("scorer");
    let ok = ctx
        .send_as(
            &[ix::update_stake_info(
                scorer,
                v.vote,
                epoch,
                sol(1_000_000.0),
                120,
                false,
            )],
            &["scorer"],
        )
        .unwrap();
    let stake: StakeInfoUpdated = ok.event();
    assert_eq!(
        (stake.epoch, stake.rank, stake.superminority),
        (epoch, 120, false)
    );

    // refresh_score: credits 99.5% = the reference (10,000), the highest commission over the
    // window is Jito's 700 bps, 41 epochs active, not delinquent → 6,000 + 1,900 + 1,500.
    let ok = refresh(&mut ctx, &v, &[]).unwrap();
    let r: ScoreRefreshed = ok.event();
    assert_eq!(
        (
            r.score,
            r.credits_ratio_bps,
            r.credits_ratio_raw_bps,
            r.commission_bps,
            r.epochs_active
        ),
        (9_400, 10_000, DEFAULT_CREDITS_REFERENCE_BPS, 700, 41)
    );
    assert_eq!(
        (r.delinquent, r.superminority, r.hedged),
        (false, false, false)
    );
    assert_eq!(ok.event::<ScoreUpdated>().score, 9_400);
    let pos = position(&ctx, &v);
    assert_eq!(
        (pos.score, pos.last_scored_epoch, pos.hedged),
        (9_400, epoch, false)
    );

    // The scorer's fallback is refused now that the history is fresh.
    ctx.send_as(&[ix::update_score(scorer, v.vote, GOOD_SCORE)], &["scorer"])
        .fails_with(code(EpochError::HistoryIsFresh));

    // The advance runs on that score: 25% of 18 SOL of trailing revenue, unhedged.
    request_advance(&mut ctx, &v, sol(4.6)).fails_with(code(EpochError::OverLimit));
    let ok = request_advance(&mut ctx, &v, sol(4.5)).unwrap();
    let opened: AdvanceOpened = ok.event();
    assert_eq!(
        (opened.vote, opened.principal, opened.epoch),
        (v.vote, sol(4.5), epoch)
    );
    ctx.assert_ledger();
}

#[test]
fn stale_history_is_refused_and_the_fallback_returns_next_epoch() {
    let (mut ctx, v) = with_revenue(Pubkey::default());
    let keeper = ctx.wallet("keeper");
    let scorer = ctx.key("scorer");
    let epoch = ctx.epoch();
    ctx.send_as(&[ix::init_validator_history(keeper, v.vote)], &["keeper"])
        .unwrap();

    // No vote copy this epoch.
    refresh(&mut ctx, &v, &[]).fails_with(code(EpochError::HistoryStale));
    // A copy, but no stake info for this epoch.
    ctx.send_as(&[ix::copy_vote_account(keeper, v.vote)], &["keeper"])
        .unwrap();
    refresh(&mut ctx, &v, &[]).fails_with(code(EpochError::StakeInfoStale));
    // Stake info, then the copy ages past max_copy_age_slots.
    ctx.send_as(
        &[ix::update_stake_info(
            scorer,
            v.vote,
            epoch,
            sol(1.0),
            7,
            true,
        )],
        &["scorer"],
    )
    .unwrap();
    ctx.advance_slots(u64::from(DEFAULT_MAX_COPY_AGE_SLOTS) + 1);
    refresh(&mut ctx, &v, &[]).fails_with(code(EpochError::HistoryStale));

    // A fresh copy of a vote account whose newest vote is that old: delinquent, score 0.
    ctx.send_as(&[ix::copy_vote_account(keeper, v.vote)], &["keeper"])
        .unwrap();
    let r: ScoreRefreshed = refresh(&mut ctx, &v, &[]).unwrap().event();
    assert_eq!((r.delinquent, r.score), (true, 0));
    // It votes again: scored, and the scorer's superminority bit caps the score at 5,000.
    voted_until_now(&mut ctx, &v);
    ctx.send_as(&[ix::copy_vote_account(keeper, v.vote)], &["keeper"])
        .unwrap();
    let r: ScoreRefreshed = refresh(&mut ctx, &v, &[]).unwrap().event();
    assert_eq!(
        (r.delinquent, r.superminority, r.score),
        (false, true, 5_000)
    );

    // Next epoch: nothing copied yet, so the history is stale and the scorer's fallback works
    // again (and is refused as soon as this epoch's copy lands).
    ctx.advance_epochs(1);
    refresh(&mut ctx, &v, &[]).fails_with(code(EpochError::HistoryStale));
    ctx.send_as(&[ix::update_score(scorer, v.vote, GOOD_SCORE)], &["scorer"])
        .unwrap();
    voted_until_now(&mut ctx, &v);
    ctx.send_as(&[ix::copy_vote_account(keeper, v.vote)], &["keeper"])
        .unwrap();
    ctx.send_as(&[ix::update_score(scorer, v.vote, GOOD_SCORE)], &["scorer"])
        .fails_with(code(EpochError::HistoryIsFresh));
}

#[test]
fn history_inputs_are_checked() {
    let (mut ctx, v) = with_revenue(Pubkey::default());
    let keeper = ctx.wallet("keeper");
    let scorer = ctx.key("scorer");
    let admin = ctx.key("admin");
    let epoch = ctx.epoch();

    // Only a vote account gets a history.
    ctx.send_as(&[ix::init_validator_history(keeper, keeper)], &["keeper"])
        .fails_with(code(EpochError::NotAVoteAccount));
    ctx.send_as(&[ix::init_validator_history(keeper, v.vote)], &["keeper"])
        .unwrap();

    // Jito copies: the epoch must be in the 64-epoch ring and started.
    ctx.send_as(
        &[ix::copy_tip_distribution_account(keeper, v.vote, epoch + 1)],
        &["keeper"],
    )
    .fails_with(code(EpochError::HistoryEpochOutOfRange));
    ctx.send_as(
        &[ix::copy_tip_distribution_account(
            keeper,
            v.vote,
            epoch - 64,
        )],
        &["keeper"],
    )
    .fails_with(code(EpochError::HistoryEpochOutOfRange));
    // Not Jito's address for (vote, epoch): another epoch's account.
    let other = ctx.set_tip_distribution(&v.vote, epoch - 2, TDA_1050);
    ctx.send_as(
        &[ix::copy_tip_distribution_account_at(
            keeper,
            v.vote,
            epoch - 1,
            other,
        )],
        &["keeper"],
    )
    .fails_with(code(EpochError::InvalidDistributionAccount));
    // Jito's address, but the account names another validator.
    let key = pda::tip_distribution(&v.vote, epoch - 1);
    ctx.set_raw(
        key,
        epoch::constants::JITO_TIP_DISTRIBUTION_PROGRAM_ID,
        jito_account_for(TDA_1050, &keeper),
    );
    ctx.send_as(
        &[ix::copy_tip_distribution_account(keeper, v.vote, epoch - 1)],
        &["keeper"],
    )
    .fails_with(code(EpochError::InvalidDistributionAccount));
    // Jito's address, a foreign owner.
    ctx.set_raw(key, TOKEN_PROGRAM_ID, jito_account_for(TDA_1050, &v.vote));
    ctx.send_as(
        &[ix::copy_tip_distribution_account(keeper, v.vote, epoch - 1)],
        &["keeper"],
    )
    .fails_with(code(EpochError::InvalidDistributionAccount));
    // The priority-fee layout where the tip layout is expected (wrong discriminator).
    ctx.set_tip_distribution(&v.vote, epoch - 1, PFDA_1048);
    ctx.send_as(
        &[ix::copy_tip_distribution_account(keeper, v.vote, epoch - 1)],
        &["keeper"],
    )
    .fails_with(code(EpochError::InvalidDistributionAccount));
    // Before the merkle root: the commission only.
    ctx.set_tip_distribution(&v.vote, epoch - 1, TDA_1051);
    let ok = ctx
        .send_as(
            &[ix::copy_tip_distribution_account(keeper, v.vote, epoch - 1)],
            &["keeper"],
        )
        .unwrap();
    let t: TipDistributionCopied = ok.event();
    assert_eq!(
        (t.found, t.mev_commission_bps, t.mev_earned_lamports),
        (true, Some(TDA_1050_COMMISSION_BPS), None)
    );

    // Stake info: rank 1 or more, inside the ring.
    ctx.send_as(
        &[ix::update_stake_info(
            scorer,
            v.vote,
            epoch,
            sol(1.0),
            0,
            false,
        )],
        &["scorer"],
    )
    .fails_with(code(EpochError::InvalidParams));
    ctx.send_as(
        &[ix::update_stake_info(
            scorer,
            v.vote,
            epoch + 1,
            sol(1.0),
            1,
            false,
        )],
        &["scorer"],
    )
    .fails_with(code(EpochError::HistoryEpochOutOfRange));

    // Scoring settings stay in range.
    for bad in [
        ScoringParams {
            credits_window_epochs: 0,
            ..scoring(Pubkey::default())
        },
        ScoringParams {
            credits_window_epochs: epoch::constants::MAX_CREDITS_WINDOW_EPOCHS + 1,
            ..scoring(Pubkey::default())
        },
        ScoringParams {
            credits_reference_bps: epoch::constants::MIN_CREDITS_REFERENCE_BPS - 1,
            ..scoring(Pubkey::default())
        },
        ScoringParams {
            max_copy_age_slots: epoch::constants::MIN_MAX_COPY_AGE_SLOTS - 1,
            ..scoring(Pubkey::default())
        },
    ] {
        ctx.send_as(&[ix::configure_scoring(admin, bad)], &["admin"])
            .fails_with(code(EpochError::InvalidScoreConfig));
    }
}

/// The market maker's quotes for each of the next five epochs, and `taker`'s receive-fixed swaps
/// of `notional` on them. Returns the swap addresses in epoch order.
fn hedge(ctx: &mut TestContext, taker: &str, notional: u64) -> Vec<Pubkey> {
    let maker = ctx.key("maker");
    let taker_key = ctx.key(taker);
    let epoch = ctx.epoch();
    (epoch + 1..=epoch + 5)
        .map(|e| {
            let quote = pda::quote(&maker, e);
            if !ctx.exists(&quote) {
                ctx.send_as(
                    &[ix::post_quote(
                        maker,
                        e,
                        10_000,
                        sol(20.0),
                        2_000,
                        e * SLOTS_PER_EPOCH,
                    )],
                    &["maker"],
                )
                .unwrap();
            }
            ctx.send_as(
                &[ix::open_swap(
                    taker_key,
                    quote,
                    notional,
                    Side::ReceiveFixed,
                )],
                &[taker],
            )
            .unwrap();
            pda::swap(&quote, &taker_key)
        })
        .collect()
}

#[test]
fn hedge_rule_reads_the_operators_swaps_from_remaining_accounts() {
    let (mut ctx, v) = with_revenue_and_maker();
    assert_eq!(
        ctx.key("maker"),
        ctx.get::<ScoreConfig>(&pda::score_config()).market_maker
    );

    let admin = ctx.key("admin");
    let publisher = ctx.wallet("publisher");
    ctx.send_as(
        &[ix::initialize_index(admin, publisher, 100, 2_000)],
        &["admin"],
    )
    .unwrap();
    copy_and_stake(&mut ctx, &v);

    // Each of the next five epochs needs half the average revenue (6 SOL) on receive-fixed swaps.
    let swaps = hedge(&mut ctx, "operator1", sol(3.0));
    ctx.wallet("operator2");
    let others = hedge(&mut ctx, "operator2", sol(3.0));
    let r: ScoreRefreshed = refresh(&mut ctx, &v, &swaps).unwrap().event();
    assert_eq!((r.hedged, r.hedge_required_notional), (true, sol(3.0)));
    assert!(position(&ctx, &v).hedged);
    // Hedged: the limit is 40% of 18 SOL.
    request_advance(&mut ctx, &v, sol(7.3)).fails_with(code(EpochError::OverLimit));

    let invalid = code(EpochError::InvalidHedgeAccount);
    // Exactly five accounts, in epoch order, each the operator's own swap address.
    refresh(&mut ctx, &v, &swaps[..4]).fails_with(invalid);
    let reversed: Vec<Pubkey> = swaps.iter().rev().copied().collect();
    refresh(&mut ctx, &v, &reversed).fails_with(invalid);
    let mut wrong_taker = swaps.clone();
    wrong_taker[0] = others[0];
    refresh(&mut ctx, &v, &wrong_taker).fails_with(invalid);

    // At the operator's own address, the account itself is checked.
    let real = ctx.account(&swaps[0]).unwrap();
    // Owned by another program.
    ctx.set_raw(swaps[0], TOKEN_PROGRAM_ID, real.data.clone());
    refresh(&mut ctx, &v, &swaps).fails_with(invalid);
    // Another taker's swap planted at the operator's address.
    let planted = ctx.account(&others[0]).unwrap().data;
    ctx.set_raw(swaps[0], pda::TEST_PROGRAM_ID, planted);
    refresh(&mut ctx, &v, &swaps).fails_with(invalid);
    // The operator's swap on another epoch planted there.
    let later = ctx.account(&swaps[1]).unwrap().data;
    ctx.set_raw(swaps[0], pda::TEST_PROGRAM_ID, later);
    refresh(&mut ctx, &v, &swaps).fails_with(invalid);
    // No swap at all on one epoch: valid, but not hedged.
    ctx.svm.set_account(swaps[0], Account::default()).unwrap();
    let r: ScoreRefreshed = refresh(&mut ctx, &v, &swaps).unwrap().event();
    assert!(!r.hedged);
    assert!(!position(&ctx, &v).hedged);
    // The real swap back: hedged again.
    ctx.svm.set_account(swaps[0], real).unwrap();
    let r: ScoreRefreshed = refresh(&mut ctx, &v, &swaps).unwrap().event();
    assert!(r.hedged);
    let ok = request_advance(&mut ctx, &v, sol(7.2)).unwrap();
    assert_eq!(ok.event::<AdvanceOpened>().principal, sol(7.2));
}

/// `with_revenue` with the `maker` wallet as Epoch's market maker.
fn with_revenue_and_maker() -> (TestContext, Validator) {
    let (mut ctx, v) = with_revenue(Pubkey::default());
    let maker = ctx.wallet("maker");
    let admin = ctx.key("admin");
    ctx.send_as(&[ix::configure_scoring(admin, scoring(maker))], &["admin"])
        .unwrap();
    (ctx, v)
}
