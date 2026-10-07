//! Score inputs from on-chain history, for `refresh_score`.
//!
//! Adapted from jito-foundation_stakenet/programs/steward/src/score.rs
//! (Apache-2.0): the credits ratio over a window of finished epochs, the
//! highest commission over a window (so a one-epoch commission drop does not
//! erase a recent rug) and a delinquency test. Changed: integer basis points
//! instead of `f64`; the maximum is the TVC maximum from the EpochSchedule
//! (no `ClusterHistory` crank over the SlotHistory sysvar); delinquency is the
//! distance from the newest vote; the result is rescaled onto Epoch's existing
//! score input ("share of the cluster average"), and Epoch's hedge rule.

use super::bps_of_ceil;
use crate::constants::{
    BPS_DENOMINATOR, DELINQUENT_SLOT_DISTANCE, HEDGE_MIN_NOTIONAL_BPS, TVC_CREDITS_PER_SLOT,
};

/// One finished epoch in the credits window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditsSample {
    /// Credits earned; `None` when the history holds nothing for the epoch
    /// (the vote account's own 64-epoch history backfills every epoch in which
    /// it earned credits, so a gap means none).
    pub earned: Option<u64>,
    /// The TVC maximum for the epoch.
    pub max: u64,
}

/// The most credits a vote account can earn in an epoch of `slots` slots.
pub fn max_credits(slots: u64) -> Option<u64> {
    slots.checked_mul(TVC_CREDITS_PER_SLOT)
}

/// Σ earned ÷ Σ max over the window, bps, capped at 10,000. `None` for an
/// empty window or a zero maximum.
pub fn credits_ratio_raw_bps(samples: &[CreditsSample]) -> Option<u16> {
    let mut earned: u128 = 0;
    let mut max: u128 = 0;
    for s in samples {
        // A sample never counts above its own maximum.
        earned = earned.checked_add(u128::from(s.earned.unwrap_or(0).min(s.max)))?;
        max = max.checked_add(u128::from(s.max))?;
    }
    if max == 0 {
        return None;
    }
    let bps = earned.checked_mul(u128::from(BPS_DENOMINATOR))? / max;
    Some(bps.min(u128::from(BPS_DENOMINATOR)) as u16)
}

/// `raw_bps` as a share of `reference_bps` (the cluster average's share of
/// the maximum), bps, saturating at `u16::MAX`.
pub fn credits_ratio_vs_reference(raw_bps: u16, reference_bps: u16) -> Option<u16> {
    if reference_bps == 0 {
        return None;
    }
    let v = u32::from(raw_bps) * BPS_DENOMINATOR as u32 / u32::from(reference_bps);
    Some(v.min(u32::from(u16::MAX)) as u16)
}

/// Delinquent: no vote in the tower, or the newest vote is more than 128 slots
/// behind the slot the vote account was read at.
pub fn is_delinquent(last_voted_slot: Option<u64>, read_at_slot: u64) -> bool {
    match last_voted_slot {
        None => true,
        Some(slot) => read_at_slot.saturating_sub(slot) > DELINQUENT_SLOT_DISTANCE,
    }
}

/// The highest known commission, capped at 10,000 bps; `None` when nothing is
/// known.
pub fn highest_commission<I: IntoIterator<Item = Option<u16>>>(values: I) -> Option<u16> {
    values
        .into_iter()
        .flatten()
        .max()
        .map(|c| c.min(BPS_DENOMINATOR as u16))
}

/// Tenure for the score: the epochs the vote account shows credits in, or the
/// epochs since onboarding, whichever is longer.
pub fn epochs_active(epochs_voted: u16, current_epoch: u64, onboarded_epoch: u64) -> u16 {
    let onboarded = current_epoch.saturating_sub(onboarded_epoch);
    u64::from(epochs_voted)
        .max(onboarded)
        .min(u64::from(u16::MAX)) as u16
}

/// Integer average, 0 for no epochs.
pub fn average(sum: u64, epochs: u64) -> u64 {
    sum.checked_div(epochs).unwrap_or(0)
}

/// Receive-fixed notional each hedged epoch needs: half of the larger of the
/// position's and the history's average revenue, rounded up and never zero
/// (an empty history cannot be hedged with dust). Taking the larger means the
/// history can only make the hedge harder, never easier.
pub fn hedge_required_notional(position_average: u64, history_average: Option<u64>) -> Option<u64> {
    let average = position_average.max(history_average.unwrap_or(0));
    Some(bps_of_ceil(average, HEDGE_MIN_NOTIONAL_BPS)?.max(1))
}

