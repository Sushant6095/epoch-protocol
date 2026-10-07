use anchor_lang::{prelude::*, system_program};

use crate::{
    constants::*,
    errors::EpochError,
    events::{ScoreRefreshed, ScoreUpdated},
    math::*,
    state::*,
};

#[derive(Accounts)]
pub struct RefreshScore<'info> {
    /// Anyone; the keeper does it every epoch after the copies.
    pub cranker: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        seeds = [SCORE_CONFIG_SEED, pool.key().as_ref()],
        bump = score_config.bump,
        has_one = pool,
    )]
    pub score_config: Account<'info, ScoreConfig>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position.vote.as_ref()],
        bump = position.bump,
        has_one = pool,
    )]
    pub position: Account<'info, ValidatorPosition>,

    #[account(
        mut,
        seeds = [HISTORY_SEED, position.vote.as_ref()],
        bump = history.load()?.bump,
    )]
    pub history: AccountLoader<'info, ValidatorHistory>,
    // Remaining accounts, when `score_config.market_maker` is set: exactly
    // `HEDGE_EPOCHS_AHEAD` accounts, the operator's swap PDA on the market
    // maker's quote for each of epochs current + 1 … current + 5, in order,
    // whether or not the swap exists. The program derives each address, so a
    // caller cannot leave a hedge out.
}

/// The Epoch Score from on-chain history, permissionless.
///
/// - credits: earned ÷ TVC maximum over the last `credits_window_epochs`
///   finished epochs, rescaled so `credits_reference_bps` reads as the cluster
///   average;
/// - commission: the highest inflation or MEV commission (and block-revenue
///   commission when counted) over the window and the current epoch;
/// - delinquent: the newest vote more than 128 slots behind the copy;
/// - epochs active: the longer of the vote account's epochs with credits and
///   the epochs since onboarding;
/// - superminority: the scorer's bit for the current epoch;
/// - hedged: computed here from the operator's swaps (the hedge rule).
///
/// Refuses stale history: no vote copy this epoch, one older than
/// `max_copy_age_slots`, or no stake info for this epoch.
pub fn refresh_score<'info>(ctx: Context<'info, RefreshScore<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let schedule = EpochSchedule::get()?;
    let epoch = clock.epoch;
    let cfg = &ctx.accounts.score_config;
    let position = &mut ctx.accounts.position;
    require!(
        position.status != PositionStatus::Released,
        EpochError::PositionNotActive
    );

    let coverage = hedge_coverage(
        ctx.remaining_accounts,
        ctx.program_id,
        &cfg.market_maker,
        &position.operator,
        epoch,
    )?;

    let mut h = ctx.accounts.history.load_mut()?;
    require_keys_eq!(h.vote, position.vote, EpochError::HistoryVoteMismatch);

    // ── Freshness ──
    let now = *h
        .entry(epoch)
        .filter(|e| e.has(SOURCE_VOTE))
        .ok_or(EpochError::HistoryStale)?;
    require!(
        clock.slot.saturating_sub(h.last_vote_copy_slot) <= u64::from(cfg.max_copy_age_slots),
        EpochError::HistoryStale
    );
    let superminority = match now.superminority {
        0 => false,
        1 => true,
        _ => return err!(EpochError::StakeInfoStale),
    };

    // ── Credits over the finished-epoch window ──
    let first = epoch.saturating_sub(u64::from(cfg.credits_window_epochs));
    let mut samples = [CreditsSample {
        earned: None,
        max: 0,
    }; MAX_CREDITS_WINDOW_EPOCHS as usize];
    let mut n = 0usize;
    for e in first..epoch {
        samples[n] = CreditsSample {
            earned: h.entry(e).and_then(|x| known_u64(x.epoch_credits)),
            max: max_credits(schedule.get_slots_in_epoch(e)).ok_or(EpochError::MathOverflow)?,
        };
        n += 1;
    }
    let raw_bps = credits_ratio_raw_bps(&samples[..n]).ok_or(EpochError::HistoryStale)?;
    let credits_ratio_bps = credits_ratio_vs_reference(raw_bps, cfg.credits_reference_bps)
        .ok_or(EpochError::InvalidScoreConfig)?;

    // ── Commission: the highest over the window and now ──
    let count_block = cfg.count_block_commission;
    let commission_bps =
        highest_commission((first..=epoch).filter_map(|e| h.entry(e)).flat_map(|x| {
            [
                known_u16(x.inflation_commission_bps),
                known_u16(x.mev_commission_bps),
                if count_block {
                    known_u16(x.block_commission_bps)
                } else {
                    None
                },
            ]
        }))
        .unwrap_or(BPS_DENOMINATOR as u16);

    let delinquent = is_delinquent(known_u64(now.last_voted_slot), h.last_vote_copy_slot);
    let epochs_active = epochs_active(h.epochs_voted, epoch, position.onboarded_epoch);

    // ── Hedge: the history can only raise the bar ──
    let window = REVENUE_WINDOW as u64;
    let history_average = if epoch >= window {
        let mut sum = 0u64;
        let mut complete = true;
        for e in epoch - window..epoch {
            match h.entry(e).and_then(|x| known_u64(x.revenue_lamports)) {
                Some(r) => sum = sum.saturating_add(r),
                None => {
                    complete = false;
                    break;
                }
            }
        }
        complete.then(|| average(sum, window))
    } else {
        None
    };
    let position_average = average(
        position.trailing_revenue(),
        u64::from(position.revenue_count).min(window),
    );
    let required = hedge_required_notional(position_average, history_average)
        .ok_or(EpochError::MathOverflow)?;
    let hedged = cfg.market_maker != Pubkey::default() && is_hedged(&coverage, required);

    let score = compute_score(&ScoreInputs {
        credits_ratio_bps,
        commission_bps,
        epochs_active,
        delinquent,
        superminority,
    });

    position.score = score;
    position.hedged = hedged;
    position.last_scored_epoch = epoch;

    h.score = score;
    h.credits_ratio_bps = credits_ratio_bps;
    h.credits_ratio_raw_bps = raw_bps;
    h.commission_bps = commission_bps;
    h.epochs_active = epochs_active;
    h.hedge_required_notional = required;
    h.refreshed_epoch = epoch;
    h.refreshed_slot = clock.slot;
    h.set_flag(SCORE_FLAG_DELINQUENT, delinquent);
    h.set_flag(SCORE_FLAG_SUPERMINORITY, superminority);
    h.set_flag(SCORE_FLAG_HEDGED, hedged);
    h.set_flag(SCORE_FLAG_SCORED, true);

    emit!(ScoreUpdated {
        vote: position.vote,
        epoch,
        score,
        hedged,
    });
    emit!(ScoreRefreshed {
        pool: ctx.accounts.pool.key(),
        vote: position.vote,
        epoch,
        score,
        credits_ratio_bps,
        credits_ratio_raw_bps: raw_bps,
        commission_bps,
        epochs_active,
        delinquent,
        superminority,
        hedged,
        hedge_required_notional: required,
    });
    Ok(())
}

