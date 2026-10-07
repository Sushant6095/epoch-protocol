use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::Accrued,
    math::{distribute_income, share_price_e9},
    outbound::system::transfer_from_pda,
    state::*,
};

#[derive(Accounts)]
pub struct Accrue<'info> {
    /// Anyone may run the epoch accrual.
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    /// CHECK: receives the protocol fee; must match the pool.
    #[account(mut, address = pool.treasury @ EpochError::PayoutMismatch)]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Once per epoch: take the protocol fee off realised income, pay the senior
/// coupon for every epoch since the last accrual, hand the rest to junior.
/// Runs even with zero income so the coupon clock keeps time.
pub fn accrue(ctx: Context<Accrue>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let epoch = Clock::get()?.epoch;
    require!(epoch > pool.last_accrued_epoch, EpochError::AlreadyAccrued);

    let epochs_elapsed = if pool.last_accrued_epoch == 0 {
        1
    } else {
        epoch - pool.last_accrued_epoch
    };

    let income = pool.income_unallocated;
    let d = distribute_income(
        income,
        pool.senior_assets,
        pool.params.senior_rate_bps_per_epoch,
        epochs_elapsed,
        pool.params.protocol_fee_bps,
    )
    .ok_or(EpochError::MathOverflow)?;

    pool.income_unallocated = 0;
    pool.cash = pool
        .cash
        .checked_sub(d.protocol_fee)
        .ok_or(EpochError::MathOverflow)?;
    pool.senior_assets = pool
        .senior_assets
        .checked_add(d.senior_gain)
        .ok_or(EpochError::MathOverflow)?;
    pool.junior_assets = pool
        .junior_assets
        .checked_add(d.junior_gain)
        .ok_or(EpochError::MathOverflow)?;
    pool.last_accrued_epoch = epoch;
    pool.assert_ledger()?;

    if d.protocol_fee > 0 {
        let pool_key = pool.key();
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[pool.vault_bump]];
        transfer_from_pda(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            d.protocol_fee,
            &[vault_seeds],
        )?;
    }

    emit!(Accrued {
        pool: pool.key(),
        epoch,
        income,
        protocol_fee: d.protocol_fee,
        senior_gain: d.senior_gain,
        junior_gain: d.junior_gain,
        senior_price_e9: share_price_e9(pool.senior_assets, pool.senior_shares).unwrap_or(0),
        junior_price_e9: share_price_e9(pool.junior_assets, pool.junior_shares).unwrap_or(0),
    });
    Ok(())
}
