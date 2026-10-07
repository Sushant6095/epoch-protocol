//! Property tests for the program's pure arithmetic (`epoch::math`).
//!
//! The unit tests in `src/math` pin worked examples; these check the
//! invariants the protocol relies on over the whole input space:
//! share accounting never lets a caller extract value through rounding,
//! every waterfall conserves lamports, the credit limit respects each of its
//! caps, the score stays in bounds, the revenue-token maths never pays
//! out more than it holds, fee-swap payoffs stay within the posted
//! collateral, and the DBC leftover never includes fees owed to anyone.
//!
//! Run: `cargo test -p epoch --test props` (`PROPTEST_CASES=10000` for a
//! deeper run).

use epoch::constants::{
    BPS_DENOMINATOR, MAX_SCORE, MIN_REVENUE_HISTORY, VIRTUAL_ASSETS, VIRTUAL_SHARES,
};
use epoch::math::{
    absorb_loss, assets_to_shares, attribute_repayment, bps_of, compute_score, credit_limit,
    distribute_income, junior_ratio_bps, redeem_payout, share_price_e9, shares_to_assets,
    slice_budget, slice_due_slot, split_sweep, split_sweep_with_share, CreditInputs, ScoreInputs,
};
use proptest::prelude::*;

/// Lamport amounts up to 10⁹ SOL: far beyond any real pool, small enough that
/// the u128 intermediate products in the share maths cannot overflow.
const MAX_LAMPORTS: u64 = 1_000_000_000 * 1_000_000_000;

fn lamports() -> impl Strategy<Value = u64> {
    prop_oneof![0..=1_000u64, 0..=1_000_000_000u64, 0..=MAX_LAMPORTS]
}

fn bps() -> impl Strategy<Value = u16> {
    0..=BPS_DENOMINATOR as u16
}

/// A tranche state reachable from deposits and redemptions: total shares are
/// within the range the virtual offset produces for the assets held (price
/// between 1e-6 and 1e3 lamports per share, generously).
fn tranche() -> impl Strategy<Value = (u64, u64)> {
    (0..=MAX_LAMPORTS, 1u64..=1_000_000).prop_map(|(assets, price_milli_inv)| {
        let shares = ((assets as u128)
            * (VIRTUAL_SHARES / VIRTUAL_ASSETS)
            * price_milli_inv as u128
            / 1_000)
            .min(u64::MAX as u128 / 2) as u64;
        (assets, shares)
    })
}

/// `(a1 + VA) / (s1 + VS) >= (a0 + VA) / (s0 + VS)`, by cross-multiplication.
fn price_not_lower(a0: u64, s0: u64, a1: u64, s1: u64) -> bool {
    let lhs = (a1 as u128 + VIRTUAL_ASSETS) * (s0 as u128 + VIRTUAL_SHARES);
    let rhs = (a0 as u128 + VIRTUAL_ASSETS) * (s1 as u128 + VIRTUAL_SHARES);
    lhs >= rhs
}

