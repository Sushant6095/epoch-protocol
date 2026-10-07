use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::ValidatorReleased,
    outbound::{
        system::transfer_from_pda,
        vote::{self, CommissionKind},
    },
    state::*,
    vote_account::{VoteHeader, VoteStateVersion},
};

#[derive(Accounts)]
pub struct ReleaseValidator<'info> {
    /// Receives the escrow balance, the bond and the position's rent.
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        close = operator,
        seeds = [POSITION_SEED, vote_account.key().as_ref()],
        bump = position.bump,
        has_one = pool,
        has_one = operator @ EpochError::NotOperator,
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

    /// CHECK: the key that becomes the withdraw authority. Normally the
    /// position's `original_withdrawer`; the operator may choose another.
    pub new_withdrawer: UncheckedAccount<'info>,

    /// CHECK: the validator identity; needed only to restore the block
    /// revenue collector on v4 vote accounts. Writable: the vote program's
    /// `UpdateCommissionCollector` takes the new collector writable, so a
    /// read-only identity fails the CPI with a privilege escalation once
    /// `set_collectors` pointed the collector at the escrow.
    #[account(mut, address = position.identity @ EpochError::IdentityMismatch)]
    pub identity: UncheckedAccount<'info>,

    pub clock: Sysvar<'info, Clock>,
    /// CHECK: the vote program.
    #[account(address = VOTE_PROGRAM_ID)]
    pub vote_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,

    /// Required when the position has a revenue token: release waits for the
    /// end of its term. Pass the program id (Anchor's `None`) otherwise.
    pub revenue_token: Option<Account<'info, RevenueToken>>,
}

/// Leave Epoch. Allowed only with nothing owed and no revenue token in its
/// term: the collectors go back to their defaults (vote account and
/// identity), the withdraw authority is handed to `new_withdrawer`, and
/// escrow, bond and rent return to the operator. A revenue token outlives the
/// position: holders keep `redeem` (and buybacks) against its escrow.
pub fn release_validator(ctx: Context<ReleaseValidator>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    let position = &ctx.accounts.position;
    require!(!position.has_open_advance(), EpochError::AdvanceOpen);
    require!(
        position.status == PositionStatus::Active,
        EpochError::PositionNotActive
    );
    if position.has_revenue_token() {
        let rt = ctx
            .accounts
            .revenue_token
            .as_ref()
            .ok_or(EpochError::RevenueTokenAccountsMissing)?;
        require_keys_eq!(
            rt.key(),
            position.revenue_token,
            EpochError::RevenueTokenMismatch
        );
        require!(
            rt.allows_release(ctx.accounts.clock.epoch),
            EpochError::RevenueTokenTermActive
        );
    }

    let header = VoteHeader::load(&ctx.accounts.vote_account)?;
    require_keys_eq!(
        header.authorized_withdrawer,
        ctx.accounts.vote_auth.key(),
        EpochError::ProgramNotWithdrawAuthority
    );

    let vote_key = ctx.accounts.vote_account.key();
    let auth_seeds: &[&[u8]] = &[
        VOTE_AUTH_SEED,
        vote_key.as_ref(),
        &[position.vote_auth_bump],
    ];

    // Restore default collectors where they point at the escrow, otherwise
    // commission would keep flowing to an account nobody controls.
    if header.version == VoteStateVersion::V4 {
        if header.inflation_rewards_collector == Some(ctx.accounts.escrow.key()) {
            vote::update_commission_collector_signed(
                &ctx.accounts.vote_account.to_account_info(),
                &ctx.accounts.vote_account.to_account_info(),
                &ctx.accounts.vote_auth.to_account_info(),
                CommissionKind::InflationRewards,
                &ctx.accounts.vote_program.to_account_info(),
                &[auth_seeds],
            )?;
        }
        if header.block_revenue_collector == Some(ctx.accounts.escrow.key()) {
            vote::update_commission_collector_signed(
                &ctx.accounts.vote_account.to_account_info(),
                &ctx.accounts.identity.to_account_info(),
                &ctx.accounts.vote_auth.to_account_info(),
                CommissionKind::BlockRevenue,
                &ctx.accounts.vote_program.to_account_info(),
                &[auth_seeds],
            )?;
        }
    }

    // Hand the withdraw authority back.
    vote::authorize_withdrawer_signed(
        &ctx.accounts.vote_account.to_account_info(),
        &ctx.accounts.clock.to_account_info(),
        &ctx.accounts.vote_auth.to_account_info(),
        ctx.accounts.new_withdrawer.key,
        &ctx.accounts.vote_program.to_account_info(),
        &[auth_seeds],
    )?;

    // Return the bond.
    let bond = position.bond_lamports;
    if bond > 0 {
        pool.bond_total = pool
            .bond_total
            .checked_sub(bond)
            .ok_or(EpochError::MathOverflow)?;
        let pool_key = pool.key();
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[pool.vault_bump]];
        transfer_from_pda(
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.operator.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
            bond,
            &[vault_seeds],
        )?;
    }

    // Empty the escrow (nothing is owed, so it is all the validator's).
    let escrow_seeds: &[&[u8]] = &[ESCROW_SEED, vote_key.as_ref(), &[position.escrow_bump]];
    transfer_from_pda(
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.operator.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        ctx.accounts.escrow.lamports(),
        &[escrow_seeds],
    )?;

    pool.validators = pool.validators.saturating_sub(1);

    emit!(ValidatorReleased {
        pool: pool.key(),
        vote: vote_key,
        new_withdrawer: ctx.accounts.new_withdrawer.key(),
        epoch: ctx.accounts.clock.epoch,
    });
    Ok(())
}
