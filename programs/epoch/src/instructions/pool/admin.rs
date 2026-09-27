use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::{ParamsUpdated, PauseToggled},
    state::*,
};

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,
}

pub fn update_params(ctx: Context<AdminOnly>, params: PoolParams) -> Result<()> {
    params.validate()?;
    ctx.accounts.pool.params = params;
    emit!(ParamsUpdated {
        pool: ctx.accounts.pool.key()
    });
    Ok(())
}

pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
    ctx.accounts.pool.paused = paused;
    emit!(PauseToggled {
        pool: ctx.accounts.pool.key(),
        paused
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetRoles<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,
    /// CHECK: new treasury, any account.
    pub treasury: UncheckedAccount<'info>,
    /// CHECK: new scorer key.
    pub scorer: UncheckedAccount<'info>,
    /// CHECK: new admin key. Pass the current admin to keep it.
    pub new_admin: UncheckedAccount<'info>,
}

/// Rotate treasury, scorer and admin in one call. Move `admin` to a Squads
/// multisig before mainnet.
pub fn set_roles(ctx: Context<SetRoles>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.treasury = ctx.accounts.treasury.key();
    pool.scorer = ctx.accounts.scorer.key();
    pool.admin = ctx.accounts.new_admin.key();
    emit!(ParamsUpdated { pool: pool.key() });
    Ok(())
}
