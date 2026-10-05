use anchor_lang::prelude::*;
use solana_sysvar::epoch_rewards::EpochRewards;

use crate::{
    constants::*,
    cpi::{system::transfer_from_pda, vote},
    errors::EpochError,
    events::{AdvanceRepaid, RevenueShareSwept, Swept},
    math::{attribute_repayment, split_sweep_with_share},
    state::*,
    vote_account::VoteHeader,
};

#[derive(Accounts)]
pub struct Sweep<'info> {
    /// Anyone may sweep; the keeper does it every epoch.
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        seeds = [POSITION_SEED, vote_account.key().as_ref()],
        bump = position.bump,
        has_one = pool,
    )]
    pub position: Account<'info, ValidatorPosition>,

    /// CHECK: owner checked; state parsed in the handler.
    #[account(mut, owner = VOTE_PROGRAM_ID @ EpochError::NotAVoteAccount)]
    pub vote_account: UncheckedAccount<'info>,

    /// CHECK: program signer, the vote account's withdraw authority.
    #[account(seeds = [VOTE_AUTH_SEED, vote_account.key().as_ref()], bump = position.vote_auth_bump)]
    pub vote_auth: UncheckedAccount<'info>,

    #[account(mut, seeds = [ESCROW_SEED, vote_account.key().as_ref()], bump = position.escrow_bump)]
    pub escrow: SystemAccount<'info>,

    /// CHECK: the validator's payout account.
    #[account(mut, address = position.payout @ EpochError::PayoutMismatch)]
    pub payout: UncheckedAccount<'info>,

    /// Required when the position has an open advance.
    #[account(mut)]
    pub advance: Option<Account<'info, Advance>>,

    /// CHECK: the vote program.
    #[account(address = VOTE_PROGRAM_ID)]
    pub vote_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,

    /// Required when the position has a revenue token (`position.revenue_token`):
    /// its `RevenueToken`. Pass the program id (Anchor's `None`) otherwise.
    #[account(mut)]
    pub revenue_token: Option<Account<'info, RevenueToken>>,

    /// CHECK: required with `revenue_token`: its buyback escrow
    /// `["buyback", vote]` (checked against the recorded bump in the handler).
    #[account(mut)]
    pub buyback_escrow: Option<UncheckedAccount<'info>>,
}

