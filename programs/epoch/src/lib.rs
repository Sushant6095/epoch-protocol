//! Epoch: the revenue desk for Solana validators.
//!
//! An Epoch PDA holds each onboarded validator's vote-account withdraw
//! authority. Validators draw SOL advances against their commission and
//! repay at source every epoch; lenders fund the advances through senior and
//! junior tranches; the program publishes the Solana Fee Index and settles
//! fee swaps against it.
//!
//! Validators can also sell a share of their revenue for a term as a token
//! launched on a Meteora Dynamic Bonding Curve; every sweep takes the share
//! off the top and permissionless slices buy the token back and burn it.
//! Epoch is the curves' partner: permissionless cranks claim the partner
//! treasury's Meteora fees into the pool as lender income and burn the token
//! side.
//!
//! Layout: `state/` (accounts), `math/` (pure, tested arithmetic),
//! `cpi/` (vote, system, SPL Token and Meteora calls), `instructions/` (one
//! file each), `vote_account.rs` (vote state reader), `meteora_account.rs`
//! (Meteora pool and SPL account readers). `lib.rs` only dispatches.

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod jito_account;
pub mod math;
pub mod meteora_account;
pub mod state;
#[cfg(test)]
mod test_fixtures;
pub mod vote_account;

use instructions::*;
use state::*;

// Placeholder until `anchor keys sync` (Phase 5) writes the deployed program ID.
declare_id!("11111111111111111111111111111111");

#[program]
pub mod epoch {
    use super::*;

    // ── Pool: admin ──
    pub fn initialize_pool(ctx: Context<InitializePool>, params: PoolParams) -> Result<()> {
        instructions::initialize_pool(ctx, params)
    }

