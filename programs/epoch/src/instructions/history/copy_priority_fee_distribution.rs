use anchor_lang::prelude::*;

use crate::{
    constants::*, events::PriorityFeeDistributionCopied, jito_account::DistributionKind, state::*,
};

use super::common::copy_distribution;

#[derive(Accounts)]
pub struct CopyPriorityFeeDistribution<'info> {
    /// Anyone.
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [HISTORY_SEED, history.load()?.vote.as_ref()],
        bump = history.load()?.bump,
    )]
    pub history: AccountLoader<'info, ValidatorHistory>,

    /// CHECK: must be `["PF_DISTRIBUTION_ACCOUNT", vote, epoch]` under Jito's
    /// priority fee distribution program (checked in the handler); may not exist.
    pub distribution_account: UncheckedAccount<'info>,
}

/// Copy the commission a validator charges on the block rewards it routes
/// through Jito's priority fee distribution program, and the lamports it has
/// sent there for `epoch` (final once the epoch is over). A no-op where the
/// account does not exist.
pub fn copy_priority_fee_distribution(
    ctx: Context<CopyPriorityFeeDistribution>,
    epoch: u64,
) -> Result<()> {
    let copied = copy_distribution(
        &ctx.accounts.history,
        &ctx.accounts.distribution_account,
        epoch,
        DistributionKind::PriorityFee,
    )?;
    emit!(PriorityFeeDistributionCopied {
        vote: copied.vote,
        epoch,
        found: copied.found.is_some(),
        priority_fee_commission_bps: copied.found.map(|a| a.validator_commission_bps),
        priority_fees_lamports: copied.found.and_then(|a| a.total_lamports_transferred),
    });
    Ok(())
}
