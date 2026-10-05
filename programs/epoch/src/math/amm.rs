//! Fee-free buy quotes on the two Meteora venues, mirrored from their sources
//! (dynamic-bonding-curve `curve.rs` and `state/virtual_pool.rs`
//! `calculate_quote_to_base_from_amount_in`; damm-v2 `liquidity_handler/
//! {concentrated,compounding}_liquidity.rs`), with the same Q64.64 sqrt
//! prices, 256-bit intermediates and rounding.
//!
//! `execute_buyback` uses them for two protocol-side bounds that hold no
//! matter what the cranker passes:
//!
//! - **min-out floor**: `min_amount_out ≥ fee_free_out × (1 − max_slippage)`;
//! - **impact cap**: a slice may raise √P by at most `max_impact_bps / 2`
//!   (≈ `max_impact_bps` on the price), so a sandwich around it cannot earn
//!   more than the two pool fees it pays.
//!
//! Both are computed from the pool state at execution time; see the module
//! docs of `instructions/revenue/execute_buyback.rs` for why that still bounds
//! a sandwich.

use super::u256::{mul_div_u256, U256};
use crate::constants::BPS_DENOMINATOR;

/// One DBC curve segment: it runs up to `sqrt_price` with `liquidity`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct CurvePoint {
    pub sqrt_price: u128,
    pub liquidity: u128,
}

/// What a quote-in, base-out swap does to a pool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyFill {
    /// Base (revenue token) out, fees ignored.
    pub output: u64,
    /// Quote consumed (less than the input when a partial fill stops at the
    /// curve's end).
    pub consumed: u64,
    pub next_sqrt_price: u128,
}

/// `Δbase = L × (√P_upper − √P_lower) / (√P_lower × √P_upper)`.
pub fn delta_base(lower: u128, upper: u128, liquidity: u128, round_up: bool) -> Option<U256> {
    let numerator = upper.checked_sub(lower)?;
    let denominator = U256::mul_u128(lower, upper);
    if denominator.is_zero() {
        return None;
    }
    mul_div_u256(
        U256::from_u128(liquidity),
        U256::from_u128(numerator),
        denominator,
        round_up,
    )
}

/// `Δquote = L × (√P_upper − √P_lower) >> 128`.
pub fn delta_quote(lower: u128, upper: u128, liquidity: u128, round_up: bool) -> Option<U256> {
    let delta = upper.checked_sub(lower)?;
    let prod = U256::mul_u128(liquidity, delta);
    let q = U256::from_u128(prod.hi);
    if round_up && prod.lo != 0 {
        q.checked_add(U256::from_u128(1))
    } else {
        Some(q)
    }
}

/// `√P' = √P + (amount << 128) / L`, rounded down (quote in raises the price).
pub fn next_sqrt_from_quote_in(sqrt_price: u128, liquidity: u128, amount: u64) -> Option<u128> {
    if liquidity == 0 {
        return None;
    }
    let (q, _) = U256::shl128(u128::from(amount)).div_rem(U256::from_u128(liquidity))?;
    q.checked_add(U256::from_u128(sqrt_price))?.to_u128()
}

/// DBC: base out for `amount_in` quote, walking the curve's segments from the
/// current √P and stopping at `stop_sqrt_price` (the migration price for a
/// partial fill). Mirrors `calculate_quote_to_base_from_amount_in`.
pub fn dbc_buy(
    curve: &[CurvePoint],
    sqrt_price: u128,
    stop_sqrt_price: u128,
    amount_in: u64,
) -> Option<BuyFill> {
    let mut output: u64 = 0;
    let mut current = sqrt_price;
    let mut left = amount_in;
    for point in curve {
        if point.sqrt_price == 0 || point.liquidity == 0 {
            break;
        }
        let reference = stop_sqrt_price.min(point.sqrt_price);
        if reference <= current {
            continue;
        }
        let max_in = delta_quote(current, reference, point.liquidity, true)?;
        if U256::from_u128(u128::from(left)) < max_in {
            let next = next_sqrt_from_quote_in(current, point.liquidity, left)?;
            let out = delta_base(current, next, point.liquidity, false)?.to_u64()?;
            output = output.checked_add(out)?;
            current = next;
            left = 0;
            break;
        }
        let out = delta_base(current, reference, point.liquidity, false)?.to_u64()?;
        output = output.checked_add(out)?;
        current = reference;
        left = left.checked_sub(max_in.to_u64()?)?;
        if reference == stop_sqrt_price {
            break;
        }
    }
    Some(BuyFill {
        output,
        consumed: amount_in - left,
        next_sqrt_price: current,
    })
}

