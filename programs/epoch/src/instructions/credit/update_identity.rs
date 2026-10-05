use anchor_lang::prelude::*;

use crate::{
    constants::*, cpi::vote, errors::EpochError, events::IdentityUpdated, state::*,
    vote_account::VoteHeader,
};

#[derive(Accounts)]
pub struct UpdateIdentity<'info> {
    pub operator: Signer<'info>,

    /// The new identity must co-sign, as the vote program requires.
    pub new_identity: Signer<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, vote_account.key().as_ref()],
        bump = position.bump,
        has_one = operator @ EpochError::NotOperator,
    )]
    pub position: Account<'info, ValidatorPosition>,

    /// CHECK: owner checked; state parsed in the handler.
    #[account(mut, owner = VOTE_PROGRAM_ID @ EpochError::NotAVoteAccount)]
    pub vote_account: UncheckedAccount<'info>,

    /// CHECK: program signer, the vote account's withdraw authority.
    #[account(seeds = [VOTE_AUTH_SEED, vote_account.key().as_ref()], bump = position.vote_auth_bump)]
    pub vote_auth: UncheckedAccount<'info>,

    /// CHECK: the vote program.
    #[account(address = VOTE_PROGRAM_ID)]
    pub vote_program: UncheckedAccount<'info>,
}

/// Rotate the validator identity. Blocked while an advance is open. A block
/// revenue collector that is not the identity (the escrow, once
/// `set_collectors` ran) stays where it is: the vote program moves only a
/// collector that was the old identity (probed on Agave 4.3 localnet by the
/// revenue-token integration test). `set_collectors` re-asserts the escrow
/// either way.
pub fn update_identity(ctx: Context<UpdateIdentity>) -> Result<()> {
    let position = &mut ctx.accounts.position;
    require!(
        position.status == PositionStatus::Active,
        EpochError::PositionNotActive
    );
    require!(!position.has_open_advance(), EpochError::AdvanceOpen);
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
        &[position.vote_auth_bump],
    ];
    vote::update_validator_identity_signed(
        &ctx.accounts.vote_account.to_account_info(),
        &ctx.accounts.new_identity.to_account_info(),
        &ctx.accounts.vote_auth.to_account_info(),
        &ctx.accounts.vote_program.to_account_info(),
        &[seeds],
    )?;
    position.identity = ctx.accounts.new_identity.key();

    emit!(IdentityUpdated {
        vote: vote_key,
        new_identity: position.identity,
    });
    Ok(())
}
