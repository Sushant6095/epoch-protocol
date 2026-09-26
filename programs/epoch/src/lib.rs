use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod state;

use constants::*;
use state::*;

// Placeholder: run `anchor keys sync` to generate the real program ID.
declare_id!("11111111111111111111111111111111");

#[program]
pub mod epoch {
    use super::*;

    /// Creates the lending pool. Day 2+: deposit, withdraw, onboard_validator,
    /// update_score, request_advance, sweep, mark_default, release,
    /// post_index, place_order, cancel_order, settle_epoch.
    pub fn initialize_pool(ctx: Context<InitializePool>, params: PoolParams) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.admin = ctx.accounts.admin.key();
        pool.params = params;
        pool.paused = false;
        pool.bump = ctx.bumps.pool;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED],
        bump
    )]
    pub pool: Account<'info, Pool>,

    pub system_program: Program<'info, System>,
}
