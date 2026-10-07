//! Revenue tokens: register (launch checks against fabricated DBC and SPL
//! accounts) → every sweep in the term moves the share into the buyback
//! escrow → `redeem` after the term (or during it when the admin opens it)
//! → `close_revenue_token`. `execute_buyback` and `sync_revenue_token_pool`
//! need a curve or a DAMM v2 pool that Meteora itself created: see
//! `tests/README.md`.

use anchor_lang::prelude::Pubkey;
use epoch::constants::TOKEN_PROGRAM_ID;
use epoch::errors::EpochError;
use epoch::events::{
    RevenueShareSwept, RevenueTokenClosed, RevenueTokenRedeemed, RevenueTokenRegistered, Swept,
};
use epoch::state::{
    BuybackParams, RevenueToken, RevenueTokenStatus, ValidatorPosition, FLAG_REDEEM_DURING_TERM,
};
use epoch_litesvm_tests::context::{code, sol, TestContext, TxResult};
use epoch_litesvm_tests::vote::Validator;
use epoch_litesvm_tests::{ix, pda, ExpectErr};

use crate::credit::onboarded;

/// 1,000 tokens, 6 decimals.
const SUPPLY: u64 = 1_000_000_000;
const SHARE_BPS: u16 = 2_000;
const TERM: u16 = 10;

struct Launch {
    mint: Pubkey,
    dbc_pool: Pubkey,
    dbc_config: Pubkey,
}

/// A fixed-supply mint on a DBC curve whose config names the Epoch treasury.
fn launch(ctx: &mut TestContext) -> Launch {
    let (mint, dbc_pool, dbc_config) = (
        Pubkey::new_unique(),
        Pubkey::new_unique(),
        Pubkey::new_unique(),
    );
    ctx.set_mint(mint, SUPPLY, None);
    ctx.set_dbc_config(dbc_config, pda::partner_treasury());
    ctx.set_dbc_pool(dbc_pool, dbc_config, mint);
    Launch {
        mint,
        dbc_pool,
        dbc_config,
    }
}

fn register(
    ctx: &mut TestContext,
    who: &str,
    v: &Validator,
    l: &Launch,
    share_bps: u16,
    term: u16,
) -> TxResult {
    let operator = ctx.wallet(who);
    ctx.send_as(
        &[ix::register_revenue_token(
            operator,
            v.vote,
            l.mint,
            l.dbc_pool,
            l.dbc_config,
            share_bps,
            term,
        )],
        &[who],
    )
}

fn sweep_with_token(ctx: &mut TestContext, v: &Validator) -> TxResult {
    let cranker = ctx.wallet("crank");
    let payout = ctx.key("payout1");
    let token = Some((pda::revenue_token(&v.vote), pda::buyback(&v.vote)));
    ctx.send_as(
        &[ix::sweep_with_token(cranker, v.vote, payout, None, token)],
        &["crank"],
    )
}

fn escrow_available(ctx: &TestContext, v: &Validator) -> u64 {
    ctx.lamports(&pda::buyback(&v.vote)) - ctx.rent_exempt(0)
}

