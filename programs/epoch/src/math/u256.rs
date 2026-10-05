//! The 256-bit unsigned arithmetic the Meteora curve formulas need
//! (`L × Δ√P / (√P_a × √P_b)`, `(amount << 128) / L`): a full u128 × u128
//! product, add/sub, compare and long division. Small on purpose, so the
//! program needs no big-integer crate; every function is checked.

use core::cmp::Ordering;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct U256 {
    pub hi: u128,
    pub lo: u128,
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for U256 {
    fn cmp(&self, other: &Self) -> Ordering {
        self.hi.cmp(&other.hi).then(self.lo.cmp(&other.lo))
    }
}

const LOW64: u128 = u64::MAX as u128;

impl U256 {
    pub const ZERO: U256 = U256 { hi: 0, lo: 0 };

    pub const fn from_u128(v: u128) -> Self {
        U256 { hi: 0, lo: v }
    }

    /// `v << 128`.
    pub const fn shl128(v: u128) -> Self {
        U256 { hi: v, lo: 0 }
    }

    pub fn is_zero(&self) -> bool {
        self.hi == 0 && self.lo == 0
    }

    /// The exact product of two u128s.
    pub fn mul_u128(a: u128, b: u128) -> Self {
        let (a1, a0) = (a >> 64, a & LOW64);
        let (b1, b0) = (b >> 64, b & LOW64);
        let p00 = a0 * b0;
        let p01 = a0 * b1;
        let p10 = a1 * b0;
        let p11 = a1 * b1;
        // middle = p01 + p10 + (p00 >> 64); each term < 2^128, so track the carry.
        let (mid, carry1) = p01.overflowing_add(p10);
        let (mid, carry2) = mid.overflowing_add(p00 >> 64);
        let carry = u128::from(carry1) + u128::from(carry2);
        let lo = (mid << 64) | (p00 & LOW64);
        let hi = p11 + (mid >> 64) + (carry << 64);
        U256 { hi, lo }
    }

    pub fn checked_add(self, o: Self) -> Option<Self> {
        let (lo, c) = self.lo.overflowing_add(o.lo);
        let hi = self.hi.checked_add(o.hi)?.checked_add(u128::from(c))?;
        Some(U256 { hi, lo })
    }

    pub fn checked_sub(self, o: Self) -> Option<Self> {
        if self < o {
            return None;
        }
        Some(self.wrapping_sub(o))
    }

    fn wrapping_sub(self, o: Self) -> Self {
        let (lo, b) = self.lo.overflowing_sub(o.lo);
        let hi = self.hi.wrapping_sub(o.hi).wrapping_sub(u128::from(b));
        U256 { hi, lo }
    }

    fn bits(&self) -> u32 {
        if self.hi != 0 {
            256 - self.hi.leading_zeros()
        } else {
            128 - self.lo.leading_zeros()
        }
    }

    fn bit(&self, i: u32) -> bool {
        if i >= 128 {
            (self.hi >> (i - 128)) & 1 == 1
        } else {
            (self.lo >> i) & 1 == 1
        }
    }

    fn set_bit(&mut self, i: u32) {
        if i >= 128 {
            self.hi |= 1 << (i - 128);
        } else {
            self.lo |= 1 << i;
        }
    }

    /// `self << 1`, and the bit shifted out.
    fn shl1(self) -> (Self, bool) {
        let out = self.hi >> 127 == 1;
        (
            U256 {
                hi: (self.hi << 1) | (self.lo >> 127),
                lo: self.lo << 1,
            },
            out,
        )
    }

    /// Quotient and remainder; `None` when dividing by zero.
    pub fn div_rem(self, d: Self) -> Option<(Self, Self)> {
        if d.is_zero() {
            return None;
        }
        if self < d {
            return Some((U256::ZERO, self));
        }
        if self.hi == 0 {
            // Both fit in 128 bits (d <= self).
            return Some((
                U256::from_u128(self.lo / d.lo),
                U256::from_u128(self.lo % d.lo),
            ));
        }
        // Restoring long division, one bit at a time. `r < d` holds before
        // each shift, so `2r + 1 < 2d`: one subtraction restores it, and a bit
        // shifted out of the top means `2r >= 2^256 > d`.
        let mut q = U256::ZERO;
        let mut r = U256::ZERO;
        for i in (0..self.bits()).rev() {
            let (shifted, out) = r.shl1();
            r = shifted;
            if self.bit(i) {
                r.lo |= 1;
            }
            if out || r >= d {
                r = r.wrapping_sub(d);
                q.set_bit(i);
            }
        }
        Some((q, r))
    }

    pub fn to_u128(self) -> Option<u128> {
        (self.hi == 0).then_some(self.lo)
    }

    pub fn to_u64(self) -> Option<u64> {
        self.to_u128().and_then(|v| u64::try_from(v).ok())
    }
}

/// `a × b / d` with a 256-bit intermediate, rounded down or up; `None` when
/// `d` is zero.
pub fn mul_div_u256(a: U256, b: U256, d: U256, round_up: bool) -> Option<U256> {
    // a × b where both may be 256-bit: only the u128 × u128 case is needed.
    let prod = if a.hi == 0 && b.hi == 0 {
        U256::mul_u128(a.lo, b.lo)
    } else {
        return None;
    };
    let (q, r) = prod.div_rem(d)?;
    if round_up && !r.is_zero() {
        q.checked_add(U256::from_u128(1))
    } else {
        Some(q)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_is_exact() {
        assert_eq!(U256::mul_u128(0, u128::MAX), U256::ZERO);
        assert_eq!(U256::mul_u128(3, 5), U256::from_u128(15));
        // (2^128 − 1)² = 2^256 − 2^129 + 1
        let m = U256::mul_u128(u128::MAX, u128::MAX);
        assert_eq!(m.hi, u128::MAX - 1);
        assert_eq!(m.lo, 1);
        // 2^64 × 2^64 = 2^128
        assert_eq!(U256::mul_u128(1 << 64, 1 << 64), U256 { hi: 1, lo: 0 });
        let x = 0x1234_5678_9abc_def0_1122_3344_5566_7788u128;
        let y = 0xfedc_ba98_7654_3210_0fed_cba9_8765_4321u128;
        // Python: x*y = 0x1234...(256-bit) checked limb by limb through division.
        let p = U256::mul_u128(x, y);
        let (q, r) = p.div_rem(U256::from_u128(y)).unwrap();
        assert_eq!(q, U256::from_u128(x));
        assert!(r.is_zero());
    }

    #[test]
    fn division_round_trips() {
        let cases = [
            (u128::MAX, u128::MAX, 7u128),
            (1u128 << 100, 3, 1 << 90),
            (987_654_321_987_654_321, 123_456_789, 1_000_003),
            (u128::MAX, 2, u128::MAX - 5),
        ];
        for (a, b, d) in cases {
            let p = U256::mul_u128(a, b);
            let (q, r) = p.div_rem(U256::from_u128(d)).unwrap();
            assert!(r < U256::from_u128(d));
            // q × d + r == p
            let back = if q.hi == 0 {
                U256::mul_u128(q.lo, d).checked_add(r).unwrap()
            } else {
                // q ≥ 2^128: check via (p − r) / q == d instead.
                let (d2, r2) = p.checked_sub(r).unwrap().div_rem(q).unwrap();
                assert!(r2.is_zero());
                assert_eq!(d2, U256::from_u128(d));
                p
            };
            assert_eq!(back, p);
        }
        // A 256-bit divisor with the top bit set.
        let big = U256 {
            hi: 1 << 127,
            lo: 5,
        };
        let (q, r) = U256 {
            hi: u128::MAX,
            lo: u128::MAX,
        }
        .div_rem(big)
        .unwrap();
        assert_eq!(q, U256::from_u128(1));
        assert_eq!(
            r,
            U256 {
                hi: (1 << 127) - 1,
                lo: u128::MAX - 5
            }
        );
        assert!(U256::from_u128(1).div_rem(U256::ZERO).is_none());
    }

    #[test]
    fn mul_div_rounds() {
        let ten = U256::from_u128(10);
        let three = U256::from_u128(3);
        assert_eq!(
            mul_div_u256(ten, U256::from_u128(1), three, false),
            Some(three)
        );
        assert_eq!(
            mul_div_u256(ten, U256::from_u128(1), three, true),
            Some(U256::from_u128(4))
        );
        assert_eq!(
            mul_div_u256(ten, three, U256::from_u128(5), true),
            Some(U256::from_u128(6))
        );
        assert_eq!(mul_div_u256(ten, three, U256::ZERO, false), None);
    }

    #[test]
    fn add_sub_compare() {
        let a = U256 {
            hi: 1,
            lo: u128::MAX,
        };
        let b = U256::from_u128(1);
        assert_eq!(a.checked_add(b), Some(U256 { hi: 2, lo: 0 }));
        assert_eq!(U256 { hi: 2, lo: 0 }.checked_sub(b), Some(a));
        assert_eq!(b.checked_sub(a), None);
        assert!(a > b);
        assert_eq!(
            U256 {
                hi: u128::MAX,
                lo: u128::MAX
            }
            .checked_add(b),
            None
        );
        assert_eq!(a.to_u128(), None);
        assert_eq!(U256::from_u128(u128::from(u64::MAX) + 1).to_u64(), None);
        assert_eq!(U256::shl128(3), U256 { hi: 3, lo: 0 });
    }
}
