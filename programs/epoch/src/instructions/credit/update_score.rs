use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::ScoreUpdated,
    math::{compute_score, ScoreInputs},
    state::*,
};

/// Inputs the scorer posts each epoch. The formula is on-chain
/// (`math::score`), so the score is reproducible from these numbers.
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
}

pub fn update_score(ctx: Context<UpdateScore>, update: ScoreUpdate) -> Result<()> {
    let position = &mut ctx.accounts.position;
    require!(
        position.status != PositionStatus::Released,
        EpochError::PositionNotActive
    );
    let score = compute_score(&ScoreInputs {
        credits_ratio_bps: update.credits_ratio_bps,
        commission_bps: update.commission_bps,
        epochs_active: update.epochs_active,
        delinquent: update.delinquent,
        superminority: update.superminority,
    });
    let epoch = Clock::get()?.epoch;
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
