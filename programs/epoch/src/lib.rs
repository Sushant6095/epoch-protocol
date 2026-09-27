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
}
