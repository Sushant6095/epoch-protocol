//! The Fee Index operator registry: who votes on the index and how much each
//! vote weighs. Admin only; every change is an event and applies from the
//! next ballot round (open rounds keep their snapshot).

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::{
        IndexConsensusSet, IndexOperatorAdded, IndexOperatorRemoved, IndexOperatorWeightSet,
        IndexOperatorsInitialized,
    },
    state::*,
};

#[derive(Accounts)]
pub struct InitializeIndexOperators<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [FEE_INDEX_SEED, pool.key().as_ref()], bump = fee_index.bump, has_one = pool)]
    pub fee_index: Box<Account<'info, FeeIndex>>,

    #[account(
        init,
        payer = admin,
        space = 8 + IndexOperators::INIT_SPACE,
        seeds = [INDEX_OPERATORS_SEED, fee_index.key().as_ref()],
        bump,
    )]
    pub index_operators: Box<Account<'info, IndexOperators>>,

    pub system_program: Program<'info, System>,
}

/// Creates the empty registry and turns consensus on: `FeeIndex.publisher`
/// becomes the registry PDA, which no key can sign for, so from now on values
/// come from ballots (or from `post_index` by the sole operator of a
/// one-operator registry). Add operators in the same transaction.
pub fn initialize_index_operators(
    ctx: Context<InitializeIndexOperators>,
    threshold_bps: u16,
    tolerance_bps: u16,
) -> Result<()> {
    IndexOperators::check_params(threshold_bps, tolerance_bps)?;
    let registry_key = ctx.accounts.index_operators.key();
    let fee_index_key = ctx.accounts.fee_index.key();

    let registry = &mut ctx.accounts.index_operators;
    registry.fee_index = fee_index_key;
    registry.bump = ctx.bumps.index_operators;
    registry.threshold_bps = threshold_bps;
    registry.tolerance_bps = tolerance_bps;

    ctx.accounts.fee_index.publisher = registry_key;

    emit!(IndexOperatorsInitialized {
        fee_index: fee_index_key,
        index_operators: registry_key,
        threshold_bps,
        tolerance_bps,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ManageIndexOperator<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,

    #[account(seeds = [FEE_INDEX_SEED, pool.key().as_ref()], bump = fee_index.bump, has_one = pool)]
    pub fee_index: Box<Account<'info, FeeIndex>>,

    #[account(
        mut,
        seeds = [INDEX_OPERATORS_SEED, fee_index.key().as_ref()],
        bump = index_operators.bump,
        has_one = fee_index,
    )]
    pub index_operators: Box<Account<'info, IndexOperators>>,

    /// CHECK: the operator's voting key; only its address is stored.
    pub operator: UncheckedAccount<'info>,
}

/// Registers `operator` with `weight` (above zero; the total stays at most
/// 10,000).
pub fn add_index_operator(ctx: Context<ManageIndexOperator>, weight: u32) -> Result<()> {
    let operator = ctx.accounts.operator.key();
    let registry = &mut ctx.accounts.index_operators;
    registry.add(operator, weight)?;
    emit!(IndexOperatorAdded {
        fee_index: registry.fee_index,
        operator,
        weight,
        total_weight: registry.total_weight,
        operator_count: registry.operator_count,
    });
    Ok(())
}

/// Removes `operator`. Rounds already open keep it in their snapshot; the
/// admin can `reset_index_ballot` a stuck one.
pub fn remove_index_operator(ctx: Context<ManageIndexOperator>) -> Result<()> {
    let operator = ctx.accounts.operator.key();
    let registry = &mut ctx.accounts.index_operators;
    let weight = registry.remove(&operator)?;
    emit!(IndexOperatorRemoved {
        fee_index: registry.fee_index,
        operator,
        weight,
        total_weight: registry.total_weight,
        operator_count: registry.operator_count,
    });
    Ok(())
}

pub fn set_index_operator_weight(ctx: Context<ManageIndexOperator>, weight: u32) -> Result<()> {
    let operator = ctx.accounts.operator.key();
    let registry = &mut ctx.accounts.index_operators;
    let old_weight = registry.set_weight(&operator, weight)?;
    emit!(IndexOperatorWeightSet {
        fee_index: registry.fee_index,
        operator,
        old_weight,
        weight,
        total_weight: registry.total_weight,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetIndexConsensus<'info> {
    pub admin: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,

    #[account(seeds = [FEE_INDEX_SEED, pool.key().as_ref()], bump = fee_index.bump, has_one = pool)]
    pub fee_index: Box<Account<'info, FeeIndex>>,

    #[account(
        mut,
        seeds = [INDEX_OPERATORS_SEED, fee_index.key().as_ref()],
        bump = index_operators.bump,
        has_one = fee_index,
    )]
    pub index_operators: Box<Account<'info, IndexOperators>>,
}

/// Sets the threshold (5,001 to 10,000 bps of total weight) and the agreement
/// tolerance (0 to 1,000 bps of the weighted median).
pub fn set_index_consensus(
    ctx: Context<SetIndexConsensus>,
    threshold_bps: u16,
    tolerance_bps: u16,
) -> Result<()> {
    IndexOperators::check_params(threshold_bps, tolerance_bps)?;
    let registry = &mut ctx.accounts.index_operators;
    registry.threshold_bps = threshold_bps;
    registry.tolerance_bps = tolerance_bps;
    emit!(IndexConsensusSet {
        fee_index: registry.fee_index,
        threshold_bps,
        tolerance_bps,
    });
    Ok(())
}