#[test]
fn register_checks_the_launch_and_the_operator() {
    let (mut ctx, v) = onboarded();
    let good = launch(&mut ctx);

    // Role and terms.
    register(&mut ctx, "intruder", &v, &good, SHARE_BPS, TERM)
        .fails_with(code(EpochError::NotOperator));
    for (share, term, err) in [
        (0, TERM, EpochError::ShareOutOfRange),
        (5_001, TERM, EpochError::ShareOutOfRange),
        (SHARE_BPS, 9, EpochError::TermOutOfRange),
        (SHARE_BPS, 1_001, EpochError::TermOutOfRange),
    ] {
        register(&mut ctx, "operator1", &v, &good, share, term).fails_with(code(err));
    }

    // A mint someone can still mint (or freeze) is refused.
    let minted = launch(&mut ctx);
    let someone = Pubkey::new_unique();
    ctx.set_mint(minted.mint, SUPPLY, Some(someone));
    ctx.set_dbc_pool(minted.dbc_pool, minted.dbc_config, minted.mint);
    register(&mut ctx, "operator1", &v, &minted, SHARE_BPS, TERM)
        .fails_with(code(EpochError::InvalidRevenueMint));

    // The curve must trade this mint under this config.
    let other = launch(&mut ctx);
    let crossed = Launch {
        mint: good.mint,
        dbc_pool: other.dbc_pool,
        dbc_config: good.dbc_config,
    };
    register(&mut ctx, "operator1", &v, &crossed, SHARE_BPS, TERM)
        .fails_with(code(EpochError::InvalidDbcPool));

    // A config whose fees go to someone else than the Epoch treasury.
    let foreign = launch(&mut ctx);
    ctx.set_dbc_config(foreign.dbc_config, someone);
    register(&mut ctx, "operator1", &v, &foreign, SHARE_BPS, TERM)
        .fails_with(code(EpochError::InvalidDbcConfig));

    // An account not owned by DBC is not a curve.
    let fake = launch(&mut ctx);
    let data = ctx.account(&fake.dbc_pool).unwrap().data;
    ctx.set_raw(fake.dbc_pool, Pubkey::new_unique(), data);
    register(&mut ctx, "operator1", &v, &fake, SHARE_BPS, TERM)
        .fails_with(code(EpochError::InvalidDbcPool));

    // The real launch registers once.
    register(&mut ctx, "operator1", &v, &good, SHARE_BPS, TERM).unwrap();
    assert!(register(&mut ctx, "operator1", &v, &good, SHARE_BPS, TERM).is_err());
}

