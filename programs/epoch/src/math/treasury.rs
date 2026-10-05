//! What the partner treasury can claim from a DBC pool, mirrored from the DBC
//! program (`dynamic-bonding-curve` `state/config.rs` and
//! `state/virtual_pool.rs`) so a claim fails fast with Epoch's own error
//! instead of a Meteora one, and so readers can show what is claimable.

use super::mul_div;
use crate::constants::DBC_PARTNER_AND_CREATOR_SURPLUS_SHARE;

/// `a × b / c` in 128-bit, rounded up.
fn mul_div_ceil(a: u64, b: u64, c: u64) -> Option<u64> {
    if c == 0 {
        return None;
    }
    let num = (a as u128).checked_mul(b as u128)?;
    let c = c as u128;
    u64::try_from(num.checked_add(c - 1)?.checked_div(c)?).ok()
}

/// DBC `split_partner_and_creator_fee`: the creator takes
/// `creator_trading_fee_percentage` of `fee` (rounded down), the partner the
/// rest.
pub fn dbc_partner_part(fee: u64, creator_trading_fee_percentage: u8) -> Option<u64> {
    if creator_trading_fee_percentage == 0 {
        return Some(fee);
    }
    let creator = mul_div(fee, u64::from(creator_trading_fee_percentage), 100)?;
    fee.checked_sub(creator)
}

/// DBC `get_partner_surplus`: of the quote raised above the migration
/// threshold, partner and creator share 80% (rounded down; the protocol keeps
/// the rest), split by the creator's trading-fee percentage. `None` while the
/// curve is not complete.
pub fn dbc_partner_surplus(
    quote_reserve: u64,
    migration_quote_threshold: u64,
    creator_trading_fee_percentage: u8,
) -> Option<u64> {
    let total = quote_reserve.checked_sub(migration_quote_threshold)?;
    let partner_and_creator = mul_div(total, DBC_PARTNER_AND_CREATOR_SURPLUS_SHARE, 100)?;
    dbc_partner_part(partner_and_creator, creator_trading_fee_percentage)
}

/// DBC `get_migration_fee_distribution`, partner side: the migration fee is
/// `threshold − ceil(threshold × (100 − migration_fee_percentage) / 100)`;
/// the creator takes `creator_migration_fee_percentage` of it (rounded down)
/// and the partner the rest.
pub fn dbc_partner_migration_fee(
    migration_quote_threshold: u64,
    migration_fee_percentage: u8,
    creator_migration_fee_percentage: u8,
) -> Option<u64> {
    let kept_pct = 100u64.checked_sub(u64::from(migration_fee_percentage))?;
    let quote_amount = mul_div_ceil(migration_quote_threshold, kept_pct, 100)?;
    let fee = migration_quote_threshold.checked_sub(quote_amount)?;
    let creator = mul_div(fee, u64::from(creator_migration_fee_percentage), 100)?;
    fee.checked_sub(creator)
}

/// DBC `withdraw_leftover`: the base vault less the unclaimed base trading
/// fees (partner, protocol, creator) and the protocol's migration base fee.
pub fn dbc_leftover(
    base_vault_amount: u64,
    partner_base_fee: u64,
    protocol_base_fee: u64,
    creator_base_fee: u64,
    protocol_migration_base_fee_amount: u64,
) -> Option<u64> {
    let fees = partner_base_fee
        .checked_add(protocol_base_fee)?
        .checked_add(creator_base_fee)?;
    base_vault_amount
        .checked_sub(fees)?
        .checked_sub(protocol_migration_base_fee_amount)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partner_part_follows_the_creator_percentage() {
        assert_eq!(dbc_partner_part(1_000, 0), Some(1_000));
        assert_eq!(dbc_partner_part(1_000, 50), Some(500));
        // Creator rounds down, so the partner gets the odd lamport.
        assert_eq!(dbc_partner_part(1_001, 50), Some(501));
        assert_eq!(dbc_partner_part(1_000, 100), Some(0));
        assert_eq!(
            dbc_partner_part(u64::MAX, 1),
            Some(u64::MAX - u64::MAX / 100)
        );
    }

    #[test]
    fn surplus() {
        // Not complete: nothing, and not zero (the caller must say "not ready").
        assert_eq!(dbc_partner_surplus(999, 1_000, 0), None);
        assert_eq!(dbc_partner_surplus(1_000, 1_000, 0), Some(0));
        // 1,001 over: 80% = 800.8 → 800 for partner and creator.
        assert_eq!(dbc_partner_surplus(2_001, 1_000, 0), Some(800));
        assert_eq!(dbc_partner_surplus(2_001, 1_000, 50), Some(400));
        assert_eq!(dbc_partner_surplus(2_001, 1_000, 30), Some(560));
        // 0.1 SOL over a 10 SOL threshold, creator 20%: 80,000,000 × 80% = 64,000,000.
        assert_eq!(
            dbc_partner_surplus(10_100_000_000, 10_000_000_000, 20),
            Some(64_000_000)
        );
    }

    #[test]
    fn migration_fee() {
        // Threshold 10 SOL, fee 10%: 1 SOL; creator 50% → partner 0.5 SOL.
        assert_eq!(
            dbc_partner_migration_fee(10_000_000_000, 10, 50),
            Some(500_000_000)
        );
        assert_eq!(dbc_partner_migration_fee(10_000_000_000, 0, 50), Some(0));
        assert_eq!(dbc_partner_migration_fee(10_000_000_000, 10, 100), Some(0));
        // Rounding: threshold 999, fee 7% → quote = ceil(999 × 93 / 100) = 930,
        // fee 69; creator 70% = 48 (floor) → partner 21.
        assert_eq!(dbc_partner_migration_fee(999, 7, 70), Some(21));
        assert_eq!(dbc_partner_migration_fee(1_000, 101, 0), None);
    }

    #[test]
    fn leftover() {
        assert_eq!(dbc_leftover(1_000, 10, 20, 30, 40), Some(900));
        assert_eq!(dbc_leftover(100, 10, 20, 30, 40), Some(0));
        assert_eq!(dbc_leftover(99, 10, 20, 30, 40), None);
        assert_eq!(dbc_leftover(u64::MAX, u64::MAX, 1, 0, 0), None);
    }
}
