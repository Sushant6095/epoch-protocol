use anchor_lang::prelude::*;

use crate::{constants::*, errors::EpochError};

/// Governance-set parameters. Every rate is in basis points.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, InitSpace)]
pub struct PoolParams {
    /// Senior tranche target coupon per epoch (4 = 0.04%/epoch ≈ 7.5%/yr at ~182 epochs).
    pub senior_rate_bps_per_epoch: u16,
    /// Share of realised income (fees and recoveries) paid to the treasury.
    pub protocol_fee_bps: u16,
    /// Credit limit as a share of trailing-window revenue, unhedged validators.
    pub advance_bps_unhedged: u16,
    /// Same, for validators hedged on the Fee Market.
    pub advance_bps_hedged: u16,
    /// Credit limit cap as a multiple of the posted bond. 0 disables the bond cap.
    pub bond_multiplier: u8,
    /// Flat fee on principal charged at origination (200 = 2%).
    pub fee_bps: u16,
    /// Share of each epoch's swept revenue that goes to repayment.
    pub remit_bps: u16,
    /// Minimum Epoch Score to borrow (0..=10,000).
    pub min_score: u16,
    /// A score older than this many epochs is stale.
    pub score_ttl_epochs: u16,
    /// Smallest advance, lamports.
    pub min_advance_lamports: u64,
    /// Largest advance per validator, lamports.
    pub max_advance_lamports: u64,
    /// Cap on total lender assets, lamports. 0 = uncapped.
    pub max_pool_assets: u64,
    /// Outstanding principal may not exceed this share of total assets.
    pub max_utilization_bps: u16,
    /// Junior assets must stay at or above this share of total assets.
    pub min_junior_bps: u16,
    /// Epochs a junior deposit is locked before it can be withdrawn.
    pub junior_lock_epochs: u16,
    /// An advance older than this is defaultable even if revenue keeps arriving.
    pub max_advance_epochs: u16,
    /// Lamports left in the vote account on every sweep for the admission
    /// ticket and vote fees (SIMD-0357 VAT).
    pub vote_reserve_lamports: u64,
    /// Validators may not set commission below this while onboarded.
    pub min_commission_bps: u16,
}

impl PoolParams {
    pub fn validate(&self) -> Result<()> {
        let bps = [
            self.senior_rate_bps_per_epoch,
            self.protocol_fee_bps,
            self.advance_bps_unhedged,
            self.advance_bps_hedged,
            self.fee_bps,
            self.remit_bps,
            self.min_score,
            self.max_utilization_bps,
            self.min_junior_bps,
            self.min_commission_bps,
        ];
        require!(
            bps.iter().all(|b| u64::from(*b) <= BPS_DENOMINATOR),
            EpochError::BpsOutOfRange
        );
        require!(self.remit_bps > 0, EpochError::InvalidParams);
        require!(self.max_utilization_bps > 0, EpochError::InvalidParams);
        require!(
            self.advance_bps_hedged >= self.advance_bps_unhedged,
            EpochError::InvalidParams
        );
        require!(
            self.max_advance_lamports >= self.min_advance_lamports,
            EpochError::InvalidParams
        );
        require!(self.max_advance_epochs > 0, EpochError::InvalidParams);
        Ok(())
    }
}

/// The lending pool. One per deployment (seeds: `["pool"]`).
///
/// Ledger invariant, checked by `assert_ledger`:
/// `senior_assets + junior_assets + income_unallocated == cash + outstanding_principal`
/// and the vault holds at least `cash + bond_total + rent`.
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    /// Receives the protocol fee.
    pub treasury: Pubkey,
    /// May post Epoch Scores.
    pub scorer: Pubkey,
    pub params: PoolParams,
    pub bump: u8,
    pub vault_bump: u8,
    pub paused: bool,

    // ── Ledger ──
    /// Lamports in the vault that belong to lenders (excludes bonds and rent).
    pub cash: u64,
    /// Principal lent out and not yet repaid.
    pub outstanding_principal: u64,
    /// Fees contracted on open advances and not yet received.
    pub expected_fees: u64,
    /// Fee income received and not yet split between tranches.
    pub income_unallocated: u64,
    /// Validator bonds held in the vault (not lender money).
    pub bond_total: u64,

    pub senior_assets: u64,
    pub senior_shares: u64,
    pub junior_assets: u64,
    pub junior_shares: u64,
    /// Shares queued for withdrawal, per tranche, so new advances do not
    /// starve queued withdrawals.
    pub senior_pending_shares: u64,
    pub junior_pending_shares: u64,

    // ── Queue ──
    pub withdraw_head: u64,
    pub withdraw_tail: u64,

    // ── Bookkeeping ──
    pub last_accrued_epoch: u64,
    pub validators: u32,
    pub open_advances: u32,
    pub total_advanced: u64,
    pub total_repaid: u64,
    pub total_defaulted: u64,

    pub _reserved: [u8; 64],
}

impl Pool {
    pub fn total_assets(&self) -> Result<u64> {
        self.senior_assets
            .checked_add(self.junior_assets)
            .and_then(|a| a.checked_add(self.income_unallocated))
            .ok_or_else(|| error!(EpochError::MathOverflow))
    }