#[test]
fn sweep_share_lands_in_the_escrow_and_redeems_after_the_term() {
    let (mut ctx, v) = onboarded();
    let l = launch(&mut ctx);
    let e0 = ctx.epoch();

    let ok = register(&mut ctx, "operator1", &v, &l, SHARE_BPS, TERM).unwrap();
    let reg: RevenueTokenRegistered = ok.event();
    let rt_key = pda::revenue_token(&v.vote);
    assert_eq!(
        (reg.vote, reg.revenue_token, reg.mint),
        (v.vote, rt_key, l.mint)
    );
    assert_eq!(
        (reg.share_bps, reg.start_epoch, reg.term_end_epoch),
        (SHARE_BPS, e0 + 1, e0 + 1 + u64::from(TERM))
    );
    // The commission floor is today's commissions.
    assert_eq!(
        (reg.inflation_commission_bps, reg.block_commission_bps),
        (500, 1_000)
    );
    let rt: RevenueToken = ctx.get(&rt_key);
    assert_eq!(rt.status, RevenueTokenStatus::Curve);
    assert_eq!((rt.dbc_pool, rt.dbc_config), (l.dbc_pool, l.dbc_config));
    let pos: ValidatorPosition = ctx.get(&pda::position(&v.vote));
    assert_eq!(pos.revenue_token, rt_key);
    // The escrow is rent-exempt and owns an SPL Token account for the mint.
    assert_eq!(escrow_available(&ctx, &v), 0);
    let tokens = ctx.account(&pda::buyback_tokens(&v.vote)).unwrap();
    assert_eq!(tokens.owner, TOKEN_PROGRAM_ID);
    assert_eq!(&tokens.data[0..32], l.mint.as_ref());
    assert_eq!(&tokens.data[32..64], pda::buyback(&v.vote).as_ref());
    assert_eq!(ctx.token_amount(&pda::buyback_tokens(&v.vote)), 0);

    // From now on a sweep must bring the token's accounts, the right ones.
    ctx.advance_epochs(1);
    ctx.transfer(&v.vote, sol(2.0));
    let cranker = ctx.wallet("crank");
    let payout = ctx.key("payout1");
    ctx.send_as(&[ix::sweep(cranker, v.vote, payout, None)], &["crank"])
        .fails_with(code(EpochError::RevenueTokenAccountsMissing));
    let wrong = Some((rt_key, payout));
    ctx.send_as(
        &[ix::sweep_with_token(cranker, v.vote, payout, None, wrong)],
        &["crank"],
    )
    .fails_with(code(EpochError::RevenueTokenMismatch));

    // Epoch 1 of the term: 20% of 2 SOL goes to the escrow before anything else.
    let payout_before = ctx.lamports(&payout);
    let ok = sweep_with_token(&mut ctx, &v).unwrap();
    let swept: Swept = ok.event();
    let share: RevenueShareSwept = ok.event();
    assert_eq!(swept.gross, sol(2.0));
    assert_eq!(share.share, sol(0.4));
    assert_eq!(share.escrow_balance, sol(0.4));
    assert_eq!(escrow_available(&ctx, &v), sol(0.4));
    // No advance open: the rest goes to the operator, less the pool fee.
    assert_eq!(ctx.lamports(&payout) - payout_before, swept.to_operator);
    assert_eq!(
        swept.gross,
        share.share + swept.remitted + swept.to_operator
    );
    // Revenue history is net of the share (the share never backs credit).
    let pos: ValidatorPosition = ctx.get(&pda::position(&v.vote));
    assert_eq!(pos.trailing_revenue(), sol(1.6));
    ctx.assert_ledger();

    // Epoch 2: 1 SOL → 0.2 SOL more.
    ctx.advance_epochs(1);
    ctx.transfer(&v.vote, sol(1.0));
    sweep_with_token(&mut ctx, &v).unwrap();
    assert_eq!(escrow_available(&ctx, &v), sol(0.6));
    let rt: RevenueToken = ctx.get(&rt_key);
    assert_eq!(rt.total_escrowed, sol(0.6));

    // A holder with 100 of the 1,000 tokens.
    let holder = ctx.wallet("holder");
    let holder_tokens = Pubkey::new_unique();
    ctx.set_token_account(holder_tokens, l.mint, holder, 100_000_000);
    let redeem = |amount| ix::redeem(holder, holder_tokens, v.vote, l.mint, amount);

    // Closed during the term unless the admin opens it.
    ctx.send_as(&[redeem(100_000_000)], &["holder"])
        .fails_with(code(EpochError::RedeemNotAllowed));
    let open = BuybackParams {
        flags: FLAG_REDEEM_DURING_TERM,
        max_impact_bps: rt.max_impact_bps,
        ..BuybackParams::default()
    };
    let intruder = ctx.wallet("intruder");
    ctx.send_as(
        &[ix::configure_revenue_token(intruder, v.vote, open)],
        &["intruder"],
    )
    .fails_with(code(EpochError::NotAdmin));

    // After the term it is open to everyone.
    ctx.warp_to_epoch(e0 + 1 + u64::from(TERM));
    ctx.send_as(&[redeem(0)], &["holder"])
        .fails_with(code(EpochError::ZeroAmount));
    ctx.send_as(&[redeem(SUPPLY + 1)], &["holder"])
        .fails_with(code(EpochError::RedeemTooLarge));
    // Someone else's tokens cannot be burned (the token program checks the owner).
    let thief = ctx.wallet("thief");
    assert!(ctx
        .send_as(
            &[ix::redeem(thief, holder_tokens, v.vote, l.mint, 1_000_000)],
            &["thief"]
        )
        .is_err());

    // 100 / 1,000 tokens → 10% of the 0.6 SOL escrow.
    let before = ctx.lamports(&holder);
    let ok = ctx.send_as(&[redeem(100_000_000)], &["holder"]).unwrap();
    let ev: RevenueTokenRedeemed = ok.event();
    assert_eq!(
        (ev.tokens_burned, ev.lamports_out, ev.circulating_supply),
        (100_000_000, sol(0.06), SUPPLY)
    );
    assert_eq!(ctx.lamports(&holder) - before, sol(0.06));
    assert_eq!(ctx.token_amount(&holder_tokens), 0);
    assert_eq!(ctx.mint_supply(&l.mint), SUPPLY - 100_000_000);
    assert_eq!(escrow_available(&ctx, &v), sol(0.54));
    let rt: RevenueToken = ctx.get(&rt_key);
    assert_eq!(
        (rt.total_redeemed, rt.total_redeemed_lamports),
        (100_000_000, sol(0.06))
    );

    // Same rate for the next holder: 0.54 SOL over 900 tokens = 0.0006 SOL per token.
    let holder2 = ctx.wallet("holder2");
    let tokens2 = Pubkey::new_unique();
    ctx.set_token_account(tokens2, l.mint, holder2, 50_000_000);
    let ok = ctx
        .send_as(
            &[ix::redeem(holder2, tokens2, v.vote, l.mint, 50_000_000)],
            &["holder2"],
        )
        .unwrap();
    assert_eq!(ok.event::<RevenueTokenRedeemed>().lamports_out, sol(0.03));
}

