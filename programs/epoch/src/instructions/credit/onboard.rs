use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::ValidatorOnboarded,
    outbound::{system::transfer_from_signer, vote},
    state::*,
    vote_account::VoteHeader,
};

#[derive(Accounts)]
pub struct OnboardValidator<'info> {
    /// Pays rent and becomes the position's operator.
    #[account(mut)]
    pub operator: Signer<'info>,

    /// The vote account's withdraw authority today. Often the same key as
    /// `operator`; a multisig can pass both.
    pub current_withdrawer: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// CHECK: owner checked here, state parsed in the handler.
    #[account(mut, owner = VOTE_PROGRAM_ID @ EpochError::NotAVoteAccount)]
    pub vote_account: UncheckedAccount<'info>,

    #[account(
        init,
        payer = operator,
        space = 8 + ValidatorPosition::INIT_SPACE,
        seeds = [POSITION_SEED, vote_account.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, ValidatorPosition>,

    /// CHECK: program signer that becomes the withdraw authority; holds no data.
    #[account(seeds = [VOTE_AUTH_SEED, vote_account.key().as_ref()], bump)]
    pub vote_auth: UncheckedAccount<'info>,

    /// System-owned, rent-exempt: the account both commission collectors
    /// will point at, and where every sweep lands first.
    #[account(mut, seeds = [ESCROW_SEED, vote_account.key().as_ref()], bump)]
    pub escrow: SystemAccount<'info>,

    /// CHECK: receives the validator's share of every sweep.
    pub payout: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
    /// CHECK: the vote program.
    #[account(address = VOTE_PROGRAM_ID)]
    pub vote_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Onboard a validator in one transaction: the current withdraw authority
/// signs once, the Epoch PDA becomes the vote account's withdraw authority,
/// and the position and escrow are created. Collectors are pointed at the
/// escrow by `set_collectors` (kept separate because SIMD-0232 is gated on
/// some clusters).
pub fn onboard_validator(ctx: Context<OnboardValidator>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(!pool.paused, EpochError::Paused);

    let header = VoteHeader::load(&ctx.accounts.vote_account)?;
    require_keys_eq!(
        header.authorized_withdrawer,
        ctx.accounts.current_withdrawer.key(),
        EpochError::NotWithdrawAuthority
    );
    require!(
        header.inflation_rewards_commission_bps >= pool.params.min_commission_bps,
        EpochError::CommissionTooLow
    );

    // Escrow must be rent-exempt to be a valid collector and to survive.
    let rent_min = Rent::get()?.minimum_balance(0);
    let top_up = rent_min.saturating_sub(ctx.accounts.escrow.lamports());
    transfer_from_signer(
        &ctx.accounts.operator.to_account_info(),
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        top_up,
    )?;

    // Hand the withdraw authority to the program.
    vote::authorize_withdrawer(
        &ctx.accounts.vote_account.to_account_info(),
        &ctx.accounts.clock.to_account_info(),
        &ctx.accounts.current_withdrawer.to_account_info(),
        ctx.accounts.vote_auth.key,
        &ctx.accounts.vote_program.to_account_info(),
    )?;

    let epoch = ctx.accounts.clock.epoch;
    let position = &mut ctx.accounts.position;
    position.pool = pool.key();
    position.vote = ctx.accounts.vote_account.key();
    position.identity = header.node_pubkey;
    position.operator = ctx.accounts.operator.key();
    position.payout = ctx.accounts.payout.key();
    position.original_withdrawer = ctx.accounts.current_withdrawer.key();
    position.bump = ctx.bumps.position;
    position.vote_auth_bump = ctx.bumps.vote_auth;
    position.escrow_bump = ctx.bumps.escrow;
    position.status = PositionStatus::Active;
    position.hedged = false;
    position.score = 0;
    position.last_scored_epoch = 0;
    position.revenue = [0; REVENUE_WINDOW];
    position.revenue_head = 0;
    position.revenue_count = 0;
    position.last_swept_epoch = epoch;
    position.inflation_commission_bps = header.inflation_rewards_commission_bps;
    position.block_commission_bps = header.block_revenue_commission_bps;
    position.onboarded_epoch = epoch;

    pool.validators = pool.validators.saturating_add(1);

    emit!(ValidatorOnboarded {
        pool: pool.key(),
        vote: position.vote,
        identity: position.identity,
        operator: position.operator,
        original_withdrawer: position.original_withdrawer,
        epoch,
    });
    Ok(())
}
