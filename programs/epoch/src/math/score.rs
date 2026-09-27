//! The Epoch Score: 0..=10,000 from inputs the largest delegators already
//! publish (Jito Steward gates, SFDP criteria). The scorer posts the inputs;
//! the formula lives here so anyone can recompute it.
//!
//! | Component  | Max   | Rule |
//! |------------|-------|------|
//! | Credits    | 6,000 | ≥97% of cluster average → full; 90–97% linear 3,000→6,000; below → pro rata of 3,000 |
//! | Commission | 2,500 | ≤5% → full; 5–10% linear 2,500→1,000; >10% → 0 |
//! | Tenure     | 1,500 | epochs active / 30, capped |
//! | Delinquent | —     | score is 0 |
//! | Superminority | — | capped at 5,000 |

use crate::constants::MAX_SCORE;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScoreInputs {
    /// Vote credits as a share of the cluster average, bps (10_000 = average).
    pub credits_ratio_bps: u16,
    /// Effective commission in bps (the higher of inflation and MEV commission).
    pub commission_bps: u16,
    /// Epochs the validator has been voting.
    pub epochs_active: u16,
    pub delinquent: bool,
    /// In the set of largest validators that together control a third of stake.
    pub superminority: bool,
}

const CREDITS_MAX: u32 = 6_000;
const COMMISSION_MAX: u32 = 2_500;
const TENURE_MAX: u32 = 1_500;
const SUPERMINORITY_CAP: u32 = 5_000;
const TENURE_FULL_EPOCHS: u32 = 30;

pub fn compute_score(i: &ScoreInputs) -> u16 {
    if i.delinquent {
        return 0;
    }
    let credits = u32::from(i.credits_ratio_bps);
    let credits_pts = if credits >= 9_700 {
        CREDITS_MAX
    } else if credits >= 9_000 {
        // 3,000 at 9,000 → 6,000 at 9,700
        3_000 + (credits - 9_000) * 3_000 / 700
    } else {
        credits * 3_000 / 9_000
    };

    let c = u32::from(i.commission_bps);
    let commission_pts = if c <= 500 {
        COMMISSION_MAX
    } else if c <= 1_000 {
        // 2,500 at 500 → 1,000 at 1,000
        2_500 - (c - 500) * 1_500 / 500
    } else {
        0
    };

    let tenure_pts =
        u32::from(i.epochs_active).min(TENURE_FULL_EPOCHS) * TENURE_MAX / TENURE_FULL_EPOCHS;

    let mut score = credits_pts + commission_pts + tenure_pts;
    if i.superminority {
        score = score.min(SUPERMINORITY_CAP);
    }
    score.min(u32::from(MAX_SCORE)) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> ScoreInputs {
        ScoreInputs {
            credits_ratio_bps: 9_900,
            commission_bps: 500,
            epochs_active: 60,
            delinquent: false,
            superminority: false,
        }
    }

    #[test]
    fn perfect_validator_scores_ten_thousand() {
        assert_eq!(compute_score(&good()), 10_000);
    }

    #[test]
    fn delinquent_is_zero() {
        assert_eq!(
            compute_score(&ScoreInputs {
                delinquent: true,
                ..good()
            }),
            0
        );
    }

    #[test]
    fn credits_ramp_is_monotonic() {
        let mut last = 0;
        for r in (0..=11_000u16).step_by(100) {
            let s = compute_score(&ScoreInputs {
                credits_ratio_bps: r,
                ..good()
            });
            assert!(s >= last, "ratio {r}: {s} < {last}");
            last = s;
        }
        assert_eq!(
            compute_score(&ScoreInputs {
                credits_ratio_bps: 9_000,
                ..good()
            }),
            3_000 + 2_500 + 1_500
        );
        assert_eq!(
            compute_score(&ScoreInputs {
                credits_ratio_bps: 4_500,
                ..good()
            }),
            1_500 + 2_500 + 1_500
        );
    }

    #[test]
    fn commission_ramp() {
        assert_eq!(
            compute_score(&ScoreInputs {
                commission_bps: 0,
                ..good()
            }),
            10_000
        );
        assert_eq!(
            compute_score(&ScoreInputs {
                commission_bps: 750,
                ..good()
            }),
            6_000 + 1_750 + 1_500
        );
        assert_eq!(
            compute_score(&ScoreInputs {
                commission_bps: 1_000,
                ..good()
            }),
            6_000 + 1_000 + 1_500
        );
        assert_eq!(
            compute_score(&ScoreInputs {
                commission_bps: 1_001,
                ..good()
            }),
            6_000 + 1_500
        );
    }

    #[test]
    fn tenure_caps_at_thirty_epochs() {
        assert_eq!(
            compute_score(&ScoreInputs {
                epochs_active: 0,
                ..good()
            }),
            8_500
        );
        assert_eq!(
            compute_score(&ScoreInputs {
                epochs_active: 15,
                ..good()
            }),
            8_500 + 750
        );
        assert_eq!(
            compute_score(&ScoreInputs {
                epochs_active: 300,
                ..good()
            }),
            10_000
        );
    }

    #[test]
    fn superminority_is_capped() {
        assert_eq!(
            compute_score(&ScoreInputs {
                superminority: true,
                ..good()
            }),
            5_000
        );
    }

    #[test]
    fn never_exceeds_max() {
        let i = ScoreInputs {
            credits_ratio_bps: u16::MAX,
            commission_bps: 0,
            epochs_active: u16::MAX,
            delinquent: false,
            superminority: false,
        };
        assert!(compute_score(&i) <= MAX_SCORE);
    }
}
