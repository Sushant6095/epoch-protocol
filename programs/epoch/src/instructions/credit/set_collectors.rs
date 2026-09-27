use anchor_lang::prelude::*;

use crate::{
    constants::*,
    cpi::vote::{self, CommissionKind},
    errors::EpochError,
    events::CollectorsSet,
    state::*,
    vote_account::VoteHeader,
};

#[derive(Accounts)]
pub struct SetCollectors<'info> {
    /// Anyone may re-assert the collectors; the program signs.
    pub cranker: Signer<'info>,

    #[account(seeds = [POSITION_SEED, vote_account.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, ValidatorPosition>,

    /// CHECK: owner checked; state parsed in the handler.
    #[account(mut, owner = VOTE_PROGRAM_ID @ EpochError::NotAVoteAccount)]
    pub vote_account: UncheckedAccount<'info>,

    /// CHECK: program signer, the vote account's withdraw authority.
    #[account(seeds = [VOTE_AUTH_SEED, vote_account.key().as_ref()], bump = position.vote_auth_bump)]
    pub vote_auth: UncheckedAccount<'info>,

    #[account(mut, seeds = [ESCROW_SEED, vote_account.key().as_ref()], bump = position.escrow_bump)]
    pub escrow: SystemAccount<'info>,

    /// CHECK: the vote program.
    #[account(address = VOTE_PROGRAM_ID)]
    pub vote_program: UncheckedAccount<'info>,
}

/// Point both commission collectors (SIMD-0232) at the escrow. Inflation
/// commission then lands in the escrow directly; block-fee commission
/// follows the epoch SIMD-0123 activates. Safe to call again after an
/// identity change, which resets the block revenue collector.
pub fn set_collectors(ctx: Context<SetCollectors>) -> Result<()> {
    require!(
        ctx.accounts.position.status != PositionStatus::Released,
        EpochError::PositionNotActive
    );
    let header = VoteHeader::load(&ctx.accounts.vote_account)?;
    require_keys_eq!(
        header.authorized_withdrawer,
        ctx.accounts.vote_auth.key(),
        EpochError::ProgramNotWithdrawAuthority
    );

    let vote_key = ctx.accounts.vote_account.key();
    let seeds: &[&[u8]] = &[
        VOTE_AUTH_SEED,
        vote_key.as_ref(),
        &[ctx.accounts.position.vote_auth_bump],
    ];
    for kind in [
        CommissionKind::InflationRewards,
        CommissionKind::BlockRevenue,
    ] {
        vote::update_commission_collector_signed(
            &ctx.accounts.vote_account.to_account_info(),
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.vote_auth.to_account_info(),
            kind,
            &ctx.accounts.vote_program.to_account_info(),
            &[seeds],
        )?;
    }

    emit!(CollectorsSet {
        vote: vote_key,
        collector: ctx.accounts.escrow.key(),
    });
    Ok(())
}
