//! The Solana Fee Index as a self-published oracle: propose → dispute
//! window → finalize, with a hard bound on how far one epoch may move.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::{IndexFinalized, IndexProposed, IndexVetoed, ParamsUpdated},
    state::*,
};

#[derive(Accounts)]
pub struct InitializeIndex<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,

    #[account(
        init,
        payer = admin,
        space = 8 + FeeIndex::INIT_SPACE,
        seeds = [FEE_INDEX_SEED, pool.key().as_ref()],
        bump,
    )]
    pub fee_index: Account<'info, FeeIndex>,

    /// CHECK: the key allowed to propose values.
    pub publisher: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_index(
    ctx: Context<InitializeIndex>,
    dispute_window_slots: u64,
    max_move_bps: u16,
) -> Result<()> {
    require!(
        u64::from(max_move_bps) <= BPS_DENOMINATOR,
        EpochError::BpsOutOfRange
    );
    let index = &mut ctx.accounts.fee_index;
    index.pool = ctx.accounts.pool.key();
    index.publisher = ctx.accounts.publisher.key();
    index.bump = ctx.bumps.fee_index;
    index.dispute_window_slots = dispute_window_slots;
    index.max_move_bps = max_move_bps;
    emit!(ParamsUpdated {
        pool: ctx.accounts.pool.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ConfigureIndex<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [FEE_INDEX_SEED, pool.key().as_ref()], bump = fee_index.bump, has_one = pool)]
    pub fee_index: Account<'info, FeeIndex>,
    /// CHECK: the new publisher key.
    pub publisher: UncheckedAccount<'info>,
}

pub fn configure_index(
    ctx: Context<ConfigureIndex>,
    dispute_window_slots: u64,
    max_move_bps: u16,
) -> Result<()> {
    require!(
        u64::from(max_move_bps) <= BPS_DENOMINATOR,
        EpochError::BpsOutOfRange
    );
    let index = &mut ctx.accounts.fee_index;
    index.publisher = ctx.accounts.publisher.key();
    index.dispute_window_slots = dispute_window_slots;
    index.max_move_bps = max_move_bps;
    emit!(ParamsUpdated {
        pool: ctx.accounts.pool.key(),
    });
    Ok(())
}

/// `post_index`. Optional `remaining_accounts[0]`: the `IndexOperators`
/// registry, needed only when consensus is on (`fee_index.publisher` is the
/// registry PDA) and the signer is its sole operator. Kept out of the
/// `Accounts` struct so existing two-account callers work unchanged.
#[derive(Accounts)]
pub struct PostIndex<'info> {
    /// `fee_index.publisher`, or the sole operator of a one-operator registry.
    pub publisher: Signer<'info>,
    #[account(mut, seeds = [FEE_INDEX_SEED, fee_index.pool.as_ref()], bump = fee_index.bump)]
    pub fee_index: Account<'info, FeeIndex>,
}

/// Propose the index for `epoch`. Rejected outright if it moves more than
/// `max_move_bps` from the last finalized value; otherwise it waits out the
/// dispute window before anyone can finalize it. `inputs_hash` commits to
/// the per-slot inputs so the value can be recomputed from public data.
///
/// With operator consensus on, only the sole operator of a one-operator
/// registry may post this way (a one-vote ballot would reach consensus
/// anyway); with two or more operators, values come from ballots.
pub fn post_index(
    ctx: Context<PostIndex>,
    epoch: u64,
    value: u64,
    inputs_hash: [u8; 32],
) -> Result<()> {
    let signer = ctx.accounts.publisher.key();
    let index = &mut ctx.accounts.fee_index;
    if index.publisher != signer {
        let registry = ctx
            .remaining_accounts
            .first()
            .ok_or(EpochError::NotPublisher)?;
        require_keys_eq!(registry.key(), index.publisher, EpochError::NotPublisher);
        require_keys_eq!(*registry.owner, crate::ID, EpochError::NotPublisher);
        let data = registry.try_borrow_data()?;
        let operators = IndexOperators::try_deserialize(&mut &data[..])?;
        require_keys_eq!(operators.fee_index, index.key(), EpochError::NotPublisher);
        require!(
            operators.is_sole_operator(&signer),
            EpochError::NotPublisher
        );
    }

    let clock = Clock::get()?;
    if let Some(blocker) = FeeIndex::start_blocker(epoch, clock.epoch) {
        return Err(blocker.into());
    }
    let slot = clock.slot;
    index.propose(epoch, value, inputs_hash, slot)?;

    emit!(IndexProposed {
        epoch,
        value,
        inputs_hash,
        slot,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct FinalizeIndex<'info> {
    /// Anyone may finalize once the window has passed.
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [FEE_INDEX_SEED, fee_index.pool.as_ref()], bump = fee_index.bump)]
    pub fee_index: Account<'info, FeeIndex>,
}

pub fn finalize_index(ctx: Context<FinalizeIndex>) -> Result<()> {
    let index = &mut ctx.accounts.fee_index;
    require!(index.has_proposal, EpochError::NoProposal);
    let slot = Clock::get()?.slot;
    require!(
        slot >= index
            .proposed_slot
            .saturating_add(index.dispute_window_slots),
        EpochError::DisputeWindowOpen
    );

    if index.finalized_slot > 0 {
        let previous = IndexPoint {
            epoch: index.epoch,
            value: index.value,
        };
        index.push_history(previous);
    }
    index.epoch = index.proposed_epoch;
    index.value = index.proposed_value;
    index.inputs_hash = index.proposed_inputs_hash;
    index.finalized_slot = slot;
    index.has_proposal = false;

    emit!(IndexFinalized {
        epoch: index.epoch,
        value: index.value,
        inputs_hash: index.inputs_hash,
        slot,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct VetoIndex<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [FEE_INDEX_SEED, pool.key().as_ref()], bump = fee_index.bump, has_one = pool)]
    pub fee_index: Account<'info, FeeIndex>,
}

/// Drop a pending proposal. Allowed until someone finalizes it.
pub fn veto_index(ctx: Context<VetoIndex>) -> Result<()> {
    let index = &mut ctx.accounts.fee_index;
    require!(index.has_proposal, EpochError::NoProposal);
    let (epoch, value) = (index.proposed_epoch, index.proposed_value);
    index.has_proposal = false;
    index.proposed_epoch = 0;
    index.proposed_value = 0;
    index.proposed_inputs_hash = [0; 32];
    index.proposed_slot = 0;
    emit!(IndexVetoed { epoch, value });
    Ok(())
}
