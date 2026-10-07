use anchor_lang::prelude::*;

use super::common::{credit_pool_income, ClaimSigner, DbcSource};
use crate::{
    constants::*,
    errors::EpochError,
    events::{TreasuryClaimKind, TreasuryClaimed},
    outbound::meteora::{dbc_claim_trading_fee_ix, invoke_claim, DbcClaimKeys},
    state::*,
};

#[derive(Accounts)]
pub struct ClaimPartnerTradingFee<'info> {
    /// Anyone may claim. Pays the transaction fee and fronts the rent of the
    /// claim's token accounts, refunded before the instruction ends.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// Receives the SOL side as pool cash.
    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    /// CHECK: the partner treasury PDA, the config's fee claimer; signs the claim.
    #[account(seeds = [PARTNER_TREASURY_SEED, pool.key().as_ref()], bump)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: `["treasury_wsol", pool]`: created, paid and closed here.
    #[account(mut, seeds = [TREASURY_WSOL_SEED, pool.key().as_ref()], bump)]
    pub treasury_wsol: UncheckedAccount<'info>,

    /// CHECK: the treasury's associated token account for the base mint
    /// (checked in the handler; created when missing and then closed again).
    #[account(mut)]
    pub treasury_tokens: UncheckedAccount<'info>,

    /// CHECK: the DBC pool (owner, layout and links checked in the handler).
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,

    /// CHECK: the pool's DBC config.
    pub dbc_config: UncheckedAccount<'info>,

    /// CHECK: the pool's base vault.
    #[account(mut)]
    pub base_vault: UncheckedAccount<'info>,

    /// CHECK: the pool's wrapped-SOL vault.
    #[account(mut)]
    pub quote_vault: UncheckedAccount<'info>,

    /// CHECK: the pool's base mint (its supply drops by the burn).
    #[account(mut)]
    pub base_mint: UncheckedAccount<'info>,

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

    /// CHECK: the associated token account program.
    #[account(address = ASSOCIATED_TOKEN_PROGRAM_ID @ EpochError::InvalidClaimAccount)]
    pub associated_token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Claim the DBC partner trading fees the treasury earned on a curve
/// (`claim_trading_fee` with no cap): the SOL side becomes pool income, the
/// base side (on a pool that collects fees in the output token) is burned.
///
/// Checks: pool not paused; a DBC pool and its config, SPL Token, quoting
/// wrapped SOL, whose fee claimer is the treasury (`NotTreasuryFeeClaimer`);
/// the vaults and mint are the pool's; something to claim (`NothingToClaim`).
pub fn claim_partner_trading_fee(ctx: Context<ClaimPartnerTradingFee>) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.pool.paused, EpochError::Paused);
    let source = DbcSource::load(&a.dbc_pool, &a.dbc_config)?;
    source.require_fee_claimer(a.treasury.key)?;
    source.require_base(&a.base_mint, &a.base_vault)?;
    source.require_quote_vault(&a.quote_vault)?;
    require!(
        source.pool.partner_base_fee > 0 || source.pool.partner_quote_fee > 0,
        EpochError::NothingToClaim
    );

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
    let tokens = a.treasury_tokens.to_account_info();
    let base_mint = a.base_mint.to_account_info();
    let vault = a.vault.to_account_info();
    let signer = ClaimSigner {
        cranker: &cranker,
        treasury: &treasury,
        token_program: &token_program,
        system_program: &system_program,
        treasury_seeds,
    };

    let wsol_opened = signer.open_wsol(&wsol, &a.wsol_mint, wsol_seeds)?;
    let tokens_opened = signer.open_tokens(&tokens, &base_mint, &a.associated_token_program)?;

    let keys = DbcClaimKeys {
        pool: a.dbc_pool.key(),
        config: a.dbc_config.key(),
        base_vault: a.base_vault.key(),
        quote_vault: a.quote_vault.key(),
        base_mint: base_mint.key(),
        base_account: tokens.key(),
        quote_account: wsol.key(),
        treasury: treasury.key(),
    };
    invoke_claim(
        &dbc_claim_trading_fee_ix(&keys, u64::MAX, u64::MAX),
        &[
            a.dbc_pool_authority.to_account_info(),
            a.dbc_config.to_account_info(),
            a.dbc_pool.to_account_info(),
            tokens.clone(),
            wsol.clone(),
            a.base_vault.to_account_info(),
            a.quote_vault.to_account_info(),
            base_mint.clone(),
            a.wsol_mint.to_account_info(),
            treasury.clone(),
            token_program.clone(),
            a.dbc_event_authority.to_account_info(),
            a.dbc_program.to_account_info(),
        ],
        &[treasury_seeds],
    )?;

    let (tokens_claimed, tokens_burned) =
        signer.burn_tokens(&tokens, &tokens_opened, &base_mint)?;
    let (lamports_claimed, lamports_to_pool) =
        signer.settle_wsol(&wsol, &wsol_opened, &vault, vault_seeds)?;
    require!(
        tokens_claimed > 0 || lamports_claimed > 0,
        EpochError::NothingToClaim
    );

    let mint = base_mint.key();
    let source_key = a.dbc_pool.key();
    let cranker_key = cranker.key();
    let pool = &mut ctx.accounts.pool;
    credit_pool_income(pool, lamports_to_pool)?;
    emit!(TreasuryClaimed {
        pool: pool_key,
        kind: TreasuryClaimKind::TradingFee,
        mint,
        source: source_key,
        position: Pubkey::default(),
        cranker: cranker_key,
        lamports_claimed,
        lamports_to_pool,
        tokens_claimed,
        tokens_burned,
        pool_cash: pool.cash,
        income_unallocated: pool.income_unallocated,
    });
    Ok(())
}