#[test]
fn admin_can_open_redemptions_during_the_term() {
    let (mut ctx, v) = onboarded();
    let l = launch(&mut ctx);
    register(&mut ctx, "operator1", &v, &l, SHARE_BPS, TERM).unwrap();
    ctx.advance_epochs(1);
    ctx.transfer(&v.vote, sol(1.0));
    sweep_with_token(&mut ctx, &v).unwrap();
    assert_eq!(escrow_available(&ctx, &v), sol(0.2));

    let rt: RevenueToken = ctx.get(&pda::revenue_token(&v.vote));
    let admin = ctx.key("admin");
    // The impact cap is bounded by the venue's fee floor (1% → 200 bps).
    let too_loose = BuybackParams {
        max_impact_bps: rt.max_impact_bound() + 1,
        ..BuybackParams::default()
    };
    ctx.send_as(
        &[ix::configure_revenue_token(admin, v.vote, too_loose)],
        &["admin"],
    )
    .fails_with(code(EpochError::ImpactAboveFeeBound));
    let open = BuybackParams {
        flags: FLAG_REDEEM_DURING_TERM,
        max_impact_bps: rt.max_impact_bps,
        ..BuybackParams::default()
    };
    ctx.send_as(
        &[ix::configure_revenue_token(admin, v.vote, open)],
        &["admin"],
    )
    .unwrap();

    let holder = ctx.wallet("holder");
    let holder_tokens = Pubkey::new_unique();
    ctx.set_token_account(holder_tokens, l.mint, holder, SUPPLY / 2);
    let ok = ctx
        .send_as(
            &[ix::redeem(
                holder,
                holder_tokens,
                v.vote,
                l.mint,
                SUPPLY / 2,
            )],
            &["holder"],
        )
        .unwrap();
    assert_eq!(ok.event::<RevenueTokenRedeemed>().lamports_out, sol(0.1));
}

#[test]
fn close_waits_for_the_term_and_the_grace_period_then_books_the_unclaimed_escrow() {
    let (mut ctx, v) = onboarded();
    let l = launch(&mut ctx);
    let e0 = ctx.epoch();
    register(&mut ctx, "operator1", &v, &l, SHARE_BPS, TERM).unwrap();
    ctx.advance_epochs(1);
    ctx.transfer(&v.vote, sol(1.0));
    sweep_with_token(&mut ctx, &v).unwrap();
    assert_eq!(escrow_available(&ctx, &v), sol(0.2));

    let cranker = ctx.wallet("crank");
    let operator = v.withdrawer;
    let close = |op| ix::close_revenue_token(cranker, op, v.vote, l.mint);
    ctx.send_as(&[close(operator)], &["crank"])
        .fails_with(code(EpochError::RevenueTokenTermActive));
    let term_end = e0 + 1 + u64::from(TERM);
    ctx.warp_to_epoch(term_end);
    // More than dust in the escrow: holders get the grace period to redeem.
    ctx.send_as(&[close(operator)], &["crank"])
        .fails_with(code(EpochError::EscrowNotEmpty));
    ctx.warp_to_epoch(term_end + epoch::constants::REDEEM_GRACE_EPOCHS - 1);
    ctx.send_as(&[close(operator)], &["crank"])
        .fails_with(code(EpochError::EscrowNotEmpty));
    ctx.advance_epochs(1);
    // The rent goes back to the operator only.
    let intruder = ctx.wallet("intruder");
    ctx.send_as(&[close(intruder)], &["crank"])
        .fails_with(code(EpochError::PayoutMismatch));

    let (cash, income) = (ctx.pool().cash, ctx.pool().income_unallocated);
    let vault = ctx.lamports(&pda::vault());
    let op_before = ctx.lamports(&operator);
    let rt_rent = ctx.lamports(&pda::revenue_token(&v.vote));
    let ok = ctx.send_as(&[close(operator)], &["crank"]).unwrap();
    let ev: RevenueTokenClosed = ok.event();
    assert_eq!(
        (ev.total_escrowed, ev.lamports_to_pool),
        (sol(0.2), sol(0.2))
    );
    // The unclaimed escrow is pool income; rents (token record, escrow, token account) go to the operator.
    assert_eq!(ctx.pool().cash, cash + sol(0.2));
    assert_eq!(ctx.pool().income_unallocated, income + sol(0.2));
    assert_eq!(ctx.lamports(&pda::vault()), vault + sol(0.2));
    let token_rent = ctx.rent_exempt(epoch_litesvm_tests::meteora::TOKEN_ACCOUNT_LEN);
    assert_eq!(
        ctx.lamports(&operator) - op_before,
        rt_rent + ctx.rent_exempt(0) + token_rent
    );
    assert!(!ctx.exists(&pda::revenue_token(&v.vote)));
    assert!(!ctx.exists(&pda::buyback_tokens(&v.vote)));
    let pos: ValidatorPosition = ctx.get(&pda::position(&v.vote));
    assert_eq!(pos.revenue_token, Pubkey::default());
    ctx.assert_ledger();
}

