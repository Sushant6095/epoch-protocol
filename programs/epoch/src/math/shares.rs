//! Tranche share accounting with virtual offsets.
//!
//! `price = (assets + VIRTUAL_ASSETS) / (shares + VIRTUAL_SHARES)`. The
//! offsets make the first depositor unable to inflate the share price by
//! donating lamports to the vault, and rounding always goes against the
//! caller: deposits mint fewer shares, redemptions pay fewer assets.

use crate::constants::{VIRTUAL_ASSETS, VIRTUAL_SHARES};

/// Shares minted for `assets` deposited into a tranche. Rounds down.
pub fn assets_to_shares(assets: u64, total_assets: u64, total_shares: u64) -> Option<u64> {
    let num = (assets as u128).checked_mul((total_shares as u128).checked_add(VIRTUAL_SHARES)?)?;
    let den = (total_assets as u128).checked_add(VIRTUAL_ASSETS)?;
    u64::try_from(num.checked_div(den)?).ok()
}

/// Assets paid for `shares` redeemed from a tranche. Rounds down.
pub fn shares_to_assets(shares: u64, total_assets: u64, total_shares: u64) -> Option<u64> {
    let num = (shares as u128).checked_mul((total_assets as u128).checked_add(VIRTUAL_ASSETS)?)?;
    let den = (total_shares as u128).checked_add(VIRTUAL_SHARES)?;
    u64::try_from(num.checked_div(den)?).ok()
}

/// Share price scaled by 1e9, for display and events. Rounds down.
pub fn share_price_e9(total_assets: u64, total_shares: u64) -> Option<u64> {
    let num = ((total_assets as u128).checked_add(VIRTUAL_ASSETS)?).checked_mul(1_000_000_000)?;
    let den = (total_shares as u128).checked_add(VIRTUAL_SHARES)?;
    u64::try_from(num.checked_div(den)?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_deposit_mints_close_to_one_to_one() {
        let shares = assets_to_shares(1_000_000_000, 0, 0).unwrap();
        // (1e9 × 1000) / 1 = 1e12 shares: the virtual offset scales shares
        // by 1000, which is fine; what matters is the round trip.
        let back = shares_to_assets(shares, 1_000_000_000, shares).unwrap();
        assert!(back <= 1_000_000_000);
        assert!(1_000_000_000 - back <= 1);
    }

    #[test]
    fn round_trip_never_pays_more_than_deposited() {
        let cases = [
            (1u64, 0u64, 0u64),
            (7, 13, 5),
            (1_000, 1_000_000, 999_999),
            (123_456_789, 987_654_321, 1_234_567),
        ];
        for (assets, ta, ts) in cases {
            let s = assets_to_shares(assets, ta, ts).unwrap();
            let a = shares_to_assets(s, ta + assets, ts + s).unwrap();
            assert!(a <= assets, "assets={assets} ta={ta} ts={ts} back={a}");
        }
    }

    #[test]
    fn donation_attack_is_unprofitable() {
        // Attacker deposits 1 lamport, then donates 1 SOL to the vault
        // (raising total_assets without minting shares), hoping the victim's
        // deposit rounds to zero shares.
        let attacker_shares = assets_to_shares(1, 0, 0).unwrap();
        let total_assets = 1 + 1_000_000_000; // deposit + donation
        let total_shares = attacker_shares;
        let victim_shares = assets_to_shares(2_000_000_000, total_assets, total_shares).unwrap();
        assert!(victim_shares > 0, "victim must receive shares");
        // Attacker redeems: gets back far less than the 1 SOL donated.
        let attacker_out = shares_to_assets(
            attacker_shares,
            total_assets + 2_000_000_000,
            total_shares + victim_shares,
        )
        .unwrap();
        assert!(
            attacker_out < 1_000_000_000,
            "attack must lose money: got {attacker_out}"
        );
    }

    #[test]
    fn share_price_grows_with_income() {
        let p0 = share_price_e9(1_000, 1_000).unwrap();
        let p1 = share_price_e9(1_100, 1_000).unwrap();
        assert!(p1 > p0);
        assert_eq!(share_price_e9(0, 0).unwrap(), 1_000_000); // 1/1000 × 1e9
    }

    #[test]
    fn overflow_returns_none() {
        assert_eq!(assets_to_shares(u64::MAX, u64::MAX, u64::MAX), None);
    }
}
