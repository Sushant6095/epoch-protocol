//! Pool: initialisation, admin round trips, deposits into both tranches, the
//! junior floor, pausing and donations.

use epoch::errors::EpochError;
use epoch::events::{Deposited, ParamsUpdated, PauseToggled, PoolInitialized};
use epoch::state::{PoolParams, Tranche};
use epoch_litesvm_tests::context::{code, sol, TestContext};
use epoch_litesvm_tests::setup::default_params;
use epoch_litesvm_tests::{ix, pda, ExpectErr};

#[test]
fn initialize_pool_sets_roles_and_params() {
    let mut ctx = TestContext::new();
    let admin = ctx.wallet("admin");
    let treasury = ctx.wallet_with("treasury", 1.0);
    let scorer = ctx.wallet("scorer");
    let ok = ctx
        .send_as(
            &[ix::initialize_pool(
                admin,
                treasury,
                scorer,
                default_params(),
            )],
            &["admin"],
        )
        .unwrap();
    let ev: PoolInitialized = ok.event();
    assert_eq!(ev.admin, admin);

    let pool = ctx.pool();
    assert_eq!(
        (pool.admin, pool.treasury, pool.scorer),
        (admin, treasury, scorer)
    );
    assert_eq!(pool.params.min_junior_bps, default_params().min_junior_bps);
    assert!(!pool.paused);
    ctx.assert_ledger();

    // A second initialisation hits the existing PDA.
    assert!(ctx
        .send_as(
            &[ix::initialize_pool(
                admin,
                treasury,
                scorer,
                default_params()
            )],
            &["admin"]
        )
        .is_err());
}

#[test]
fn initialize_pool_rejects_invalid_params() {
    let mut ctx = TestContext::new();
    let admin = ctx.wallet("admin");
    let bad = [
        PoolParams {
            remit_bps: 0,
            ..default_params()
        },
        PoolParams {
            max_utilization_bps: 0,
            ..default_params()
        },
        PoolParams {
            advance_bps_hedged: 1_000,
            advance_bps_unhedged: 2_000,
            ..default_params()
        },
        PoolParams {
            min_advance_lamports: sol(10.0),
            max_advance_lamports: sol(1.0),
            ..default_params()
        },
        PoolParams {
            max_advance_epochs: 0,
            ..default_params()
        },
    ];
    for params in bad {
        ctx.send_as(
            &[ix::initialize_pool(admin, admin, admin, params)],
            &["admin"],
        )
        .fails_with(code(EpochError::InvalidParams));
    }
    ctx.send_as(
        &[ix::initialize_pool(
            admin,
            admin,
            admin,
            PoolParams {
                protocol_fee_bps: 10_001,
                ..default_params()
            },
        )],
        &["admin"],
    )
    .fails_with(code(EpochError::BpsOutOfRange));
}

#[test]
fn update_params_and_pause_are_admin_only() {
    let mut ctx = TestContext::with_pool();
    let admin = ctx.key("admin");
    let mallory = ctx.wallet("mallory");

    let new = PoolParams {
        senior_rate_bps_per_epoch: 5,
        ..default_params()
    };
    ctx.send_as(&[ix::update_params(mallory, new)], &["mallory"])
        .fails_with(code(EpochError::NotAdmin));
    ctx.send_as(&[ix::set_paused(mallory, true)], &["mallory"])
        .fails_with(code(EpochError::NotAdmin));

    let ok = ctx
        .send_as(&[ix::update_params(admin, new)], &["admin"])
        .unwrap();
    let _: ParamsUpdated = ok.event();
    assert_eq!(ctx.pool().params.senior_rate_bps_per_epoch, 5);

    let ok = ctx
        .send_as(&[ix::set_paused(admin, true)], &["admin"])
        .unwrap();
    assert!(ok.event::<PauseToggled>().paused);
    ctx.deposit("lender1", Tranche::Junior, sol(10.0))
        .fails_with(code(EpochError::Paused));
    ctx.send_as(&[ix::set_paused(admin, false)], &["admin"])
        .unwrap();
    ctx.deposit("lender1", Tranche::Junior, sol(10.0)).unwrap();
}

#[test]
fn deposits_respect_the_junior_floor() {
    let mut ctx = TestContext::with_pool();

    // No junior yet: any senior money breaches the 20% floor.
    ctx.deposit("lender1", Tranche::Senior, sol(10.0))
        .fails_with(code(EpochError::JuniorFloorBreached));

    let ok = ctx.deposit("lender2", Tranche::Junior, sol(20.0)).unwrap();
    let ev: Deposited = ok.event();
    assert_eq!((ev.tranche, ev.assets), (Tranche::Junior, sol(20.0)));
    assert_eq!(ctx.lamports(&pda::vault()), ctx.rent_exempt(0) + sol(20.0));

    // 20 junior covers 80 senior at exactly 20%; one lamport more breaches it.
    ctx.deposit("lender1", Tranche::Senior, sol(80.0)).unwrap();
    ctx.deposit("lender1", Tranche::Senior, 1)
        .fails_with(code(EpochError::JuniorFloorBreached));

    let pool = ctx.pool();
    assert_eq!(
        (pool.senior_assets, pool.junior_assets, pool.cash),
        (sol(80.0), sol(20.0), sol(100.0))
    );
    let l1 = ctx.lender(&ctx.key("lender1"), Tranche::Senior);
    assert_eq!(l1.shares, pool.senior_shares);
    assert_eq!(l1.total_deposited, sol(80.0));
    ctx.assert_ledger();

    ctx.deposit("lender1", Tranche::Junior, 0)
        .fails_with(code(EpochError::ZeroAmount));
}

#[test]
fn deposits_stop_at_the_pool_cap() {
    let mut ctx = TestContext::with_pool_params(PoolParams {
        max_pool_assets: sol(50.0),
        ..default_params()
    });
    ctx.deposit("lender1", Tranche::Junior, sol(50.0)).unwrap();
    ctx.deposit("lender1", Tranche::Junior, 1)
        .fails_with(code(EpochError::PoolCapExceeded));
}

#[test]
fn a_donation_does_not_move_the_share_price() {
    let mut ctx = TestContext::with_pool();
    ctx.deposit("lender1", Tranche::Junior, sol(100.0)).unwrap();
    let before = ctx.pool();

    // Lamports sent straight to the vault are not lender assets.
    ctx.transfer(&pda::vault(), sol(1_000.0));
    let ok = ctx.deposit("lender2", Tranche::Junior, sol(100.0)).unwrap();
    let ev: Deposited = ok.event();
    let after = ctx.pool();

    assert_eq!(after.junior_assets, before.junior_assets + sol(100.0));
    // Same price → the second lender gets the same shares for the same assets.
    assert_eq!(ev.shares, before.junior_shares);
    ctx.assert_ledger();
}