proptest! {
    // ── shares ──────────────────────────────────────────────────────────

    /// Depositing and immediately redeeming never returns more than was put in.
    #[test]
    fn deposit_then_redeem_never_profits((assets, shares) in tranche(), deposit in lamports()) {
        let Some(minted) = assets_to_shares(deposit, assets, shares) else { return Ok(()) };
        let Some(total_shares) = shares.checked_add(minted) else { return Ok(()) };
        let back = shares_to_assets(minted, assets + deposit, total_shares).unwrap();
        prop_assert!(back <= deposit, "deposit {deposit} minted {minted} redeemed {back}");
    }

    /// A deposit never lowers the share price for the existing holders.
    #[test]
    fn deposit_never_dilutes((assets, shares) in tranche(), deposit in lamports()) {
        let Some(minted) = assets_to_shares(deposit, assets, shares) else { return Ok(()) };
        let Some(total_shares) = shares.checked_add(minted) else { return Ok(()) };
        prop_assert!(price_not_lower(assets, shares, assets + deposit, total_shares));
    }

    /// A redemption never pays more than the tranche holds and never lowers the
    /// share price for the holders who stay.
    #[test]
    fn redemption_never_dilutes((assets, shares) in tranche(), part in 0.0f64..=1.0) {
        let redeemed = ((shares as f64) * part) as u64;
        let paid = shares_to_assets(redeemed, assets, shares).unwrap();
        prop_assert!(paid <= assets, "paid {paid} of {assets}");
        prop_assert!(price_not_lower(assets, shares, assets - paid, shares - redeemed));
    }

    /// More assets mint at least as many shares; more shares redeem at least as much.
    #[test]
    fn conversions_are_monotonic((assets, shares) in tranche(), x in lamports(), y in lamports()) {
        let (lo, hi) = if x <= y { (x, y) } else { (y, x) };
        if let (Some(a), Some(b)) = (assets_to_shares(lo, assets, shares), assets_to_shares(hi, assets, shares)) {
            prop_assert!(a <= b);
        }
        let (slo, shi) = (lo.min(shares), hi.min(shares));
        prop_assert!(shares_to_assets(slo, assets, shares).unwrap() <= shares_to_assets(shi, assets, shares).unwrap());
    }

    /// Income credited to a tranche (assets up, shares unchanged) never lowers the price.
    #[test]
    fn share_price_rises_with_income((assets, shares) in tranche(), income in lamports()) {
        let after = share_price_e9(assets.saturating_add(income), shares);
        if let (Some(before), Some(after)) = (share_price_e9(assets, shares), after) {
            prop_assert!(after >= before);
        }
    }

    // ── waterfall ───────────────────────────────────────────────────────

    /// A sweep's gross revenue is split exactly; the pool never takes more than is owed.
    #[test]
    fn sweep_split_conserves(gross in lamports(), outstanding in lamports(), remit_bps in bps(), full in any::<bool>()) {
        let s = split_sweep(gross, outstanding, remit_bps, full).unwrap();
        prop_assert_eq!(s.remit + s.to_operator, gross);
        prop_assert!(s.remit <= outstanding);
        if !full {
            prop_assert!(s.remit <= bps_of(gross, remit_bps).unwrap());
        }
    }

    /// A remittance is attributed exactly, up to what is outstanding, never past either ledger.
    #[test]
    fn repayment_attribution_is_exact(remit in lamports(), principal in lamports(), fee in lamports()) {
        let (p, f) = attribute_repayment(remit, principal, fee).unwrap();
        prop_assert!(p <= principal && f <= fee);
        prop_assert_eq!(p + f, remit.min(principal + fee));
    }

    /// Income is split exactly between the protocol, senior (at most its coupon) and junior.
    #[test]
    fn income_distribution_conserves(
        income in lamports(), senior in lamports(), rate in 0u16..=1_000, epochs in 0u64..=1_000, fee_bps in bps(),
    ) {
        let Some(d) = distribute_income(income, senior, rate, epochs, fee_bps) else { return Ok(()) };
        prop_assert_eq!(d.protocol_fee + d.senior_gain + d.junior_gain, income);
        prop_assert!(d.senior_gain <= bps_of(senior, rate).unwrap() * epochs);
        prop_assert!(d.protocol_fee <= bps_of(income, fee_bps).unwrap());
    }

    /// Losses hit junior first, are conserved, and senior is untouched while junior can absorb them.
    #[test]
    fn losses_hit_junior_first(loss in lamports(), senior in lamports(), junior in lamports()) {
        let (s, j, unabsorbed) = absorb_loss(loss, senior, junior);
        prop_assert_eq!((senior - s) + (junior - j) + unabsorbed, loss);
        if loss <= junior {
            prop_assert_eq!(s, senior);
            prop_assert_eq!(unabsorbed, 0);
        } else {
            prop_assert_eq!(j, 0);
        }
        if loss <= junior + senior {
            prop_assert_eq!(unabsorbed, 0);
        }
    }

    #[test]
    fn junior_ratio_is_bps(senior in lamports(), junior in lamports()) {
        prop_assert!(junior_ratio_bps(senior, junior).unwrap() <= BPS_DENOMINATOR);
    }

    // ── credit limit ────────────────────────────────────────────────────

    /// The limit respects every cap, is zero without enough history, and rises with revenue and bond.
    #[test]
    fn credit_limit_respects_caps(
        revenue in lamports(), history in 0u8..=20, advance_bps in bps(), bond in 0..=MAX_LAMPORTS / 1_000,
        multiplier in 0u8..=10, cap in lamports(), more in lamports(),
    ) {
        let i = CreditInputs {
            trailing_revenue: revenue,
            history_epochs: history,
            advance_bps,
            bond_lamports: bond,
            bond_multiplier: multiplier,
            cap_lamports: cap,
        };
        let limit = credit_limit(&i).unwrap();
        if history < MIN_REVENUE_HISTORY {
            prop_assert_eq!(limit, 0);
        } else {
            prop_assert!(limit <= cap);
            prop_assert!(limit <= bps_of(revenue, advance_bps).unwrap());
            if multiplier > 0 {
                prop_assert!(limit <= bond * u64::from(multiplier));
            }
        }
        let richer = CreditInputs { trailing_revenue: revenue.saturating_add(more), ..i };
        prop_assert!(credit_limit(&richer).unwrap() >= limit);
        let bonded = CreditInputs { bond_lamports: bond.saturating_add(more / 1_000), ..i };
        prop_assert!(credit_limit(&bonded).unwrap() >= limit);
    }

    // ── score ───────────────────────────────────────────────────────────

    /// The score is in 0..=MAX_SCORE, zero when delinquent, at most 5,000 in the
    /// superminority, and never falls when credits rise or commission falls.
    #[test]
    fn score_is_bounded_and_monotonic(
        credits in any::<u16>(), commission in any::<u16>(), active in any::<u16>(),
        superminority in any::<bool>(), d_credits in any::<u16>(), d_commission in any::<u16>(),
    ) {
        let i = ScoreInputs { credits_ratio_bps: credits, commission_bps: commission, epochs_active: active, delinquent: false, superminority };
        let s = compute_score(&i);
        prop_assert!(s <= MAX_SCORE);
        if superminority {
            prop_assert!(s <= 5_000);
        }
        prop_assert_eq!(compute_score(&ScoreInputs { delinquent: true, ..i }), 0);
        let better = ScoreInputs {
            credits_ratio_bps: credits.saturating_add(d_credits),
            commission_bps: commission.saturating_sub(d_commission),
            ..i
        };
        prop_assert!(compute_score(&better) >= s);
    }

    // ── revenue tokens ──────────────────────────────────────────────────

    /// The three-way split conserves gross, the share never exceeds its bps, and a zero share is the plain waterfall.
    #[test]
    fn share_split_conserves(
        gross in lamports(), share_bps in 0u16..=5_000, outstanding in lamports(), remit_bps in bps(),
        full in any::<bool>(), senior in any::<bool>(),
    ) {
        let s = split_sweep_with_share(gross, share_bps, outstanding, remit_bps, full, senior).unwrap();
        prop_assert_eq!(s.share + s.remit + s.to_operator, gross);
        prop_assert!(s.share <= bps_of(gross, share_bps).unwrap());
        prop_assert!(s.remit <= outstanding);
        if share_bps == 0 {
            let plain = split_sweep(gross, outstanding, remit_bps, full).unwrap();
            prop_assert_eq!((s.share, s.remit, s.to_operator), (0, plain.remit, plain.to_operator));
        }
        if senior {
            // An advance that predates the token keeps its full claim on gross.
            prop_assert_eq!(s.remit, split_sweep(gross, outstanding, remit_bps, full).unwrap().remit);
        }
    }

    /// Redemptions never pay more than the escrow, pro rata, and splitting a redemption never pays more.
    #[test]
    fn redeem_pays_pro_rata(escrow in lamports(), circulating in 1..=MAX_LAMPORTS, a in 0.0f64..=1.0, b in 0.0f64..=1.0) {
        let amount = ((circulating as f64) * a) as u64;
        let paid = redeem_payout(escrow, amount, circulating).unwrap();
        prop_assert!(paid <= escrow);
        prop_assert_eq!(redeem_payout(escrow, circulating, circulating).unwrap(), escrow);
        prop_assert!(redeem_payout(escrow, circulating + 1, circulating).is_none());
        // Redeem `amount` in two steps against the shrinking escrow and supply.
        let first = ((amount as f64) * b) as u64;
        let p1 = redeem_payout(escrow, first, circulating).unwrap();
        let p2 = redeem_payout(escrow - p1, amount - first, circulating - first).unwrap_or(0);
        prop_assert!(p1 + p2 <= escrow);
        // Each step rounds down, so two steps stay within one lamport of the one-step pro-rata value.
        let exact = (escrow as u128) * (amount as u128) / (circulating as u128);
        prop_assert!((p1 + p2) as u128 <= exact + 1);
    }

    /// Buyback slices are due inside the window in order, and a slice never spends more than is left or held.
    #[test]
    fn buyback_slices_stay_in_budget(
        slices in 1u8..=32, window in 1u32..=100_000, budget in lamports(), spent in lamports(),
        done in any::<u32>(), escrow in lamports(),
    ) {
        let mut last = 0u64;
        for k in 0..slices {
            let due = slice_due_slot(k, slices, window).unwrap();
            prop_assert!(due < u64::from(window) || window == 0);
            prop_assert!(due >= last);
            last = due;
        }
        prop_assert!(slice_due_slot(slices, slices, window).is_none());
        let done = done & ((1u64 << slices) - 1) as u32;
        if let Some(b) = slice_budget(budget, spent, slices, done, escrow) {
            prop_assert!(b <= escrow);
            prop_assert!(b <= budget.saturating_sub(spent));
        }
    }
}

