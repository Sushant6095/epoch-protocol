//! Fee swaps: a taker trades the Fee Index for one epoch against a maker's
//! fixed rate. Payoff is linear in `(index − fixed) / fixed` and clipped to
//! ±`max_move_bps` of notional, so both sides post exactly their maximum
//! loss as collateral and settlement can never fail for lack of funds.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::{SwapOpened, SwapSettled},
    math::bps_of,
    outbound::system::transfer_from_signer,
    state::*,
};

#[derive(Accounts)]
pub struct OpenSwap<'info> {
    #[account(mut)]
    pub taker: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(seeds = [FEE_INDEX_SEED, pool.key().as_ref()], bump = fee_index.bump, has_one = pool)]
    pub fee_index: Account<'info, FeeIndex>,

    #[account(
        mut,
        seeds = [QUOTE_SEED, quote.maker.as_ref(), &quote.epoch.to_le_bytes()],
        bump = quote.bump,
        has_one = pool,
    )]
    pub quote: Account<'info, FeeQuote>,

    #[account(
        init,
        payer = taker,
        space = 8 + SwapPosition::INIT_SPACE,
        seeds = [SWAP_SEED, quote.key().as_ref(), taker.key().as_ref()],
        bump,
    )]
    pub swap: Account<'info, SwapPosition>,

    pub system_program: Program<'info, System>,
}

pub fn open_swap(ctx: Context<OpenSwap>, notional: u64, side: Side) -> Result<()> {
    require!(!ctx.accounts.pool.paused, EpochError::Paused);
    require!(notional > 0, EpochError::ZeroAmount);
    let clock = Clock::get()?;
    let quote = &mut ctx.accounts.quote;
    require!(clock.slot < quote.expiry_slot, EpochError::QuoteExpired);
    // Trading closes when the quoted epoch begins.
    require!(clock.epoch < quote.epoch, EpochError::QuoteExpired);
    let filled = quote
        .filled_notional
        .checked_add(notional)
        .ok_or(EpochError::MathOverflow)?;
    require!(
        filled <= quote.max_notional,
        EpochError::QuoteCapacityExceeded
    );

    let collateral = bps_of(notional, quote.max_move_bps).ok_or(EpochError::MathOverflow)?;
    require!(collateral > 0, EpochError::ZeroAmount);
    transfer_from_signer(
        &ctx.accounts.taker.to_account_info(),
        &ctx.accounts.swap.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        collateral,
    )?;

    quote.filled_notional = filled;
    quote.locked_collateral = quote
        .locked_collateral
        .checked_add(collateral)
        .ok_or(EpochError::MathOverflow)?;
    require!(
        quote.locked_collateral <= quote.collateral,
        EpochError::QuoteCapacityExceeded
    );
    quote.open_swaps = quote.open_swaps.saturating_add(1);

    let swap = &mut ctx.accounts.swap;
    swap.quote = quote.key();
    swap.taker = ctx.accounts.taker.key();
    swap.epoch = quote.epoch;
    swap.side = side;
    swap.notional = notional;
    swap.fixed_rate = quote.fixed_rate;
    swap.max_move_bps = quote.max_move_bps;
    swap.collateral = collateral;
    swap.settled = false;
    swap.pnl = 0;
    swap.bump = ctx.bumps.swap;

    emit!(SwapOpened {
        quote: quote.key(),
        swap: swap.key(),
        taker: swap.taker,
        epoch: swap.epoch,
        side,
        notional,
        fixed_rate: swap.fixed_rate,
        collateral,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SettleSwap<'info> {
    /// Anyone may settle once the index for the epoch is final.
    pub cranker: Signer<'info>,

    #[account(seeds = [FEE_INDEX_SEED, quote.pool.as_ref()], bump = fee_index.bump)]
    pub fee_index: Account<'info, FeeIndex>,

    #[account(
        mut,
        seeds = [QUOTE_SEED, quote.maker.as_ref(), &quote.epoch.to_le_bytes()],
        bump = quote.bump,
    )]
    pub quote: Account<'info, FeeQuote>,

    /// CHECK: the taker; receives collateral plus profit and the swap's rent.
    #[account(mut, address = swap.taker @ EpochError::PayoutMismatch)]
    pub taker: UncheckedAccount<'info>,

    #[account(
        mut,
        close = taker,
        seeds = [SWAP_SEED, quote.key().as_ref(), taker.key().as_ref()],
        bump = swap.bump,
        has_one = quote,
    )]
    pub swap: Account<'info, SwapPosition>,
}

