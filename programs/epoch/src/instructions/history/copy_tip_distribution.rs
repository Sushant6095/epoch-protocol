use anchor_lang::prelude::*;

use crate::{
    constants::*, events::TipDistributionCopied, jito_account::DistributionKind, state::*,
};

use super::common::copy_distribution;

#[derive(Accounts)]
pub struct CopyTipDistribution<'info> {
    /// Anyone.
    pub cranker: Signer<'info>,

    #[account(
        mut,
        seeds = [HISTORY_SEED, history.load()?.vote.as_ref()],
        bump = history.load()?.bump,
    )]
    pub history: AccountLoader<'info, ValidatorHistory>,

    /// CHECK: must be `["TIP_DISTRIBUTION_ACCOUNT", vote, epoch]` under Jito's
    /// tip distribution program (checked in the handler); may not exist.
    pub tip_distribution_account: UncheckedAccount<'info>,
}

/// Copy the validator's Jito MEV commission and, once the merkle root is
/// uploaded (early in `epoch + 1`), the epoch's `max_total_claim`. A no-op
/// where the account does not exist (devnet, or no Jito client).
pub fn copy_tip_distribution_account(ctx: Context<CopyTipDistribution>, epoch: u64) -> Result<()> {
    let copied = copy_distribution(
        &ctx.accounts.history,
        &ctx.accounts.tip_distribution_account,
        epoch,
        DistributionKind::Tip,
    )?;
    emit!(TipDistributionCopied {
        vote: copied.vote,
        epoch,
        found: copied.found.is_some(),
        mev_commission_bps: copied.found.map(|a| a.validator_commission_bps),
        mev_earned_lamports: copied.found.and_then(|a| a.max_total_claim),
    });
    Ok(())
}