#[test]
fn sync_records_only_the_damm_pool_dbc_migrated_to() {
    use epoch::constants::{CP_AMM_PROGRAM_ID, DBC_POOL_AUTHORITY, NATIVE_MINT};
    use epoch::events::RevenueTokenPoolSynced;
    use epoch_litesvm_tests::meteora::{damm_config_data, damm_pool_address, damm_pool_data};

    let (mut ctx, v) = onboarded();
    let l = launch(&mut ctx);
    register(&mut ctx, "operator1", &v, &l, SHARE_BPS, TERM).unwrap();
    let cranker = ctx.wallet("crank");
    let config = Pubkey::new_unique();
    ctx.set_raw(
        config,
        CP_AMM_PROGRAM_ID,
        damm_config_data(DBC_POOL_AUTHORITY),
    );
    let pool = damm_pool_address(&config, &l.mint);
    ctx.set_raw(pool, CP_AMM_PROGRAM_ID, damm_pool_data(l.mint, NATIVE_MINT));
    let sync = |dbc: Pubkey, cfg: Pubkey, damm: Pubkey| {
        ix::sync_revenue_token_pool(cranker, v.vote, dbc, cfg, damm)
    };

    // Not graduated yet.
    ctx.send_as(&[sync(l.dbc_pool, config, pool)], &["crank"])
        .fails_with(code(EpochError::PoolNotMigrated));
    ctx.patch(l.dbc_pool, 305, &[1]);
    // Another curve.
    let other = launch(&mut ctx);
    ctx.send_as(&[sync(other.dbc_pool, config, pool)], &["crank"])
        .fails_with(code(EpochError::InvalidDbcPool));
    // A lookalike pool at another address (someone else's pool for the pair).
    let lookalike = Pubkey::new_unique();
    ctx.set_raw(
        lookalike,
        CP_AMM_PROGRAM_ID,
        damm_pool_data(l.mint, NATIVE_MINT),
    );
    ctx.send_as(&[sync(l.dbc_pool, config, lookalike)], &["crank"])
        .fails_with(code(EpochError::InvalidDammPool));
    // A config DBC does not control, with its own correctly derived pool.
    let open_config = Pubkey::new_unique();
    ctx.set_raw(
        open_config,
        CP_AMM_PROGRAM_ID,
        damm_config_data(Pubkey::new_unique()),
    );
    let open_pool = damm_pool_address(&open_config, &l.mint);
    ctx.set_raw(
        open_pool,
        CP_AMM_PROGRAM_ID,
        damm_pool_data(l.mint, NATIVE_MINT),
    );
    ctx.send_as(&[sync(l.dbc_pool, open_config, open_pool)], &["crank"])
        .fails_with(code(EpochError::InvalidDammPool));
    // The pool must trade the token against wrapped SOL, in DBC's orientation.
    ctx.set_raw(pool, CP_AMM_PROGRAM_ID, damm_pool_data(NATIVE_MINT, l.mint));
    ctx.send_as(&[sync(l.dbc_pool, config, pool)], &["crank"])
        .fails_with(code(EpochError::InvalidDammPool));
    ctx.set_raw(pool, CP_AMM_PROGRAM_ID, damm_pool_data(l.mint, NATIVE_MINT));

    let ok = ctx
        .send_as(&[sync(l.dbc_pool, config, pool)], &["crank"])
        .unwrap();
    let ev: RevenueTokenPoolSynced = ok.event();
    assert_eq!(
        (ev.damm_pool, ev.damm_config, ev.mint),
        (pool, config, l.mint)
    );
    let rt: RevenueToken = ctx.get(&pda::revenue_token(&v.vote));
    assert_eq!(
        (rt.status, rt.damm_pool),
        (RevenueTokenStatus::Graduated, pool)
    );
    // Re-syncing the same pool is a no-op; another pool is refused.
    ctx.send_as(&[sync(l.dbc_pool, config, pool)], &["crank"])
        .unwrap();
    ctx.send_as(&[sync(l.dbc_pool, open_config, open_pool)], &["crank"])
        .fails_with(code(EpochError::InvalidDammPool));
}

