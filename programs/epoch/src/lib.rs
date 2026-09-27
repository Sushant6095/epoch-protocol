//! Epoch: the revenue desk for Solana validators.
//!
//! An Epoch PDA holds each onboarded validator's vote-account withdraw
//! authority. Validators draw SOL advances against their commission and
//! repay at source every epoch; lenders fund the advances through senior and
//! junior tranches; the program publishes the Solana Fee Index and settles
//! fee swaps against it.
//!
//! Layout: `state/` (accounts), `math/` (pure, tested arithmetic),
//! `cpi/` (vote and system program calls), `instructions/` (one file each),
//! `vote_account.rs` (vote state reader). `lib.rs` only dispatches.

#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;
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
}