/// The heart of the protocol. Once per epoch, after rewards distribution:
///
/// 1. withdraw everything above the vote account's floor (rent + pending
///    delegator rewards + the admission-ticket reserve) into the escrow;
/// 2. take the escrow balance above rent as this epoch's gross revenue
///    (it also holds whatever the collectors deposited);
/// 3. with a revenue token in its term, move `share_bps` of it to the token's
///    buyback escrow first (after the remittance instead, while an advance
///    that predates the token is open: its lenders underwrote gross revenue);
/// 4. remit `remit_bps` of the rest to the pool while an advance is open (all
///    of it while defaulted), the rest to the validator's payout account;
/// 5. attribute the remittance to principal and fee, close the advance when
///    it is paid, and record the epoch's revenue **net of the share** for the
///    credit limit (the share never repays anything, so an advance is sized on
///    what is left).
///
/// A position with a revenue token must pass its `RevenueToken` and escrow:
/// leaving them out fails with `RevenueTokenAccountsMissing`, so a cranker
/// cannot skip the share.
pub fn sweep(ctx: Context<Sweep>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    require!(
        position.status != PositionStatus::Released,
        EpochError::PositionNotActive
    );

    let epoch = Clock::get()?.epoch;
    require!(
        position.last_swept_epoch < epoch,
        EpochError::AlreadySweptThisEpoch
    );
    // Stake rewards are still being paid out in the first blocks of an epoch
    // (SIMD-0118); a sweep before that finishes could see a partial state.
    if let Ok(rewards) = EpochRewards::get() {
        require!(!rewards.active, EpochError::RewardsInProgress);
    }

    let header = VoteHeader::load(&ctx.accounts.vote_account)?;
    require_keys_eq!(
        header.authorized_withdrawer,
        ctx.accounts.vote_auth.key(),
        EpochError::ProgramNotWithdrawAuthority
    );
    require_keys_eq!(
        header.node_pubkey,
        position.identity,
        EpochError::IdentityMismatch
    );

    // ── 1. Vote account → escrow ──
    let rent = Rent::get()?;
    let vote_floor = rent
        .minimum_balance(ctx.accounts.vote_account.data_len())
        .checked_add(header.pending_delegator_rewards)
        .and_then(|v| v.checked_add(pool.params.vote_reserve_lamports))
        .ok_or(EpochError::MathOverflow)?;
    let from_vote = ctx
        .accounts
        .vote_account
        .lamports()
        .saturating_sub(vote_floor);
    let vote_key = ctx.accounts.vote_account.key();
    if from_vote > 0 {
        let seeds: &[&[u8]] = &[
            VOTE_AUTH_SEED,
            vote_key.as_ref(),
            &[position.vote_auth_bump],
        ];
        vote::withdraw_signed(
            &ctx.accounts.vote_account.to_account_info(),
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.vote_auth.to_account_info(),
            from_vote,
            &ctx.accounts.vote_program.to_account_info(),
            &[seeds],
        )?;
    }

    // ── 2. Gross revenue ──
    let gross = ctx
        .accounts
        .escrow
        .lamports()
        .saturating_sub(rent.minimum_balance(0));

    // ── 3. Revenue token ──
    // (share_bps this sweep, the token's advance cut-off, the escrow)
    let revenue_token = if position.has_revenue_token() {
        let (Some(rt), Some(buyback)) = (
            ctx.accounts.revenue_token.as_ref(),
            ctx.accounts.buyback_escrow.as_ref(),
        ) else {
            return err!(EpochError::RevenueTokenAccountsMissing);
        };
        require_keys_eq!(
            rt.key(),
            position.revenue_token,
            EpochError::RevenueTokenMismatch
        );
        let expected = Pubkey::create_program_address(
            &[BUYBACK_SEED, vote_key.as_ref(), &[rt.escrow_bump]],
            ctx.program_id,
        )
        .map_err(|_| error!(EpochError::RevenueTokenMismatch))?;
        require_keys_eq!(buyback.key(), expected, EpochError::RevenueTokenMismatch);
        let share_bps = if rt.in_term(epoch) { rt.share_bps } else { 0 };
        Some((
            share_bps,
            rt.advance_seq_at_registration,
            buyback.to_account_info(),
        ))
    } else {
        None
    };

    // ── 4. Split ──
    let (outstanding, remit_bps, full_remit, advance_seq) =
        match (position.open_advance, ctx.accounts.advance.as_ref()) {
            (Some(expected), Some(adv)) => {
                require_keys_eq!(adv.key(), expected, EpochError::AdvanceMismatch);
                require!(
                    adv.state != AdvanceState::Repaid,
                    EpochError::AdvanceStateInvalid
                );
                (
                    adv.outstanding(),
                    adv.remit_bps,
                    position.status == PositionStatus::Defaulted,
                    Some(adv.seq),
                )
            }
            (Some(_), None) => return err!(EpochError::AdvanceMismatch),
            (None, _) => (0, 0, false, None),
        };
    let (share_bps, senior_advance) = match (&revenue_token, advance_seq) {
        (Some((bps, cutoff, _)), Some(seq)) => (*bps, seq < *cutoff),
        (Some((bps, _, _)), None) => (*bps, false),
        (None, _) => (0, false),
    };
    let split = split_sweep_with_share(
        gross,
        share_bps,
        outstanding,
        remit_bps,
        full_remit,
        senior_advance,
    )
    .ok_or(EpochError::MathOverflow)?;

    let escrow_seeds: &[&[u8]] = &[ESCROW_SEED, vote_key.as_ref(), &[position.escrow_bump]];
    if let Some((_, _, buyback)) = &revenue_token {
        transfer_from_pda(
            &ctx.accounts.escrow.to_account_info(),
            buyback,
            &ctx.accounts.system_program.to_account_info(),
            split.share,
            &[escrow_seeds],
        )?;
    }
    transfer_from_pda(
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        split.remit,
        &[escrow_seeds],
    )?;
    transfer_from_pda(
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.payout.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        split.to_operator,
        &[escrow_seeds],
    )?;

    // ── 5. Accounting ──
    if let Some(adv) = ctx.accounts.advance.as_mut() {
        if split.remit > 0 {
            match adv.state {
                AdvanceState::Open => {
                    let (principal_part, fee_part) = attribute_repayment(
                        split.remit,
                        adv.principal_outstanding(),
                        adv.fee_outstanding(),
                    )
                    .ok_or(EpochError::MathOverflow)?;
                    adv.principal_repaid = adv
                        .principal_repaid
                        .checked_add(principal_part)
                        .ok_or(EpochError::MathOverflow)?;
                    adv.fee_repaid = adv
                        .fee_repaid
                        .checked_add(fee_part)
                        .ok_or(EpochError::MathOverflow)?;
                    pool.outstanding_principal = pool
                        .outstanding_principal
                        .checked_sub(principal_part)
                        .ok_or(EpochError::MathOverflow)?;
                    pool.expected_fees = pool
                        .expected_fees
                        .checked_sub(fee_part)
                        .ok_or(EpochError::MathOverflow)?;
                    pool.income_unallocated = pool
                        .income_unallocated
                        .checked_add(fee_part)
                        .ok_or(EpochError::MathOverflow)?;
                }
                AdvanceState::Defaulted => {
                    // Principal was written off at default; every recovery
                    // is income and flows through the waterfall.
                    pool.income_unallocated = pool
                        .income_unallocated
                        .checked_add(split.remit)
                        .ok_or(EpochError::MathOverflow)?;
                }
                AdvanceState::Repaid => return err!(EpochError::AdvanceStateInvalid),
            }
            adv.repaid = adv
                .repaid
                .checked_add(split.remit)
                .ok_or(EpochError::MathOverflow)?;
            pool.cash = pool
                .cash
                .checked_add(split.remit)
                .ok_or(EpochError::MathOverflow)?;
            pool.total_repaid = pool.total_repaid.saturating_add(split.remit);
            position.total_remitted = position.total_remitted.saturating_add(split.remit);

            if adv.outstanding() == 0 {
                adv.state = AdvanceState::Repaid;
                adv.closed_epoch = epoch;
                position.open_advance = None;
                position.status = PositionStatus::Active;
                position.late_epochs = 0;
                pool.open_advances = pool.open_advances.saturating_sub(1);
                emit!(AdvanceRepaid {
                    vote: vote_key,
                    advance: adv.key(),
                    epoch,
                });
            }
        }

        // Late tracking while an advance stays open.
        if adv.state == AdvanceState::Open {
            if gross == 0 {
                position.late_epochs = position.late_epochs.saturating_add(1);
                position.status = PositionStatus::Late;
            } else if position.status == PositionStatus::Late {
                position.late_epochs = 0;
                position.status = PositionStatus::Active;
            }
        }
    }

    // The credit limit and the hedge rule read this ring buffer: net of the share.
    position.push_revenue(gross - split.share);
    position.last_swept_epoch = epoch;
    position.total_swept = position.total_swept.saturating_add(gross);
    if let Some((share_bps, _, buyback)) = &revenue_token {
        let rt = ctx
            .accounts
            .revenue_token
            .as_mut()
            .ok_or(EpochError::RevenueTokenAccountsMissing)?;
        rt.last_share_epoch = epoch;
        rt.total_escrowed = rt.total_escrowed.saturating_add(split.share);
        if *share_bps > 0 {
            emit!(RevenueShareSwept {
                vote: vote_key,
                mint: rt.mint,
                epoch,
                gross,
                share: split.share,
                after_senior_advance: senior_advance,
                escrow_balance: buyback.lamports().saturating_sub(rent.minimum_balance(0)),
            });
        }
    }
    pool.assert_ledger()?;
    require!(
        ctx.accounts.vault.lamports() >= pool.required_vault_lamports(rent.minimum_balance(0))?,
        EpochError::VaultLedgerMismatch
    );

    emit!(Swept {
        pool: pool.key(),
        vote: vote_key,
        epoch,
        from_vote,
        gross,
        remitted: split.remit,
        to_operator: split.to_operator,
    });
    Ok(())
}
