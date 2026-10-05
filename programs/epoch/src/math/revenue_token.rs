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
}