    pub fn update_params(ctx: Context<AdminOnly>, params: PoolParams) -> Result<()> {
        instructions::update_params(ctx, params)
    }

    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        instructions::set_paused(ctx, paused)
    }

    pub fn set_roles(ctx: Context<SetRoles>) -> Result<()> {
        instructions::set_roles(ctx)
    }

    // ── Pool: lenders ──
    pub fn deposit(ctx: Context<Deposit>, tranche: Tranche, assets: u64) -> Result<()> {
        instructions::deposit(ctx, tranche, assets)
    }

    pub fn request_withdraw(ctx: Context<RequestWithdraw>, shares: u64) -> Result<()> {
        instructions::request_withdraw(ctx, shares)
    }

    pub fn cancel_withdraw(ctx: Context<CancelWithdraw>) -> Result<()> {
        instructions::cancel_withdraw(ctx)
    }

    pub fn process_withdrawal(ctx: Context<ProcessWithdrawal>) -> Result<()> {
        instructions::process_withdrawal(ctx)
    }

    pub fn accrue(ctx: Context<Accrue>) -> Result<()> {
        instructions::accrue(ctx)
    }

    // ── Credit ──
    pub fn onboard_validator(ctx: Context<OnboardValidator>) -> Result<()> {
        instructions::onboard_validator(ctx)
    }

    pub fn set_collectors(ctx: Context<SetCollectors>) -> Result<()> {
        instructions::set_collectors(ctx)
    }

    pub fn update_score(ctx: Context<UpdateScore>, update: ScoreUpdate) -> Result<()> {
        instructions::update_score(ctx, update)
    }

    pub fn post_bond(ctx: Context<Bond>, lamports: u64) -> Result<()> {
        instructions::post_bond(ctx, lamports)
    }

    pub fn withdraw_bond(ctx: Context<Bond>, lamports: u64) -> Result<()> {
        instructions::withdraw_bond(ctx, lamports)
    }

    pub fn request_advance(ctx: Context<RequestAdvance>, amount: u64) -> Result<()> {
        instructions::request_advance(ctx, amount)
    }

    pub fn sweep(ctx: Context<Sweep>) -> Result<()> {
        instructions::sweep(ctx)
    }

    pub fn mark_default(ctx: Context<MarkDefault>) -> Result<()> {
        instructions::mark_default(ctx)
    }

    pub fn release_validator(ctx: Context<ReleaseValidator>) -> Result<()> {
        instructions::release_validator(ctx)
    }

    pub fn update_commission(
        ctx: Context<UpdateCommission>,
        kind: u8,
        commission_bps: u16,
    ) -> Result<()> {
        instructions::update_commission(ctx, kind, commission_bps)
    }

    pub fn update_identity(ctx: Context<UpdateIdentity>) -> Result<()> {
        instructions::update_identity(ctx)
    }

    // ── Fee Index ──
    pub fn initialize_index(
        ctx: Context<InitializeIndex>,
        dispute_window_slots: u64,
        max_move_bps: u16,
    ) -> Result<()> {
        instructions::initialize_index(ctx, dispute_window_slots, max_move_bps)
    }

    pub fn configure_index(
        ctx: Context<ConfigureIndex>,
        dispute_window_slots: u64,
        max_move_bps: u16,
    ) -> Result<()> {
        instructions::configure_index(ctx, dispute_window_slots, max_move_bps)
    }

    pub fn post_index(
        ctx: Context<PostIndex>,
        epoch: u64,
        value: u64,
        inputs_hash: [u8; 32],
    ) -> Result<()> {
        instructions::post_index(ctx, epoch, value, inputs_hash)
    }

    pub fn finalize_index(ctx: Context<FinalizeIndex>) -> Result<()> {
        instructions::finalize_index(ctx)
    }

    pub fn veto_index(ctx: Context<VetoIndex>) -> Result<()> {
        instructions::veto_index(ctx)
    }

    // ── Fee Index operator consensus ──
    pub fn initialize_index_operators(
        ctx: Context<InitializeIndexOperators>,
        threshold_bps: u16,
        tolerance_bps: u16,
    ) -> Result<()> {
        instructions::initialize_index_operators(ctx, threshold_bps, tolerance_bps)
    }

    pub fn add_index_operator(ctx: Context<ManageIndexOperator>, weight: u32) -> Result<()> {
        instructions::add_index_operator(ctx, weight)
    }

    pub fn remove_index_operator(ctx: Context<ManageIndexOperator>) -> Result<()> {
        instructions::remove_index_operator(ctx)
    }

    pub fn set_index_operator_weight(ctx: Context<ManageIndexOperator>, weight: u32) -> Result<()> {
        instructions::set_index_operator_weight(ctx, weight)
    }

    pub fn set_index_consensus(
        ctx: Context<SetIndexConsensus>,
        threshold_bps: u16,
        tolerance_bps: u16,
    ) -> Result<()> {
        instructions::set_index_consensus(ctx, threshold_bps, tolerance_bps)
    }

    pub fn cast_index_vote(
        ctx: Context<CastIndexVote>,
        epoch: u64,
        value: u64,
        inputs_hash: [u8; 32],
    ) -> Result<()> {
        instructions::cast_index_vote(ctx, epoch, value, inputs_hash)
    }

    pub fn submit_index_ballot(ctx: Context<SubmitIndexBallot>) -> Result<()> {
        instructions::submit_index_ballot(ctx)
    }

    pub fn reset_index_ballot(ctx: Context<ResetIndexBallot>) -> Result<()> {
        instructions::reset_index_ballot(ctx)
    }

    pub fn close_index_ballot(ctx: Context<CloseIndexBallot>) -> Result<()> {
        instructions::close_index_ballot(ctx)
    }

    // ── Fee Market ──
    pub fn post_quote(
        ctx: Context<PostQuote>,
        epoch: u64,
        fixed_rate: u64,
        max_notional: u64,
        max_move_bps: u16,
        expiry_slot: u64,
    ) -> Result<()> {
        instructions::post_quote(
            ctx,
            epoch,
            fixed_rate,
            max_notional,
            max_move_bps,
            expiry_slot,
        )
    }

    pub fn withdraw_quote(ctx: Context<WithdrawQuote>) -> Result<()> {
        instructions::withdraw_quote(ctx)
    }

    pub fn open_swap(ctx: Context<OpenSwap>, notional: u64, side: Side) -> Result<()> {
        instructions::open_swap(ctx, notional, side)
    }

    pub fn settle_swap(ctx: Context<SettleSwap>) -> Result<()> {
        instructions::settle_swap(ctx)
    }

    // ── Revenue tokens (Meteora) ──
    pub fn register_revenue_token(
        ctx: Context<RegisterRevenueToken>,
        share_bps: u16,
        term_epochs: u16,
    ) -> Result<()> {
        instructions::register_revenue_token(ctx, share_bps, term_epochs)
    }

    pub fn sync_revenue_token_pool(ctx: Context<SyncRevenueTokenPool>) -> Result<()> {
        instructions::sync_revenue_token_pool(ctx)
    }

    pub fn execute_buyback<'info>(
        ctx: Context<'info, ExecuteBuyback<'info>>,
        slice: u8,
        min_amount_out: u64,
    ) -> Result<()> {
        instructions::execute_buyback(ctx, slice, min_amount_out)
    }

    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        instructions::redeem(ctx, amount)
    }

    pub fn configure_revenue_token(
        ctx: Context<ConfigureRevenueToken>,
        params: BuybackParams,
    ) -> Result<()> {
        instructions::configure_revenue_token(ctx, params)
    }

    pub fn close_revenue_token(ctx: Context<CloseRevenueToken>) -> Result<()> {
        instructions::close_revenue_token(ctx)
    }

    // ── Partner treasury claims (Meteora) ──
    pub fn claim_partner_trading_fee(ctx: Context<ClaimPartnerTradingFee>) -> Result<()> {
        instructions::claim_partner_trading_fee(ctx)
    }

    pub fn claim_partner_surplus(ctx: Context<ClaimPartnerQuote>) -> Result<()> {
        instructions::claim_partner_surplus(ctx)
    }

    pub fn claim_partner_migration_fee(ctx: Context<ClaimPartnerQuote>) -> Result<()> {
        instructions::claim_partner_migration_fee(ctx)
    }

    pub fn burn_leftover(ctx: Context<BurnLeftover>) -> Result<()> {
        instructions::burn_leftover(ctx)
    }

    pub fn claim_treasury_lp_fee(ctx: Context<ClaimTreasuryLpFee>) -> Result<()> {
        instructions::claim_treasury_lp_fee(ctx)
    }

    // ── Validator history and the permissionless score ──
    pub fn init_validator_history(ctx: Context<InitValidatorHistory>) -> Result<()> {
        instructions::init_validator_history(ctx)
    }

    pub fn copy_vote_account(ctx: Context<CopyVoteAccount>) -> Result<()> {
        instructions::copy_vote_account(ctx)
    }

    pub fn copy_tip_distribution_account(
        ctx: Context<CopyTipDistribution>,
        epoch: u64,
    ) -> Result<()> {
        instructions::copy_tip_distribution_account(ctx, epoch)
    }

    pub fn copy_priority_fee_distribution(
        ctx: Context<CopyPriorityFeeDistribution>,
        epoch: u64,
    ) -> Result<()> {
        instructions::copy_priority_fee_distribution(ctx, epoch)
    }

    pub fn update_stake_info(
        ctx: Context<UpdateStakeInfo>,
        epoch: u64,
        activated_stake_lamports: u64,
        rank: u32,
        superminority: bool,
    ) -> Result<()> {
        instructions::update_stake_info(ctx, epoch, activated_stake_lamports, rank, superminority)
    }

    pub fn refresh_score<'info>(ctx: Context<'info, RefreshScore<'info>>) -> Result<()> {
        instructions::refresh_score(ctx)
    }

    pub fn configure_scoring(ctx: Context<ConfigureScoring>, params: ScoringParams) -> Result<()> {
        instructions::configure_scoring(ctx, params)
    }
}
