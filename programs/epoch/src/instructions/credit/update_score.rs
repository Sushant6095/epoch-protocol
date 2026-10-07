use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::ScoreUpdated,
    math::{compute_score, ScoreInputs},
    state::*,
};

/// Inputs the scorer posts each epoch. The formula is on-chain
/// (`math::score`), so the score is reproducible from these numbers. This is
/// the fallback for clusters without validator history: once a validator's
/// history is fresh, `refresh_score` computes the inputs on chain and this
/// instruction refuses (`HistoryIsFresh`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoreUpdate {
    /// Vote credits as a share of the cluster average, bps.
    pub credits_ratio_bps: u16,
    /// The higher of inflation and MEV commission, bps.
    pub commission_bps: u16,
    pub epochs_active: u16,
    pub delinquent: bool,
    pub superminority: bool,
    /// The validator holds a Fee Market hedge for the coming epoch.
    pub hedged: bool,
}

#[derive(Accounts)]
pub struct UpdateScore<'info> {
    pub scorer: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = scorer @ EpochError::NotScorer)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [POSITION_SEED, position.vote.as_ref()], bump = position.bump, has_one = pool)]
    pub position: Account<'info, ValidatorPosition>,

    /// CHECK: the validator's `ValidatorHistory` address (`["history", vote]`),
    /// which may not exist. While it holds a vote copy from this epoch the
    /// chain can compute the score itself, so the scorer may not post one.
    #[account(seeds = [HISTORY_SEED, position.vote.as_ref()], bump)]
    pub history: UncheckedAccount<'info>,
}

/// True when `history` is an initialized `ValidatorHistory` with a vote copy
/// from `epoch`. Reads the one entry by offset (no zero-copy load, no
/// alignment requirement).
fn history_is_fresh(history: &AccountInfo, program_id: &Pubkey, epoch: u64) -> Result<bool> {
    if history.owner != program_id || history.data_len() < ValidatorHistory::SPACE {
        return Ok(false);
    }
    let data = history.try_borrow_data()?;
    if data[..8] != *ValidatorHistory::DISCRIMINATOR {
        return Ok(false);
    }
    let at = 8
        + core::mem::offset_of!(ValidatorHistory, entries)
        + ValidatorHistory::slot_of(epoch) * core::mem::size_of::<HistoryEntry>();
    let mut epoch_bytes = [0u8; 8];
    epoch_bytes.copy_from_slice(&data[at..at + 8]);
    let sources = data[at + core::mem::offset_of!(HistoryEntry, sources)];
    Ok(u64::from_le_bytes(epoch_bytes) == epoch && sources & SOURCE_VOTE != 0)
}

pub fn update_score(ctx: Context<UpdateScore>, update: ScoreUpdate) -> Result<()> {
    let position = &mut ctx.accounts.position;
    require!(
        position.status != PositionStatus::Released,
        EpochError::PositionNotActive
    );
    let epoch = Clock::get()?.epoch;
    require!(
        !history_is_fresh(&ctx.accounts.history, ctx.program_id, epoch)?,
        EpochError::HistoryIsFresh
    );
    let score = compute_score(&ScoreInputs {
        credits_ratio_bps: update.credits_ratio_bps,
        commission_bps: update.commission_bps,
        epochs_active: update.epochs_active,
        delinquent: update.delinquent,
        superminority: update.superminority,
    });
    position.score = score;
    position.hedged = update.hedged;
    position.last_scored_epoch = epoch;

    emit!(ScoreUpdated {
        vote: position.vote,
        epoch,
        score,
        hedged: update.hedged,
    });
    Ok(())
}
