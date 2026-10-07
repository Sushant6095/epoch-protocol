use anchor_lang::prelude::*;

use super::common::{credit_pool_income, ClaimSigner, DbcSource};
use crate::{
    constants::*,
    errors::EpochError,
    events::{TreasuryClaimKind, TreasuryClaimed},
    math::{dbc_partner_migration_fee, dbc_partner_surplus},
    outbound::meteora::{
        dbc_partner_withdraw_surplus_ix, dbc_withdraw_migration_fee_ix, invoke_claim, DbcClaimKeys,
        DBC_MIGRATION_FEE_FLAG_PARTNER,
    },
    state::*,
};

/// The accounts of the DBC claims that pay only SOL: the partner surplus and
/// the partner migration fee.
#[derive(Accounts)]
pub struct ClaimPartnerQuote<'info> {
    /// Anyone may claim. Pays the transaction fee and fronts the rent of the
    /// claim's wrapped-SOL account, refunded before the instruction ends.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// Receives the SOL as pool cash.
    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    /// CHECK: the partner treasury PDA, the config's fee claimer; signs the claim.
    #[account(seeds = [PARTNER_TREASURY_SEED, pool.key().as_ref()], bump)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: `["treasury_wsol", pool]`: created, paid and closed here.
    #[account(mut, seeds = [TREASURY_WSOL_SEED, pool.key().as_ref()], bump)]
    pub treasury_wsol: UncheckedAccount<'info>,

    /// CHECK: the DBC pool (owner, layout and links checked in the handler).
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,

    /// CHECK: the pool's DBC config.
    pub dbc_config: UncheckedAccount<'info>,

    /// CHECK: the pool's wrapped-SOL vault.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

    /// CHECK: wrapped SOL.
    #[account(address = NATIVE_MINT @ EpochError::InvalidClaimAccount)]
    pub wsol_mint: UncheckedAccount<'info>,

    /// CHECK: DBC's pool authority.
    #[account(address = DBC_POOL_AUTHORITY @ EpochError::InvalidClaimAccount)]
    pub dbc_pool_authority: UncheckedAccount<'info>,

    /// CHECK: DBC's event authority.
    #[account(address = DBC_EVENT_AUTHORITY @ EpochError::InvalidClaimAccount)]
    pub dbc_event_authority: UncheckedAccount<'info>,

    /// CHECK: the DBC program.
    #[account(address = DBC_PROGRAM_ID @ EpochError::InvalidClaimAccount)]
    pub dbc_program: UncheckedAccount<'info>,

    /// CHECK: the SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Claim the partner's share of a completed curve's surplus (DBC
/// `partner_withdraw_surplus`): the quote raised above the migration
/// threshold, 80% to partner and creator, split by the creator's trading-fee
/// percentage. Pool income.
///
/// Checks: the shared ones (see `claim_partner_trading_fee`); the curve is
/// complete (`ClaimNotReady`); not claimed yet (`AlreadyClaimed`); the
/// partner's share is above zero (`NothingToClaim`).
pub fn claim_partner_surplus(ctx: Context<ClaimPartnerQuote>) -> Result<()> {
    let source = load_source(ctx.accounts)?;
    require!(source.curve_complete(), EpochError::ClaimNotReady);
    require!(
        !source.pool.is_partner_withdraw_surplus,
        EpochError::AlreadyClaimed
    );
    let due = dbc_partner_surplus(
        source.pool.quote_reserve,
        source.terms.migration_quote_threshold,
        source.terms.creator_trading_fee_percentage,
    )
    .ok_or(EpochError::MathOverflow)?;
    require!(due > 0, EpochError::NothingToClaim);
    claim_quote(ctx, TreasuryClaimKind::Surplus, source.pool.base_mint)
}

