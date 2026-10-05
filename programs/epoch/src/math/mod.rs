//! Pure arithmetic. Nothing in this module touches an account; every function
//! is total over its inputs (returns `Option`/`Result` instead of panicking)
//! and is covered by unit tests. Rounding always favours the pool.

pub mod amm;
pub mod credit_limit;
pub mod revenue_token;
pub mod score;
pub mod shares;
pub mod treasury;
pub mod u256;
pub mod waterfall;

pub use amm::*;
pub use credit_limit::*;
pub use revenue_token::*;
pub use score::*;
pub use shares::*;
pub use treasury::*;
pub use waterfall::*;

use crate::constants::BPS_DENOMINATOR;

/// `amount × bps / 10_000`, rounded down, without overflow.
pub fn bps_of(amount: u64, bps: u16) -> Option<u64> {
    let v = (amount as u128)
        .checked_mul(bps as u128)?
        .checked_div(BPS_DENOMINATOR as u128)?;
    u64::try_from(v).ok()
}

/// `amount × bps / 10_000`, rounded up, without overflow.
pub fn bps_of_ceil(amount: u64, bps: u16) -> Option<u64> {
    let num = (amount as u128).checked_mul(bps as u128)?;
    let den = BPS_DENOMINATOR as u128;
    let v = num.checked_add(den - 1)?.checked_div(den)?;
    u64::try_from(v).ok()
}

/// `a × b / c` in 128-bit, rounded down.
pub fn mul_div(a: u64, b: u64, c: u64) -> Option<u64> {
    if c == 0 {
        return None;
    }
    let v = (a as u128).checked_mul(b as u128)?.checked_div(c as u128)?;
    u64::try_from(v).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bps_rounding() {
        assert_eq!(bps_of(10_000, 2_500), Some(2_500));
        assert_eq!(bps_of(3, 3_333), Some(0));
        assert_eq!(bps_of_ceil(3, 3_333), Some(1));
        assert_eq!(bps_of(u64::MAX, 10_000), Some(u64::MAX));
        assert_eq!(bps_of_ceil(u64::MAX, 10_000), Some(u64::MAX));
    }

    #[test]
    fn mul_div_guards() {
        assert_eq!(mul_div(10, 3, 4), Some(7));
        assert_eq!(mul_div(1, 1, 0), None);
        assert_eq!(mul_div(u64::MAX, u64::MAX, 1), None);
        assert_eq!(mul_div(u64::MAX, 2, 2), Some(u64::MAX));
    }
}
