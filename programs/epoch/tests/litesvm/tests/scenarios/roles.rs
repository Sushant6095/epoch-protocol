//! Every role check with the wrong signer: each role-gated instruction is
//! sent twice, once signed by an intruder in the role's slot (the role's own
//! error, or the PDA seed check when the account is derived from the role's
//! key) and once with the right key in the slot but without its signature
//! (`AccountNotSigner`). Role checks that need more setup live next to their
//! scenario: `configure_revenue_token` and `register_revenue_token` in
//! `revenue.rs`, `withdraw_quote` in `market.rs`.

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use epoch::errors::EpochError;
use epoch::state::Tranche;
use epoch_litesvm_tests::context::{anchor_code, code, sol, TestContext};
use epoch_litesvm_tests::setup::default_params;
use epoch_litesvm_tests::vote::Validator;
use epoch_litesvm_tests::{ix, pda};

use crate::credit::{onboarded, GOOD_SCORE};

/// One role-gated instruction: `build(signer)` puts `signer` in the role's
/// slot; `role` names the wallet that holds the role; `extra` wallets sign
/// both variants (accounts that must sign whoever the role holder is).
struct Case {
    name: &'static str,
    role: &'static str,
    build: Box<dyn Fn(Pubkey) -> Instruction>,
    wrong_signer: u32,
    extra: &'static [&'static str],
}

fn case(
    name: &'static str,
    role: &'static str,
    wrong_signer: u32,
    build: impl Fn(Pubkey) -> Instruction + 'static,
) -> Case {
    Case {
        name,
        role,
        build: Box::new(build),
        wrong_signer,
        extra: &[],
    }
}

/// `ix` with every meta for `key` marked as not signing.
fn unsigned(mut ix: Instruction, key: Pubkey) -> Instruction {
    for meta in ix.accounts.iter_mut().filter(|m| m.pubkey == key) {
        meta.is_signer = false;
    }
    ix
}

fn check(ctx: &mut TestContext, cases: Vec<Case>) {
    let intruder = ctx.wallet("intruder");
    for c in cases {
        let mut signers = vec!["intruder"];
        signers.extend_from_slice(c.extra);
        let err = ctx
            .send_as(&[(c.build)(intruder)], &signers)
            .expect_err(c.name);
        assert_eq!(
            err.custom_code(),
            Some(c.wrong_signer),
            "{}: signed by an intruder, logs:\n{}",
            c.name,
            err.logs.join("\n")
        );

        let holder = ctx.key(c.role);
        let err = ctx
            .send_as(&[unsigned((c.build)(holder), holder)], c.extra)
            .expect_err(c.name);
        assert_eq!(
            err.custom_code(),
            Some(anchor_code(ErrorCode::AccountNotSigner)),
            "{}: the role's key without its signature, logs:\n{}",
            c.name,
            err.logs.join("\n")
        );
    }
}

/// A pool, validator `v1` onboarded, a junior lender, the Fee Index with a
/// pending proposal.
fn fixture() -> (TestContext, Validator) {
    let (mut ctx, v) = onboarded();
    let admin = ctx.key("admin");
    let publisher = ctx.wallet("publisher");
    ctx.send_as(
        &[ix::initialize_index(admin, publisher, 100, 2_000)],
        &["admin"],
    )
    .unwrap();
    ctx.send_as(
        &[ix::post_index(publisher, 800, 10_000, [1; 32])],
        &["publisher"],
    )
    .unwrap();
    (ctx, v)
}