/// Claim the partner's share of the DBC migration fee
/// (`withdraw_migration_fee` with the partner flag): `migration_fee_percentage`
/// of the threshold, less the creator's `creator_migration_fee_percentage`.
/// Pool income.
///
/// Checks: the shared ones; the curve is complete (`ClaimNotReady`); the
/// partner bit of `migration_fee_withdraw_status` is clear (`AlreadyClaimed`);
/// the partner's share is above zero (`NothingToClaim`).
pub fn claim_partner_migration_fee(ctx: Context<ClaimPartnerQuote>) -> Result<()> {
    let source = load_source(ctx.accounts)?;
    require!(source.curve_complete(), EpochError::ClaimNotReady);
    require!(
        source.pool.migration_fee_withdraw_status & DBC_PARTNER_MIGRATION_FEE_MASK == 0,
        EpochError::AlreadyClaimed
    );
    let due = dbc_partner_migration_fee(
        source.terms.migration_quote_threshold,
        source.terms.migration_fee_percentage,
        source.terms.creator_migration_fee_percentage,
    )
    .ok_or(EpochError::MathOverflow)?;
    require!(due > 0, EpochError::NothingToClaim);
    claim_quote(ctx, TreasuryClaimKind::MigrationFee, source.pool.base_mint)
}

fn load_source(a: &ClaimPartnerQuote) -> Result<DbcSource> {
    require!(!a.pool.paused, EpochError::Paused);
    let source = DbcSource::load(&a.dbc_pool, &a.dbc_config)?;
    source.require_fee_claimer(a.treasury.key)?;
    source.require_quote_vault(&a.quote_vault)?;
    Ok(source)
}

fn claim_quote(
    ctx: Context<ClaimPartnerQuote>,
    kind: TreasuryClaimKind,
    mint: Pubkey,
) -> Result<()> {
    let a = &ctx.accounts;
    let pool_key = a.pool.key();
    let treasury_seeds: &[&[u8]] = &[
        PARTNER_TREASURY_SEED,
        pool_key.as_ref(),
        &[ctx.bumps.treasury],
    ];
    let wsol_seeds: &[&[u8]] = &[
        TREASURY_WSOL_SEED,
        pool_key.as_ref(),
        &[ctx.bumps.treasury_wsol],
    ];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[a.pool.vault_bump]];

    let cranker = a.cranker.to_account_info();
    let treasury = a.treasury.to_account_info();
    let token_program = a.token_program.to_account_info();
    let system_program = a.system_program.to_account_info();
    let wsol = a.treasury_wsol.to_account_info();
    let vault = a.vault.to_account_info();
    let signer = ClaimSigner {
        cranker: &cranker,
        treasury: &treasury,
        token_program: &token_program,
        system_program: &system_program,
        treasury_seeds,
    };

    let wsol_opened = signer.open_wsol(&wsol, &a.wsol_mint, wsol_seeds)?;
    let keys = DbcClaimKeys {
        pool: a.dbc_pool.key(),
        config: a.dbc_config.key(),
        base_vault: Pubkey::default(),
        quote_vault: a.quote_vault.key(),
        base_mint: Pubkey::default(),
        base_account: Pubkey::default(),
        quote_account: wsol.key(),
        treasury: treasury.key(),
    };
    let ix = match kind {
        TreasuryClaimKind::Surplus => dbc_partner_withdraw_surplus_ix(&keys),
        _ => dbc_withdraw_migration_fee_ix(&keys, DBC_MIGRATION_FEE_FLAG_PARTNER),
    };
    invoke_claim(
        &ix,
        &[
            a.dbc_pool_authority.to_account_info(),
            a.dbc_config.to_account_info(),
            a.dbc_pool.to_account_info(),
            wsol.clone(),
            a.quote_vault.to_account_info(),
            a.wsol_mint.to_account_info(),
            treasury.clone(),
            token_program.clone(),
            a.dbc_event_authority.to_account_info(),
            a.dbc_program.to_account_info(),
        ],
        &[treasury_seeds],
    )?;

    let (lamports_claimed, lamports_to_pool) =
        signer.settle_wsol(&wsol, &wsol_opened, &vault, vault_seeds)?;
    require!(lamports_claimed > 0, EpochError::NothingToClaim);

    let source_key = a.dbc_pool.key();
    let cranker_key = cranker.key();
    let pool = &mut ctx.accounts.pool;
    credit_pool_income(pool, lamports_to_pool)?;
    emit!(TreasuryClaimed {
        pool: pool_key,
        kind,
        mint,
        source: source_key,
        position: Pubkey::default(),
        cranker: cranker_key,
        lamports_claimed,
        lamports_to_pool,
        tokens_claimed: 0,
        tokens_burned: 0,
        pool_cash: pool.cash,
        income_unallocated: pool.income_unallocated,
    });
    Ok(())
}
