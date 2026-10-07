use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::VoteAccountCopied,
    math::max_credits,
    state::*,
    vote_account::{VoteHeader, VoteRecord},
};

#[derive(Accounts)]
pub struct CopyVoteAccount<'info> {
    /// Anyone; the keeper does it every epoch, before `sweep`.
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [HISTORY_SEED, vote_account.key().as_ref()],
        bump = history.load()?.bump,
    )]
    pub history: AccountLoader<'info, ValidatorHistory>,

    /// CHECK: owner checked; parsed in the handler.
    #[account(owner = VOTE_PROGRAM_ID @ EpochError::NotAVoteAccount)]
    pub vote_account: UncheckedAccount<'info>,

    /// CHECK: Epoch's escrow for this vote account; only its lamports are
    /// read (zero when the validator is not onboarded).
    #[account(seeds = [ESCROW_SEED, vote_account.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
}

/// Copy what the vote account proves into the history:
///
/// - every epoch of credits the vote account remembers (up to 64) that falls
///   inside the ring, with the epoch's TVC maximum from the EpochSchedule;
/// - for the current epoch: both commissions, the newest voted slot, the
///   vote-account lamports and the revenue by the sweep rule (the most seen
///   above rent + pending delegator rewards, plus the escrow above rent).
pub fn copy_vote_account(ctx: Context<CopyVoteAccount>) -> Result<()> {
    let clock = Clock::get()?;
    let schedule = EpochSchedule::get()?;
    let rent = Rent::get()?;
    let epoch = clock.epoch;
    let vote = ctx.accounts.vote_account.key();

    let vote_info = ctx.accounts.vote_account.to_account_info();
    let data = vote_info.try_borrow_data()?;
    let header = VoteHeader::parse(&data).ok_or(EpochError::UnsupportedVoteState)?;
    let record = VoteRecord::parse_or_err(&data)?;

    // The sweep rule (`sweep.rs`), without the pool-specific reserve.
    let vote_lamports = vote_info.lamports();
    let vote_floor = rent
        .minimum_balance(data.len())
        .checked_add(header.pending_delegator_rewards)
        .ok_or(EpochError::MathOverflow)?;
    let observed_revenue = vote_lamports
        .saturating_sub(vote_floor)
        .checked_add(
            ctx.accounts
                .escrow
                .lamports()
                .saturating_sub(rent.minimum_balance(0)),
        )
        .ok_or(EpochError::MathOverflow)?;

    let mut h = ctx.accounts.history.load_mut()?;
    require_keys_eq!(h.vote, vote, EpochError::HistoryVoteMismatch);

    let oldest = ValidatorHistory::oldest_writable(epoch);
    let mut backfilled: u8 = 0;
    let mut credits_now = 0u64;
    for row in record.epoch_credits() {
        if row.epoch < oldest || row.epoch > epoch {
            continue;
        }
        let max =
            max_credits(schedule.get_slots_in_epoch(row.epoch)).ok_or(EpochError::MathOverflow)?;
        let e = h.entry_mut(row.epoch)?;
        e.epoch_credits = row.earned();
        e.max_credits = max;
        e.sources |= SOURCE_CREDITS;
        if row.epoch == epoch {
            credits_now = row.earned();
        } else {
            backfilled = backfilled.saturating_add(1);
        }
    }

    let max_now =
        max_credits(schedule.get_slots_in_epoch(epoch)).ok_or(EpochError::MathOverflow)?;
    let e = h.entry_mut(epoch)?;
    e.epoch_credits = credits_now;
    e.max_credits = max_now;
    e.inflation_commission_bps = header.inflation_rewards_commission_bps;
    e.block_commission_bps = header.block_revenue_commission_bps;
    e.vote_lamports = vote_lamports;
    e.revenue_lamports =
        known_u64(e.revenue_lamports).map_or(observed_revenue, |seen| seen.max(observed_revenue));
    e.last_voted_slot = record.last_voted_slot.unwrap_or(UNKNOWN_U64);
    e.updated_slot = clock.slot;
    e.sources |= SOURCE_VOTE;
    let revenue_lamports = e.revenue_lamports;

    h.epochs_voted = record.epochs_with_credits();
    h.last_vote_copy_slot = clock.slot;

    emit!(VoteAccountCopied {
        vote,
        epoch,
        slot: clock.slot,
        epoch_credits: credits_now,
        epochs_backfilled: backfilled,
        last_voted_slot: record.last_voted_slot,
        inflation_commission_bps: header.inflation_rewards_commission_bps,
        block_commission_bps: header.block_revenue_commission_bps,
        vote_lamports,
        revenue_lamports,
    });
    Ok(())
}
