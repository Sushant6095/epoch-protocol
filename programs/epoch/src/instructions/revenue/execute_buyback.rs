//! One buyback slice: swap part of the escrow for the revenue token on its
//! Meteora venue and burn what it buys.
//!
//! **Sandwich resistance.** A slice runs at a known time, so it must be
//! unprofitable to sandwich even for the cranker, who builds the transaction.
//! Three bounds hold whatever the cranker passes:
//!
//! 1. **Small, scheduled slices.** The epoch's budget (the escrow when its
//!    first slice runs) is spread over `slices_per_epoch` slices (12) across
//!    the first `window_slots` slots (~1 hour); each slice spends
//!    `what is left / slices left`.
//! 2. **Impact cap.** A slice may not raise the pool price by more than
//!    `max_impact_bps` (100 = 1%), computed on the pool's state at execution.
//!    A front-runner profits from the price move our buy causes on top of
//!    theirs, but pays the pool fee twice (in and out); with the move capped
//!    at about twice the fee (Epoch's pools charge 1%), the sandwich loses.
//!    Liquidity, not the price level, sets the move, so pushing the price
//!    first does not loosen the cap.
//! 3. **Min-out floor.** `min_amount_out` must be at least the pool's
//!    fee-free output for the slice minus `max_slippage_bps` (300), so a
//!    cranker cannot pass a token minimum such as 1; the pool enforces it.
//!
//! Residual risk: the floor is computed from the state the transaction sees,
//! so it does not detect a front-run inside the same block; bound 2 is what
//! makes one unprofitable, and it needs the pool fee to be at least half of
//! `max_impact_bps`. The program enforces that: registration records the
//! lowest fee the curve and the graduated pool can charge (`fee_floor_bps`,
//! from the DBC config) and `max_impact_bps` can never exceed twice it. It
//! assumes Meteora's operator does not lower a live pool's fee below its
//! config's.

use anchor_lang::prelude::*;
use solana_sysvar::epoch_schedule::EpochSchedule;

use super::venue::{SwapIo, Venue, VenueAccounts};
use crate::{
    constants::*,
    errors::EpochError,
    events::BuybackExecuted,
    math::{min_out_floor, slice_budget, slice_timing, SliceTiming},
    meteora_account::SplTokenAccount,
    outbound::{
        meteora::invoke_swap,
        system::{create_pda_account, transfer_from_pda},
        token::{burn, close_account, initialize_account3_ix},
    },
    state::*,
};

#[derive(Accounts)]
pub struct ExecuteBuyback<'info> {
    /// Anyone may run a due slice. Fronts the rent of the slice's wrapped-SOL
    /// account and gets it back in the same instruction.
    #[account(mut)]
    pub cranker: Signer<'info>,

    /// The lending pool: pausing it stops buybacks too.
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    #[account(
        mut,
        seeds = [REVENUE_TOKEN_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.bump,
        has_one = pool,
    )]
    pub revenue_token: Account<'info, RevenueToken>,

    /// Pays the swap (its `payer`) and owns both token accounts.
    #[account(
        mut,
        seeds = [BUYBACK_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.escrow_bump,
    )]
    pub buyback_escrow: SystemAccount<'info>,

    /// CHECK: `["buyback_wsol", vote]`, created, swapped from and closed here.
    #[account(
        mut,
        seeds = [BUYBACK_WSOL_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.wsol_bump,
    )]
    pub buyback_wsol: UncheckedAccount<'info>,

    /// CHECK: `["buyback_tokens", vote]`, the escrow's token account (checked in the handler).
    #[account(
        mut,
        seeds = [BUYBACK_TOKENS_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.tokens_bump,
    )]
    pub buyback_tokens: UncheckedAccount<'info>,

    /// CHECK: the revenue token's mint (supply drops by every burn).
    #[account(mut, address = revenue_token.mint @ EpochError::InvalidVenueAccount)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: wrapped SOL.
    #[account(address = NATIVE_MINT @ EpochError::InvalidVenueAccount)]
    pub wsol_mint: UncheckedAccount<'info>,

    /// CHECK: the token's DBC config (the curve; unused once graduated).
    #[account(address = revenue_token.dbc_config @ EpochError::InvalidVenueAccount)]
    pub dbc_config: UncheckedAccount<'info>,

    /// CHECK: the DBC pool, or the DAMM v2 pool once graduated (checked in `Venue::load`).
    #[account(mut)]
    pub venue_pool: UncheckedAccount<'info>,

    /// CHECK: the pool's vault of the revenue token (DBC base / DAMM v2 token A).
    #[account(mut)]
    pub venue_token_vault: UncheckedAccount<'info>,

    /// CHECK: the pool's wrapped-SOL vault (DBC quote / DAMM v2 token B).
    #[account(mut)]
    pub venue_quote_vault: UncheckedAccount<'info>,

    /// CHECK: the venue's `["pool_authority"]`.
    pub venue_pool_authority: UncheckedAccount<'info>,

    /// CHECK: the venue's `["__event_authority"]`.
    pub venue_event_authority: UncheckedAccount<'info>,

    /// CHECK: the DBC or DAMM v2 program.
    pub venue_program: UncheckedAccount<'info>,

    /// CHECK: the SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    // Remaining accounts: at most one, the instructions sysvar, forwarded to
    // the venue for pools whose rate limiter asks for it.
}

