//! Where every lamport of a sweep goes, and how income and losses move
//! between tranches.

use super::{bps_of, mul_div};
use crate::constants::BPS_DENOMINATOR;

/// The split of one epoch's gross revenue between repayment and operator.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct SweepSplit {
    pub remit: u64,
    pub to_operator: u64,
}

/// Remit `remit_bps` of `gross` (or all of it when `full_remit`, the default
/// state), capped at what is still owed. The remainder goes to the operator.
pub fn split_sweep(
    gross: u64,
    outstanding: u64,
    remit_bps: u16,
    full_remit: bool,
) -> Option<SweepSplit> {
    let wanted = if full_remit {
        gross
    } else {
        bps_of(gross, remit_bps)?
    };
    let remit = wanted.min(outstanding).min(gross);
    Some(SweepSplit {
        remit,
        to_operator: gross.checked_sub(remit)?,
    })
}

/// Attribute a remittance to principal and fee pro rata to what is
/// outstanding of each, so the pool's receivable and income ledgers stay
/// exact. Fee is computed first and rounded down; principal takes the rest.
pub fn attribute_repayment(
    remit: u64,
    principal_outstanding: u64,
    fee_outstanding: u64,
) -> Option<(u64, u64)> {
    let total = principal_outstanding.checked_add(fee_outstanding)?;
    if total == 0 || remit == 0 {
        return Some((0, 0));
    }
    let remit = remit.min(total);
    let fee_part = mul_div(remit, fee_outstanding, total)?.min(fee_outstanding);
    let principal_part = remit.checked_sub(fee_part)?.min(principal_outstanding);
    Some((principal_part, fee_part))
}

/// One epoch's income split.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Distribution {
    pub protocol_fee: u64,
    pub senior_gain: u64,
    pub junior_gain: u64,
}

/// Split realised income: protocol fee off the top, then the senior coupon
/// (`senior_assets × rate × epochs`), then everything left to junior. If
/// income does not cover the coupon, senior takes all of it and junior gets
/// nothing; the shortfall is not carried forward.
pub fn distribute_income(
    income: u64,
    senior_assets: u64,
    senior_rate_bps_per_epoch: u16,
    epochs: u64,
    protocol_fee_bps: u16,
) -> Option<Distribution> {
    let protocol_fee = bps_of(income, protocol_fee_bps)?;
    let net = income.checked_sub(protocol_fee)?;
    let coupon_per_epoch = bps_of(senior_assets, senior_rate_bps_per_epoch)?;
    let senior_due = coupon_per_epoch.checked_mul(epochs)?;
    let senior_gain = net.min(senior_due);
    let junior_gain = net.checked_sub(senior_gain)?;
    Some(Distribution {
        protocol_fee,
        senior_gain,
        junior_gain,
    })
}

/// Absorb a write-off: junior first, then senior. Returns the new tranche
/// balances and any loss the pool could not absorb (should be zero unless the
/// ledger is already broken).
pub fn absorb_loss(loss: u64, senior_assets: u64, junior_assets: u64) -> (u64, u64, u64) {
    let from_junior = loss.min(junior_assets);
    let rest = loss - from_junior;
    let from_senior = rest.min(senior_assets);
    let unabsorbed = rest - from_senior;
    (
        senior_assets - from_senior,
        junior_assets - from_junior,
        unabsorbed,
    )
}

/// Junior share of total assets in basis points (10_000 when senior is empty).
pub fn junior_ratio_bps(senior_assets: u64, junior_assets: u64) -> Option<u64> {
    let total = senior_assets.checked_add(junior_assets)?;
    if total == 0 {
        return Some(BPS_DENOMINATOR);
    }
    mul_div(junior_assets, BPS_DENOMINATOR, total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sweep_split_caps_at_outstanding() {
        assert_eq!(
            split_sweep(1_000, 10_000, 2_500, false).unwrap(),
            SweepSplit {
                remit: 250,
                to_operator: 750
            }
        );
        assert_eq!(
            split_sweep(1_000, 100, 2_500, false).unwrap(),
            SweepSplit {
                remit: 100,
                to_operator: 900
            }
        );
        assert_eq!(
            split_sweep(1_000, 5_000, 2_500, true).unwrap(),
            SweepSplit {
                remit: 1_000,
                to_operator: 0
            }
        );
        assert_eq!(
            split_sweep(0, 5_000, 2_500, true).unwrap(),
            SweepSplit {
                remit: 0,
                to_operator: 0
            }
        );
        assert_eq!(
            split_sweep(1_000, 0, 2_500, false).unwrap(),
            SweepSplit {
                remit: 0,
                to_operator: 1_000
            }
        );
    }

    #[test]
    fn attribution_is_pro_rata_and_exact() {
        // 1,000 principal + 20 fee outstanding; remit 510 → fee 10, principal 500.
        assert_eq!(attribute_repayment(510, 1_000, 20).unwrap(), (500, 10));
        // Final remittance clears both exactly.
        assert_eq!(attribute_repayment(1_020, 1_000, 20).unwrap(), (1_000, 20));
        // Over-remit is capped.
        assert_eq!(attribute_repayment(5_000, 1_000, 20).unwrap(), (1_000, 20));
        // Nothing outstanding.
        assert_eq!(attribute_repayment(5, 0, 0).unwrap(), (0, 0));
        // Sum of parts always equals the capped remit.
        for r in [1u64, 3, 7, 99, 101, 999, 1_019] {
            let (p, f) = attribute_repayment(r, 1_000, 20).unwrap();
            assert_eq!(p + f, r);
        }
    }

    #[test]
    fn income_waterfall() {
        // 10,000 income, 10% protocol fee, senior 1,000,000 at 4 bps/epoch for 1 epoch = 400 due.
        let d = distribute_income(10_000, 1_000_000, 4, 1, 1_000).unwrap();
        assert_eq!(
            d,
            Distribution {
                protocol_fee: 1_000,
                senior_gain: 400,
                junior_gain: 8_600
            }
        );
        // Income below coupon: senior takes all, junior nothing.
        let d = distribute_income(300, 1_000_000, 4, 1, 0).unwrap();
        assert_eq!(
            d,
            Distribution {
                protocol_fee: 0,
                senior_gain: 300,
                junior_gain: 0
            }
        );
        // Several epochs accrue a bigger coupon.
        let d = distribute_income(10_000, 1_000_000, 4, 3, 0).unwrap();
        assert_eq!(d.senior_gain, 1_200);
        // Zero income is a no-op.
        assert_eq!(
            distribute_income(0, 5, 5, 5, 5).unwrap(),
            Distribution {
                protocol_fee: 0,
                senior_gain: 0,
                junior_gain: 0
            }
        );
    }

    #[test]
    fn losses_hit_junior_first() {
        assert_eq!(absorb_loss(100, 1_000, 500), (1_000, 400, 0));
        assert_eq!(absorb_loss(600, 1_000, 500), (900, 0, 0));
        assert_eq!(absorb_loss(2_000, 1_000, 500), (0, 0, 500));
    }

    #[test]
    fn junior_ratio() {
        assert_eq!(junior_ratio_bps(900, 100).unwrap(), 1_000);
        assert_eq!(junior_ratio_bps(0, 0).unwrap(), 10_000);
        assert_eq!(junior_ratio_bps(0, 5).unwrap(), 10_000);
    }
}
