//! Market-maker quotes: a fixed index level for one future epoch, backed by
//! collateral equal to the maker's maximum loss.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    cpi::system::transfer_from_signer,
    errors::EpochError,
    events::{QuotePosted, QuoteWithdrawn},
    math::bps_of,
    state::*,
};

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct PostQuote<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(seeds = [FEE_INDEX_SEED, pool.key().as_ref()], bump = fee_index.bump, has_one = pool)]
    pub fee_index: Account<'info, FeeIndex>,

    #[account(
        init,
        payer = maker,
        space = 8 + FeeQuote::INIT_SPACE,
        seeds = [QUOTE_SEED, maker.key().as_ref(), &epoch.to_le_bytes()],
        bump,
    )]
    pub quote: Account<'info, FeeQuote>,

    pub system_program: Program<'info, System>,
}

/// Post a quote for `epoch`. Collateral = `max_notional × max_move_bps`,
/// held on the quote account above its rent.
pub fn post_quote(
    ctx: Context<PostQuote>,
    epoch: u64,
    fixed_rate: u64,
    max_notional: u64,
    max_move_bps: u16,
    expiry_slot: u64,
) -> Result<()> {
    require!(!ctx.accounts.pool.paused, EpochError::Paused);
    require!(fixed_rate > 0 && max_notional > 0, EpochError::ZeroAmount);
    require!(
        max_move_bps > 0 && u64::from(max_move_bps) <= BPS_DENOMINATOR,
        EpochError::BpsOutOfRange
    );
    let clock = Clock::get()?;
    require!(epoch > clock.epoch, EpochError::QuoteEpochMismatch);
    require!(
        epoch > ctx.accounts.fee_index.epoch,
        EpochError::QuoteEpochMismatch
    );
    require!(expiry_slot > clock.slot, EpochError::QuoteExpired);

    let collateral = bps_of(max_notional, max_move_bps).ok_or(EpochError::MathOverflow)?;
    require!(collateral > 0, EpochError::ZeroAmount);
    transfer_from_signer(
        &ctx.accounts.maker.to_account_info(),
        &ctx.accounts.quote.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        collateral,
    )?;

    let quote = &mut ctx.accounts.quote;
    quote.pool = ctx.accounts.pool.key();
    quote.maker = ctx.accounts.maker.key();
    quote.epoch = epoch;
    quote.fixed_rate = fixed_rate;
    quote.max_notional = max_notional;
    quote.filled_notional = 0;
    quote.max_move_bps = max_move_bps;
    quote.expiry_slot = expiry_slot;
    quote.collateral = collateral;
    quote.locked_collateral = 0;
    quote.open_swaps = 0;
    quote.bump = ctx.bumps.quote;

    emit!(QuotePosted {
        quote: quote.key(),
        maker: quote.maker,
        epoch,
        fixed_rate,
        max_notional,
        max_move_bps,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawQuote<'info> {
    #[account(mut)]
    pub maker: Signer<'info>,

    #[account(seeds = [FEE_INDEX_SEED, quote.pool.as_ref()], bump = fee_index.bump)]
    pub fee_index: Account<'info, FeeIndex>,

    #[account(
        mut,
        close = maker,
        seeds = [QUOTE_SEED, maker.key().as_ref(), &quote.epoch.to_le_bytes()],
        bump = quote.bump,
        has_one = maker @ EpochError::NotMaker,
    )]
    pub quote: Account<'info, FeeQuote>,
}

/// Take the collateral back once the quote has expired or its epoch has
/// started, and no swap is still open against it. Closing the account
/// returns rent plus whatever collateral is left after settlements.
pub fn withdraw_quote(ctx: Context<WithdrawQuote>) -> Result<()> {
    let quote = &ctx.accounts.quote;
    require!(quote.open_swaps == 0, EpochError::QuoteHasOpenSwaps);
    let clock = Clock::get()?;
    let expired = clock.slot >= quote.expiry_slot || clock.epoch >= quote.epoch;
    require!(expired, EpochError::QuoteNotExpired);
    emit!(QuoteWithdrawn {
        quote: quote.key(),
        maker: quote.maker,
        epoch: quote.epoch,
        lamports: quote.to_account_info().lamports(),
    });
    Ok(())
}
