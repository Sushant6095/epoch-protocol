use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AdvanceState {
    Open,
    Repaid,
    Defaulted,
}

/// One advance to one validator (seeds: `["advance", vote, seq]`).
///
/// Repayment is a flat fee, not interest: `total_due = principal + fee`, and
/// every sweep remits `remit_bps` of gross revenue until `repaid == total_due`.
/// Each remittance is attributed to principal and fee pro rata so the pool's
/// receivable and income ledgers stay exact.
#[account]
#[derive(InitSpace)]
pub struct Advance {
    pub pool: Pubkey,
    pub vote: Pubkey,
    pub position: Pubkey,
    pub seq: u64,
    pub principal: u64,
    pub fee: u64,
    pub total_due: u64,
    pub repaid: u64,
    pub principal_repaid: u64,
    pub fee_repaid: u64,
    pub remit_bps: u16,
    pub opened_epoch: u64,
    pub closed_epoch: u64,
    pub state: AdvanceState,
    pub bump: u8,
    pub _reserved: [u8; 16],
}

impl Advance {
    pub fn outstanding(&self) -> u64 {
        self.total_due.saturating_sub(self.repaid)
    }
    pub fn principal_outstanding(&self) -> u64 {
        self.principal.saturating_sub(self.principal_repaid)
    }
    pub fn fee_outstanding(&self) -> u64 {
        self.fee.saturating_sub(self.fee_repaid)
    }
}
