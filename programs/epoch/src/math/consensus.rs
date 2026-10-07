//! Fee Index operator consensus: the weighted median of the votes cast,
//! agreement within a tolerance of it, and the threshold test.
//!
//! Adapted from jito-foundation/jito-tip-router/core/src/ballot_box.rs
//! (MIT or Apache-2.0): tip-router tallies exact-match ballots (merkle roots)
//! and declares consensus when one ballot holds 2/3 of the total stake
//! weight. Epoch votes on a number, so votes are tallied by agreement with the
//! weighted median instead of by equality, the threshold is a parameter in bps
//! with an explicit rounding rule, every vote's deviation is measured for the
//! record, and the arithmetic is integer-only (no `PreciseNumber`).

use crate::constants::BPS_DENOMINATOR;

/// One cast vote as the tally sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WeightedVote {
    pub value: u64,
    pub weight: u64,
}

/// The state of a round after a tally.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tally {
    /// Lower weighted median of the votes cast.
    pub median: u64,
    /// Weight of the votes within the tolerance of `median`.
    pub agreeing_weight: u64,
    /// Weight of all votes cast.
    pub cast_weight: u64,
}

/// The lower weighted median: the smallest cast value at which the weight of
/// the votes at or below it reaches half of the cast weight
/// (`2 × cumulative ≥ cast`). It is always one of the cast values. `None`
/// when no vote carries weight.
///
/// O(n²) without allocating or sorting; n is at most `MAX_INDEX_OPERATORS`.
pub fn weighted_median(votes: &[WeightedVote]) -> Option<u64> {
    let cast: u128 = votes.iter().map(|v| u128::from(v.weight)).sum();
    if cast == 0 {
        return None;
    }
    let mut median: Option<u64> = None;
    for candidate in votes.iter().filter(|v| v.weight > 0) {
        if median.is_some_and(|m| m <= candidate.value) {
            continue;
        }
        let at_or_below: u128 = votes
            .iter()
            .filter(|v| v.value <= candidate.value)
            .map(|v| u128::from(v.weight))
            .sum();
        if at_or_below * 2 >= cast {
            median = Some(candidate.value);
        }
    }
    median
}

/// Whether `value` is within `tolerance_bps` of `center`:
/// `|value − center| × 10,000 ≤ center × tolerance_bps`, exactly, in 128-bit.
/// At `center = 0` only 0 agrees.
pub fn agrees(value: u64, center: u64, tolerance_bps: u16) -> bool {
    let diff = u128::from(value.abs_diff(center));
    diff * u128::from(BPS_DENOMINATOR) <= u128::from(center) * u128::from(tolerance_bps)
}

/// How far `value` is from `center`, in bps of `center`, rounded up and
/// saturating at `u32::MAX` (also returned for any non-zero value when
/// `center` is 0). `agrees(v, c, t)` holds exactly when
/// `deviation_bps(v, c) ≤ t`.
pub fn deviation_bps(value: u64, center: u64) -> u32 {
    let diff = u128::from(value.abs_diff(center));
    if diff == 0 {
        return 0;
    }
    if center == 0 {
        return u32::MAX;
    }
    let den = u128::from(center);
    let bps = (diff * u128::from(BPS_DENOMINATOR)).div_ceil(den);
    u32::try_from(bps).unwrap_or(u32::MAX)
}

/// Whether `agreeing_weight` reaches `threshold_bps` of `total_weight`, with
/// the agreeing share rounded UP to a whole bps:
/// `agreeing × 10,000 > (threshold_bps − 1) × total`.
///
/// Rounding up makes 6,667 bps mean "at least two thirds" (two of three equal
/// weights are 6,666.67 bps). With `total_weight ≤ 10,000` (the registry's
/// cap) the rounding is lenient by less than 1 bps, and 10,000 bps still
/// needs every unit of weight. False when `total_weight` is 0.
pub fn meets_threshold(agreeing_weight: u64, total_weight: u64, threshold_bps: u16) -> bool {
    if total_weight == 0 || agreeing_weight == 0 {
        return false;
    }
    u128::from(agreeing_weight) * u128::from(BPS_DENOMINATOR)
        > u128::from(threshold_bps.saturating_sub(1)) * u128::from(total_weight)
}

