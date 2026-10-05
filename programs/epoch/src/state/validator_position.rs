use anchor_lang::prelude::*;

use crate::constants::REVENUE_WINDOW;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PositionStatus {
    /// Onboarded; may borrow when the score allows.
    Active,
    /// An advance is open and revenue stopped arriving.
    Late,
    /// An advance was written off; every sweep repays the pool until cured.
    Defaulted,
    /// Withdraw authority handed back. Terminal.
    Released,
}

/// One onboarded validator (seeds: `["position", vote]`).
///
/// The program's PDA `["vote_auth", vote]` is the vote account's withdraw
/// authority for as long as this position exists, and `["escrow", vote]` is
/// the system-owned account both commission collectors point at.
#[account]
#[derive(InitSpace)]
pub struct ValidatorPosition {
    pub pool: Pubkey,
    pub vote: Pubkey,
    /// Validator identity (node pubkey) at onboarding. Locked while an
    /// advance is open because `UpdateValidatorIdentity` resets the block
    /// revenue collector.
    pub identity: Pubkey,
    /// Signs operator actions: advances, commission changes, release.
    pub operator: Pubkey,
    /// Receives the validator's share of every sweep.
    pub payout: Pubkey,
    /// Withdraw authority before onboarding; the default target of `release`.
    pub original_withdrawer: Pubkey,
    pub bump: u8,
    pub vote_auth_bump: u8,
    pub escrow_bump: u8,
    pub status: PositionStatus,
    /// Set by the scorer when the validator holds a fee hedge for the epoch.
    pub hedged: bool,

    // ── Score ──
    /// 0..=10,000.
    pub score: u16,
    pub last_scored_epoch: u64,

    // ── Revenue history (ring buffer, newest at `revenue_head - 1`) ──
    pub revenue: [u64; REVENUE_WINDOW],
    pub revenue_head: u8,
    /// Number of filled slots, capped at `REVENUE_WINDOW`.
    pub revenue_count: u8,
    pub last_swept_epoch: u64,
    pub total_swept: u64,
    pub total_remitted: u64,

    // ── Credit ──
    /// Lamports the operator posted as a bond; held in the pool vault.
    pub bond_lamports: u64,
    pub open_advance: Option<Pubkey>,
    /// Monotonic; part of every advance's seeds.
    pub advance_seq: u64,
    /// Consecutive swept epochs with zero revenue while an advance is open.
    pub late_epochs: u8,

    // ── Snapshot at onboarding ──
    pub inflation_commission_bps: u16,
    pub block_commission_bps: u16,
    pub onboarded_epoch: u64,
    /// The validator's `RevenueToken` (`["revenue_token", vote]`), or all
    /// zeros for none. Takes the 32 bytes that were `_reserved`, so the
    /// account size (415) and every other field are unchanged, and positions
    /// onboarded before revenue tokens existed read as "none".
    pub revenue_token: Pubkey,
}

impl ValidatorPosition {
    /// Append one epoch's gross revenue to the ring buffer.
    pub fn push_revenue(&mut self, lamports: u64) {
        let head = usize::from(self.revenue_head) % REVENUE_WINDOW;
        self.revenue[head] = lamports;
        self.revenue_head = ((head + 1) % REVENUE_WINDOW) as u8;
        if usize::from(self.revenue_count) < REVENUE_WINDOW {
            self.revenue_count += 1;
        }
    }

    /// Sum of the filled slots.
    pub fn trailing_revenue(&self) -> u64 {
        self.revenue
            .iter()
            .take(usize::from(self.revenue_count).min(REVENUE_WINDOW))
            .fold(0u64, |acc, v| acc.saturating_add(*v))
    }

    pub fn has_open_advance(&self) -> bool {
        self.open_advance.is_some()
    }

    pub fn has_revenue_token(&self) -> bool {
        self.revenue_token != Pubkey::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> ValidatorPosition {
        ValidatorPosition {
            pool: Pubkey::default(),
            vote: Pubkey::default(),
            identity: Pubkey::default(),
            operator: Pubkey::default(),
            payout: Pubkey::default(),
            original_withdrawer: Pubkey::default(),
            bump: 0,
            vote_auth_bump: 0,
            escrow_bump: 0,
            status: PositionStatus::Active,
            hedged: false,
            score: 0,
            last_scored_epoch: 0,
            revenue: [0; REVENUE_WINDOW],
            revenue_head: 0,
            revenue_count: 0,
            last_swept_epoch: 0,
            total_swept: 0,
            total_remitted: 0,
            bond_lamports: 0,
            open_advance: None,
            advance_seq: 0,
            late_epochs: 0,
            inflation_commission_bps: 0,
            block_commission_bps: 0,
            onboarded_epoch: 0,
            revenue_token: Pubkey::default(),
        }
    }

    #[test]
    fn ring_buffer_keeps_the_last_window_only() {
        let mut p = blank();
        for i in 1..=(REVENUE_WINDOW as u64 + 3) {
            p.push_revenue(i);
        }
        assert_eq!(usize::from(p.revenue_count), REVENUE_WINDOW);
        // Entries 4..=13 remain: sum = 13*14/2 - 3*4/2 = 91 - 6 = 85
        assert_eq!(p.trailing_revenue(), 85);
        assert_eq!(usize::from(p.revenue_head), 3);
    }

    #[test]
    fn partial_history_sums_only_filled_slots() {
        let mut p = blank();
        p.push_revenue(10);
        p.push_revenue(20);
        assert_eq!(p.revenue_count, 2);
        assert_eq!(p.trailing_revenue(), 30);
    }
}
