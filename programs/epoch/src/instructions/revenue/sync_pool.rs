use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::RevenueTokenPoolSynced,
    meteora_account::{DammConfig, DammPool, DbcPool},
    state::*,
};

#[derive(Accounts)]
pub struct SyncRevenueTokenPool<'info> {
    /// Anyone may sync once the curve has graduated.
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [REVENUE_TOKEN_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.bump,
    )]
    pub revenue_token: Account<'info, RevenueToken>,

    /// CHECK: the token's DBC pool (address checked; state parsed in the handler).
    #[account(address = revenue_token.dbc_pool @ EpochError::InvalidDbcPool)]
    pub dbc_pool: UncheckedAccount<'info>,

    /// CHECK: the DAMM v2 config DBC migrated with; checked in the handler.
    pub damm_config: UncheckedAccount<'info>,

    /// CHECK: the DAMM v2 pool; checked in the handler.
    pub damm_pool: UncheckedAccount<'info>,
}

/// Record the DAMM v2 pool a revenue token's curve graduated to, so buybacks
/// move there. Permissionless; the pool must be the one DBC's own migration
/// created:
///
/// - the DBC pool reports `is_migrated`;
/// - `damm_config` is a DAMM v2 `Config` whose `pool_creator_authority` is
///   DBC's pool authority (true of every config DBC migrates with, and it
///   means only DBC can create pools from it);
/// - `damm_pool` is a DAMM v2 `Pool` at `["pool", damm_config, max(mint, wsol),
///   min(mint, wsol)]` with token A = the revenue token (SPL Token) and
///   token B = wrapped SOL, the orientation DBC's migration uses.
///
/// A lookalike pool someone else created for the same pair (a different
/// config or a customizable pool) fails the address check, so a buyback can
/// never be pointed at a pool the attacker seeded. Re-syncing the same pool
/// is a no-op.
pub fn sync_revenue_token_pool(ctx: Context<SyncRevenueTokenPool>) -> Result<()> {
    let rt = &mut ctx.accounts.revenue_token;
    let damm_key = ctx.accounts.damm_pool.key();
    if rt.graduated() {
        require_keys_eq!(rt.damm_pool, damm_key, EpochError::InvalidDammPool);
        return Ok(());
    }

    let dbc = DbcPool::load(&ctx.accounts.dbc_pool)?;
    require!(dbc.is_migrated, EpochError::PoolNotMigrated);

    let config = DammConfig::load(&ctx.accounts.damm_config)?;
    require_keys_eq!(
        config.pool_creator_authority,
        DBC_POOL_AUTHORITY,
        EpochError::InvalidDammPool
    );

    let pool = DammPool::load(&ctx.accounts.damm_pool)?;
    require_keys_eq!(pool.token_a_mint, rt.mint, EpochError::InvalidDammPool);
    require_keys_eq!(pool.token_b_mint, NATIVE_MINT, EpochError::InvalidDammPool);
    require!(pool.token_a_flag == 0, EpochError::InvalidDammPool);

    let (hi, lo) = if rt.mint > NATIVE_MINT {
        (rt.mint, NATIVE_MINT)
    } else {
        (NATIVE_MINT, rt.mint)
    };
    let config_key = ctx.accounts.damm_config.key();
    let (expected, _) = Pubkey::find_program_address(
        &[b"pool", config_key.as_ref(), hi.as_ref(), lo.as_ref()],
        &CP_AMM_PROGRAM_ID,
    );
    require_keys_eq!(damm_key, expected, EpochError::InvalidDammPool);

    rt.damm_pool = damm_key;
    rt.status = RevenueTokenStatus::Graduated;

    emit!(RevenueTokenPoolSynced {
        vote: rt.vote,
        mint: rt.mint,
        dbc_pool: rt.dbc_pool,
        damm_pool: damm_key,
        damm_config: config_key,
    });
    Ok(())
}
