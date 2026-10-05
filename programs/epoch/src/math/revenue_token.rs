//! Revenue-token arithmetic: the sweep waterfall with a revenue share, the
//! buyback slice schedule and budget, and the `redeem` payout.

use super::{bps_of, mul_div, split_sweep};

/// One sweep's gross revenue, three ways.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct ShareSplit {
    /// To the buyback escrow.
    pub share: u64,
    /// To the pool (advance repayment).
    pub remit: u64,
    /// To the validator's payout account.
    pub to_operator: u64,
}

/// The sweep waterfall with a revenue share of `share_bps`.
///
/// Normally the share comes **off the top**: `share = gross × share_bps`, then
/// the existing advance waterfall runs on `gross − share`. When the open
/// advance predates the token (`senior_advance`), its lenders underwrote the
/// gross revenue, so it keeps its claim: the remittance is computed on
/// `gross` first and the share is taken from what would have gone to the
/// validator (up to the same `gross × share_bps`).
///
/// `share_bps == 0` is exactly `split_sweep`. `share + remit + to_operator ==
/// gross` always.
pub fn split_sweep_with_share(
    gross: u64,
    share_bps: u16,
    outstanding: u64,
    remit_bps: u16,
    full_remit: bool,
    senior_advance: bool,
) -> Option<ShareSplit> {
    let wanted = bps_of(gross, share_bps)?;
    if senior_advance {
        let s = split_sweep(gross, outstanding, remit_bps, full_remit)?;
        let share = wanted.min(s.to_operator);
        Some(ShareSplit {
            share,
            remit: s.remit,
            to_operator: s.to_operator - share,
        })
    } else {
        let net = gross.checked_sub(wanted)?;
        let s = split_sweep(net, outstanding, remit_bps, full_remit)?;
        Some(ShareSplit {
            share: wanted,
            remit: s.remit,
            to_operator: s.to_operator,
        })
    }
}

/// Slot index (from the epoch's first slot) at which slice `slice` is due:
/// `slice × window_slots / slices`. `None` for an out-of-range slice.
pub fn slice_due_slot(slice: u8, slices: u8, window_slots: u32) -> Option<u64> {
    if slices == 0 || slice >= slices {
        return None;
    }
    Some(u64::from(slice) * u64::from(window_slots) / u64::from(slices))
}

/// Whether slice `slice` may run `slot_index` slots into the epoch.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum SliceTiming {
    Due,
    /// Before the slice's slot.
    NotDue,
    /// At or after `window_slots`.
    WindowClosed,
}

/// Slices run inside `[0, window_slots)`; slice `i` from `slice_due_slot(i)`
/// on (a late slice can still run until the window closes). `None` for an
/// out-of-range slice.
pub fn slice_timing(
    slot_index: u64,
    slice: u8,
    slices: u8,
    window_slots: u32,
) -> Option<SliceTiming> {
    let due = slice_due_slot(slice, slices, window_slots)?;
    Some(if slot_index >= u64::from(window_slots) {
        SliceTiming::WindowClosed
    } else if slot_index < due {
        SliceTiming::NotDue
    } else {
        SliceTiming::Due
    })
}

/// What slice `n` of the epoch may spend: what is left of the epoch's budget
/// divided by the slices still to run (the last one takes the rest), never
/// more than the escrow holds now (redemptions can shrink it mid-epoch).
pub fn slice_budget(
    epoch_budget: u64,
    epoch_spent: u64,
    slices: u8,
    slices_done: u32,
    escrow_available: u64,
) -> Option<u64> {
    let done = slices_done.count_ones();
    let remaining = u32::from(slices).checked_sub(done)?;
    if remaining == 0 {
        return Some(0);
    }
    let left = epoch_budget.saturating_sub(epoch_spent);
    Some((left / u64::from(remaining)).min(escrow_available))
}

/// SOL paid for burning `amount` of `circulating` tokens: the same share of
/// the escrow, rounded down (in favour of the holders who stay).
pub fn redeem_payout(escrow_available: u64, amount: u64, circulating: u64) -> Option<u64> {
    if amount > circulating {
        return None;
    }
    mul_div(escrow_available, amount, circulating)
}