/// Run buyback slice `slice` of the current epoch with the cranker's
/// `min_amount_out` (from a fresh quote). See the module docs for the
/// protocol-side bounds. Stopped by the pool's pause (`Paused`) as well as
/// the token's own `FLAG_BUYBACKS_PAUSED`.
pub fn execute_buyback<'info>(
    ctx: Context<'info, ExecuteBuyback<'info>>,
    slice: u8,
    min_amount_out: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let epoch = clock.epoch;
    let rent = Rent::get()?;

    // ── Schedule ──
    {
        require!(!ctx.accounts.pool.paused, EpochError::Paused);
        let rt = &ctx.accounts.revenue_token;
        require!(!rt.buybacks_paused(), EpochError::BuybacksPaused);
        require!(min_amount_out > 0, EpochError::MinOutTooLow);
        let (_, slot_index) = EpochSchedule::get()?.get_epoch_and_slot_index(clock.slot);
        match slice_timing(slot_index, slice, rt.slices_per_epoch, rt.window_slots)
            .ok_or(EpochError::InvalidSlice)?
        {
            SliceTiming::Due => {}
            SliceTiming::NotDue => return err!(EpochError::SliceNotDue),
            SliceTiming::WindowClosed => return err!(EpochError::OutsideBuybackWindow),
        }
        if rt.in_term(epoch) {
            // This epoch's share must be in the escrow before the budget is fixed.
            require!(rt.last_share_epoch == epoch, EpochError::SweepPending);
        }
    }

    // ── Budget ──
    let escrow_info = ctx.accounts.buyback_escrow.to_account_info();
    let escrow_floor = rent.minimum_balance(0);
    let escrow_available = escrow_info.lamports().saturating_sub(escrow_floor);
    let rt = &mut ctx.accounts.revenue_token;
    if rt.buyback_epoch != epoch {
        rt.buyback_epoch = epoch;
        rt.epoch_budget = escrow_available;
        rt.epoch_spent = 0;
        rt.slices_done = 0;
    }
    let bit = 1u32 << slice;
    require!(rt.slices_done & bit == 0, EpochError::SliceAlreadyExecuted);
    let mut amount = slice_budget(
        rt.epoch_budget,
        rt.epoch_spent,
        rt.slices_per_epoch,
        rt.slices_done,
        escrow_available,
    )
    .ok_or(EpochError::MathOverflow)?;

    // ── Venue, impact cap, floor ──
    let venue_accounts = VenueAccounts {
        program: &ctx.accounts.venue_program.to_account_info(),
        pool_authority: &ctx.accounts.venue_pool_authority.to_account_info(),
        event_authority: &ctx.accounts.venue_event_authority.to_account_info(),
        pool: &ctx.accounts.venue_pool.to_account_info(),
        token_vault: &ctx.accounts.venue_token_vault.to_account_info(),
        quote_vault: &ctx.accounts.venue_quote_vault.to_account_info(),
        dbc_config: &ctx.accounts.dbc_config.to_account_info(),
    };
    let venue = Venue::load(rt, &venue_accounts)?;
    venue.require_trading()?;
    amount = amount.min(venue.max_quote_in(rt.max_impact_bps)?);
    require!(amount > 0, EpochError::NothingToBuy);
    let fill = venue.fee_free_buy(amount)?;
    require!(fill.output > 0, EpochError::NothingToBuy);
    let floor = min_out_floor(fill.output, rt.max_slippage_bps).ok_or(EpochError::MathOverflow)?;
    require!(min_amount_out >= floor, EpochError::MinOutTooLow);

    let tokens = SplTokenAccount::load(&ctx.accounts.buyback_tokens)?;
    require_keys_eq!(tokens.mint, rt.mint, EpochError::InvalidVenueAccount);
    require_keys_eq!(
        tokens.owner,
        escrow_info.key(),
        EpochError::InvalidVenueAccount
    );

    // ── Wrap `amount` SOL in a one-slice token account ──
    let vote = rt.vote;
    let escrow_seeds: &[&[u8]] = &[BUYBACK_SEED, vote.as_ref(), &[rt.escrow_bump]];
    let wsol_seeds: &[&[u8]] = &[BUYBACK_WSOL_SEED, vote.as_ref(), &[rt.wsol_bump]];
    let cranker = ctx.accounts.cranker.to_account_info();
    let wsol = ctx.accounts.buyback_wsol.to_account_info();
    let system_program = ctx.accounts.system_program.to_account_info();
    let token_program = ctx.accounts.token_program.to_account_info();
    let cranker_paid = create_pda_account(
        &cranker,
        &wsol,
        TOKEN_ACCOUNT_LEN,
        &TOKEN_PROGRAM_ID,
        &system_program,
        wsol_seeds,
    )?;
    transfer_from_pda(
        &escrow_info,
        &wsol,
        &system_program,
        amount,
        &[escrow_seeds],
    )?;
    anchor_lang::solana_program::program::invoke(
        &initialize_account3_ix(wsol.key, &NATIVE_MINT, escrow_info.key),
        &[
            wsol.clone(),
            ctx.accounts.wsol_mint.to_account_info(),
            token_program.clone(),
        ],
    )?;
    let wsol_before = SplTokenAccount::load(&wsol)?.amount;

    // ── Swap ──
    let io = SwapIo {
        input: wsol.key(),
        output: ctx.accounts.buyback_tokens.key(),
        mint: rt.mint,
        payer: escrow_info.key(),
    };
    let ix = venue.swap_ix(&venue_accounts, &io, amount, min_amount_out);
    let extra: Vec<AccountInfo<'info>> = match ctx.remaining_accounts {
        [] => vec![],
        [sysvar] if *sysvar.key == INSTRUCTIONS_SYSVAR_ID => {
            vec![sysvar.clone()]
        }
        _ => return err!(EpochError::InvalidVenueAccount),
    };
    let mut infos = vec![
        venue_accounts.pool_authority.clone(),
        venue_accounts.pool.clone(),
        wsol.clone(),
        ctx.accounts.buyback_tokens.to_account_info(),
        venue_accounts.token_vault.clone(),
        venue_accounts.quote_vault.clone(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.wsol_mint.to_account_info(),
        escrow_info.clone(),
        token_program.clone(),
        venue_accounts.event_authority.clone(),
        venue_accounts.program.clone(),
    ];
    if venue.kind() == BuybackVenue::Dbc {
        infos.push(venue_accounts.dbc_config.clone());
    }
    invoke_swap(ix, &infos, &extra, &[escrow_seeds])?;

    // ── Settle: what the swap used and returned ──
    let wsol_after = SplTokenAccount::load(&wsol)?.amount;
    let spent = wsol_before
        .checked_sub(wsol_after)
        .ok_or(EpochError::MathOverflow)?;
    let held = SplTokenAccount::load(&ctx.accounts.buyback_tokens)?.amount;
    let bought = held
        .checked_sub(tokens.amount)
        .ok_or(EpochError::MathOverflow)?;
    require!(bought >= min_amount_out, EpochError::BuybackOutputTooLow);

    // Unwrap: every lamport of the slice account goes back to the escrow, then
    // the cranker gets its rent back.
    close_account(
        &wsol,
        &escrow_info,
        &escrow_info,
        &token_program,
        &[escrow_seeds],
    )?;
    transfer_from_pda(
        &escrow_info,
        &cranker,
        &system_program,
        cranker_paid,
        &[escrow_seeds],
    )?;

    // Burn everything the buyback account holds.
    burn(
        &ctx.accounts.buyback_tokens.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &escrow_info,
        held,
        &token_program,
        &[escrow_seeds],
    )?;

    let rt = &mut ctx.accounts.revenue_token;
    rt.slices_done |= bit;
    rt.epoch_spent = rt.epoch_spent.saturating_add(spent);
    rt.total_spent = rt.total_spent.saturating_add(spent);
    rt.total_bought = rt.total_bought.saturating_add(bought);
    rt.total_burned = rt.total_burned.saturating_add(held);
    rt.buyback_count = rt.buyback_count.saturating_add(1);

    emit!(BuybackExecuted {
        vote,
        mint: rt.mint,
        venue: venue.kind(),
        epoch,
        slice,
        lamports_in: spent,
        tokens_bought: bought,
        tokens_burned: held,
        min_amount_out,
        fee_free_out: fill.output,
        escrow_balance: escrow_info.lamports().saturating_sub(escrow_floor),
    });
    Ok(())
}
