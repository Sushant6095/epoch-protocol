//! Shared by the two Jito copies.
//!
//! Adapted from jito-foundation_stakenet/programs/validator-history/src/instructions/
//! copy_tip_distribution_account.rs and copy_priority_fee_distribution.rs
//! (Apache-2.0): derive the distribution account from (vote, epoch), check its
//! owner, read the commission and the epoch's total. Changed: the program ids
//! are constants rather than admin-settable config; a missing account is a
//! clean no-op (devnet, validators without Jito, accounts closed after expiry)
//! instead of an error or a write of defaults; the account's own vote field is
//! cross-checked; one reader serves both layouts.

use anchor_lang::{prelude::*, system_program};

use crate::{
    constants::*,
    errors::EpochError,
    jito_account::{DistributionAccount, DistributionKind},
    state::*,
};

/// What a copy found: `None` when the account does not exist.
pub struct CopiedDistribution {
    pub vote: Pubkey,
    pub found: Option<DistributionAccount>,
}

/// Check `account` is `kind`'s account for the history's vote account and
/// `epoch`, and copy it into the entry. A missing account writes nothing.
pub fn copy_distribution(
    history: &AccountLoader<ValidatorHistory>,
    account: &AccountInfo,
    epoch: u64,
    kind: DistributionKind,
) -> Result<CopiedDistribution> {
    let clock = Clock::get()?;
    require!(
        epoch <= clock.epoch && epoch >= ValidatorHistory::oldest_writable(clock.epoch),
        EpochError::HistoryEpochOutOfRange
    );
    let mut h = history.load_mut()?;
    let vote = h.vote;

    let (program, seed) = match kind {
        DistributionKind::Tip => (
            JITO_TIP_DISTRIBUTION_PROGRAM_ID,
            TIP_DISTRIBUTION_ACCOUNT_SEED,
        ),
        DistributionKind::PriorityFee => (
            JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID,
            PF_DISTRIBUTION_ACCOUNT_SEED,
        ),
    };
    let (expected, _) =
        Pubkey::find_program_address(&[seed, vote.as_ref(), &epoch.to_le_bytes()], &program);
    require_keys_eq!(
        account.key(),
        expected,
        EpochError::InvalidDistributionAccount
    );

    let found = if *account.owner == program {
        let data = account.try_borrow_data()?;
        let parsed = DistributionAccount::parse(kind, &data)
            .ok_or(EpochError::InvalidDistributionAccount)?;
        require_keys_eq!(
            parsed.validator_vote_account,
            vote,
            EpochError::InvalidDistributionAccount
        );
        Some(parsed)
    } else {
        // Never created, or closed: the address is an empty system account.
        require!(
            *account.owner == system_program::ID && account.data_is_empty(),
            EpochError::InvalidDistributionAccount
        );
        None
    };

    if let Some(a) = found {
        let e = h.entry_mut(epoch)?;
        match kind {
            DistributionKind::Tip => {
                e.mev_commission_bps = a.validator_commission_bps;
                if let Some(total) = a.max_total_claim {
                    e.mev_earned_lamports = total;
                }
                e.sources |= SOURCE_TIP;
            }
            DistributionKind::PriorityFee => {
                e.priority_fee_commission_bps = a.validator_commission_bps;
                if let Some(total) = a.total_lamports_transferred {
                    e.priority_fees_lamports = total;
                }
                e.sources |= SOURCE_PRIORITY_FEE;
            }
        }
        e.updated_slot = clock.slot;
    }
    Ok(CopiedDistribution { vote, found })
}