/// The tokens that can claim the escrow: the mint supply less what Epoch's
/// own accounts hold (the buyback token account and the treasury's, both
/// burned by the next slice or claim). Tokens in a Meteora pool count: anyone
/// can buy and redeem them, and leaving them out would let a holder shrink
/// the denominator by selling into the pool, redeem at the inflated rate and
/// buy back for the price of the pool fee.
pub fn circulating_supply(supply: u64, held_by_epoch: u64) -> u64 {
    supply.saturating_sub(held_by_epoch)
}

/// Meteora fee numerators are over 10⁹, so one bps is 10⁵.
pub const FEE_NUMERATOR_PER_BPS: u64 = 100_000;
const ONE_Q64: u128 = 1 << 64;

/// The lowest base fee a DBC curve can charge, as a numerator over 10⁹
/// (DBC's `get_min_base_fee_numerator`). Fee scheduler (`mode` 0 linear,
/// 1 exponential): the fee after all `number_of_period` periods,
/// `cliff − n × reduction` or `cliff × (1 − reduction / 10⁴)ⁿ` (rounded
/// down, so the floor is never overstated). Rate limiter (2): the cliff; it
/// only adds to large trades. `None` for an unknown mode.
pub fn dbc_min_base_fee_numerator(
    mode: u8,
    cliff_fee_numerator: u64,
    number_of_period: u16,
    reduction_factor: u64,
) -> Option<u64> {
    match mode {
        0 => Some(
            cliff_fee_numerator
                .saturating_sub(u64::from(number_of_period).saturating_mul(reduction_factor)),
        ),
        1 => {
            if number_of_period == 0 || reduction_factor == 0 {
                return Some(cliff_fee_numerator);
            }
            if reduction_factor >= crate::constants::BPS_DENOMINATOR {
                return Some(0);
            }
            // base = 1 − reduction / 10⁴ in Q64, strictly below 1.
            let base = ONE_Q64 - (u128::from(reduction_factor) << 64) / 10_000;
            let (mut result, mut b, mut n) = (ONE_Q64, base, number_of_period);
            while n > 0 {
                if n & 1 == 1 {
                    result = result.checked_mul(b)? >> 64;
                }
                b = b.checked_mul(b)? >> 64;
                n >>= 1;
            }
            u64::try_from(u128::from(cliff_fee_numerator).checked_mul(result)? >> 64).ok()
        }
        2 => Some(cliff_fee_numerator),
        _ => None,
    }
}

/// The base fee, in bps, of the DAMM v2 pool a DBC config graduates to:
/// options 0–5 are fixed tiers; option 6 (customizable) is fixed when its
/// base fee mode is a time scheduler (DBC ignores scheduler parameters for
/// migrated pools). `None` for a fee that falls with the market cap (modes
/// 3 and 4) or an unknown option.
pub fn dbc_migrated_fee_bps(option: u8, custom_fee_bps: u16, custom_mode: u8) -> Option<u16> {
    match option {
        0 => Some(25),
        1 => Some(30),
        2 => Some(100),
        3 => Some(200),
        4 => Some(400),
        5 => Some(600),
        6 if custom_mode <= 1 => Some(custom_fee_bps),
        _ => None,
    }
}

/// The lowest fee, in bps, a buyback's venue can charge over the token's
/// life: the curve's floor or the graduated pool's fee, whichever is lower.
pub fn venue_fee_floor_bps(curve_min_fee_numerator: u64, migrated_fee_bps: u16) -> u16 {
    let curve_bps = curve_min_fee_numerator / FEE_NUMERATOR_PER_BPS;
    // ≤ migrated_fee_bps, so it fits.
    curve_bps.min(u64::from(migrated_fee_bps)) as u16
}

