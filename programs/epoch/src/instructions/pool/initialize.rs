use anchor_lang::prelude::*;

use crate::{constants::*, events::PoolInitialized, state::*};

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED],
        bump,
    )]
    pub pool: Account<'info, Pool>,

    /// The pool's SOL vault: a system-owned PDA with no data, so it can be a
    /// SIMD-0232 commission collector and the program can sign transfers out
    /// of it. Funded with the rent-exempt minimum here so it can never be
    /// garbage-collected.
    #[account(
        mut,
        seeds = [VAULT_SEED, pool.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: any account; receives protocol fees.
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: any key; signs score updates.
    pub scorer: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_pool(ctx: Context<InitializePool>, params: PoolParams) -> Result<()> {
    params.validate()?;

    // Keep the vault rent-exempt forever.
    let rent_min = Rent::get()?.minimum_balance(0);
    let top_up = rent_min.saturating_sub(ctx.accounts.vault.lamports());
    crate::cpi::system::transfer_from_signer(
        &ctx.accounts.admin.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        top_up,
    )?;

    let pool = &mut ctx.accounts.pool;
    pool.admin = ctx.accounts.admin.key();
    pool.treasury = ctx.accounts.treasury.key();
    pool.scorer = ctx.accounts.scorer.key();
    pool.params = params;
    pool.bump = ctx.bumps.pool;
    pool.vault_bump = ctx.bumps.vault;
    pool.paused = false;
    pool.assert_ledger()?;

    emit!(PoolInitialized {
        pool: pool.key(),
        admin: pool.admin,
        treasury: pool.treasury,
        scorer: pool.scorer,
    });
    Ok(())
}
