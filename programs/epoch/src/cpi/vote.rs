//! Vote-program instruction encoders and invokers.
//!
//! Wire format is bincode: a `u32` little-endian variant index followed by the
//! variant's fields. Variant indices from `solana-vote-interface` 7.1:
//! `Authorize = 1`, `Withdraw = 3`, `UpdateValidatorIdentity = 4`,
//! `UpdateCommissionCollector = 17`, `UpdateCommissionBps = 18`.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::{invoke, invoke_signed},
    },
};

use crate::constants::VOTE_PROGRAM_ID;

const CLOCK_SYSVAR: Pubkey = pubkey!("SysvarC1ock11111111111111111111111111111111");

const IX_AUTHORIZE: u32 = 1;
const IX_WITHDRAW: u32 = 3;
const IX_UPDATE_VALIDATOR_IDENTITY: u32 = 4;
const IX_UPDATE_COMMISSION_COLLECTOR: u32 = 17;
const IX_UPDATE_COMMISSION_BPS: u32 = 18;

/// `VoteAuthorize::Withdrawer` variant index.
const AUTHORIZE_WITHDRAWER: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum CommissionKind {
    InflationRewards = 0,
    BlockRevenue = 1,
}

// ── Encoders ───────────────────────────────────────────────────────────────

/// `Authorize(new_withdrawer, Withdrawer)`. Signer: the current withdraw
/// authority.
pub fn authorize_withdrawer_ix(
    vote: &Pubkey,
    current_authority: &Pubkey,
    new_authority: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(4 + 32 + 4);
    data.extend_from_slice(&IX_AUTHORIZE.to_le_bytes());
    data.extend_from_slice(new_authority.as_ref());
    data.extend_from_slice(&AUTHORIZE_WITHDRAWER.to_le_bytes());
    Instruction {
        program_id: VOTE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*vote, false),
            AccountMeta::new_readonly(CLOCK_SYSVAR, false),
            AccountMeta::new_readonly(*current_authority, true),
        ],
        data,
    }
}

/// `Withdraw(lamports)` to `to`. Signer: the withdraw authority.
pub fn withdraw_ix(vote: &Pubkey, withdrawer: &Pubkey, lamports: u64, to: &Pubkey) -> Instruction {
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&IX_WITHDRAW.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: VOTE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*vote, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(*withdrawer, true),
        ],
        data,
    }
}

/// `UpdateValidatorIdentity`. Signers: the new identity and the withdraw
/// authority.
pub fn update_validator_identity_ix(
    vote: &Pubkey,
    withdrawer: &Pubkey,
    new_identity: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: VOTE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*vote, false),
            AccountMeta::new_readonly(*new_identity, true),
            AccountMeta::new_readonly(*withdrawer, true),
        ],
        data: IX_UPDATE_VALIDATOR_IDENTITY.to_le_bytes().to_vec(),
    }
}

/// `UpdateCommissionCollector(kind)` (SIMD-0232). The collector must be the
/// vote account or a system-owned, rent-exempt account, and is passed
/// writable. Signer: the withdraw authority.
pub fn update_commission_collector_ix(
    vote: &Pubkey,
    withdrawer: &Pubkey,
    collector: &Pubkey,
    kind: CommissionKind,
) -> Instruction {
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&IX_UPDATE_COMMISSION_COLLECTOR.to_le_bytes());
    data.extend_from_slice(&(kind as u32).to_le_bytes());
    Instruction {
        program_id: VOTE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*vote, false),
            AccountMeta::new(*collector, false),
            AccountMeta::new_readonly(*withdrawer, true),
        ],
        data,
    }
}

/// `UpdateCommissionBps { commission_bps, kind }`. Signer: the withdraw
/// authority. Field order follows the struct declaration: `commission_bps`
/// first, then `kind`.
pub fn update_commission_bps_ix(
    vote: &Pubkey,
    withdrawer: &Pubkey,
    kind: CommissionKind,
    commission_bps: u16,
) -> Instruction {
    let mut data = Vec::with_capacity(10);
    data.extend_from_slice(&IX_UPDATE_COMMISSION_BPS.to_le_bytes());
    data.extend_from_slice(&commission_bps.to_le_bytes());
    data.extend_from_slice(&(kind as u32).to_le_bytes());
    Instruction {
        program_id: VOTE_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*vote, false),
            AccountMeta::new_readonly(*withdrawer, true),
        ],
        data,
    }
}

// ── Invokers ───────────────────────────────────────────────────────────────

/// Hand the withdraw authority to `new_authority`, signed by the current
/// authority (a transaction signer).
pub fn authorize_withdrawer<'info>(
    vote: &AccountInfo<'info>,
    clock: &AccountInfo<'info>,
    current_authority: &AccountInfo<'info>,
    new_authority: &Pubkey,
    vote_program: &AccountInfo<'info>,
) -> Result<()> {
    let ix = authorize_withdrawer_ix(vote.key, current_authority.key, new_authority);
    invoke(
        &ix,
        &[
            vote.clone(),
            clock.clone(),
            current_authority.clone(),
            vote_program.clone(),
        ],
    )?;
    Ok(())
}