/// The largest `max_impact_bps` that keeps sandwiching a slice unprofitable:
/// a sandwich earns at most the price move the slice causes on the
/// attacker's position and pays the venue fee on the way in and out, so the
/// move may be at most twice the lowest fee. Capped at `MAX_MAX_IMPACT_BPS`.
pub fn max_impact_bound(fee_floor_bps: u16) -> u16 {
    fee_floor_bps
        .saturating_mul(2)
        .min(crate::constants::MAX_MAX_IMPACT_BPS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_comes_off_the_top() {
        // 10 SOL gross, 10% share, advance at 50% remit with plenty owed.
        let s = split_sweep_with_share(10_000, 1_000, 1_000_000, 5_000, false, false).unwrap();
        assert_eq!(
            s,
            ShareSplit {
                share: 1_000,
                remit: 4_500,
                to_operator: 4_500
            }
        );
        // No advance: share, then everything to the operator.
        let s = split_sweep_with_share(10_000, 1_000, 0, 0, false, false).unwrap();
        assert_eq!((s.share, s.remit, s.to_operator), (1_000, 0, 9_000));
        // Defaulted (full remit): the share is still first.
        let s = split_sweep_with_share(10_000, 2_500, 1_000_000, 5_000, true, false).unwrap();
        assert_eq!((s.share, s.remit, s.to_operator), (2_500, 7_500, 0));
        // share_bps 0 is the old waterfall.
        let s = split_sweep_with_share(10_000, 0, 1_000_000, 5_000, false, false).unwrap();
        assert_eq!((s.share, s.remit, s.to_operator), (0, 5_000, 5_000));
    }

    #[test]
    fn a_senior_advance_is_repaid_first() {
        // The advance predates the token: remit 50% of gross, share from the rest.
        let s = split_sweep_with_share(10_000, 1_000, 1_000_000, 5_000, false, true).unwrap();
        assert_eq!((s.share, s.remit, s.to_operator), (1_000, 5_000, 4_000));
        // Defaulted senior advance: everything to the pool, nothing left to share.
        let s = split_sweep_with_share(10_000, 1_000, 1_000_000, 5_000, true, true).unwrap();
        assert_eq!((s.share, s.remit, s.to_operator), (0, 10_000, 0));
        // Small operator remainder caps the share.
        let s = split_sweep_with_share(10_000, 5_000, 1_000_000, 8_000, false, true).unwrap();
        assert_eq!((s.share, s.remit, s.to_operator), (2_000, 8_000, 0));
    }

    #[test]
    fn split_always_sums_to_gross() {
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        for _ in 0..2_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let gross = x >> (x % 64);
            let share_bps = (x % 5_001) as u16;
            let remit_bps = ((x >> 20) % 10_001) as u16;
            let outstanding = x.rotate_left(17) >> ((x >> 8) % 64);
            for (full, senior) in [(false, false), (true, false), (false, true), (true, true)] {
                let s =
                    split_sweep_with_share(gross, share_bps, outstanding, remit_bps, full, senior)
                        .unwrap();
                assert_eq!(s.share + s.remit + s.to_operator, gross);
                assert!(s.share <= bps_of(gross, share_bps).unwrap());
                assert!(s.remit <= outstanding);
            }
        }
        // Overflow-free at the extremes.
        let s = split_sweep_with_share(u64::MAX, 5_000, u64::MAX, 10_000, false, false).unwrap();
        assert_eq!(s.share + s.remit + s.to_operator, u64::MAX);
    }

    #[test]
    fn slices_are_spread_over_the_window() {
        assert_eq!(slice_due_slot(0, 12, 9_000), Some(0));
        assert_eq!(slice_due_slot(1, 12, 9_000), Some(750));
        assert_eq!(slice_due_slot(11, 12, 9_000), Some(8_250));
        assert_eq!(slice_due_slot(12, 12, 9_000), None);
        assert_eq!(slice_due_slot(0, 0, 9_000), None);
        assert_eq!(slice_due_slot(2, 3, 10), Some(6));
    }

    #[test]
    fn the_window_opens_each_slice_in_turn_and_then_closes() {
        use SliceTiming::*;
        assert_eq!(slice_timing(0, 0, 12, 9_000), Some(Due));
        assert_eq!(slice_timing(749, 1, 12, 9_000), Some(NotDue));
        assert_eq!(slice_timing(750, 1, 12, 9_000), Some(Due));
        // A late slice may still run while the window is open...
        assert_eq!(slice_timing(8_999, 1, 12, 9_000), Some(Due));
        // ...but nothing runs once it closes.
        assert_eq!(slice_timing(9_000, 11, 12, 9_000), Some(WindowClosed));
        assert_eq!(slice_timing(431_999, 0, 12, 9_000), Some(WindowClosed));
        assert_eq!(slice_timing(0, 12, 12, 9_000), None);
        // One slot per slice at the smallest window.
        assert_eq!(slice_timing(3, 3, 4, 4), Some(Due));
        assert_eq!(slice_timing(4, 3, 4, 4), Some(WindowClosed));
    }

    #[test]
    fn slice_budget_divides_what_is_left() {
        // 12 SOL over 12 slices: 1 SOL each.
        assert_eq!(slice_budget(12_000, 0, 12, 0, 12_000), Some(1_000));
        // Five done, 5 spent, 7 left over 7 slices.
        assert_eq!(slice_budget(12_000, 5_000, 12, 0b11111, 7_000), Some(1_000));
        // A partial fill left more: the remaining slices pick it up.
        assert_eq!(slice_budget(12_000, 4_000, 12, 0b11111, 8_000), Some(1_142));
        // The last slice takes the rest.
        assert_eq!(
            slice_budget(12_000, 11_500, 12, (1 << 11) - 1, 500),
            Some(500)
        );
        // Capped by the escrow (a redemption ran mid-epoch).
        assert_eq!(slice_budget(12_000, 0, 12, 0, 600), Some(600));
        // All slices done.
        assert_eq!(slice_budget(12_000, 0, 12, (1 << 12) - 1, 12_000), Some(0));
        // Spent past the budget (donations, rounding): nothing more.
        assert_eq!(slice_budget(100, 150, 4, 1, 500), Some(0));
    }

    #[test]
    fn redeem_is_pro_rata_and_rounds_down() {
        assert_eq!(redeem_payout(1_000, 250, 1_000), Some(250));
        assert_eq!(redeem_payout(1_000, 1, 3), Some(333));
        assert_eq!(redeem_payout(1_000, 1_001, 1_000), None);
        assert_eq!(redeem_payout(0, 5, 10), Some(0));
        assert_eq!(redeem_payout(1, 0, 0), None);
        assert_eq!(redeem_payout(u64::MAX, u64::MAX, u64::MAX), Some(u64::MAX));
    }

    /// The review's redeem finding: with pool balances excluded, selling into
    /// the pool before redeeming raised the payout per token. With only
    /// Epoch's own accounts excluded, the pool balance does not enter the
    /// denominator, so the same round trip pays exactly the fair share.
    #[test]
    fn selling_into_the_pool_no_longer_inflates_a_redemption() {
        let (supply, escrow) = (1_000_000u64, 10_000_000u64);
        let (pool_before, attacker) = (300_000u64, 400_000u64);
        // Old rule: circulating = supply − pool balance (− Epoch accounts).
        let old = |pool: u64| supply - pool;
        // Fair: the attacker redeems 100k of its tokens without touching the pool.
        let fair_old = redeem_payout(escrow, 100_000, old(pool_before)).unwrap();
        // Attack: sell 300k into the pool first, redeem the other 100k.
        let inflated = redeem_payout(escrow, 100_000, old(pool_before + 300_000)).unwrap();
        assert!(
            inflated > fair_old + fair_old / 2,
            "{inflated} vs {fair_old}"
        );
        let _ = attacker;
        // New rule: the pool balance does not move the denominator.
        let new_before = circulating_supply(supply, 0);
        let new_after = circulating_supply(supply, 0);
        assert_eq!(new_before, new_after);
        assert_eq!(
            redeem_payout(escrow, 100_000, new_after),
            redeem_payout(escrow, 100_000, new_before)
        );
        // Every token gets the same rate whatever the order of redemptions.
        let first = redeem_payout(escrow, 250_000, supply).unwrap();
        let second = redeem_payout(escrow - first, 250_000, supply - 250_000).unwrap();
        assert_eq!(first, second);
        // Epoch's own balances are excluded, never below zero.
        assert_eq!(circulating_supply(1_000, 300), 700);
        assert_eq!(circulating_supply(1_000, 5_000), 0);
    }

    #[test]
    fn dbc_fee_floors() {
        // Flat fee (Epoch's preset: a linear scheduler with no periods).
        assert_eq!(
            dbc_min_base_fee_numerator(0, 10_000_000, 0, 0),
            Some(10_000_000)
        );
        // Linear: 5% falling 0.1% per period over 40 periods ends at 1%.
        assert_eq!(
            dbc_min_base_fee_numerator(0, 50_000_000, 40, 1_000_000),
            Some(10_000_000)
        );
        // A schedule that would go negative floors at zero.
        assert_eq!(
            dbc_min_base_fee_numerator(0, 5_000_000, 10, 1_000_000),
            Some(0)
        );
        // Exponential: 50% × (1 − 10%)^10 = 17.43%; rounded down.
        let exp = dbc_min_base_fee_numerator(1, 500_000_000, 10, 1_000).unwrap();
        assert!(
            (174_339_000..=174_339_220).contains(&exp),
            "exponential floor {exp}"
        );
        assert_eq!(
            dbc_min_base_fee_numerator(1, 500_000_000, 0, 1_000),
            Some(500_000_000)
        );
        assert_eq!(
            dbc_min_base_fee_numerator(1, 500_000_000, 3, 0),
            Some(500_000_000)
        );
        assert_eq!(
            dbc_min_base_fee_numerator(1, 500_000_000, 3, 10_000),
            Some(0)
        );
        // The longest schedule stays finite and never above the cliff.
        let long = dbc_min_base_fee_numerator(1, 990_000_000, u16::MAX, 1).unwrap();
        assert!(long < 990_000_000);
        // Rate limiter: the cliff. Unknown modes are refused.
        assert_eq!(
            dbc_min_base_fee_numerator(2, 2_500_000, 7, 9),
            Some(2_500_000)
        );
        assert_eq!(dbc_min_base_fee_numerator(3, 2_500_000, 0, 0), None);
    }

    #[test]
    fn migrated_pool_fees_and_the_impact_bound() {
        let tiers: Vec<_> = (0..=5).map(|o| dbc_migrated_fee_bps(o, 0, 0)).collect();
        assert_eq!(tiers, [25, 30, 100, 200, 400, 600].map(Some).to_vec());
        assert_eq!(dbc_migrated_fee_bps(6, 10, 0), Some(10));
        assert_eq!(dbc_migrated_fee_bps(6, 250, 1), Some(250));
        // Market-cap schedulers can fall below the configured fee.
        assert_eq!(dbc_migrated_fee_bps(6, 250, 3), None);
        assert_eq!(dbc_migrated_fee_bps(6, 250, 4), None);
        assert_eq!(dbc_migrated_fee_bps(7, 0, 0), None);
        // The floor is the lower of curve and pool, in whole bps (rounded down).
        assert_eq!(venue_fee_floor_bps(10_000_000, 100), 100);
        assert_eq!(venue_fee_floor_bps(2_500_000, 10), 10);
        assert_eq!(venue_fee_floor_bps(2_599_999, 600), 25);
        // Twice the floor, capped.
        assert_eq!(max_impact_bound(100), 200);
        assert_eq!(max_impact_bound(25), 50);
        assert_eq!(max_impact_bound(4), 8);
        assert_eq!(max_impact_bound(600), 1_000);
        assert_eq!(max_impact_bound(u16::MAX), 1_000);
    }

    /// Sandwich model for a constant-product pool: an attacker buys `x` SOL
    /// before the slice and sells everything after it, paying `fee_bps` on
    /// both legs. With the slice's own price move capped at twice the fee the
    /// best front-run size loses money; at four times the fee it profits.
    #[test]
    fn a_slice_within_the_bound_is_not_worth_sandwiching() {
        fn profit(sol: f64, tokens: f64, fee: f64, x: f64, slice: f64) -> f64 {
            let k = sol * tokens;
            // Attacker buys with x (fee on input).
            let (s1, t1) = (sol + x * (1.0 - fee), k / (sol + x * (1.0 - fee)));
            let got = tokens - t1;
            // The slice buys.
            let s2 = s1 + slice * (1.0 - fee);
            let t2 = k / s2;
            // Attacker sells `got` (fee on output).
            let t3 = t2 + got;
            let out = (s2 - k / t3) * (1.0 - fee);
            out - x
        }
        let (sol, tokens, fee) = (1_000.0, 1_000_000.0, 0.01);
        // The slice that moves the price by `impact`: (1 + b/S)² − 1 = impact.
        let slice_for = |impact: f64| sol * ((1.0 + impact).sqrt() - 1.0) / (1.0 - fee);
        let best = |impact: f64| {
            (1..=400)
                .map(|i| profit(sol, tokens, fee, i as f64 * 2.5, slice_for(impact)))
                .fold(f64::MIN, f64::max)
        };
        let bound = f64::from(max_impact_bound(100)) / 10_000.0;
        assert!(best(bound) < 0.0, "within the bound: {}", best(bound));
        assert!(best(0.04) > 0.0, "four times the fee: {}", best(0.04));
    }
}