// ── Fee swaps and treasury claims ────────────────────────────────────────

use epoch::instructions::market::swap::taker_pnl;
use epoch::state::Side;

proptest! {
    /// A swap's payoff never exceeds the collateral either side posted, the
    /// two sides are exact mirrors, a flat index pays nothing, and the payer
    /// of fixed gains exactly when the index rises: settlement can never fail
    /// for lack of funds.
    #[test]
    fn swap_payoff_is_bounded_and_symmetric(
        notional in 1..=MAX_LAMPORTS,
        fixed in 1..=10_000_000u64,
        index in 0..=10_000_000u64,
        max_move in 1..=BPS_DENOMINATOR as u16,
    ) {
        let max_loss = bps_of(notional, max_move).unwrap();
        let pay = taker_pnl(Side::PayFixed, notional, fixed, index, max_loss).unwrap();
        let receive = taker_pnl(Side::ReceiveFixed, notional, fixed, index, max_loss).unwrap();
        prop_assert!(pay.unsigned_abs() <= max_loss);
        prop_assert_eq!(pay, -receive);
        if index == fixed { prop_assert_eq!(pay, 0); }
        if index > fixed { prop_assert!(pay >= 0); }
        if index < fixed { prop_assert!(pay <= 0); }
    }

    /// The payoff is monotonic in the index for the payer of fixed.
    #[test]
    fn swap_payoff_is_monotonic_in_the_index(
        notional in 1..=MAX_LAMPORTS,
        fixed in 1..=10_000_000u64,
        a in 0..=10_000_000u64,
        b in 0..=10_000_000u64,
        max_move in 1..=BPS_DENOMINATOR as u16,
    ) {
        let max_loss = bps_of(notional, max_move).unwrap();
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        let p_lo = taker_pnl(Side::PayFixed, notional, fixed, lo, max_loss).unwrap();
        let p_hi = taker_pnl(Side::PayFixed, notional, fixed, hi, max_loss).unwrap();
        prop_assert!(p_lo <= p_hi);
    }

    /// DBC's leftover never includes fees owed to anyone: it is at most the
    /// vault less every unclaimed fee, and absent when the fees exceed the vault.
    #[test]
    fn dbc_leftover_excludes_every_fee(
        vault in lamports(),
        partner in lamports(),
        protocol in lamports(),
        creator in lamports(),
        migration in lamports(),
    ) {
        let owed = u128::from(partner) + u128::from(protocol) + u128::from(creator) + u128::from(migration);
        match epoch::math::dbc_leftover(vault, partner, protocol, creator, migration) {
            Some(left) => prop_assert_eq!(u128::from(left) + owed, u128::from(vault)),
            None => prop_assert!(owed > u128::from(vault)),
        }
    }
}
