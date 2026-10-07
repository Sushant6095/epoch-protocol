use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::AdvanceOpened,
    math::{bps_of, credit_limit, CreditInputs},
    outbound::system::transfer_from_pda,
    state::*,
};

#[derive(Accounts)]
pub struct RequestAdvance<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, position.vote.as_ref()],
        bump = position.bump,
        has_one = pool,
        has_one = operator @ EpochError::NotOperator,
    )]
    pub position: Account<'info, ValidatorPosition>,

    #[account(
        init,
        payer = operator,
        space = 8 + Advance::INIT_SPACE,
        seeds = [ADVANCE_SEED, position.vote.as_ref(), &position.advance_seq.to_le_bytes()],
        bump,
    )]
    pub advance: Account<'info, Advance>,

    /// CHECK: receives the principal; must be the position's payout account.
    #[account(mut, address = position.payout @ EpochError::PayoutMismatch)]
    pub payout: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Draw an advance against trailing commission. Flat fee, repaid at source
/// by every sweep until `total_due` is met.
pub fn request_advance(ctx: Context<RequestAdvance>, amount: u64) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    let params = pool.params;
    let epoch = Clock::get()?.epoch;

    require!(!pool.paused, EpochError::Paused);
    require!(
        position.status == PositionStatus::Active,
        EpochError::PositionNotActive
    );
    require!(!position.has_open_advance(), EpochError::AdvanceAlreadyOpen);
    require!(position.score >= params.min_score, EpochError::ScoreTooLow);
    require!(
        position.last_scored_epoch > 0
            && epoch
                <= position
                    .last_scored_epoch
                    .saturating_add(u64::from(params.score_ttl_epochs)),
        EpochError::ScoreStale
    );
    require!(
        position.revenue_count >= MIN_REVENUE_HISTORY,
        EpochError::InsufficientHistory
    );
    require!(
        amount >= params.min_advance_lamports,
        EpochError::BelowMinimum
    );

    let limit = credit_limit(&CreditInputs {
        trailing_revenue: position.trailing_revenue(),
        history_epochs: position.revenue_count,
        advance_bps: if position.hedged {
            params.advance_bps_hedged
        } else {
            params.advance_bps_unhedged
        },
        bond_lamports: position.bond_lamports,
        bond_multiplier: params.bond_multiplier,
        cap_lamports: params.max_advance_lamports,
    })
    .ok_or(EpochError::MathOverflow)?;
    require!(amount <= limit, EpochError::OverLimit);

    // Pool-level guards: utilisation and cash not owed to queued withdrawals.
    let new_outstanding = pool
        .outstanding_principal
        .checked_add(amount)
        .ok_or(EpochError::MathOverflow)?;
    let max_outstanding =
        bps_of(pool.total_assets()?, params.max_utilization_bps).ok_or(EpochError::MathOverflow)?;
    require!(
        new_outstanding <= max_outstanding,
        EpochError::UtilizationCapExceeded
    );
    require!(
        pool.free_cash()? >= amount,
        EpochError::InsufficientLiquidity
    );

    let fee = bps_of(amount, params.fee_bps).ok_or(EpochError::MathOverflow)?;
    let total_due = amount.checked_add(fee).ok_or(EpochError::MathOverflow)?;

    // Ledger: cash becomes a receivable; the fee is expected income.
    pool.cash -= amount;
    pool.outstanding_principal = new_outstanding;
    pool.expected_fees = pool
        .expected_fees
        .checked_add(fee)
        .ok_or(EpochError::MathOverflow)?;
    pool.open_advances = pool.open_advances.saturating_add(1);
    pool.total_advanced = pool.total_advanced.saturating_add(amount);
    pool.assert_ledger()?;

    let seq = position.advance_seq;
    position.advance_seq = seq.checked_add(1).ok_or(EpochError::MathOverflow)?;
    position.open_advance = Some(ctx.accounts.advance.key());
    position.late_epochs = 0;

    let advance = &mut ctx.accounts.advance;
    advance.pool = pool.key();
    advance.vote = position.vote;
    advance.position = position.key();
    advance.seq = seq;
    advance.principal = amount;
    advance.fee = fee;
    advance.total_due = total_due;
    advance.repaid = 0;
    advance.principal_repaid = 0;
    advance.fee_repaid = 0;
    advance.remit_bps = params.remit_bps;
    advance.opened_epoch = epoch;
    advance.closed_epoch = 0;
    advance.state = AdvanceState::Open;
    advance.bump = ctx.bumps.advance;

    let pool_key = pool.key();
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[pool.vault_bump]];
    transfer_from_pda(
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.payout.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        amount,
        &[vault_seeds],
    )?;
    let rent_min = Rent::get()?.minimum_balance(0);
    require!(
        ctx.accounts.vault.lamports() >= pool.required_vault_lamports(rent_min)?,
        EpochError::VaultLedgerMismatch
    );

    emit!(AdvanceOpened {
        pool: pool_key,
        vote: position.vote,
        advance: advance.key(),
        seq,
        principal: amount,
        fee,
        remit_bps: params.remit_bps,
        epoch,
    });
    Ok(())
}