/// DBC: the most quote one buy may add before √P rises past `target`
/// (capped at `stop_sqrt_price`), rounded down.
pub fn dbc_max_quote_in(
    curve: &[CurvePoint],
    sqrt_price: u128,
    stop_sqrt_price: u128,
    target_sqrt_price: u128,
) -> Option<u64> {
    let end = target_sqrt_price.min(stop_sqrt_price);
    let mut total = U256::ZERO;
    let mut current = sqrt_price;
    for point in curve {
        if point.sqrt_price == 0 || point.liquidity == 0 || current >= end {
            break;
        }
        let upper = end.min(point.sqrt_price);
        if upper <= current {
            continue;
        }
        total = total.checked_add(delta_quote(current, upper, point.liquidity, false)?)?;
        current = upper;
    }
    Some(total.to_u64().unwrap_or(u64::MAX))
}

/// DAMM v2 concentrated pool (collect-fee modes 0 and 1), token A out for
/// `amount_in` of token B (the revenue token is A, SOL is B on every DBC
/// graduation). `None` past `sqrt_max_price` (the pool rejects it too).
pub fn damm_concentrated_buy(
    sqrt_price: u128,
    liquidity: u128,
    sqrt_max_price: u128,
    amount_in: u64,
) -> Option<BuyFill> {
    let next = next_sqrt_from_quote_in(sqrt_price, liquidity, amount_in)?;
    if next > sqrt_max_price {
        return None;
    }
    let output = delta_base(sqrt_price, next, liquidity, false)?.to_u64()?;
    Some(BuyFill {
        output,
        consumed: amount_in,
        next_sqrt_price: next,
    })
}

/// DAMM v2 concentrated pool: the most token B one buy may add before √P
/// passes `target` (or the range's top).
pub fn damm_concentrated_max_quote_in(
    sqrt_price: u128,
    liquidity: u128,
    sqrt_max_price: u128,
    target_sqrt_price: u128,
) -> Option<u64> {
    let end = target_sqrt_price.min(sqrt_max_price);
    if end <= sqrt_price {
        return Some(0);
    }
    Some(
        delta_quote(sqrt_price, end, liquidity, false)?
            .to_u64()
            .unwrap_or(u64::MAX),
    )
}

/// DAMM v2 compounding pool (collect-fee mode 2, `x·y = k` on the reserves):
/// `out = a × in / (b + in)`, rounded down.
pub fn damm_compounding_buy(reserve_a: u64, reserve_b: u64, amount_in: u64) -> Option<BuyFill> {
    let den = u128::from(reserve_b).checked_add(u128::from(amount_in))?;
    if den == 0 {
        return None;
    }
    let out = u128::from(reserve_a).checked_mul(u128::from(amount_in))? / den;
    Some(BuyFill {
        output: u64::try_from(out).ok()?,
        consumed: amount_in,
        next_sqrt_price: 0,
    })
}

/// Compounding pool: `√P` scales with the B reserve, so a √P rise of
/// `half_impact_bps` takes `b × half_impact_bps / 10_000` of B.
pub fn damm_compounding_max_quote_in(reserve_b: u64, max_impact_bps: u16) -> Option<u64> {
    let v = u128::from(reserve_b).checked_mul(u128::from(max_impact_bps))? / 20_000;
    Some(u64::try_from(v).unwrap_or(u64::MAX))
}

/// The √P a slice may reach: `√P × (1 + max_impact_bps / 20_000)`, rounded down,
/// so the price (√P²) rises by about `max_impact_bps`.
pub fn impact_target_sqrt_price(sqrt_price: u128, max_impact_bps: u16) -> Option<u128> {
    let step = mul_div_u256(
        U256::from_u128(sqrt_price),
        U256::from_u128(u128::from(max_impact_bps)),
        U256::from_u128(20_000),
        false,
    )?
    .to_u128()?;
    sqrt_price.checked_add(step)
}