#[test]
fn buyback_slices_follow_the_schedule_and_wait_for_the_sweep() {
    use anchor_lang::prelude::EpochSchedule;
    use epoch::state::FLAG_BUYBACKS_PAUSED;
    use epoch_litesvm_tests::ix::CurveVenue;

    let (mut ctx, v) = onboarded();
    let l = launch(&mut ctx);
    let e0 = ctx.epoch();
    register(&mut ctx, "operator1", &v, &l, SHARE_BPS, TERM).unwrap();
    let rt: RevenueToken = ctx.get(&pda::revenue_token(&v.vote));
    let (slices, window) = (rt.slices_per_epoch, u64::from(rt.window_slots));
    let venue = CurveVenue {
        dbc_pool: l.dbc_pool,
        dbc_config: l.dbc_config,
        token_vault: Pubkey::new_unique(),
        quote_vault: Pubkey::new_unique(),
    };
    let cranker = ctx.wallet("crank");
    let buy = |slice, min_out| ix::execute_buyback(cranker, v.vote, l.mint, &venue, slice, min_out);

    // First slot of the term's first epoch; the schedule sysvar agrees with the clock.
    ctx.warp_to_epoch(e0 + 1);
    let clock = ctx.clock();
    let schedule: EpochSchedule = ctx.svm.get_sysvar();
    assert_eq!(schedule.get_epoch_and_slot_index(clock.slot), (e0 + 1, 0));

    ctx.send_as(&[buy(0, 0)], &["crank"])
        .fails_with(code(EpochError::MinOutTooLow));
    ctx.send_as(&[buy(slices, 1)], &["crank"])
        .fails_with(code(EpochError::InvalidSlice));
    ctx.send_as(&[buy(1, 1)], &["crank"])
        .fails_with(code(EpochError::SliceNotDue));
    // The epoch's share is not in the escrow yet.
    ctx.send_as(&[buy(0, 1)], &["crank"])
        .fails_with(code(EpochError::SweepPending));
    ctx.transfer(&v.vote, sol(1.0));
    sweep_with_token(&mut ctx, &v).unwrap();
    // Schedule passed: the venue is checked next (a wrong DBC program is refused).
    let mut wrong = ix::execute_buyback_accounts(cranker, v.vote, l.mint, &venue);
    wrong.venue_program = epoch::constants::CP_AMM_PROGRAM_ID;
    ctx.send_as(
        &[ix::build(
            wrong,
            epoch::instruction::ExecuteBuyback {
                slice: 0,
                min_amount_out: 1,
            },
        )],
        &["crank"],
    )
    .fails_with(code(EpochError::InvalidVenueAccount));

    // The admin can pause buybacks for this token.
    let admin = ctx.key("admin");
    let paused = BuybackParams {
        flags: FLAG_BUYBACKS_PAUSED,
        max_impact_bps: rt.max_impact_bps,
        ..BuybackParams::default()
    };
    ctx.send_as(
        &[ix::configure_revenue_token(admin, v.vote, paused)],
        &["admin"],
    )
    .unwrap();
    ctx.send_as(&[buy(0, 1)], &["crank"])
        .fails_with(code(EpochError::BuybacksPaused));
    let resumed = BuybackParams { flags: 0, ..paused };
    ctx.send_as(
        &[ix::configure_revenue_token(admin, v.vote, resumed)],
        &["admin"],
    )
    .unwrap();

    // Slices run only in the window at the start of the epoch.
    ctx.advance_slots(window);
    ctx.send_as(&[buy(slices - 1, 1)], &["crank"])
        .fails_with(code(EpochError::OutsideBuybackWindow));
}
