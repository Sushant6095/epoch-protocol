use anchor_lang::prelude::*;

use crate::{
    constants::*,
    cpi::system::{transfer_from_pda, transfer_from_signer},
    errors::EpochError,
    events::{BondPosted, BondWithdrawn},
    state::*,
};

#[derive(Accounts)]
pub struct Bond<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position.vote.as_ref()],
        bump = position.bump,
        has_one = pool,
        has_one = operator @ EpochError::NotOperator,
    )]
    pub position: Account<'info, ValidatorPosition>,

    pub system_program: Program<'info, System>,
}

/// Post SOL as a bond. It raises the credit limit (`bond × bond_multiplier`)
/// and is the first thing applied against a default.
pub fn post_bond(ctx: Context<Bond>, lamports: u64) -> Result<()> {
    require!(lamports > 0, EpochError::ZeroAmount);
    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    require!(
        position.status != PositionStatus::Released,
        EpochError::PositionNotActive
    );

    transfer_from_signer(
        &ctx.accounts.operator.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        lamports,
    )?;
    position.bond_lamports = position
        .bond_lamports
        .checked_add(lamports)
        .ok_or(EpochError::MathOverflow)?;
    pool.bond_total = pool
        .bond_total
        .checked_add(lamports)
        .ok_or(EpochError::MathOverflow)?;

    emit!(BondPosted {
        vote: position.vote,
        lamports,
        bond_total: position.bond_lamports,
    });
    Ok(())
}

/// Take the bond back. Only with no advance open and the position in good
/// standing.
pub fn withdraw_bond(ctx: Context<Bond>, lamports: u64) -> Result<()> {
    require!(lamports > 0, EpochError::ZeroAmount);
    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    require!(!position.has_open_advance(), EpochError::BondLocked);
    require!(
        position.status == PositionStatus::Active,
        EpochError::PositionNotActive
    );
    require!(
        position.bond_lamports >= lamports,
        EpochError::InsufficientLiquidity
    );

    position.bond_lamports -= lamports;
    pool.bond_total = pool
        .bond_total
        .checked_sub(lamports)
        .ok_or(EpochError::MathOverflow)?;

    let pool_key = pool.key();
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[pool.vault_bump]];
    transfer_from_pda(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.operator.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        lamports,
        &[vault_seeds],
    )?;

    let rent_min = Rent::get()?.minimum_balance(0);
    require!(
        ctx.accounts.vault.lamports() >= pool.required_vault_lamports(rent_min)?,
        EpochError::VaultLedgerMismatch
    );

    emit!(BondWithdrawn {
        vote: position.vote,
        lamports,
        bond_total: position.bond_lamports,
    });
    Ok(())
}
