use anchor_lang::prelude::*;

/// Where the token trades, so where buybacks swap.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum RevenueTokenStatus {
    /// On its Meteora Dynamic Bonding Curve: buybacks use DBC `swap2`.
    Curve,
    /// Graduated and synced: buybacks use the DAMM v2 pool's `swap2`.
    Graduated,
}

/// Which Meteora program a buyback slice swapped on (`BuybackExecuted.venue`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum BuybackVenue {
    Dbc,
    DammV2,
}

/// `flags` bit: buybacks paused by the pool admin (the escrow keeps
/// accumulating; `redeem` still works when allowed).
pub const FLAG_BUYBACKS_PAUSED: u8 = 1 << 0;
/// `flags` bit: holders may `redeem` during the term, not only after it (the
/// fallback when buybacks cannot run, ADR 0006).
pub const FLAG_REDEEM_DURING_TERM: u8 = 1 << 1;

/// A validator's revenue token (seeds: `["revenue_token", vote]`).
///
/// The validator sold `share_bps` of its gross revenue for `term_epochs`
/// epochs as an SPL token launched on a Meteora DBC curve. Every sweep in the
/// term moves the share into the buyback escrow `["buyback", vote]`; buyback
/// slices swap it for the token and burn what they buy; after the term (or
/// during it, when the admin allows), holders can `redeem` tokens for a
/// pro-rata share of whatever the escrow still holds.
#[account]
#[derive(InitSpace)]
pub struct RevenueToken {
    pub pool: Pubkey,
    /// The `ValidatorPosition` it was registered on (may be closed after the term).
    pub position: Pubkey,
    pub vote: Pubkey,
    /// Paid the rent at registration; receives it back from `close_revenue_token`.
    pub operator: Pubkey,
    pub mint: Pubkey,
    /// Always SPL Token in v1 (Token-2022 mints are rejected at registration).
    pub token_program: Pubkey,
    pub dbc_pool: Pubkey,
    pub dbc_config: Pubkey,
    /// The DAMM v2 pool the curve graduated to; all zeros until
    /// `sync_revenue_token_pool` verifies and records it.
    pub damm_pool: Pubkey,

    // ── Terms (immutable) ──
    pub share_bps: u16,
    pub term_epochs: u16,
    pub registered_epoch: u64,
    /// First epoch whose sweep pays the share (the epoch after registration).
    pub start_epoch: u64,
    /// `start_epoch + term_epochs`: the first epoch after the term. Release and
    /// commission cuts are blocked until then.
    pub term_end_epoch: u64,
    /// `position.advance_seq` at registration. An advance with a lower `seq`
    /// predates the token and keeps its claim on gross revenue: while it is
    /// open the share is taken after its remittance, not before.
    pub advance_seq_at_registration: u64,
    /// Vote-account commission at registration; neither may go lower during the term.
    pub inflation_commission_bps: u16,
    pub block_commission_bps: u16,

    // ── Bumps ──
    pub bump: u8,
    pub escrow_bump: u8,
    pub tokens_bump: u8,
    pub wsol_bump: u8,

    // ── Buyback parameters (pool admin, `configure_revenue_token`) ──
    pub slices_per_epoch: u8,
    /// Slots from the start of the epoch during which slices may run.
    pub window_slots: u32,
    /// `min_amount_out` must be at least the pool's fee-free output minus this.
    pub max_slippage_bps: u16,
    /// One slice may move the pool price by at most this much.
    pub max_impact_bps: u16,
    /// `FLAG_BUYBACKS_PAUSED | FLAG_REDEEM_DURING_TERM`.
    pub flags: u8,
    pub status: RevenueTokenStatus,

    // ── This epoch's buybacks ──
    /// Epoch the fields below belong to.
    pub buyback_epoch: u64,
    /// Escrow balance (above rent) when the epoch's first slice ran.
    pub epoch_budget: u64,
    pub epoch_spent: u64,
    /// Bit `i` set = slice `i` ran in `buyback_epoch`.
    pub slices_done: u32,
    /// Epoch of the last sweep that ran with this token attached.
    pub last_share_epoch: u64,