/// The lowest `min_amount_out` the program accepts:
/// `fee_free_out × (10_000 − max_slippage_bps) / 10_000`, rounded up, and
/// never below 1.
pub fn min_out_floor(fee_free_out: u64, max_slippage_bps: u16) -> Option<u64> {
    let keep = BPS_DENOMINATOR.checked_sub(u64::from(max_slippage_bps))?;
    let num = u128::from(fee_free_out).checked_mul(u128::from(keep))?;
    let den = u128::from(BPS_DENOMINATOR);
    let v = num.checked_add(den - 1)? / den;
    Some(u64::try_from(v).ok()?.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    const Q64: u128 = 1 << 64;

    #[test]
    fn delta_formulas_match_hand_values() {
        // L = 2^64 (one unit in Q64), √P from 1.0 to 2.0 (Q64):
        // Δbase = L × (2 − 1)·2^64 / (2^64 × 2·2^64) = 2^64·2^64/2^129 = 0.5 → 0 (down), 1 (up).
        assert_eq!(delta_base(Q64, 2 * Q64, Q64, false), Some(U256::ZERO));
        assert_eq!(
            delta_base(Q64, 2 * Q64, Q64, true),
            Some(U256::from_u128(1))
        );
        // With L = 2^65 × 1e9: Δbase = 1e9.
        let l = 1_000_000_000u128 << 65;
        assert_eq!(
            delta_base(Q64, 2 * Q64, l, false),
            Some(U256::from_u128(1_000_000_000))
        );
        // Δquote = L × Δ√P >> 128 = 1e9 × 2^65 × 2^64 >> 128 = 2e9.
        assert_eq!(
            delta_quote(Q64, 2 * Q64, l, false),
            Some(U256::from_u128(2_000_000_000))
        );
        // And the next price for that much quote is exactly 2.0.
        assert_eq!(
            next_sqrt_from_quote_in(Q64, l, 2_000_000_000),
            Some(2 * Q64)
        );
        assert_eq!(delta_base(2 * Q64, Q64, l, false), None);
        assert_eq!(next_sqrt_from_quote_in(Q64, 0, 1), None);
    }

    #[test]
    fn dbc_buy_walks_segments_and_stops_at_migration() {
        let l = 1_000_000_000u128 << 65;
        let curve = [
            CurvePoint {
                sqrt_price: 2 * Q64,
                liquidity: l,
            },
            CurvePoint {
                sqrt_price: 4 * Q64,
                liquidity: 2 * l,
            },
            CurvePoint::default(),
        ];
        // Inside the first segment: same as one constant-product pool.
        let f = dbc_buy(&curve, Q64, 4 * Q64, 1_000_000_000).unwrap();
        assert_eq!(f.consumed, 1_000_000_000);
        assert_eq!(f.next_sqrt_price, Q64 + Q64 / 2);
        // Δbase = L(1.5−1)/(1×1.5) = 1e9·2·(1/3) = 666,666,666.
        assert_eq!(f.output, 666_666_666);
        // Crossing into segment 2: 2e9 fills segment 1 (1e9 base), then 4e9
        // more in segment 2 (L doubled) moves √P from 2 to 3: Δbase = 2e9·2·(1/6).
        let f = dbc_buy(&curve, Q64, 4 * Q64, 6_000_000_000).unwrap();
        assert_eq!(f.next_sqrt_price, 3 * Q64);
        assert_eq!(f.output, 1_000_000_000 + 666_666_666);
        // Stop at the migration price 3.0: the rest is left (partial fill).
        let f = dbc_buy(&curve, Q64, 3 * Q64, 50_000_000_000).unwrap();
        assert_eq!(f.next_sqrt_price, 3 * Q64);
        assert_eq!(f.consumed, 6_000_000_000);
        // At the stop already: nothing moves.
        let f = dbc_buy(&curve, 3 * Q64, 3 * Q64, 5).unwrap();
        assert_eq!((f.output, f.consumed), (0, 0));
    }

    #[test]
    fn caps_and_floor() {
        let l = 1_000_000_000u128 << 65;
        let curve = [
            CurvePoint {
                sqrt_price: 2 * Q64,
                liquidity: l,
            },
            CurvePoint {
                sqrt_price: 4 * Q64,
                liquidity: 2 * l,
            },
        ];
        // √P may rise 0.5% for 100 bps.
        let target = impact_target_sqrt_price(Q64, 100).unwrap();
        assert_eq!(target, Q64 + Q64 / 200);
        // Δquote = L × 0.005 = 1e9·2·0.005 = 10,000,000, less the Q64 rounding of the target.
        assert_eq!(
            dbc_max_quote_in(&curve, Q64, 4 * Q64, target),
            Some(9_999_999)
        );
        let f = dbc_buy(&curve, Q64, 4 * Q64, 9_999_999).unwrap();
        assert!(f.next_sqrt_price <= target);
        // Across segments, and capped by the stop.
        assert_eq!(
            dbc_max_quote_in(&curve, Q64, 4 * Q64, 3 * Q64),
            Some(6_000_000_000)
        );
        assert_eq!(
            dbc_max_quote_in(&curve, Q64, 2 * Q64, 3 * Q64),
            Some(2_000_000_000)
        );
        // DAMM concentrated.
        assert_eq!(
            damm_concentrated_max_quote_in(Q64, l, u128::MAX, target),
            Some(9_999_999)
        );
        assert_eq!(damm_concentrated_max_quote_in(Q64, l, Q64, target), Some(0));
        let f = damm_concentrated_buy(Q64, l, u128::MAX, 2_000_000_000).unwrap();
        assert_eq!((f.output, f.next_sqrt_price), (1_000_000_000, 2 * Q64));
        assert_eq!(damm_concentrated_buy(Q64, l, Q64 + 1, 2_000_000_000), None);
        // DAMM compounding.
        assert_eq!(
            damm_compounding_buy(1_000, 1_000, 1_000).unwrap().output,
            500
        );
        assert_eq!(
            damm_compounding_max_quote_in(2_000_000_000, 100),
            Some(10_000_000)
        );
        // Floor: 3% below, rounded up, at least 1.
        assert_eq!(min_out_floor(1_000, 300), Some(970));
        assert_eq!(min_out_floor(1_001, 300), Some(971));
        assert_eq!(min_out_floor(0, 300), Some(1));
        assert_eq!(min_out_floor(u64::MAX, 0), Some(u64::MAX));
        assert_eq!(min_out_floor(5, 10_001), None);
    }
}
