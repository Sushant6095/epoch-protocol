use anchor_lang::prelude::*;

use crate::{constants::*, errors::EpochError, events::RevenueTokenConfigured, state::*};

#[derive(Accounts)]
pub struct ConfigureRevenueToken<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [REVENUE_TOKEN_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.bump,
        has_one = pool,
    )]
    pub revenue_token: Account<'info, RevenueToken>,
}

/// Pool admin: tune a revenue token's buyback schedule and protections, pause
/// buybacks, or open redemptions during the term (the fallback when buybacks
/// cannot run). Never touches the share, the term or the commission floor.
/// Changing the number of slices restarts the current epoch's schedule from
/// what the escrow holds. `max_impact_bps` may be at most twice the venue's
/// lowest fee (`ImpactAboveFeeBound`), so a slice is never worth sandwiching.
pub fn configure_revenue_token(
    ctx: Context<ConfigureRevenueToken>,
    params: BuybackParams,
) -> Result<()> {
    require!(params.is_valid(), EpochError::InvalidBuybackParams);
    let rt = &mut ctx.accounts.revenue_token;
    require!(
        params.max_impact_bps <= rt.max_impact_bound(),
        EpochError::ImpactAboveFeeBound
    );
    if params.slices_per_epoch != rt.slices_per_epoch {
        rt.buyback_epoch = 0;
        rt.slices_done = 0;
        rt.epoch_budget = 0;
        rt.epoch_spent = 0;
    }
    rt.slices_per_epoch = params.slices_per_epoch;
    rt.window_slots = params.window_slots;
    rt.max_slippage_bps = params.max_slippage_bps;
    rt.max_impact_bps = params.max_impact_bps;
    rt.flags = params.flags;

    emit!(RevenueTokenConfigured {
        vote: rt.vote,
        slices_per_epoch: rt.slices_per_epoch,
        window_slots: rt.window_slots,
        max_slippage_bps: rt.max_slippage_bps,
        max_impact_bps: rt.max_impact_bps,
        flags: rt.flags,
    });
    Ok(())
}