#[test]
fn admin_scorer_and_publisher_roles_reject_other_signers() {
    let (mut ctx, v) = fixture();
    let (treasury, scorer) = (ctx.key("treasury"), ctx.key("scorer"));
    let vote = v.vote;
    let admin_err = code(EpochError::NotAdmin);
    check(
        &mut ctx,
        vec![
            case("update_params", "admin", admin_err, |k| {
                ix::update_params(k, default_params())
            }),
            case("set_paused", "admin", admin_err, |k| {
                ix::set_paused(k, true)
            }),
            case("set_roles", "admin", admin_err, move |k| {
                ix::set_roles(k, treasury, scorer, k)
            }),
            case("configure_index", "admin", admin_err, |k| {
                ix::configure_index(k, k, 10, 500)
            }),
            case("veto_index", "admin", admin_err, ix::veto_index),
            case(
                "update_score",
                "scorer",
                code(EpochError::NotScorer),
                move |k| ix::update_score(k, vote, GOOD_SCORE),
            ),
            case(
                "post_index",
                "publisher",
                code(EpochError::NotPublisher),
                |k| ix::post_index(k, 801, 10_000, [2; 32]),
            ),
        ],
    );
    // Nothing changed hands.
    let pool = ctx.pool();
    assert_eq!((pool.treasury, pool.scorer), (treasury, scorer));
    assert_eq!(pool.admin, ctx.key("admin"));
    assert!(!pool.paused);
}

#[test]
fn operator_role_rejects_other_signers() {
    let (mut ctx, v) = fixture();
    let (vote, identity) = (v.vote, v.identity);
    let payout = ctx.key("payout1");
    let seq = ctx
        .get::<epoch::state::ValidatorPosition>(&pda::position(&vote))
        .advance_seq;
    let new_identity = ctx.wallet("identity2");
    let not_operator = code(EpochError::NotOperator);
    let mut cases = vec![
        case("post_bond", "operator1", not_operator, move |k| {
            ix::post_bond(k, vote, sol(1.0))
        }),
        case("withdraw_bond", "operator1", not_operator, move |k| {
            ix::withdraw_bond(k, vote, sol(1.0))
        }),
        case("request_advance", "operator1", not_operator, move |k| {
            ix::request_advance(k, vote, payout, seq, sol(1.0))
        }),
        case("update_commission", "operator1", not_operator, move |k| {
            ix::update_commission(k, vote, 0, 600, None)
        }),
        case("release_validator", "operator1", not_operator, move |k| {
            ix::release_validator(k, vote, k, identity, None)
        }),
    ];
    let mut identity_case = case("update_identity", "operator1", not_operator, move |k| {
        ix::update_identity(k, new_identity, vote)
    });
    identity_case.extra = &["identity2"];
    cases.push(identity_case);
    check(&mut ctx, cases);
    // The program still holds the vote account.
    assert_eq!(
        ctx.vote_state(&vote).authorized_withdrawer,
        pda::vote_auth(&vote)
    );
}

#[test]
fn lender_owner_role_rejects_other_signers() {
    let (mut ctx, _v) = fixture();
    let owner = ctx.key("lender1");
    let shares = ctx.lender(&owner, Tranche::Junior).shares;
    // The junior lock has passed for this check.
    let lock = ctx.pool().params.junior_lock_epochs;
    ctx.advance_epochs(u64::from(lock) + 1);
    let seq = ctx.pool().withdraw_tail;
    // The lender PDA is derived from the owner's key, so an intruder in the
    // owner slot fails the seed check on the victim's account.
    let victim_lender = pda::lender(&owner, Tranche::Junior);
    let request = move |k: Pubkey| {
        let mut ix = ix::request_withdraw(k, Tranche::Junior, seq, shares / 2);
        ix.accounts[2].pubkey = victim_lender;
        ix
    };
    check(
        &mut ctx,
        vec![case(
            "request_withdraw",
            "lender1",
            anchor_code(ErrorCode::ConstraintSeeds),
            request,
        )],
    );
    // A real request, then the same checks on its cancellation.
    let seq = ctx
        .request_withdraw("lender1", Tranche::Junior, shares / 2)
        .unwrap();
    let cancel = move |k: Pubkey| {
        let mut ix = ix::cancel_withdraw(k, Tranche::Junior, seq);
        ix.accounts[2].pubkey = victim_lender;
        ix
    };
    check(
        &mut ctx,
        vec![case(
            "cancel_withdraw",
            "lender1",
            anchor_code(ErrorCode::ConstraintSeeds),
            cancel,
        )],
    );
    assert!(ctx.exists(&pda::withdraw_request(seq)));
}
