use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::CommissionUpdated,
    outbound::vote::{self, CommissionKind},
    state::*,
    vote_account::VoteHeader,
};

#[derive(Accounts)]
pub struct UpdateCommission<'info> {
    pub operator: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
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

    /// CHECK: the vote program.
    #[account(address = VOTE_PROGRAM_ID)]
    pub vote_program: UncheckedAccount<'info>,

    /// Required when the position has a revenue token (its commission floor
    /// applies until the term ends). Pass the program id (`None`) otherwise.
    pub revenue_token: Option<Account<'info, RevenueToken>>,
}

/// The operator keeps control of commission, within covenants: never below
/// the pool minimum, never lower than at origination while an advance is
/// open, and never below its level at registration while a revenue token's
/// term runs (the token's buyers priced that commission; the runtime adds its
/// own one-epoch delay, SIMD-0249).
/// `kind`: 0 = inflation rewards, 1 = block revenue.
pub fn update_commission(
    ctx: Context<UpdateCommission>,
    kind: u8,
    commission_bps: u16,
) -> Result<()> {
    require!(
        u64::from(commission_bps) <= BPS_DENOMINATOR,
        EpochError::BpsOutOfRange
    );
    let position = &mut ctx.accounts.position;
    require!(
        position.status != PositionStatus::Released,
        EpochError::PositionNotActive
    );
    let header = VoteHeader::load(&ctx.accounts.vote_account)?;
    require_keys_eq!(
        header.authorized_withdrawer,
        ctx.accounts.vote_auth.key(),
        EpochError::ProgramNotWithdrawAuthority
    );

    let kind = match kind {
        0 => CommissionKind::InflationRewards,
        1 => CommissionKind::BlockRevenue,
        _ => return err!(EpochError::InvalidParams),
    };
    let current = match kind {
        CommissionKind::InflationRewards => header.inflation_rewards_commission_bps,
        CommissionKind::BlockRevenue => header.block_revenue_commission_bps,
    };
    if kind == CommissionKind::InflationRewards {
        require!(
            commission_bps >= ctx.accounts.pool.params.min_commission_bps,
            EpochError::CommissionTooLow
        );
    }
    if position.has_open_advance() {
        require!(
            commission_bps >= current,
            EpochError::CommissionChangeBlocked
        );
    }
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
            rt.allows_commission(
                Clock::get()?.epoch,
                kind == CommissionKind::BlockRevenue,
                commission_bps
            ),
            EpochError::CommissionBelowSnapshot
        );
    }

    let vote_key = ctx.accounts.vote_account.key();
    let seeds: &[&[u8]] = &[
        VOTE_AUTH_SEED,
        vote_key.as_ref(),
        &[position.vote_auth_bump],
    ];
    vote::update_commission_bps_signed(
        &ctx.accounts.vote_account.to_account_info(),
        &ctx.accounts.vote_auth.to_account_info(),
        kind,
        commission_bps,
        &ctx.accounts.vote_program.to_account_info(),
        &[seeds],
    )?;

    match kind {
        CommissionKind::InflationRewards => position.inflation_commission_bps = commission_bps,
        CommissionKind::BlockRevenue => position.block_commission_bps = commission_bps,
    }

    emit!(CommissionUpdated {
        vote: vote_key,
        kind: kind as u8,
        commission_bps,
    });
    Ok(())
}