    // ── Totals ──
    /// Shares swept into the escrow.
    pub total_escrowed: u64,
    /// SOL spent on buybacks.
    pub total_spent: u64,
    /// Tokens the buybacks received.
    pub total_bought: u64,
    /// Tokens burned by the buybacks (what they bought plus anything else
    /// sent to the buyback token account).
    pub total_burned: u64,
    /// Tokens burned by `redeem`, and the SOL paid for them.
    pub total_redeemed: u64,
    pub total_redeemed_lamports: u64,
    pub buyback_count: u32,
    /// The lowest fee, bps, the token's venues can charge (the DBC curve's
    /// floor or the graduated DAMM v2 pool's fee, from the DBC config at
    /// registration). `max_impact_bps` may not exceed twice it.
    pub fee_floor_bps: u16,
    pub _reserved: [u8; 62],
}

impl RevenueToken {
    /// Share 1–5,000 bps and term 10–1,000 epochs.
    pub fn validate_terms(share_bps: u16, term_epochs: u16) -> Result<()> {
        use crate::{constants::*, errors::EpochError};
        require!(
            (MIN_SHARE_BPS..=MAX_SHARE_BPS).contains(&share_bps),
            EpochError::ShareOutOfRange
        );
        require!(
            (MIN_TERM_EPOCHS..=MAX_TERM_EPOCHS).contains(&term_epochs),
            EpochError::TermOutOfRange
        );
        Ok(())
    }

    /// `release_validator` may hand the withdraw authority back.
    pub fn allows_release(&self, epoch: u64) -> bool {
        !self.term_active(epoch)
    }

    /// `update_commission` may set `kind` to `commission_bps`.
    pub fn allows_commission(&self, epoch: u64, block_revenue: bool, commission_bps: u16) -> bool {
        !self.term_active(epoch) || commission_bps >= self.commission_floor(block_revenue)
    }

    /// The sweep in `epoch` pays the share.
    pub fn in_term(&self, epoch: u64) -> bool {
        epoch >= self.start_epoch && epoch < self.term_end_epoch
    }

    /// Release and commission cuts are blocked (registration through the last
    /// epoch of the term).
    pub fn term_active(&self, epoch: u64) -> bool {
        epoch < self.term_end_epoch
    }

    pub fn graduated(&self) -> bool {
        self.damm_pool != Pubkey::default()
    }

    pub fn buybacks_paused(&self) -> bool {
        self.flags & FLAG_BUYBACKS_PAUSED != 0
    }

    pub fn redeem_open(&self, epoch: u64) -> bool {
        !self.term_active(epoch) || self.flags & FLAG_REDEEM_DURING_TERM != 0
    }

    /// The highest `max_impact_bps` `configure_revenue_token` accepts.
    pub fn max_impact_bound(&self) -> u16 {
        crate::math::max_impact_bound(self.fee_floor_bps)
    }

    /// Whether `close_revenue_token` may run, and where the escrow goes. After
    /// the term, once at most `MAX_CLOSE_DUST_LAMPORTS` remain, everything
    /// returns to the operator. Holders get `REDEEM_GRACE_EPOCHS` after the
    /// term to redeem; after that the token closes whatever the escrow holds,
    /// so a donation cannot keep it open, and the unclaimed SOL becomes pool
    /// income (the operator still gets the rent).
    pub fn close_mode(&self, epoch: u64, escrow_available: u64) -> Option<CloseMode> {
        use crate::constants::{MAX_CLOSE_DUST_LAMPORTS, REDEEM_GRACE_EPOCHS};
        if self.term_active(epoch) {
            None
        } else if escrow_available <= MAX_CLOSE_DUST_LAMPORTS {
            Some(CloseMode::Spent)
        } else if epoch >= self.term_end_epoch.saturating_add(REDEEM_GRACE_EPOCHS) {
            Some(CloseMode::Unclaimed)
        } else {
            None
        }
    }

    /// The commission snapshot for `kind` (0 = inflation rewards, 1 = block revenue).
    pub fn commission_floor(&self, block_revenue: bool) -> u16 {
        if block_revenue {
            self.block_commission_bps
        } else {
            self.inflation_commission_bps
        }
    }
}

/// How `close_revenue_token` empties the escrow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseMode {
    /// Spent down to dust: every lamport to the operator.
    Spent,
    /// The redemption grace period is over: rent to the operator, the rest
    /// to the pool as income.
    Unclaimed,
}

