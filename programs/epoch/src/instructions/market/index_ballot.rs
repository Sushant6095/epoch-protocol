//! Fee Index ballots: registered operators vote on an epoch's value; when the
//! weight agreeing with the weighted median reaches the threshold, the ballot
//! writes the proposal into `FeeIndex` exactly as `post_index` does, and the
//! dispute window, `max_move_bps`, `veto_index` and `finalize_index` take it
//! from there.
//!
//! Adapted from jito-foundation/jito-tip-router/program/src/cast_vote.rs,
//! initialize_ballot_box.rs, admin_set_tie_breaker.rs and
//! close_epoch_account.rs (MIT or Apache-2.0): the ballot is created by the
//! first vote instead of a separate initialize step; consensus feeds the
//! existing FeeIndex proposal (queued when FeeIndex cannot take it yet)
//! instead of being consumed directly; the stalled-vote way out reopens the
//! round with the current registry instead of letting an admin pick a value;
//! and a ballot closes once its epoch is final, refunding its payer, with
//! `FeeIndex.epoch` doing the job of tip-router's epoch marker.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::{
        IndexBallotClosed, IndexBallotOpened, IndexBallotSubmitted, IndexConsensusReached,
        IndexProposed, IndexVoteCast,
    },
    state::*,
};

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct CastIndexVote<'info> {
    /// Pays the ballot's rent when this vote creates it (refunded on close).
    #[account(mut)]
    pub payer: Signer<'info>,

    /// A registered operator in the ballot's current round.
    pub operator: Signer<'info>,

    #[account(mut, seeds = [FEE_INDEX_SEED, fee_index.pool.as_ref()], bump = fee_index.bump)]
    pub fee_index: Box<Account<'info, FeeIndex>>,

    #[account(
        seeds = [INDEX_OPERATORS_SEED, fee_index.key().as_ref()],
        bump = index_operators.bump,
        has_one = fee_index,
        constraint = fee_index.publisher == index_operators.key() @ EpochError::ConsensusOff,
    )]
    pub index_operators: Box<Account<'info, IndexOperators>>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + IndexBallot::INIT_SPACE,
        seeds = [INDEX_BALLOT_SEED, fee_index.key().as_ref(), &epoch.to_le_bytes()],
        bump,
    )]
    pub ballot: Box<Account<'info, IndexBallot>>,

    pub system_program: Program<'info, System>,
}

/// Vote `value` (µL/CU) with its `inputs_hash` for program epoch `epoch`.
///
/// The first vote opens the ballot (the epoch must be newer than the last
/// final one and must have started on this cluster). Before consensus an
/// operator may replace its vote; after it, its vote is locked and an
/// operator that had not voted is recorded as late. A vote on a vetoed ballot
/// opens a new round with a fresh registry snapshot. When the agreeing weight
/// reaches the threshold the proposal goes into `FeeIndex` (or is queued for
/// `submit_index_ballot` if `FeeIndex` cannot take it yet).
pub fn cast_index_vote(
    ctx: Context<CastIndexVote>,
    epoch: u64,
    value: u64,
    inputs_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let slot = clock.slot;
    let fee_index_key = ctx.accounts.fee_index.key();
    let ballot_key = ctx.accounts.ballot.key();
    let payer = ctx.accounts.payer.key();
    let operator = ctx.accounts.operator.key();
    let registry = &ctx.accounts.index_operators;
    let index = &mut ctx.accounts.fee_index;
    let ballot = &mut ctx.accounts.ballot;

    if ballot.fee_index == Pubkey::default() {
        require!(epoch > index.epoch, EpochError::IndexEpochNotNewer);
        if let Some(blocker) = FeeIndex::start_blocker(epoch, clock.epoch) {
            return Err(blocker.into());
        }
        ballot.fee_index = fee_index_key;
        ballot.epoch = epoch;
        ballot.bump = ctx.bumps.ballot;
        ballot.payer = payer;
        ballot.round = 0;
        ballot.open_round(registry, slot)?;
        emit_opened(ballot, ballot_key, false, slot);
    } else {
        match ballot.status(index) {
            BallotStatus::Vetoed => {
                ballot.round = ballot
                    .round
                    .checked_add(1)
                    .ok_or(EpochError::MathOverflow)?;
                ballot.open_round(registry, slot)?;
                emit_opened(ballot, ballot_key, false, slot);
            }
            // Final without this ballot: nothing left to agree on.
            BallotStatus::Settled if !ballot.has_consensus() => {
                return err!(EpochError::IndexEpochNotNewer);
            }
            _ => {}
        }
    }

    let queued_before = ballot.status(index) == BallotStatus::Queued;
    let outcome = ballot.cast(&operator, value, inputs_hash, slot)?;
    let vote = ballot.votes[outcome.slot_index];
    emit!(IndexVoteCast {
        fee_index: fee_index_key,
        epoch,
        round: ballot.round,
        operator,
        weight: vote.weight,
        value,
        inputs_hash,
        deviation_bps: vote.deviation_bps,
        agrees: vote.agrees,
        changed: outcome.changed,
        late: outcome.late,
        median_value: ballot.median_value,
        agreeing_weight: ballot.agreeing_weight,
        total_weight: ballot.total_weight,
        votes_cast: ballot.votes_cast,
        slot,
    });

    if outcome.consensus_now {
        let proposed = try_propose(index, ballot, slot)?;
        emit!(IndexConsensusReached {
            fee_index: fee_index_key,
            epoch,
            round: ballot.round,
            value: ballot.consensus_value,
            inputs_hash: ballot.consensus_inputs_hash,
            agreeing_weight: ballot.agreeing_weight,
            total_weight: ballot.total_weight,
            threshold_bps: ballot.threshold_bps,
            votes_cast: ballot.votes_cast,
            proposed,
            slot,
        });
        if proposed {
            emit_proposed(index);
        }
    } else if queued_before && try_propose(index, ballot, slot)? {
        // A late vote retries a queued proposal for free.
        emit_submitted(ballot, slot);
        emit_proposed(index);
    }
    Ok(())
}