/// Median, agreeing weight and cast weight of a set of votes. `None` when no
/// vote carries weight.
pub fn tally(votes: &[WeightedVote], tolerance_bps: u16) -> Option<Tally> {
    let median = weighted_median(votes)?;
    let mut agreeing_weight: u64 = 0;
    let mut cast_weight: u64 = 0;
    for vote in votes {
        cast_weight = cast_weight.checked_add(vote.weight)?;
        if agrees(vote.value, median, tolerance_bps) {
            agreeing_weight = agreeing_weight.checked_add(vote.weight)?;
        }
    }
    Some(Tally {
        median,
        agreeing_weight,
        cast_weight,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MAX_INDEX_TOTAL_WEIGHT;

    fn v(value: u64, weight: u64) -> WeightedVote {
        WeightedVote { value, weight }
    }

    // ── Unit tests: the worked examples in docs/FEE_INDEX_METHODOLOGY.md ──

    #[test]
    fn two_of_three_equal_operators_agree() {
        let t = tally(&[v(1_000, 1), v(1_004, 1)], 100).unwrap();
        assert_eq!(t.median, 1_000);
        assert_eq!(t.agreeing_weight, 2);
        assert!(meets_threshold(t.agreeing_weight, 3, 6_667));
        assert!(!meets_threshold(1, 3, 6_667));
        assert_eq!(deviation_bps(1_004, 1_000), 40);
    }

    #[test]
    fn a_dissenter_is_outvoted_and_recorded() {
        let votes = [v(1_000, 1), v(1_004, 1), v(1_500, 1)];
        let t = tally(&votes, 100).unwrap();
        assert_eq!(t.median, 1_004);
        assert_eq!(t.agreeing_weight, 2);
        assert_eq!(t.cast_weight, 3);
        assert!(meets_threshold(t.agreeing_weight, 3, 6_667));
        assert!(!agrees(1_500, 1_004, 100));
        assert_eq!(deviation_bps(1_500, 1_004), 4_941);
    }

    #[test]
    fn order_only_matters_inside_the_tolerance() {
        let early = tally(&[v(1_004, 1), v(1_012, 1)], 100).unwrap();
        assert_eq!((early.median, early.agreeing_weight), (1_004, 2));
        let split = tally(&[v(1_000, 1), v(1_012, 1)], 100).unwrap();
        assert_eq!((split.median, split.agreeing_weight), (1_000, 1));
        let all = tally(&[v(1_000, 1), v(1_012, 1), v(1_004, 1)], 100).unwrap();
        assert_eq!((all.median, all.agreeing_weight), (1_004, 3));
    }

    #[test]
    fn unequal_weights() {
        let t = tally(&[v(2_000, 5), v(2_010, 3), v(1_000, 2)], 100).unwrap();
        assert_eq!(t.median, 2_000);
        assert_eq!(t.agreeing_weight, 8);
        assert!(meets_threshold(8, 10, 6_667));
        // The heaviest operator alone (50%) cannot move the index.
        assert!(!meets_threshold(5, 10, 6_667));
    }

    #[test]
    fn one_operator_always_meets_any_threshold() {
        for threshold in [5_001u16, 6_667, 10_000] {
            assert!(meets_threshold(7, 7, threshold));
        }
    }

    #[test]
    fn threshold_edges() {
        assert!(!meets_threshold(0, 10, 5_001));
        assert!(!meets_threshold(5, 0, 5_001));
        assert!(meets_threshold(10_000, 10_000, 10_000));
        assert!(!meets_threshold(9_999, 10_000, 10_000));
        assert!(!meets_threshold(2, 3, 10_000));
        assert!(meets_threshold(6_667, 10_000, 6_667));
        assert!(!meets_threshold(6_666, 10_000, 6_667));
        // Majority: 5,001 bps of 2 equal weights needs both.
        assert!(!meets_threshold(1, 2, 5_001));
        assert!(meets_threshold(2, 3, 5_001));
    }

    #[test]
    fn median_edges() {
        assert_eq!(weighted_median(&[]), None);
        assert_eq!(weighted_median(&[v(5, 0)]), None);
        assert_eq!(weighted_median(&[v(5, 1)]), Some(5));
        // Exact split: the lower of the two middle values.
        assert_eq!(weighted_median(&[v(10, 1), v(20, 1)]), Some(10));
        assert_eq!(weighted_median(&[v(20, 1), v(10, 1)]), Some(10));
        // A zero-weight vote is never the median.
        assert_eq!(weighted_median(&[v(1, 0), v(9, 1)]), Some(9));
        // Duplicates.
        assert_eq!(weighted_median(&[v(7, 1), v(7, 1), v(100, 1)]), Some(7));
        // Weight decides, not count.
        assert_eq!(weighted_median(&[v(1, 1), v(2, 1), v(3, 5)]), Some(3));
        assert_eq!(weighted_median(&[v(u64::MAX, 3), v(0, 1)]), Some(u64::MAX));
    }

    #[test]
    fn agreement_and_deviation_edges() {
        assert!(agrees(0, 0, 0));
        assert!(!agrees(1, 0, 1_000));
        assert_eq!(deviation_bps(1, 0), u32::MAX);
        assert_eq!(deviation_bps(0, 0), 0);
        assert!(agrees(1_000, 1_000, 0));
        assert!(!agrees(1_001, 1_000, 0));
        assert!(agrees(1_010, 1_000, 100));
        assert!(!agrees(1_011, 1_000, 100));
        assert!(agrees(990, 1_000, 100));
        assert!(!agrees(989, 1_000, 100));
        assert_eq!(deviation_bps(1_011, 1_000), 110);
        // 998 × 10,000 / 3 = 3,326,666.67, rounded up.
        assert_eq!(deviation_bps(1_001, 3), 3_326_667);
        assert_eq!(deviation_bps(u64::MAX, 1), u32::MAX);
        assert!(agrees(u64::MAX, u64::MAX - 1, 1));
    }

    // ── Property tests (seeded, no extra crates) ──

    /// xorshift64*: deterministic, so a failure reproduces from its seed.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }

        fn votes(&mut self) -> Vec<WeightedVote> {
            let n = 1 + self.below(8) as usize;
            let base = 1 + self.below(1_000_000);
            (0..n)
                .map(|_| {
                    let spread = self.below(4);
                    let value = match spread {
                        0 => base,
                        1 => base + self.below(base / 100 + 1),
                        2 => base.saturating_sub(self.below(base / 50 + 1)),
                        _ => self.below(4 * base + 1),
                    };
                    v(value, 1 + self.below(2_500))
                })
                .collect()
        }
    }

    const CASES: u64 = 4_000;

    #[test]
    fn prop_median_is_a_cast_value_and_splits_the_weight() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for _ in 0..CASES {
            let votes = rng.votes();
            let m = weighted_median(&votes).unwrap();
            assert!(votes.iter().any(|x| x.value == m));
            let cast: u64 = votes.iter().map(|x| x.weight).sum();
            let at_or_below: u64 = votes
                .iter()
                .filter(|x| x.value <= m)
                .map(|x| x.weight)
                .sum();
            let below: u64 = votes.iter().filter(|x| x.value < m).map(|x| x.weight).sum();
            assert!(2 * at_or_below >= cast, "{votes:?}");
            assert!(2 * below < cast, "{votes:?}");
        }
    }

    #[test]
    fn prop_tally_ignores_vote_order() {
        let mut rng = Rng(0xDEAD_BEEF_CAFE_F00D);
        for _ in 0..CASES {
            let mut votes = rng.votes();
            let tolerance = rng.below(1_001) as u16;
            let before = tally(&votes, tolerance).unwrap();
            for i in (1..votes.len()).rev() {
                let j = rng.below(i as u64 + 1) as usize;
                votes.swap(i, j);
            }
            assert_eq!(tally(&votes, tolerance).unwrap(), before);
        }
    }

    #[test]
    fn prop_a_weighted_majority_bounds_the_median() {
        let mut rng = Rng(0x0123_4567_89AB_CDEF);
        for _ in 0..CASES {
            let honest = rng.votes();
            let honest_weight: u64 = honest.iter().map(|x| x.weight).sum();
            let lo = honest.iter().map(|x| x.value).min().unwrap();
            let hi = honest.iter().map(|x| x.value).max().unwrap();
            // Attackers hold strictly less weight than the honest votes and
            // vote anywhere.
            let mut all = honest.clone();
            let mut attack_weight = 0;
            while attack_weight + 1 < honest_weight && all.len() < 16 {
                let w = 1 + rng.below(honest_weight - attack_weight - 1);
                let value = if rng.below(2) == 0 {
                    0
                } else {
                    u64::MAX - rng.below(10)
                };
                all.push(v(value, w));
                attack_weight += w;
            }
            let m = weighted_median(&all).unwrap();
            assert!(lo <= m && m <= hi, "{all:?}");
        }
    }

    #[test]
    fn prop_agreement_is_deviation_within_tolerance() {
        let mut rng = Rng(0x5555_AAAA_3333_CCCC);
        for _ in 0..CASES * 4 {
            let center = match rng.below(5) {
                0 => 0,
                1 => rng.below(10),
                _ => rng.next(),
            };
            let value = match rng.below(3) {
                0 => center,
                1 => center.saturating_add(rng.below(center / 50 + 2)),
                _ => rng.next(),
            };
            let tolerance = rng.below(u64::from(u16::MAX) + 1) as u16;
            assert_eq!(
                agrees(value, center, tolerance),
                deviation_bps(value, center) <= u32::from(tolerance),
                "value {value} center {center} tolerance {tolerance}"
            );
        }
    }

    #[test]
    fn prop_threshold_is_the_rounded_up_share() {
        let mut rng = Rng(0x1357_9BDF_2468_ACE0);
        for _ in 0..CASES * 4 {
            let total = 1 + rng.below(10_000);
            let agreeing = rng.below(total + 1);
            let threshold = 1 + rng.below(10_000) as u16;
            // Share in bps rounded up, computed independently.
            let share_up = (agreeing * 10_000).div_ceil(total);
            let expected = agreeing > 0 && share_up >= u64::from(threshold);
            assert_eq!(
                meets_threshold(agreeing, total, threshold),
                expected,
                "agreeing {agreeing} total {total} threshold {threshold}"
            );
            // Monotonic in the agreeing weight.
            if meets_threshold(agreeing, total, threshold) && agreeing < total {
                assert!(meets_threshold(agreeing + 1, total, threshold));
            }
            // 10,000 bps means everyone.
            if threshold == 10_000 {
                assert_eq!(
                    meets_threshold(agreeing, total, threshold),
                    agreeing == total
                );
            }
        }
    }

    #[test]
    fn prop_two_thirds_default_is_lenient_by_under_one_bps() {
        for total in 1u64..=MAX_INDEX_TOTAL_WEIGHT {
            for agreeing in [
                (2 * total) / 3,
                (2 * total) / 3 + 1,
                (2 * total).saturating_sub(3) / 3,
            ] {
                if agreeing == 0 || agreeing > total {
                    continue;
                }
                let two_thirds = 3 * agreeing >= 2 * total;
                let meets = meets_threshold(agreeing, total, 6_667);
                if total <= 300 {
                    assert_eq!(meets, two_thirds, "{agreeing}/{total}");
                }
                if two_thirds {
                    assert!(meets, "{agreeing}/{total}");
                }
                // Accepted below two thirds only by less than 1 bps.
                if meets && !two_thirds {
                    assert!(
                        (2 * total - 3 * agreeing) * 10_000 < 3 * total,
                        "{agreeing}/{total}"
                    );
                }
            }
        }
    }
}