/// Buyback parameters the pool admin may change (never the share or the term).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuybackParams {
    pub slices_per_epoch: u8,
    pub window_slots: u32,
    pub max_slippage_bps: u16,
    pub max_impact_bps: u16,
    pub flags: u8,
}

impl Default for BuybackParams {
    fn default() -> Self {
        use crate::constants::*;
        Self {
            slices_per_epoch: DEFAULT_BUYBACK_SLICES,
            window_slots: DEFAULT_BUYBACK_WINDOW_SLOTS,
            max_slippage_bps: DEFAULT_MAX_SLIPPAGE_BPS,
            max_impact_bps: DEFAULT_MAX_IMPACT_BPS,
            flags: 0,
        }
    }
}

impl BuybackParams {
    /// Slices 1..=32, at least one slot per slice, slippage and impact inside
    /// their bounds, no unknown flag bits.
    pub fn is_valid(&self) -> bool {
        use crate::constants::*;
        (1..=MAX_BUYBACK_SLICES).contains(&self.slices_per_epoch)
            && self.window_slots >= u32::from(self.slices_per_epoch)
            && (MIN_MAX_SLIPPAGE_BPS..=MAX_MAX_SLIPPAGE_BPS).contains(&self.max_slippage_bps)
            && (MIN_MAX_IMPACT_BPS..=MAX_MAX_IMPACT_BPS).contains(&self.max_impact_bps)
            && self.flags & !(FLAG_BUYBACKS_PAUSED | FLAG_REDEEM_DURING_TERM) == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{errors::EpochError, state::ValidatorPosition};

    fn token(start_epoch: u64, term: u16) -> RevenueToken {
        RevenueToken {
            pool: Pubkey::default(),
            position: Pubkey::default(),
            vote: Pubkey::default(),
            operator: Pubkey::default(),
            mint: Pubkey::default(),
            token_program: Pubkey::default(),
            dbc_pool: Pubkey::default(),
            dbc_config: Pubkey::default(),
            damm_pool: Pubkey::default(),
            share_bps: 1_000,
            term_epochs: term,
            registered_epoch: start_epoch - 1,
            start_epoch,
            term_end_epoch: start_epoch + u64::from(term),
            advance_seq_at_registration: 0,
            inflation_commission_bps: 500,
            block_commission_bps: 1_000,
            bump: 0,
            escrow_bump: 0,
            tokens_bump: 0,
            wsol_bump: 0,
            slices_per_epoch: 12,
            window_slots: 9_000,
            max_slippage_bps: 300,
            max_impact_bps: 100,
            flags: 0,
            status: RevenueTokenStatus::Curve,
            buyback_epoch: 0,
            epoch_budget: 0,
            epoch_spent: 0,
            slices_done: 0,
            last_share_epoch: 0,
            total_escrowed: 0,
            total_spent: 0,
            total_bought: 0,
            total_burned: 0,
            total_redeemed: 0,
            total_redeemed_lamports: 0,
            buyback_count: 0,
            fee_floor_bps: 100,
            _reserved: [0; 62],
        }
    }

    #[test]
    fn sizes_stay_put() {
        // The SDK, the indexer and deployed decoders rely on 415.
        assert_eq!(8 + ValidatorPosition::INIT_SPACE, 415);
        assert_eq!(8 + RevenueToken::INIT_SPACE, 503);
    }

    #[test]
    fn terms_are_bounded() {
        let code = |r: Result<()>| match r {
            Ok(()) => None,
            Err(anchor_lang::error::Error::AnchorError(e)) => Some(e.error_code_number),
            Err(_) => Some(0),
        };
        let share = u32::from(EpochError::ShareOutOfRange);
        let term = u32::from(EpochError::TermOutOfRange);
        assert_eq!(code(RevenueToken::validate_terms(1, 10)), None);
        assert_eq!(code(RevenueToken::validate_terms(5_000, 1_000)), None);
        assert_eq!(code(RevenueToken::validate_terms(0, 100)), Some(share));
        assert_eq!(code(RevenueToken::validate_terms(5_001, 100)), Some(share));
        assert_eq!(code(RevenueToken::validate_terms(100, 9)), Some(term));
        assert_eq!(code(RevenueToken::validate_terms(100, 1_001)), Some(term));
    }

    #[test]
    fn the_term_gates_the_share_release_commission_and_redeem() {
        // Registered in epoch 99: term covers sweeps 100..=109, ends at 110.
        let mut rt = token(100, 10);
        assert!(!rt.in_term(99) && rt.in_term(100) && rt.in_term(109) && !rt.in_term(110));
        // Release is blocked from registration until the term ends.
        assert!(!rt.allows_release(99) && !rt.allows_release(109) && rt.allows_release(110));
        // Commission: never below the snapshot during the term, either kind.
        assert!(!rt.allows_commission(105, false, 499));
        assert!(rt.allows_commission(105, false, 500));
        assert!(!rt.allows_commission(105, true, 999));
        assert!(rt.allows_commission(105, true, 1_000));
        assert!(rt.allows_commission(110, false, 0));
        // Redeem: after the term, or during it when the admin opened it.
        assert!(!rt.redeem_open(105) && rt.redeem_open(110));
        rt.flags = FLAG_REDEEM_DURING_TERM;
        assert!(rt.redeem_open(105));
        assert!(!rt.buybacks_paused());
        rt.flags |= FLAG_BUYBACKS_PAUSED;
        assert!(rt.buybacks_paused());
        assert!(!rt.graduated());
        rt.damm_pool = Pubkey::new_from_array([1; 32]);
        assert!(rt.graduated());
    }

    #[test]
    fn close_waits_for_the_spend_or_the_grace_period() {
        use crate::constants::{MAX_CLOSE_DUST_LAMPORTS, REDEEM_GRACE_EPOCHS};
        // Term covers 100..=109.
        let rt = token(100, 10);
        // Never during the term, however empty.
        assert_eq!(rt.close_mode(109, 0), None);
        // After it: dust closes to the operator.
        assert_eq!(
            rt.close_mode(110, MAX_CLOSE_DUST_LAMPORTS),
            Some(CloseMode::Spent)
        );
        // More than dust waits for holders to redeem...
        assert_eq!(rt.close_mode(110, MAX_CLOSE_DUST_LAMPORTS + 1), None);
        assert_eq!(
            rt.close_mode(110 + REDEEM_GRACE_EPOCHS - 1, 5_000_000_000),
            None
        );
        // ...until the grace period ends: a donation cannot keep it open.
        assert_eq!(
            rt.close_mode(110 + REDEEM_GRACE_EPOCHS, 5_000_000_000),
            Some(CloseMode::Unclaimed)
        );
        assert_eq!(
            rt.close_mode(110 + REDEEM_GRACE_EPOCHS, 0),
            Some(CloseMode::Spent)
        );
    }

    #[test]
    fn the_impact_bound_follows_the_fee_floor() {
        let mut rt = token(100, 10);
        rt.fee_floor_bps = 100;
        assert_eq!(rt.max_impact_bound(), 200);
        rt.fee_floor_bps = 10;
        assert_eq!(rt.max_impact_bound(), 20);
    }

    #[test]
    fn default_params_are_valid_and_bounds_hold() {
        let p = BuybackParams::default();
        assert!(p.is_valid());
        assert!(!BuybackParams {
            slices_per_epoch: 0,
            ..p
        }
        .is_valid());
        assert!(!BuybackParams {
            slices_per_epoch: 33,
            ..p
        }
        .is_valid());
        assert!(!BuybackParams {
            window_slots: 11,
            ..p
        }
        .is_valid());
        assert!(BuybackParams {
            window_slots: 12,
            ..p
        }
        .is_valid());
        assert!(!BuybackParams {
            max_slippage_bps: 49,
            ..p
        }
        .is_valid());
        assert!(!BuybackParams {
            max_slippage_bps: 2_001,
            ..p
        }
        .is_valid());
        assert!(!BuybackParams {
            max_impact_bps: 9,
            ..p
        }
        .is_valid());
        assert!(!BuybackParams {
            max_impact_bps: 1_001,
            ..p
        }
        .is_valid());
        assert!(BuybackParams { flags: 3, ..p }.is_valid());
        assert!(!BuybackParams { flags: 4, ..p }.is_valid());
    }
}
