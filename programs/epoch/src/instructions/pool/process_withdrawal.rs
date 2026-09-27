use anchor_lang::prelude::*;

use crate::{
    constants::*,
    cpi::system::transfer_from_pda,
    errors::EpochError,
    events::{WithdrawCancelled, WithdrawProcessed},
    math::shares_to_assets,
    state::*,
};

#[derive(Accounts)]
pub struct ProcessWithdrawal<'info> {
    /// Anyone may crank the queue.
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    /// CHECK: the request's owner; receives the payout and the request's rent.
    #[account(mut, address = request.owner @ EpochError::PayoutMismatch)]
    pub owner: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [LENDER_SEED, pool.key().as_ref(), owner.key().as_ref(), &[request.tranche.as_u8()]],
        bump = lender.bump,
        has_one = pool,
    )]
    pub lender: Account<'info, LenderShares>,

    #[account(
        mut,
        close = owner,
        seeds = [WITHDRAW_SEED, pool.key().as_ref(), &request.seq.to_le_bytes()],
        bump = request.bump,
        has_one = pool,
    )]
    pub request: Account<'info, WithdrawRequest>,

    pub system_program: Program<'info, System>,
}

/// Pay the request at the head of the queue, whole-or-nothing, at today's
/// share price. A cancelled request just advances the head. A junior
/// request that would breach the floor is bounced: shares go back to the
/// lender and the head advances, so one blocked request never freezes the
/// queue for everyone behind it.
pub fn process_withdrawal(ctx: Context<ProcessWithdrawal>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let request = &ctx.accounts.request;
    require!(
        request.seq == pool.withdraw_head,
        EpochError::NotHeadOfQueue
    );

    let seq = request.seq;
    let tranche = request.tranche;
    let shares = request.shares;

    if request.cancelled {
        pool.withdraw_head = seq.checked_add(1).ok_or(EpochError::MathOverflow)?;
        return Ok(());
    }

    let lender = &mut ctx.accounts.lender;
    let (tranche_assets, tranche_shares) = pool.tranche(tranche);
    let assets =
        shares_to_assets(shares, tranche_assets, tranche_shares).ok_or(EpochError::MathOverflow)?;

    // Junior floor: bounce rather than block the queue.
    if tranche == Tranche::Junior {
        let new_junior = pool.junior_assets.saturating_sub(assets);
        if !pool.junior_floor_holds(pool.senior_assets, new_junior)? {
            lender.pending_shares = lender
                .pending_shares
                .checked_sub(shares)
                .ok_or(EpochError::InsufficientShares)?;
            lender.shares = lender
                .shares
                .checked_add(shares)
                .ok_or(EpochError::MathOverflow)?;
            {
                let (_, _, pending) = pool.tranche_mut(tranche);
                *pending = pending
                    .checked_sub(shares)
                    .ok_or(EpochError::InsufficientShares)?;
            }
            pool.withdraw_head = seq.checked_add(1).ok_or(EpochError::MathOverflow)?;
            emit!(WithdrawCancelled {
                pool: pool.key(),
                owner: ctx.accounts.owner.key(),
                seq,
                reason: 1,
            });
            return Ok(());
        }
    }

    // Whole-or-nothing: wait for the next sweep if the cash is not there.
    require!(pool.cash >= assets, EpochError::InsufficientLiquidity);

    pool.cash -= assets;
    {
        let (a, s, pending) = pool.tranche_mut(tranche);
        *a = a.checked_sub(assets).ok_or(EpochError::MathOverflow)?;
        *s = s
            .checked_sub(shares)
            .ok_or(EpochError::InsufficientShares)?;
        *pending = pending
            .checked_sub(shares)
            .ok_or(EpochError::InsufficientShares)?;
    }
    lender.pending_shares = lender
        .pending_shares
        .checked_sub(shares)
        .ok_or(EpochError::InsufficientShares)?;
    lender.total_withdrawn = lender.total_withdrawn.saturating_add(assets);
    pool.withdraw_head = seq.checked_add(1).ok_or(EpochError::MathOverflow)?;
    pool.assert_ledger()?;

    let pool_key = pool.key();
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[pool.vault_bump]];
    transfer_from_pda(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        assets,
        &[vault_seeds],
    )?;

    let rent_min = Rent::get()?.minimum_balance(0);
    require!(
        ctx.accounts.vault.lamports() >= pool.required_vault_lamports(rent_min)?,
        EpochError::VaultLedgerMismatch
    );

    emit!(WithdrawProcessed {
        pool: pool_key,
        owner: ctx.accounts.owner.key(),
        tranche,
        shares,
        assets,
        seq,
    });
    Ok(())
}
