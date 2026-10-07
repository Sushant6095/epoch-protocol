use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::Deposited,
    math::{assets_to_shares, share_price_e9},
    outbound::system::transfer_from_signer,
    state::*,
};

#[derive(Accounts)]
#[instruction(tranche: Tranche)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + LenderShares::INIT_SPACE,
        seeds = [LENDER_SEED, pool.key().as_ref(), owner.key().as_ref(), &[tranche.as_u8()]],
        bump,
    )]
    pub lender: Account<'info, LenderShares>,

    pub system_program: Program<'info, System>,
}

/// Deposit SOL into a tranche and receive shares at the current price.
pub fn deposit(ctx: Context<Deposit>, tranche: Tranche, assets: u64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(!pool.paused, EpochError::Paused);
    require!(assets > 0, EpochError::ZeroAmount);

    // Pool cap.
    if pool.params.max_pool_assets > 0 {
        let after = pool
            .total_assets()?
            .checked_add(assets)
            .ok_or(EpochError::MathOverflow)?;
        require!(
            after <= pool.params.max_pool_assets,
            EpochError::PoolCapExceeded
        );
    }

    // Senior money may only come in while junior still covers the floor.
    if tranche == Tranche::Senior {
        let new_senior = pool
            .senior_assets
            .checked_add(assets)
            .ok_or(EpochError::MathOverflow)?;
        require!(
            pool.junior_floor_holds(new_senior, pool.junior_assets)?,
            EpochError::JuniorFloorBreached
        );
    }

    let (tranche_assets, tranche_shares) = pool.tranche(tranche);
    let shares =
        assets_to_shares(assets, tranche_assets, tranche_shares).ok_or(EpochError::MathOverflow)?;
    require!(shares > 0, EpochError::ZeroAmount);

    transfer_from_signer(
        &ctx.accounts.owner.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        assets,
    )?;

    pool.cash = pool
        .cash
        .checked_add(assets)
        .ok_or(EpochError::MathOverflow)?;
    {
        let (a, s, _) = pool.tranche_mut(tranche);
        *a = a.checked_add(assets).ok_or(EpochError::MathOverflow)?;
        *s = s.checked_add(shares).ok_or(EpochError::MathOverflow)?;
    }
    pool.assert_ledger()?;

    let lender = &mut ctx.accounts.lender;
    if lender.owner == Pubkey::default() {
        lender.pool = pool.key();
        lender.owner = ctx.accounts.owner.key();
        lender.tranche = tranche;
        lender.bump = ctx.bumps.lender;
    }
    lender.shares = lender
        .shares
        .checked_add(shares)
        .ok_or(EpochError::MathOverflow)?;
    lender.last_deposit_epoch = Clock::get()?.epoch;
    lender.total_deposited = lender.total_deposited.saturating_add(assets);

    let (a, s) = pool.tranche(tranche);
    emit!(Deposited {
        pool: pool.key(),
        owner: ctx.accounts.owner.key(),
        tranche,
        assets,
        shares,
        share_price_e9: share_price_e9(a, s).unwrap_or(0),
    });
    Ok(())
}
