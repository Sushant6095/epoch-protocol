use anchor_lang::prelude::*;

use super::common::{ClaimSigner, DbcSource};
use crate::{
    constants::*,
    errors::EpochError,
    events::{TreasuryClaimKind, TreasuryClaimed},
    math::dbc_leftover,
    meteora_account::SplTokenAccount,
    outbound::meteora::{dbc_withdraw_leftover_ix, invoke_claim, DbcClaimKeys},
    state::*,
};

#[derive(Accounts)]
pub struct BurnLeftover<'info> {
    /// Anyone may run it. Pays the transaction fee and fronts the rent of the
    /// treasury's token account when it has to be created (refunded when the
    /// instruction closes it again).
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// CHECK: the partner treasury PDA, the config's leftover receiver; owns
    /// the token account and signs the burn.
    #[account(seeds = [PARTNER_TREASURY_SEED, pool.key().as_ref()], bump)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: the treasury's associated token account for the base mint, where
    /// DBC sends the leftover (checked in the handler).
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

    /// CHECK: the pool's base mint (its supply drops by the burn).
    #[account(mut)]
    pub base_mint: UncheckedAccount<'info>,

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

/// Withdraw a graduated curve's unsold supply to the treasury (DBC
/// `withdraw_leftover`) and burn all of it. DBC lets anyone withdraw the
/// leftover to the receiver's token account; when that already happened, this
/// burns what the treasury's account holds.
///
/// Checks: pool not paused; a DBC pool and its config, SPL Token, quoting
/// wrapped SOL, whose leftover receiver is the treasury
/// (`NotTreasuryLeftoverReceiver`); the vault and mint are the pool's. Before
/// the withdrawal: a fixed-supply config (`UnsupportedClaimPool`), the DAMM v2
/// pool exists (`ClaimNotReady`) and the leftover is above zero
/// (`NothingToClaim`). After it: the treasury still holds tokens
/// (`AlreadyClaimed`).
pub fn burn_leftover(ctx: Context<BurnLeftover>) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.pool.paused, EpochError::Paused);
    let source = DbcSource::load(&a.dbc_pool, &a.dbc_config)?;
    source.require_base(&a.base_mint, &a.base_vault)?;
    require_keys_eq!(
        source.terms.leftover_receiver,
        a.treasury.key(),
        EpochError::NotTreasuryLeftoverReceiver
    );
    let withdraw = !source.pool.is_withdraw_leftover;
    if withdraw {
        require!(
            source.terms.fixed_token_supply_flag == 1,
            EpochError::UnsupportedClaimPool
        );
        require!(
            source.pool.migration_progress == DBC_MIGRATION_PROGRESS_CREATED_POOL,
            EpochError::ClaimNotReady
        );
        let leftover = dbc_leftover(
            SplTokenAccount::load(&a.base_vault)?.amount,
            source.pool.partner_base_fee,
            source.pool.protocol_base_fee,
            source.pool.creator_base_fee,
            source.pool.protocol_migration_base_fee_amount,
        )
        .ok_or(EpochError::MathOverflow)?;
        require!(leftover > 0, EpochError::NothingToClaim);
    } else {
        require!(
            !a.treasury_tokens.data_is_empty(),
            EpochError::AlreadyClaimed
        );
    }

    let pool_key = a.pool.key();
    let treasury_seeds: &[&[u8]] = &[
        PARTNER_TREASURY_SEED,
        pool_key.as_ref(),
        &[ctx.bumps.treasury],
    ];
    let cranker = a.cranker.to_account_info();
    let treasury = a.treasury.to_account_info();
    let token_program = a.token_program.to_account_info();
    let system_program = a.system_program.to_account_info();
    let tokens = a.treasury_tokens.to_account_info();
    let base_mint = a.base_mint.to_account_info();
    let signer = ClaimSigner {
        cranker: &cranker,
        treasury: &treasury,
        token_program: &token_program,
        system_program: &system_program,
        treasury_seeds,
    };

    let opened = signer.open_tokens(&tokens, &base_mint, &a.associated_token_program)?;
    if withdraw {
        let keys = DbcClaimKeys {
            pool: a.dbc_pool.key(),
            config: a.dbc_config.key(),
            base_vault: a.base_vault.key(),
            quote_vault: Pubkey::default(),
            base_mint: base_mint.key(),
            base_account: tokens.key(),
            quote_account: Pubkey::default(),
            treasury: treasury.key(),
        };
        // The receiver does not sign `withdraw_leftover`.
        invoke_claim(
            &dbc_withdraw_leftover_ix(&keys),
            &[
                a.dbc_pool_authority.to_account_info(),
                a.dbc_config.to_account_info(),
                a.dbc_pool.to_account_info(),
                tokens.clone(),
                a.base_vault.to_account_info(),
                base_mint.clone(),
                treasury.clone(),
                token_program.clone(),
                a.dbc_event_authority.to_account_info(),
                a.dbc_program.to_account_info(),
            ],
            &[],
        )?;
    } else {
        require!(opened.amount_before > 0, EpochError::AlreadyClaimed);
    }
    let (tokens_claimed, tokens_burned) = signer.burn_tokens(&tokens, &opened, &base_mint)?;

    emit!(TreasuryClaimed {
        pool: pool_key,
        kind: TreasuryClaimKind::Leftover,
        mint: base_mint.key(),
        source: a.dbc_pool.key(),
        position: Pubkey::default(),
        cranker: cranker.key(),
        lamports_claimed: 0,
        lamports_to_pool: 0,
        tokens_claimed,
        tokens_burned,
        pool_cash: a.pool.cash,
        income_unallocated: a.pool.income_unallocated,
    });
    Ok(())
}
