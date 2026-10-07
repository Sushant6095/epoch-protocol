//! Partner treasury claims: permissionless cranks, so the access checks are
//! on the accounts: the treasury and wrapped-SOL PDAs, the Meteora program
//! and authorities, a DBC pool and config that belong together and name the
//! Epoch treasury as fee claimer, the pool's own vaults and mint, the pause.
//! Every check runs before the DBC CPI; with valid accounts and nothing
//! owed the claim stops at `NothingToClaim` / `ClaimNotReady`, which proves
//! valid accounts pass. The CPI itself needs the DBC program: see the last
//! test and `tests/README.md`.

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::system_program;
use epoch::constants::{
    CP_AMM_PROGRAM_ID, DBC_MIGRATION_PROGRESS_CREATED_POOL, DBC_POOL_AUTHORITY, DBC_PROGRAM_ID,
    NATIVE_MINT,
};
use epoch::errors::EpochError;
use epoch::events::TreasuryClaimed;
use epoch::{accounts as a, instruction as i};
use epoch_litesvm_tests::context::{anchor_code, code, sol, TestContext};
use epoch_litesvm_tests::ix::{self, DbcAccounts};
use epoch_litesvm_tests::{pda, ExpectErr};

fn dbc_launch(ctx: &mut TestContext, fee_claimer: Pubkey) -> DbcAccounts {
    let d = DbcAccounts {
        pool: Pubkey::new_unique(),
        config: Pubkey::new_unique(),
        base_vault: Pubkey::new_unique(),
        quote_vault: Pubkey::new_unique(),
        base_mint: Pubkey::new_unique(),
    };
    ctx.set_mint(d.base_mint, 1_000_000_000, None);
    ctx.set_dbc_config(d.config, fee_claimer);
    ctx.set_dbc_pool(d.pool, d.config, d.base_mint);
    ctx.patch(d.pool, 168, d.base_vault.as_ref());
    ctx.patch(d.pool, 200, d.quote_vault.as_ref());
    d
}

fn trading_fee(
    accounts: a::ClaimPartnerTradingFee,
) -> anchor_lang::solana_program::instruction::Instruction {
    ix::build(accounts, i::ClaimPartnerTradingFee {})
}

#[test]
fn trading_fee_claim_checks_every_account_before_the_cpi() {
    let mut ctx = TestContext::with_pool();
    let cranker = ctx.wallet("crank");
    let d = dbc_launch(&mut ctx, pda::partner_treasury());
    let good = || ix::claim_partner_trading_fee_accounts(cranker, &d);
    let send = |ctx: &mut TestContext, acc| ctx.send_as(&[trading_fee(acc)], &["crank"]);

    // Valid accounts, nothing owed: every access check passed.
    send(&mut ctx, good()).fails_with(code(EpochError::NothingToClaim));

    let stranger = Pubkey::new_unique();
    let invalid = code(EpochError::InvalidClaimAccount);
    let seeds = anchor_code(ErrorCode::ConstraintSeeds);
    let cases: Vec<(&str, a::ClaimPartnerTradingFee, u32)> = vec![
        (
            "treasury",
            a::ClaimPartnerTradingFee {
                treasury: stranger,
                ..good()
            },
            seeds,
        ),
        (
            "treasury_wsol",
            a::ClaimPartnerTradingFee {
                treasury_wsol: stranger,
                ..good()
            },
            seeds,
        ),
        (
            "vault",
            a::ClaimPartnerTradingFee {
                vault: cranker,
                ..good()
            },
            seeds,
        ),
        (
            "dbc_program",
            a::ClaimPartnerTradingFee {
                dbc_program: system_program::ID,
                ..good()
            },
            invalid,
        ),
        (
            "dbc_pool_authority",
            a::ClaimPartnerTradingFee {
                dbc_pool_authority: stranger,
                ..good()
            },
            invalid,
        ),
        (
            "dbc_event_authority",
            a::ClaimPartnerTradingFee {
                dbc_event_authority: stranger,
                ..good()
            },
            invalid,
        ),
        (
            "wsol_mint",
            a::ClaimPartnerTradingFee {
                wsol_mint: d.base_mint,
                ..good()
            },
            invalid,
        ),
        (
            "associated_token_program",
            a::ClaimPartnerTradingFee {
                associated_token_program: stranger,
                ..good()
            },
            invalid,
        ),
        (
            "token_program",
            a::ClaimPartnerTradingFee {
                token_program: system_program::ID,
                ..good()
            },
            anchor_code(ErrorCode::ConstraintAddress),
        ),
        (
            "base_vault",
            a::ClaimPartnerTradingFee {
                base_vault: d.quote_vault,
                ..good()
            },
            invalid,
        ),
        (
            "quote_vault",
            a::ClaimPartnerTradingFee {
                quote_vault: d.base_vault,
                ..good()
            },
            invalid,
        ),
        (
            "base_mint",
            a::ClaimPartnerTradingFee {
                base_mint: stranger,
                ..good()
            },
            invalid,
        ),
    ];
    for (name, acc, err) in cases {
        let e = send(&mut ctx, acc).expect_err(name);
        assert_eq!(
            e.custom_code(),
            Some(err),
            "{name}: logs:\n{}",
            e.logs.join("\n")
        );
    }

    // A config that is not the pool's.
    let other = dbc_launch(&mut ctx, pda::partner_treasury());
    send(
        &mut ctx,
        a::ClaimPartnerTradingFee {
            dbc_config: other.config,
            ..good()
        },
    )
    .fails_with(code(EpochError::InvalidClaimAccount));
    // A curve whose fees go to someone else.
    let foreign = dbc_launch(&mut ctx, stranger);
    ctx.send_as(
        &[ix::claim_partner_trading_fee(cranker, &foreign)],
        &["crank"],
    )
    .fails_with(code(EpochError::NotTreasuryFeeClaimer));
    // An account that only looks like a DBC pool.
    let data = ctx.account(&d.pool).unwrap().data;
    let fake = Pubkey::new_unique();
    ctx.set_raw(fake, Pubkey::new_unique(), data);
    send(
        &mut ctx,
        a::ClaimPartnerTradingFee {
            dbc_pool: fake,
            ..good()
        },
    )
    .fails_with(code(EpochError::InvalidDbcPool));

    // Paused pool: no claims.
    let admin = ctx.key("admin");
    ctx.send_as(&[ix::set_paused(admin, true)], &["admin"])
        .unwrap();
    send(&mut ctx, good()).fails_with(code(EpochError::Paused));
}

