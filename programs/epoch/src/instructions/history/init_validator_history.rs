use anchor_lang::prelude::*;

use crate::{
    constants::*, errors::EpochError, events::HistoryInitialized, state::*,
    vote_account::VoteHeader,
};

#[derive(Accounts)]
pub struct InitValidatorHistory<'info> {
    /// Anyone; pays the rent (8,352 bytes, ~0.059 SOL).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: owner checked; the version is checked in the handler.
    #[account(owner = VOTE_PROGRAM_ID @ EpochError::NotAVoteAccount)]
    pub vote_account: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = ValidatorHistory::SPACE,
        seeds = [HISTORY_SEED, vote_account.key().as_ref()],
        bump,
    )]
    pub history: AccountLoader<'info, ValidatorHistory>,

    pub system_program: Program<'info, System>,
}

/// Create a validator's history. Every entry starts unknown; the first
/// `copy_vote_account` backfills up to 64 epochs of credits.
pub fn init_validator_history(ctx: Context<InitValidatorHistory>) -> Result<()> {
    {
        let data = ctx.accounts.vote_account.try_borrow_data()?;
        VoteHeader::parse(&data).ok_or(EpochError::UnsupportedVoteState)?;
    }
    let epoch = Clock::get()?.epoch;
    let vote = ctx.accounts.vote_account.key();
    {
        let mut h = ctx.accounts.history.load_init()?;
        h.vote = vote;
        h.created_epoch = epoch;
        h.bump = ctx.bumps.history;
        h.version = VALIDATOR_HISTORY_VERSION;
        // One entry at a time: the whole ring would not fit on the SBF stack.
        for e in h.entries.iter_mut() {
            *e = HistoryEntry::EMPTY;
        }
    }
    emit!(HistoryInitialized {
        vote,
        history: ctx.accounts.history.key(),
        payer: ctx.accounts.payer.key(),
        epoch,
    });
    Ok(())
}