/// Hedged when every epoch in `coverage` (current + 1 … current + 5) holds at
/// least `required`.
pub fn is_hedged(coverage: &[u64], required: u64) -> bool {
    !coverage.is_empty() && coverage.iter().all(|n| *n >= required)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{constants::MAX_SCORE, math::score::*};
    use proptest::prelude::*;

    const MAX: u64 = 432_000 * 16;

    fn s(earned: Option<u64>) -> CreditsSample {
        CreditsSample { earned, max: MAX }
    }

    #[test]
    fn max_credits_is_sixteen_per_slot() {
        assert_eq!(max_credits(432_000), Some(6_912_000));
        assert_eq!(max_credits(u64::MAX), None);
    }

    #[test]
    fn credits_ratio_from_real_mainnet_numbers() {
        // CcaHc2… earned 6,904,039 / 6,906,891 / 6,903,633 / 6,899,849 in
        // epochs 1047–1050.
        let w = [
            s(Some(6_904_039)),
            s(Some(6_906_891)),
            s(Some(6_903_633)),
            s(Some(6_899_849)),
        ];
        let raw = credits_ratio_raw_bps(&w).unwrap();
        assert_eq!(raw, 9_987);
        // On the score's scale against the 99.50% reference: above average.
        assert_eq!(credits_ratio_vs_reference(raw, 9_950), Some(10_037));
    }

    #[test]
    fn gaps_count_as_zero_and_overshoot_is_clipped() {
        assert_eq!(credits_ratio_raw_bps(&[s(Some(MAX)), s(None)]), Some(5_000));
        assert_eq!(credits_ratio_raw_bps(&[s(Some(MAX * 2))]), Some(10_000));
        assert_eq!(credits_ratio_raw_bps(&[]), None);
        assert_eq!(
            credits_ratio_raw_bps(&[CreditsSample {
                earned: Some(1),
                max: 0
            }]),
            None
        );
    }

    #[test]
    fn reference_rescaling() {
        assert_eq!(credits_ratio_vs_reference(9_950, 9_950), Some(10_000));
        assert_eq!(credits_ratio_vs_reference(10_000, 5_000), Some(20_000));
        assert_eq!(credits_ratio_vs_reference(10_000, 1), Some(u16::MAX));
        assert_eq!(credits_ratio_vs_reference(10_000, 0), None);
    }

    #[test]
    fn delinquency_boundary() {
        assert!(!is_delinquent(Some(1_000), 1_128));
        assert!(is_delinquent(Some(1_000), 1_129));
        assert!(!is_delinquent(Some(2_000), 1_000)); // vote newer than the read
        assert!(is_delinquent(None, 5));
    }

    #[test]
    fn highest_commission_ignores_unknowns() {
        assert_eq!(highest_commission([Some(500), None, Some(800)]), Some(800));
        assert_eq!(highest_commission([None, None]), None);
        assert_eq!(highest_commission([Some(u16::MAX - 1)]), Some(10_000));
    }

    #[test]
    fn tenure() {
        assert_eq!(epochs_active(64, 1_051, 1_050), 64);
        assert_eq!(epochs_active(3, 1_051, 1_000), 51);
        assert_eq!(epochs_active(0, 5, 10), 0);
    }

    #[test]
    fn hedge_requirement() {
        // Half of 10 SOL, rounded up.
        assert_eq!(
            hedge_required_notional(10_000_000_001, None),
            Some(5_000_000_001)
        );
        // The larger average wins.
        assert_eq!(hedge_required_notional(10, Some(1_000)), Some(500));
        assert_eq!(hedge_required_notional(1_000, Some(10)), Some(500));
        // Never zero.
        assert_eq!(hedge_required_notional(0, None), Some(1));
        assert!(is_hedged(&[5, 5, 6, 5, 9], 5));
        assert!(!is_hedged(&[5, 5, 4, 5, 9], 5));
        assert!(!is_hedged(&[], 1));
    }

    proptest! {
        #[test]
        fn raw_ratio_is_bounded_and_monotonic(
            earned in proptest::collection::vec(proptest::option::of(0u64..=MAX), 1..=32),
            bump in 0u64..=MAX,
            at in 0usize..32,
        ) {
            let w: Vec<_> = earned.iter().map(|e| s(*e)).collect();
            let r = credits_ratio_raw_bps(&w).unwrap();
            prop_assert!(r <= 10_000);
            // More credits in any epoch never lowers the ratio.
            let mut more = w.clone();
            let i = at % more.len();
            more[i].earned = Some(more[i].earned.unwrap_or(0).saturating_add(bump));
            prop_assert!(credits_ratio_raw_bps(&more).unwrap() >= r);
        }

        #[test]
        fn rescaled_ratio_is_monotonic_in_raw(a in 0u16..=10_000, b in 0u16..=10_000, reference in 5_000u16..=10_000) {
            let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
            prop_assert!(credits_ratio_vs_reference(lo, reference) <= credits_ratio_vs_reference(hi, reference));
        }

        #[test]
        fn history_never_lowers_the_hedge_bar(position in 0u64..=u64::MAX / 2, history in proptest::option::of(0u64..=u64::MAX / 2)) {
            let with = hedge_required_notional(position, history).unwrap();
            let without = hedge_required_notional(position, None).unwrap();
            prop_assert!(with >= without);
            prop_assert!(with >= 1);
        }

        #[test]
        fn score_from_history_inputs_is_in_range(
            raw in 0u16..=10_000,
            reference in 5_000u16..=10_000,
            commission in proptest::option::of(0u16..=u16::MAX),
            voted in 0u16..=64,
            delinquent in any::<bool>(),
            superminority in any::<bool>(),
        ) {
            let score = compute_score(&ScoreInputs {
                credits_ratio_bps: credits_ratio_vs_reference(raw, reference).unwrap(),
                commission_bps: highest_commission([commission]).unwrap_or(0),
                epochs_active: voted,
                delinquent,
                superminority,
            });
            prop_assert!(score <= MAX_SCORE);
            if delinquent { prop_assert_eq!(score, 0); }
            if superminority { prop_assert!(score <= 5_000); }
        }
    }
}
