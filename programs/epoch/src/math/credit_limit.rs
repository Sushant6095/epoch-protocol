//! How much a validator may draw.
//!
//! `limit = min(trailing_revenue × advance_bps, bond × bond_multiplier, cap)`
//! with the bond cap skipped when `bond_multiplier == 0`. A validator with
//! fewer than `MIN_REVENUE_HISTORY` swept epochs has a limit of zero.

use super::bps_of;
use crate::constants::MIN_REVENUE_HISTORY;

#[derive(Debug, Clone, Copy)]
pub struct CreditInputs {
    pub trailing_revenue: u64,
    pub history_epochs: u8,
    pub advance_bps: u16,
    pub bond_lamports: u64,
    pub bond_multiplier: u8,
    pub cap_lamports: u64,
}

pub fn credit_limit(i: &CreditInputs) -> Option<u64> {
    if i.history_epochs < MIN_REVENUE_HISTORY {
        return Some(0);
    }
    let by_revenue = bps_of(i.trailing_revenue, i.advance_bps)?;
    let by_bond = if i.bond_multiplier == 0 {
        u64::MAX
    } else {
        i.bond_lamports.checked_mul(u64::from(i.bond_multiplier))?
    };
    Some(by_revenue.min(by_bond).min(i.cap_lamports))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> CreditInputs {
        CreditInputs {
            trailing_revenue: 100_000_000_000, // 100 SOL over the window
            history_epochs: 10,
            advance_bps: 2_500,
            bond_lamports: 0,
            bond_multiplier: 0,
            cap_lamports: 50_000_000_000,
        }
    }

    #[test]
    fn revenue_rule() {
        assert_eq!(credit_limit(&base()).unwrap(), 25_000_000_000);
    }

    #[test]
    fn hedged_validators_get_more() {
        let mut i = base();
        i.advance_bps = 4_000;
        assert_eq!(credit_limit(&i).unwrap(), 40_000_000_000);
    }

    #[test]
    fn cap_binds() {
        let mut i = base();
        i.cap_lamports = 10_000_000_000;
        assert_eq!(credit_limit(&i).unwrap(), 10_000_000_000);
    }

    #[test]
    fn bond_binds_when_enabled() {
        let mut i = base();
        i.bond_multiplier = 2;
        i.bond_lamports = 3_000_000_000;
        assert_eq!(credit_limit(&i).unwrap(), 6_000_000_000);
    }

    #[test]
    fn no_history_no_credit() {
        let mut i = base();
        i.history_epochs = 2;
        assert_eq!(credit_limit(&i).unwrap(), 0);
    }

    #[test]
    fn bond_overflow_is_none() {
        let mut i = base();
        i.bond_multiplier = 255;
        i.bond_lamports = u64::MAX;
        assert_eq!(credit_limit(&i), None);
    }
}
