use anchor_lang::prelude::*;

use crate::{
    constants::*, errors::EpochError, events::AdvanceDefaulted, math::absorb_loss, state::*,
};

#[derive(Accounts)]
pub struct MarkDefault<'info> {
    /// Anyone may mark a default once the conditions are met.
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [POSITION_SEED, position.vote.as_ref()], bump = position.bump, has_one = pool)]
    pub position: Account<'info, ValidatorPosition>,

    #[account(mut, has_one = pool, has_one = position)]
    pub advance: Account<'info, Advance>,
}

/// Write off an advance that has gone `DEFAULT_AFTER_LATE_EPOCHS` epochs
/// without revenue, or outlived `max_advance_epochs`. The bond is applied
/// first; the rest hits junior, then senior. The position stays onboarded
/// and every future sweep remits 100% until the balance is recovered.
pub fn mark_default(ctx: Context<MarkDefault>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    let advance = &mut ctx.accounts.advance;
    let epoch = Clock::get()?.epoch;

    require!(
        position.open_advance == Some(advance.key()),
        EpochError::AdvanceMismatch
    );
    require!(
        advance.state == AdvanceState::Open,
        EpochError::AdvanceStateInvalid
    );
    let too_late = position.late_epochs >= DEFAULT_AFTER_LATE_EPOCHS;
    let too_old = epoch
        >= advance
            .opened_epoch
            .saturating_add(u64::from(pool.params.max_advance_epochs));
    require!(too_late || too_old, EpochError::NotDefaultable);

    let principal_lost = advance.principal_outstanding();
    let fee_lost = advance.fee_outstanding();

    // Bond first: it is already in the vault, so it just changes ledger.
    let bond_applied = position.bond_lamports.min(principal_lost);
    position.bond_lamports -= bond_applied;
    pool.bond_total = pool
        .bond_total
        .checked_sub(bond_applied)
        .ok_or(EpochError::MathOverflow)?;
    pool.cash = pool
        .cash
        .checked_add(bond_applied)
        .ok_or(EpochError::MathOverflow)?;
    advance.repaid = advance
        .repaid
        .checked_add(bond_applied)
        .ok_or(EpochError::MathOverflow)?;
    advance.principal_repaid = advance
        .principal_repaid
        .checked_add(bond_applied)
        .ok_or(EpochError::MathOverflow)?;

    // Write off what remains.
    let loss = principal_lost - bond_applied;
    pool.outstanding_principal = pool
        .outstanding_principal
        .checked_sub(principal_lost)
        .ok_or(EpochError::MathOverflow)?;
    pool.expected_fees = pool
        .expected_fees
        .checked_sub(fee_lost)
        .ok_or(EpochError::MathOverflow)?;
    let (senior, junior, unabsorbed) = absorb_loss(loss, pool.senior_assets, pool.junior_assets);
    require!(unabsorbed == 0, EpochError::VaultLedgerMismatch);
    pool.senior_assets = senior;
    pool.junior_assets = junior;
    pool.total_defaulted = pool.total_defaulted.saturating_add(loss);
    pool.assert_ledger()?;

    advance.state = AdvanceState::Defaulted;
    position.status = PositionStatus::Defaulted;

    emit!(AdvanceDefaulted {
        pool: pool.key(),
        vote: position.vote,
        advance: advance.key(),
        principal_lost: loss,
        bond_applied,
        epoch,
    });
    Ok(())
}