#[derive(Accounts)]
pub struct SubmitIndexBallot<'info> {
    /// Anyone.
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [FEE_INDEX_SEED, fee_index.pool.as_ref()], bump = fee_index.bump)]
    pub fee_index: Box<Account<'info, FeeIndex>>,

    #[account(
        seeds = [INDEX_OPERATORS_SEED, fee_index.key().as_ref()],
        bump = index_operators.bump,
        has_one = fee_index,
        constraint = fee_index.publisher == index_operators.key() @ EpochError::ConsensusOff,
    )]
    pub index_operators: Box<Account<'info, IndexOperators>>,

    #[account(
        mut,
        seeds = [INDEX_BALLOT_SEED, fee_index.key().as_ref(), &ballot.epoch.to_le_bytes()],
        bump = ballot.bump,
        has_one = fee_index,
    )]
    pub ballot: Box<Account<'info, IndexBallot>>,
}

/// Writes a queued consensus into `FeeIndex` once it can take it (the earlier
/// proposal was finalized, or the admin widened `max_move_bps`). Fails with
/// `post_index`'s errors while it still cannot.
pub fn submit_index_ballot(ctx: Context<SubmitIndexBallot>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let index = &mut ctx.accounts.fee_index;
    let ballot = &mut ctx.accounts.ballot;
    require!(ballot.has_consensus(), EpochError::NoConsensus);
    require!(ballot.proposed_slot == 0, EpochError::BallotAlreadyProposed);
    let at = slot.max(1);
    index.propose(
        ballot.epoch,
        ballot.consensus_value,
        ballot.consensus_inputs_hash,
        at,
    )?;
    ballot.proposed_slot = at;
    emit_submitted(ballot, at);
    emit_proposed(index);
    Ok(())
}

#[derive(Accounts)]
pub struct ResetIndexBallot<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,

    #[account(seeds = [FEE_INDEX_SEED, pool.key().as_ref()], bump = fee_index.bump, has_one = pool)]
    pub fee_index: Box<Account<'info, FeeIndex>>,

    #[account(
        seeds = [INDEX_OPERATORS_SEED, fee_index.key().as_ref()],
        bump = index_operators.bump,
        has_one = fee_index,
    )]
    pub index_operators: Box<Account<'info, IndexOperators>>,

    #[account(
        mut,
        seeds = [INDEX_BALLOT_SEED, fee_index.key().as_ref(), &ballot.epoch.to_le_bytes()],
        bump = ballot.bump,
        has_one = fee_index,
    )]
    pub ballot: Box<Account<'info, IndexBallot>>,
}