    /// The accounting identity every mutating instruction must preserve.
    pub fn assert_ledger(&self) -> Result<()> {
        let lhs = self.total_assets()?;
        let rhs = self
            .cash
            .checked_add(self.outstanding_principal)
            .ok_or_else(|| error!(EpochError::MathOverflow))?;
        require!(lhs == rhs, EpochError::VaultLedgerMismatch);
        Ok(())
    }

    /// Lamports the vault must hold: lender cash, validator bonds and rent.
    pub fn required_vault_lamports(&self, rent_exempt_min: u64) -> Result<u64> {
        self.cash
            .checked_add(self.bond_total)
            .and_then(|v| v.checked_add(rent_exempt_min))
            .ok_or_else(|| error!(EpochError::MathOverflow))
    }

    pub fn tranche_mut(&mut self, tranche: super::Tranche) -> (&mut u64, &mut u64, &mut u64) {
        match tranche {
            super::Tranche::Senior => (
                &mut self.senior_assets,
                &mut self.senior_shares,
                &mut self.senior_pending_shares,
            ),
            super::Tranche::Junior => (
                &mut self.junior_assets,
                &mut self.junior_shares,
                &mut self.junior_pending_shares,
            ),
        }
    }

    pub fn tranche(&self, tranche: super::Tranche) -> (u64, u64) {
        match tranche {
            super::Tranche::Senior => (self.senior_assets, self.senior_shares),
            super::Tranche::Junior => (self.junior_assets, self.junior_shares),
        }
    }

    /// Lamports the queued withdrawals would take at today's share prices.
    pub fn pending_withdrawal_value(&self) -> Result<u64> {
        let senior = crate::math::shares_to_assets(
            self.senior_pending_shares,
            self.senior_assets,
            self.senior_shares,
        )
        .ok_or_else(|| error!(EpochError::MathOverflow))?;
        let junior = crate::math::shares_to_assets(
            self.junior_pending_shares,
            self.junior_assets,
            self.junior_shares,
        )
        .ok_or_else(|| error!(EpochError::MathOverflow))?;
        senior
            .checked_add(junior)
            .ok_or_else(|| error!(EpochError::MathOverflow))
    }

    /// Cash not earmarked for queued withdrawals: what new advances may draw.
    pub fn free_cash(&self) -> Result<u64> {
        Ok(self.cash.saturating_sub(self.pending_withdrawal_value()?))
    }

    /// The junior floor: junior assets must be at least `min_junior_bps` of
    /// total tranche assets whenever senior holds anything. Checked on senior
    /// deposits and junior withdrawals; disabled when the parameter is zero.
    pub fn junior_floor_holds(&self, senior_assets: u64, junior_assets: u64) -> Result<bool> {
        if self.params.min_junior_bps == 0 || senior_assets == 0 {
            return Ok(true);
        }
        let ratio = crate::math::junior_ratio_bps(senior_assets, junior_assets)
            .ok_or_else(|| error!(EpochError::MathOverflow))?;
        Ok(ratio >= u64::from(self.params.min_junior_bps))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool() -> Pool {
        Pool {
            admin: Pubkey::default(),
            treasury: Pubkey::default(),
            scorer: Pubkey::default(),
            params: PoolParams {
                min_junior_bps: 1_000,
                ..PoolParams::default()
            },
            bump: 0,
            vault_bump: 0,
            paused: false,
            cash: 1_000_000,
            outstanding_principal: 500_000,
            expected_fees: 0,
            income_unallocated: 0,
            bond_total: 0,
            senior_assets: 1_200_000,
            senior_shares: 1_200_000,
            junior_assets: 300_000,
            junior_shares: 300_000,
            senior_pending_shares: 0,
            junior_pending_shares: 0,
            withdraw_head: 0,
            withdraw_tail: 0,
            last_accrued_epoch: 0,
            validators: 0,
            open_advances: 0,
            total_advanced: 0,
            total_repaid: 0,
            total_defaulted: 0,
            _reserved: [0; 64],
        }
    }

    #[test]
    fn ledger_identity_holds_and_breaks() {
        let mut p = pool();
        assert!(p.assert_ledger().is_ok());
        p.cash -= 1;
        assert!(p.assert_ledger().is_err());
    }

    #[test]
    fn free_cash_excludes_queued_withdrawals() {
        let mut p = pool();
        assert_eq!(p.free_cash().unwrap(), 1_000_000);
        p.senior_pending_shares = 600_000;
        let free = p.free_cash().unwrap();
        // 600,000 shares at just under 1.0 (virtual offset) → ~599,500
        // lamports reserved, so a little over 400,000 stays free.
        assert!((400_000..=401_000).contains(&free), "free={free}");
    }

    #[test]
    fn junior_floor() {
        let p = pool();
        assert!(p.junior_floor_holds(900_000, 100_000).unwrap());
        assert!(!p.junior_floor_holds(950_000, 50_000).unwrap());
        assert!(p.junior_floor_holds(0, 0).unwrap());
        let mut off = pool();
        off.params.min_junior_bps = 0;
        assert!(off.junior_floor_holds(1, 0).unwrap());
    }
}