/// Taker profit in lamports for a settled index, clipped to ±max loss.
pub fn taker_pnl(
    side: Side,
    notional: u64,
    fixed_rate: u64,
    index_value: u64,
    max_loss: u64,
) -> Option<i64> {
    if fixed_rate == 0 {
        return None;
    }
    let diff = i128::from(index_value) - i128::from(fixed_rate);
    let raw = i128::from(notional)
        .checked_mul(diff)?
        .checked_div(i128::from(fixed_rate))?;
    let signed = match side {
        Side::PayFixed => raw,
        Side::ReceiveFixed => -raw,
    };
    let cap = i128::from(max_loss);
    i64::try_from(signed.clamp(-cap, cap)).ok()
}

pub fn settle_swap(ctx: Context<SettleSwap>) -> Result<()> {
    let swap = &mut ctx.accounts.swap;
    require!(!swap.settled, EpochError::AlreadySettled);
    let index_value = ctx
        .accounts
        .fee_index
        .value_for(swap.epoch)
        .ok_or(EpochError::IndexMissing)?;

    let pnl = taker_pnl(
        swap.side,
        swap.notional,
        swap.fixed_rate,
        index_value,
        swap.collateral,
    )
    .ok_or(EpochError::MathOverflow)?;

    // Move lamports between the two program-owned accounts. The taker's
    // account is closed afterwards, which sends everything on it (collateral
    // ± pnl, plus rent) to the taker.
    let quote_info = ctx.accounts.quote.to_account_info();
    let swap_info = swap.to_account_info();
    if pnl > 0 {
        let amount = pnl as u64;
        **quote_info.try_borrow_mut_lamports()? -= amount;
        **swap_info.try_borrow_mut_lamports()? += amount;
    } else if pnl < 0 {
        let amount = pnl.unsigned_abs();
        **swap_info.try_borrow_mut_lamports()? -= amount;
        **quote_info.try_borrow_mut_lamports()? += amount;
    }

    let quote = &mut ctx.accounts.quote;
    quote.locked_collateral = quote.locked_collateral.saturating_sub(swap.collateral);
    if pnl > 0 {
        quote.collateral = quote
            .collateral
            .checked_sub(pnl as u64)
            .ok_or(EpochError::MathOverflow)?;
    } else {
        quote.collateral = quote
            .collateral
            .checked_add(pnl.unsigned_abs())
            .ok_or(EpochError::MathOverflow)?;
    }
    quote.open_swaps = quote.open_swaps.saturating_sub(1);

    swap.settled = true;
    swap.pnl = pnl;

    emit!(SwapSettled {
        swap: swap.key(),
        epoch: swap.epoch,
        index_value,
        taker_pnl: pnl,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pay_fixed_gains_when_index_rises() {
        // notional 1 SOL, fixed 10,000, index 11,000 → +10% = 0.1 SOL
        assert_eq!(
            taker_pnl(Side::PayFixed, 1_000_000_000, 10_000, 11_000, 500_000_000),
            Some(100_000_000)
        );
        assert_eq!(
            taker_pnl(
                Side::ReceiveFixed,
                1_000_000_000,
                10_000,
                11_000,
                500_000_000
            ),
            Some(-100_000_000)
        );
    }

    #[test]
    fn payoff_is_clipped_to_max_loss_both_ways() {
        let max = 200_000_000; // 20% of notional
        assert_eq!(
            taker_pnl(Side::PayFixed, 1_000_000_000, 10_000, 30_000, max),
            Some(200_000_000)
        );
        assert_eq!(
            taker_pnl(Side::PayFixed, 1_000_000_000, 10_000, 1, max),
            Some(-200_000_000)
        );
        assert_eq!(
            taker_pnl(Side::ReceiveFixed, 1_000_000_000, 10_000, 30_000, max),
            Some(-200_000_000)
        );
    }

    #[test]
    fn flat_index_is_zero_and_zero_fixed_is_none() {
        assert_eq!(taker_pnl(Side::PayFixed, 5, 10_000, 10_000, 1), Some(0));
        assert_eq!(taker_pnl(Side::PayFixed, 5, 0, 10_000, 1), None);
    }
}
