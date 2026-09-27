use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::{WithdrawCancelled, WithdrawRequested},
    state::*,
};

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [LENDER_SEED, pool.key().as_ref(), owner.key().as_ref(), &[lender.tranche.as_u8()]],
        bump = lender.bump,
        has_one = owner,
        has_one = pool,
    )]
    pub lender: Account<'info, LenderShares>,

    #[account(
        init,
        payer = owner,
        space = 8 + WithdrawRequest::INIT_SPACE,
        seeds = [WITHDRAW_SEED, pool.key().as_ref(), &pool.withdraw_tail.to_le_bytes()],
        bump,
    )]
    pub request: Account<'info, WithdrawRequest>,

    pub system_program: Program<'info, System>,
}

/// Queue `shares` for withdrawal. The shares stop earning the moment they
/// are queued (they are excluded from the pool's free cash) and are paid at
/// the share price on the day the request reaches the head of the queue.
pub fn request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
    require!(shares > 0, EpochError::ZeroAmount);
    let pool = &mut ctx.accounts.pool;
    let lender = &mut ctx.accounts.lender;
    require!(lender.shares >= shares, EpochError::InsufficientShares);

    let epoch = Clock::get()?.epoch;
    if lender.tranche == Tranche::Junior {
        let unlock = lender
            .last_deposit_epoch
            .saturating_add(u64::from(pool.params.junior_lock_epochs));
        require!(epoch >= unlock, EpochError::JuniorLocked);
    }

    lender.shares -= shares;
    lender.pending_shares = lender
        .pending_shares
        .checked_add(shares)
        .ok_or(EpochError::MathOverflow)?;
    {
        let (_, _, pending) = pool.tranche_mut(lender.tranche);
        *pending = pending
            .checked_add(shares)
            .ok_or(EpochError::MathOverflow)?;
    }

    let seq = pool.withdraw_tail;
    pool.withdraw_tail = seq.checked_add(1).ok_or(EpochError::MathOverflow)?;

    let request = &mut ctx.accounts.request;
    request.pool = pool.key();
    request.owner = ctx.accounts.owner.key();
    request.tranche = lender.tranche;
    request.shares = shares;
    request.seq = seq;
    request.requested_epoch = epoch;
    request.cancelled = false;
    request.bump = ctx.bumps.request;

    emit!(WithdrawRequested {
        pool: pool.key(),
        owner: ctx.accounts.owner.key(),
        tranche: lender.tranche,
        shares,
        seq,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelWithdraw<'info> {
    pub owner: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [LENDER_SEED, pool.key().as_ref(), owner.key().as_ref(), &[lender.tranche.as_u8()]],
        bump = lender.bump,
        has_one = owner,
        has_one = pool,
    )]
    pub lender: Account<'info, LenderShares>,

    #[account(
        mut,
        seeds = [WITHDRAW_SEED, pool.key().as_ref(), &request.seq.to_le_bytes()],
        bump = request.bump,
        has_one = owner,
        has_one = pool,
    )]
    pub request: Account<'info, WithdrawRequest>,
}

/// Take a request back. The account stays until it reaches the head of the
/// queue so sequence numbers remain contiguous; processing then closes it.
pub fn cancel_withdraw(ctx: Context<CancelWithdraw>) -> Result<()> {
    let request = &mut ctx.accounts.request;
    require!(!request.cancelled, EpochError::RequestCancelled);
    let pool = &mut ctx.accounts.pool;
    let lender = &mut ctx.accounts.lender;

    let shares = request.shares;
    lender.pending_shares = lender
        .pending_shares
        .checked_sub(shares)
        .ok_or(EpochError::InsufficientShares)?;
    lender.shares = lender
        .shares
        .checked_add(shares)
        .ok_or(EpochError::MathOverflow)?;
    {
        let (_, _, pending) = pool.tranche_mut(request.tranche);
        *pending = pending
            .checked_sub(shares)
            .ok_or(EpochError::InsufficientShares)?;
    }
    request.cancelled = true;

    emit!(WithdrawCancelled {
        pool: pool.key(),
        owner: ctx.accounts.owner.key(),
        seq: request.seq,
        reason: 0,
    });
    Ok(())
}