/// Opens a new round with the current registry, clearing every vote: the way
/// out of a stuck vote (after removing a dead operator or widening the
/// tolerance) or of a queued value the admin will not let through. The admin
/// cannot choose a value. A proposal pending in `FeeIndex` must be vetoed
/// first; a final epoch cannot be reset.
pub fn reset_index_ballot(ctx: Context<ResetIndexBallot>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let ballot_key = ctx.accounts.ballot.key();
    let registry = &ctx.accounts.index_operators;
    let ballot = &mut ctx.accounts.ballot;
    match ballot.status(&ctx.accounts.fee_index) {
        BallotStatus::Voting | BallotStatus::Queued | BallotStatus::Vetoed => {}
        BallotStatus::Proposed | BallotStatus::Settled => {
            return err!(EpochError::BallotNotResettable);
        }
    }
    ballot.round = ballot
        .round
        .checked_add(1)
        .ok_or(EpochError::MathOverflow)?;
    ballot.open_round(registry, slot)?;
    emit_opened(ballot, ballot_key, true, slot);
    Ok(())
}

#[derive(Accounts)]
pub struct CloseIndexBallot<'info> {
    /// Anyone.
    pub cranker: Signer<'info>,

    #[account(seeds = [FEE_INDEX_SEED, fee_index.pool.as_ref()], bump = fee_index.bump)]
    pub fee_index: Box<Account<'info, FeeIndex>>,

    #[account(
        mut,
        seeds = [INDEX_BALLOT_SEED, fee_index.key().as_ref(), &ballot.epoch.to_le_bytes()],
        bump = ballot.bump,
        has_one = fee_index,
        has_one = payer @ EpochError::BallotPayerMismatch,
        close = payer,
    )]
    pub ballot: Box<Account<'info, IndexBallot>>,

    /// CHECK: receives the rent; must be the ballot's payer (`has_one`).
    #[account(mut)]
    pub payer: UncheckedAccount<'info>,
}

/// Closes a ballot whose epoch is final (or was passed over by a later final
/// epoch), so nothing can be proposed for it again, and refunds its payer.
/// Its votes stay in the events.
pub fn close_index_ballot(ctx: Context<CloseIndexBallot>) -> Result<()> {
    let ballot = &ctx.accounts.ballot;
    require!(
        ballot.status(&ctx.accounts.fee_index) == BallotStatus::Settled,
        EpochError::BallotNotClosable
    );
    emit!(IndexBallotClosed {
        fee_index: ballot.fee_index,
        epoch: ballot.epoch,
        round: ballot.round,
        payer: ballot.payer,
        lamports: ballot.to_account_info().lamports(),
    });
    Ok(())
}

/// Writes the ballot's consensus into `FeeIndex` if it can take it now.
/// `slot.max(1)`: a proposed slot of 0 would read as "queued".
fn try_propose(index: &mut FeeIndex, ballot: &mut IndexBallot, slot: u64) -> Result<bool> {
    if index
        .proposal_blocker(ballot.epoch, ballot.consensus_value)
        .is_some()
    {
        return Ok(false);
    }
    let at = slot.max(1);
    index.propose(
        ballot.epoch,
        ballot.consensus_value,
        ballot.consensus_inputs_hash,
        at,
    )?;
    ballot.proposed_slot = at;
    Ok(true)
}

fn emit_opened(ballot: &IndexBallot, ballot_key: Pubkey, reset: bool, slot: u64) {
    emit!(IndexBallotOpened {
        fee_index: ballot.fee_index,
        ballot: ballot_key,
        epoch: ballot.epoch,
        round: ballot.round,
        operators: ballot
            .snapshot()
            .iter()
            .map(|v| IndexOperator {
                key: v.operator,
                weight: v.weight,
            })
            .collect(),
        total_weight: ballot.total_weight,
        threshold_bps: ballot.threshold_bps,
        tolerance_bps: ballot.tolerance_bps,
        reset,
        slot,
    });
}

fn emit_submitted(ballot: &IndexBallot, slot: u64) {
    emit!(IndexBallotSubmitted {
        fee_index: ballot.fee_index,
        epoch: ballot.epoch,
        round: ballot.round,
        value: ballot.consensus_value,
        slot,
    });
}

/// The same event `post_index` emits, so every reader of proposals keeps
/// working.
fn emit_proposed(index: &FeeIndex) {
    emit!(IndexProposed {
        epoch: index.proposed_epoch,
        value: index.proposed_value,
        inputs_hash: index.proposed_inputs_hash,
        slot: index.proposed_slot,
    });
}