/// Receive-fixed notional the operator holds against the market maker's quote
/// for each of the next `HEDGE_EPOCHS_AHEAD` epochs. With no market maker
/// configured nobody is hedged and no accounts are read.
fn hedge_coverage<'info>(
    accounts: &'info [AccountInfo<'info>],
    program_id: &Pubkey,
    market_maker: &Pubkey,
    operator: &Pubkey,
    epoch: u64,
) -> Result<[u64; HEDGE_EPOCHS_AHEAD as usize]> {
    let mut coverage = [0u64; HEDGE_EPOCHS_AHEAD as usize];
    if *market_maker == Pubkey::default() {
        return Ok(coverage);
    }
    require!(
        accounts.len() == HEDGE_EPOCHS_AHEAD as usize,
        EpochError::InvalidHedgeAccount
    );
    for (i, info) in accounts.iter().enumerate() {
        let target = epoch
            .checked_add(i as u64 + 1)
            .ok_or(EpochError::MathOverflow)?;
        let (quote, _) = Pubkey::find_program_address(
            &[QUOTE_SEED, market_maker.as_ref(), &target.to_le_bytes()],
            program_id,
        );
        let (expected, _) = Pubkey::find_program_address(
            &[SWAP_SEED, quote.as_ref(), operator.as_ref()],
            program_id,
        );
        require_keys_eq!(info.key(), expected, EpochError::InvalidHedgeAccount);
        if *info.owner == *program_id {
            let swap = Account::<SwapPosition>::try_from(info)?;
            require!(
                swap.quote == quote && swap.taker == *operator && swap.epoch == target,
                EpochError::InvalidHedgeAccount
            );
            if swap.side == Side::ReceiveFixed && !swap.settled {
                coverage[i] = swap.notional;
            }
        } else {
            // No swap (never opened, or closed): an empty system account.
            require!(
                *info.owner == system_program::ID && info.data_is_empty(),
                EpochError::InvalidHedgeAccount
            );
        }
    }
    Ok(coverage)
}