/// Hand the withdraw authority from the program PDA to `new_authority`.
pub fn authorize_withdrawer_signed<'info>(
    vote: &AccountInfo<'info>,
    clock: &AccountInfo<'info>,
    vote_auth: &AccountInfo<'info>,
    new_authority: &Pubkey,
    vote_program: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = authorize_withdrawer_ix(vote.key, vote_auth.key, new_authority);
    invoke_signed(
        &ix,
        &[
            vote.clone(),
            clock.clone(),
            vote_auth.clone(),
            vote_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

pub fn withdraw_signed<'info>(
    vote: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    vote_auth: &AccountInfo<'info>,
    lamports: u64,
    vote_program: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = withdraw_ix(vote.key, vote_auth.key, lamports, to.key);
    invoke_signed(
        &ix,
        &[
            vote.clone(),
            to.clone(),
            vote_auth.clone(),
            vote_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

pub fn update_commission_collector_signed<'info>(
    vote: &AccountInfo<'info>,
    collector: &AccountInfo<'info>,
    vote_auth: &AccountInfo<'info>,
    kind: CommissionKind,
    vote_program: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = update_commission_collector_ix(vote.key, vote_auth.key, collector.key, kind);
    invoke_signed(
        &ix,
        &[
            vote.clone(),
            collector.clone(),
            vote_auth.clone(),
            vote_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

pub fn update_commission_bps_signed<'info>(
    vote: &AccountInfo<'info>,
    vote_auth: &AccountInfo<'info>,
    kind: CommissionKind,
    commission_bps: u16,
    vote_program: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = update_commission_bps_ix(vote.key, vote_auth.key, kind, commission_bps);
    invoke_signed(
        &ix,
        &[vote.clone(), vote_auth.clone(), vote_program.clone()],
        signer_seeds,
    )?;
    Ok(())
}

pub fn update_validator_identity_signed<'info>(
    vote: &AccountInfo<'info>,
    new_identity: &AccountInfo<'info>,
    vote_auth: &AccountInfo<'info>,
    vote_program: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = update_validator_identity_ix(vote.key, vote_auth.key, new_identity.key);
    invoke_signed(
        &ix,
        &[
            vote.clone(),
            new_identity.clone(),
            vote_auth.clone(),
            vote_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_vote_interface::{
        instruction::{self as upstream, CommissionKind as UpKind, VoteInstruction},
        state::VoteAuthorize,
    };

    fn k(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }
    fn up(p: &Pubkey) -> solana_pubkey_v4::Pubkey {
        solana_pubkey_v4::Pubkey::new_from_array(p.to_bytes())
    }

    #[test]
    fn authorize_matches_upstream() {
        let ours = authorize_withdrawer_ix(&k(1), &k(2), &k(3));
        let theirs = upstream::authorize(
            &up(&k(1)),
            &up(&k(2)),
            &up(&k(3)),
            VoteAuthorize::Withdrawer,
        );
        assert_eq!(ours.data, theirs.data);
        assert_eq!(ours.program_id.to_bytes(), theirs.program_id.to_bytes());
        assert_eq!(ours.accounts.len(), theirs.accounts.len());
        for (a, b) in ours.accounts.iter().zip(theirs.accounts.iter()) {
            assert_eq!(a.pubkey.to_bytes(), b.pubkey.to_bytes());
            assert_eq!(a.is_signer, b.is_signer);
            assert_eq!(a.is_writable, b.is_writable);
        }
    }

    #[test]
    fn withdraw_matches_upstream() {
        let ours = withdraw_ix(&k(1), &k(2), 987_654_321, &k(4));
        let theirs = upstream::withdraw(&up(&k(1)), &up(&k(2)), 987_654_321, &up(&k(4)));
        assert_eq!(ours.data, theirs.data);
        assert_eq!(
            ours.data,
            bincode::serialize(&VoteInstruction::Withdraw(987_654_321)).unwrap()
        );
        for (a, b) in ours.accounts.iter().zip(theirs.accounts.iter()) {
            assert_eq!(
                (a.pubkey.to_bytes(), a.is_signer, a.is_writable),
                (b.pubkey.to_bytes(), b.is_signer, b.is_writable)
            );
        }
    }

    #[test]
    fn update_identity_matches_upstream() {
        let ours = update_validator_identity_ix(&k(1), &k(2), &k(5));
        let theirs = upstream::update_validator_identity(&up(&k(1)), &up(&k(2)), &up(&k(5)));
        assert_eq!(ours.data, theirs.data);
        for (a, b) in ours.accounts.iter().zip(theirs.accounts.iter()) {
            assert_eq!(
                (a.pubkey.to_bytes(), a.is_signer, a.is_writable),
                (b.pubkey.to_bytes(), b.is_signer, b.is_writable)
            );
        }
    }

    #[test]
    fn collector_matches_upstream_for_both_kinds() {
        for (ours_kind, their_kind) in [
            (CommissionKind::InflationRewards, UpKind::InflationRewards),
            (CommissionKind::BlockRevenue, UpKind::BlockRevenue),
        ] {
            let ours = update_commission_collector_ix(&k(1), &k(2), &k(9), ours_kind);
            let theirs = upstream::update_commission_collector(
                &up(&k(1)),
                &up(&k(2)),
                &up(&k(9)),
                their_kind,
            );
            assert_eq!(ours.data, theirs.data);
            for (a, b) in ours.accounts.iter().zip(theirs.accounts.iter()) {
                assert_eq!(
                    (a.pubkey.to_bytes(), a.is_signer, a.is_writable),
                    (b.pubkey.to_bytes(), b.is_signer, b.is_writable)
                );
            }
        }
    }

    #[test]
    fn commission_bps_matches_upstream() {
        let ours = update_commission_bps_ix(&k(1), &k(2), CommissionKind::BlockRevenue, 750);
        let theirs =
            upstream::update_commission_bps(&up(&k(1)), &up(&k(2)), UpKind::BlockRevenue, 750);
        assert_eq!(ours.data, theirs.data);
        for (a, b) in ours.accounts.iter().zip(theirs.accounts.iter()) {
            assert_eq!(
                (a.pubkey.to_bytes(), a.is_signer, a.is_writable),
                (b.pubkey.to_bytes(), b.is_signer, b.is_writable)
            );
        }
    }
}