#[test]
fn surplus_and_migration_fee_claims_check_the_source_and_the_curve() {
    let mut ctx = TestContext::with_pool();
    let cranker = ctx.wallet("crank");
    let d = dbc_launch(&mut ctx, pda::partner_treasury());
    // The curve is still filling: 0 of 100 SOL.
    ctx.patch(d.config, 264, &sol(100.0).to_le_bytes());
    for claim in [ix::claim_partner_surplus, ix::claim_partner_migration_fee] {
        ctx.send_as(&[claim(cranker, &d)], &["crank"])
            .fails_with(code(EpochError::ClaimNotReady));
    }

    let stranger = Pubkey::new_unique();
    let good = || ix::claim_partner_quote_accounts(cranker, &d);
    for (name, acc, err) in [
        (
            "treasury",
            a::ClaimPartnerQuote {
                treasury: stranger,
                ..good()
            },
            anchor_code(ErrorCode::ConstraintSeeds),
        ),
        (
            "treasury_wsol",
            a::ClaimPartnerQuote {
                treasury_wsol: stranger,
                ..good()
            },
            anchor_code(ErrorCode::ConstraintSeeds),
        ),
        (
            "dbc_program",
            a::ClaimPartnerQuote {
                dbc_program: system_program::ID,
                ..good()
            },
            code(EpochError::InvalidClaimAccount),
        ),
        (
            "quote_vault",
            a::ClaimPartnerQuote {
                quote_vault: stranger,
                ..good()
            },
            code(EpochError::InvalidClaimAccount),
        ),
    ] {
        let e = ctx
            .send_as(&[ix::build(acc, i::ClaimPartnerSurplus {})], &["crank"])
            .expect_err(name);
        assert_eq!(
            e.custom_code(),
            Some(err),
            "{name}: logs:\n{}",
            e.logs.join("\n")
        );
    }
    let foreign = dbc_launch(&mut ctx, stranger);
    ctx.send_as(&[ix::claim_partner_surplus(cranker, &foreign)], &["crank"])
        .fails_with(code(EpochError::NotTreasuryFeeClaimer));
}

