//! Adapted from jito-foundation_stakenet/programs/validator-history/src/instructions/
//! update_stake_history.rs (Apache-2.0): the oracle posts activated stake, rank
//! and the superminority bit for an epoch. Changed: signed by the pool's
//! existing `scorer` instead of a separate oracle authority, bounded to the
//! ring's 64 epochs, and the rank is checked.

use anchor_lang::prelude::*;

use crate::{constants::*, errors::EpochError, events::StakeInfoUpdated, state::*};

#[derive(Accounts)]
pub struct UpdateStakeInfo<'info> {
    pub scorer: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = scorer @ EpochError::NotScorer)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [HISTORY_SEED, history.load()?.vote.as_ref()],
        bump = history.load()?.bump,
    )]
    pub history: AccountLoader<'info, ValidatorHistory>,
}

/// The one oracle input left: activated stake, stake rank (1 = largest) and
/// superminority for `epoch`. No single account proves them (they need every
/// stake account, or every vote account's stake, in the cluster), so the
/// pool's scorer signs them; `refresh_score` uses only the current epoch's.
pub fn update_stake_info(
    ctx: Context<UpdateStakeInfo>,
    epoch: u64,
    activated_stake_lamports: u64,
    rank: u32,
    superminority: bool,
) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        epoch <= clock.epoch && epoch >= ValidatorHistory::oldest_writable(clock.epoch),
        EpochError::HistoryEpochOutOfRange
    );
    require!(
        rank >= 1 && rank != UNKNOWN_U32 && activated_stake_lamports != UNKNOWN_U64,
        EpochError::InvalidParams
    );
    let mut h = ctx.accounts.history.load_mut()?;
    let vote = h.vote;
    let e = h.entry_mut(epoch)?;
    e.activated_stake_lamports = activated_stake_lamports;
    e.rank = rank;
    e.superminority = u8::from(superminority);
    e.updated_slot = clock.slot;
    e.sources |= SOURCE_STAKE;

    emit!(StakeInfoUpdated {
        vote,
        epoch,
        activated_stake_lamports,
        rank,
        superminority,
    });
    Ok(())
}