/// With `EPOCH_METEORA_SO_DIR` pointing at dumps of the DBC (`dbc.so`) and
/// DAMM v2 (`cp_amm.so`) programs (not committed), a full
/// `claim_partner_trading_fee` through the real DBC program, loaded at its
/// mainnet id: the fabricated pool and config pass DBC's own checks. The curve's vaults are SPL Token accounts owned by DBC's pool
/// authority; DBC pays the partner's quote fee into the treasury's one-claim
/// wrapped-SOL account, Epoch unwraps it into the vault as pool income.
#[test]
fn trading_fee_claim_through_the_real_dbc_program() {
    let Ok(dir) = std::env::var("EPOCH_METEORA_SO_DIR") else {
        eprintln!("EPOCH_METEORA_SO_DIR not set: DBC claim skipped");
        return;
    };
    let mut ctx = TestContext::with_pool();
    ctx.svm
        .add_program_from_file(DBC_PROGRAM_ID, format!("{dir}/dbc.so"))
        .expect("load dbc.so");
    ctx.svm
        .add_program_from_file(CP_AMM_PROGRAM_ID, format!("{dir}/cp_amm.so"))
        .expect("load cp_amm.so");
    let cranker = ctx.wallet("crank");
    let d = dbc_launch(&mut ctx, pda::partner_treasury());
    let owed = sol(1.5);
    ctx.patch(d.pool, 272, &owed.to_le_bytes()); // partner quote fee
    ctx.set_token_account(d.base_vault, d.base_mint, DBC_POOL_AUTHORITY, 0);
    // DBC loads the quote mint (LiteSVM has no account at the native mint's address).
    ctx.set_raw(
        NATIVE_MINT,
        epoch::constants::TOKEN_PROGRAM_ID,
        epoch_litesvm_tests::meteora::mint_data(0, 9, None),
    );
    // A native (wrapped SOL) vault holding the fee: lamports = rent + amount.
    let mut data =
        epoch_litesvm_tests::meteora::token_account_data(NATIVE_MINT, DBC_POOL_AUTHORITY, owed);
    let rent = ctx.rent_exempt(data.len());
    data[109..113].copy_from_slice(&1u32.to_le_bytes());
    data[113..121].copy_from_slice(&rent.to_le_bytes());
    ctx.svm
        .set_account(
            d.quote_vault,
            solana_account::Account {
                lamports: rent + owed,
                data,
                owner: epoch::constants::TOKEN_PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

    let cash_before = ctx.pool().cash;
    let vault_before = ctx.lamports(&pda::vault());
    let cranker_before = ctx.lamports(&cranker);
    let ok = ctx
        .send_as(&[ix::claim_partner_trading_fee(cranker, &d)], &["crank"])
        .unwrap();
    let ev: TreasuryClaimed = ok.event();
    assert_eq!((ev.lamports_claimed, ev.lamports_to_pool), (owed, owed));
    assert_eq!(
        (ev.source, ev.mint, ev.cranker),
        (d.pool, d.base_mint, cranker)
    );
    assert_eq!(ctx.pool().cash, cash_before + owed);
    assert_eq!(ctx.lamports(&pda::vault()), vault_before + owed);
    // The cranker's fronted rent came back.
    assert_eq!(ctx.lamports(&cranker), cranker_before);
    assert!(!ctx.exists(&pda::treasury_wsol()));
    ctx.assert_ledger();
}

#[test]
fn burn_leftover_waits_for_graduation_and_needs_the_treasury_as_receiver() {
    let mut ctx = TestContext::with_pool();
    let cranker = ctx.wallet("crank");
    let d = dbc_launch(&mut ctx, pda::partner_treasury());
    ctx.set_token_account(d.base_vault, d.base_mint, DBC_POOL_AUTHORITY, 0);
    let burn = |ctx: &mut TestContext| ctx.send_as(&[ix::burn_leftover(cranker, &d)], &["crank"]);

    // Still on its curve.
    burn(&mut ctx).fails_with(code(EpochError::ClaimNotReady));
    ctx.patch(d.pool, 308, &[DBC_MIGRATION_PROGRESS_CREATED_POOL]);
    // Graduated, but nothing left in the vault.
    burn(&mut ctx).fails_with(code(EpochError::NothingToClaim));
    // A curve without a fixed supply has no leftover to claim (DBC burns it).
    ctx.patch(d.config, 244, &[0]);
    burn(&mut ctx).fails_with(code(EpochError::UnsupportedClaimPool));
    ctx.patch(d.config, 244, &[1]);
    // The leftover must come to the treasury, which burns it.
    ctx.patch(d.config, 72, Pubkey::new_unique().as_ref());
    burn(&mut ctx).fails_with(code(EpochError::NotTreasuryLeftoverReceiver));
}

/// With the DBC dump: the unsold supply of a graduated fixed-supply curve
/// goes from DBC to the treasury and is burned in the same instruction.
#[test]
fn burn_leftover_through_the_real_dbc_program() {
    let Ok(dir) = std::env::var("EPOCH_METEORA_SO_DIR") else {
        eprintln!("EPOCH_METEORA_SO_DIR not set: DBC leftover burn skipped");
        return;
    };
    let mut ctx = TestContext::with_pool();
    ctx.svm
        .add_program_from_file(DBC_PROGRAM_ID, format!("{dir}/dbc.so"))
        .expect("load dbc.so");
    let cranker = ctx.wallet("crank");
    let d = dbc_launch(&mut ctx, pda::partner_treasury());
    ctx.patch(d.pool, 308, &[DBC_MIGRATION_PROGRESS_CREATED_POOL]);
    ctx.patch(d.pool, 305, &[1]); // is_migrated
    let unsold = 300_000_000; // 300 of the 1,000 tokens
    ctx.set_token_account(d.base_vault, d.base_mint, DBC_POOL_AUTHORITY, unsold);
    let supply = ctx.mint_supply(&d.base_mint);
    let cranker_before = ctx.lamports(&cranker);
    let ok = ctx
        .send_as(&[ix::burn_leftover(cranker, &d)], &["crank"])
        .unwrap();
    let ev: TreasuryClaimed = ok.event();
    assert_eq!((ev.source, ev.mint), (d.pool, d.base_mint));
    assert_eq!((ev.tokens_burned, ev.lamports_claimed), (unsold, 0));
    assert_eq!(ctx.mint_supply(&d.base_mint), supply - unsold);
    assert_eq!(ctx.token_amount(&d.base_vault), 0);
    assert_eq!(ctx.lamports(&cranker), cranker_before);
    // DBC marked the leftover withdrawn: a second burn has nothing left.
    assert!(ctx
        .send_as(&[ix::burn_leftover(cranker, &d)], &["crank"])
        .is_err());
}

/// The treasury's DAMM v2 position on a graduated pool, all fabricated.
fn damm_position(ctx: &mut TestContext, nft_owner: Pubkey) -> ix::DammAccounts {
    use epoch::constants::TOKEN_2022_PROGRAM_ID;
    use epoch_litesvm_tests::meteora::{damm_pool_data, damm_position_data, token_account_data};
    let d = ix::DammAccounts {
        pool: Pubkey::new_unique(),
        position: Pubkey::new_unique(),
        position_nft_account: Pubkey::new_unique(),
        token_a_vault: Pubkey::new_unique(),
        token_b_vault: Pubkey::new_unique(),
        token_a_mint: Pubkey::new_unique(),
    };
    ctx.set_mint(d.token_a_mint, 1_000_000_000, None);
    ctx.set_raw(
        d.pool,
        CP_AMM_PROGRAM_ID,
        damm_pool_data(d.token_a_mint, NATIVE_MINT),
    );
    ctx.patch(d.pool, 232, d.token_a_vault.as_ref());
    ctx.patch(d.pool, 264, d.token_b_vault.as_ref());
    let nft_mint = Pubkey::new_unique();
    ctx.set_raw(
        d.position,
        CP_AMM_PROGRAM_ID,
        damm_position_data(d.pool, nft_mint),
    );
    // A Token-2022 account (account-type byte 2 after the base layout) holding the one NFT.
    let mut nft = token_account_data(nft_mint, nft_owner, 1);
    nft.push(2);
    ctx.set_raw(d.position_nft_account, TOKEN_2022_PROGRAM_ID, nft);
    d
}

#[test]
fn lp_fee_claim_checks_the_pool_the_position_and_its_owner() {
    let mut ctx = TestContext::with_pool();
    let cranker = ctx.wallet("crank");
    let treasury = pda::partner_treasury();
    let d = damm_position(&mut ctx, treasury);
    let good = || ix::claim_treasury_lp_fee_accounts(cranker, &d);
    let send = |ctx: &mut TestContext, acc| {
        ctx.send_as(&[ix::build(acc, i::ClaimTreasuryLpFee {})], &["crank"])
    };

    let stranger = Pubkey::new_unique();
    let invalid = code(EpochError::InvalidClaimAccount);
    let seeds = anchor_code(ErrorCode::ConstraintSeeds);
    let cases: Vec<(&str, a::ClaimTreasuryLpFee, u32)> = vec![
        (
            "treasury",
            a::ClaimTreasuryLpFee {
                treasury: stranger,
                ..good()
            },
            seeds,
        ),
        (
            "treasury_wsol",
            a::ClaimTreasuryLpFee {
                treasury_wsol: stranger,
                ..good()
            },
            seeds,
        ),
        (
            "damm_program",
            a::ClaimTreasuryLpFee {
                damm_program: DBC_PROGRAM_ID,
                ..good()
            },
            invalid,
        ),
        (
            "damm_pool_authority",
            a::ClaimTreasuryLpFee {
                damm_pool_authority: stranger,
                ..good()
            },
            invalid,
        ),
        (
            "damm_event_authority",
            a::ClaimTreasuryLpFee {
                damm_event_authority: stranger,
                ..good()
            },
            invalid,
        ),
        (
            "token_a_vault",
            a::ClaimTreasuryLpFee {
                token_a_vault: d.token_b_vault,
                ..good()
            },
            invalid,
        ),
        (
            "token_b_vault",
            a::ClaimTreasuryLpFee {
                token_b_vault: d.token_a_vault,
                ..good()
            },
            invalid,
        ),
        (
            "token_a_mint",
            a::ClaimTreasuryLpFee {
                token_a_mint: stranger,
                ..good()
            },
            invalid,
        ),
    ];
    for (name, acc, err) in cases {
        let e = send(&mut ctx, acc).expect_err(name);
        assert_eq!(
            e.custom_code(),
            Some(err),
            "{name}: logs:\n{}",
            e.logs.join("\n")
        );
    }

    // Someone else's position NFT: the treasury can only claim its own position.
    let theirs = damm_position(&mut ctx, stranger);
    ctx.send_as(
        &[ix::build(
            ix::claim_treasury_lp_fee_accounts(cranker, &theirs),
            i::ClaimTreasuryLpFee {},
        )],
        &["crank"],
    )
    .fails_with(code(EpochError::NotTreasuryPosition));
    // A position of another pool.
    send(
        &mut ctx,
        a::ClaimTreasuryLpFee {
            position: theirs.position,
            ..good()
        },
    )
    .fails_with(code(EpochError::InvalidClaimAccount));
    // A pool that is not DAMM v2's, or not token / wrapped SOL.
    let data = ctx.account(&d.pool).unwrap().data;
    let fake = Pubkey::new_unique();
    ctx.set_raw(fake, DBC_PROGRAM_ID, data);
    send(
        &mut ctx,
        a::ClaimTreasuryLpFee {
            damm_pool: fake,
            ..good()
        },
    )
    .fails_with(code(EpochError::InvalidClaimAccount));
    ctx.patch(d.pool, 200, d.token_a_mint.as_ref());
    send(&mut ctx, good()).fails_with(code(EpochError::UnsupportedClaimPool));
    ctx.patch(d.pool, 200, NATIVE_MINT.as_ref());

    // Paused pool: no claims.
    let admin = ctx.key("admin");
    ctx.send_as(&[ix::set_paused(admin, true)], &["admin"])
        .unwrap();
    send(&mut ctx, good()).fails_with(code(EpochError::Paused));
}

/// With the DAMM v2 dump: valid accounts get through every Epoch check and
/// the claim really invokes DAMM v2's `claim_position_fee` (the fabricated
/// position then fails DAMM's own checks; a paying claim needs a pool and
/// position DAMM created, README).
#[test]
fn lp_fee_claim_reaches_the_real_damm_v2_program() {
    let Ok(dir) = std::env::var("EPOCH_METEORA_SO_DIR") else {
        eprintln!("EPOCH_METEORA_SO_DIR not set: DAMM v2 probe skipped");
        return;
    };
    let mut ctx = TestContext::with_pool();
    ctx.svm
        .add_program_from_file(CP_AMM_PROGRAM_ID, format!("{dir}/cp_amm.so"))
        .expect("load cp_amm.so");
    let cranker = ctx.wallet("crank");
    let d = damm_position(&mut ctx, pda::partner_treasury());
    let err = ctx
        .send_as(
            &[ix::build(
                ix::claim_treasury_lp_fee_accounts(cranker, &d),
                i::ClaimTreasuryLpFee {},
            )],
            &["crank"],
        )
        .expect_err("a fabricated position cannot pay");
    let invoked = format!("Program {CP_AMM_PROGRAM_ID} invoke [2]");
    assert!(
        err.logs.iter().any(|l| l.starts_with(&invoked)),
        "DAMM v2 was not invoked, logs:\n{}",
        err.logs.join("\n")
    );
}
