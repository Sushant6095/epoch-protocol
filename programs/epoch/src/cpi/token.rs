//! SPL Token CPIs, encoded by hand (one tag byte plus fixed fields) so the
//! program needs no `spl-token`/`anchor-spl` dependency. Tags from the SPL
//! Token `TokenInstruction` enum: `Burn = 8`, `CloseAccount = 9`,
//! `InitializeAccount3 = 18`; and the associated token account program's
//! `CreateIdempotent = 1`.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};

use super::system::create_pda_account;
use crate::constants::{ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_ACCOUNT_LEN, TOKEN_PROGRAM_ID};

const IX_BURN: u8 = 8;
const IX_CLOSE_ACCOUNT: u8 = 9;
const IX_INITIALIZE_ACCOUNT3: u8 = 18;
const IX_ATA_CREATE_IDEMPOTENT: u8 = 1;

/// The SPL Token associated token account of `wallet` for `mint`.
pub fn associated_token_address(wallet: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[wallet.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// Associated token account `CreateIdempotent`: accounts `[payer (s, w),
/// account (w), wallet, mint, system program, token program]`. Creates the
/// account (rent from `payer`) unless it already exists for `wallet` and
/// `mint`.
pub fn create_ata_idempotent_ix(
    payer: &Pubkey,
    account: &Pubkey,
    wallet: &Pubkey,
    mint: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*account, false),
            AccountMeta::new_readonly(*wallet, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        ],
        data: vec![IX_ATA_CREATE_IDEMPOTENT],
    }
}

/// `InitializeAccount3 { owner }`: accounts `[account (w), mint]`, no signer.
pub fn initialize_account3_ix(account: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> Instruction {
    let mut data = Vec::with_capacity(33);
    data.push(IX_INITIALIZE_ACCOUNT3);
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new_readonly(*mint, false),
        ],
        data,
    }
}

/// `CloseAccount`: accounts `[account (w), destination (w), owner (s)]`.
/// Native (wrapped SOL) accounts close with any balance; all lamports go to
/// the destination.
pub fn close_account_ix(account: &Pubkey, destination: &Pubkey, owner: &Pubkey) -> Instruction {
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*owner, true),
        ],
        data: vec![IX_CLOSE_ACCOUNT],
    }
}

/// `Burn { amount }`: accounts `[account (w), mint (w), owner (s)]`.
pub fn burn_ix(account: &Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(IX_BURN);
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(*owner, true),
        ],
        data,
    }
}

/// Create an SPL Token account for `mint` owned by `owner` at a PDA
/// (`account_seeds`), rent paid by `payer` (a transaction signer). Handles an
/// address someone pre-funded (see `create_pda_account`). Returns the lamports
/// `payer` paid.
pub fn create_token_account<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    owner: &Pubkey,
    token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    account_seeds: &[&[u8]],
) -> Result<u64> {
    let paid = create_pda_account(
        payer,
        account,
        TOKEN_ACCOUNT_LEN,
        &TOKEN_PROGRAM_ID,
        system_program,
        account_seeds,
    )?;
    let ix = initialize_account3_ix(account.key, mint.key, owner);
    invoke_signed(
        &ix,
        &[account.clone(), mint.clone(), token_program.clone()],
        &[],
    )?;
    Ok(paid)
}

/// Create `wallet`'s associated token account for `mint` if it does not exist,
/// rent paid by `payer` (a transaction signer).
#[allow(clippy::too_many_arguments)]
pub fn create_ata_idempotent<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    wallet: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    ata_program: &AccountInfo<'info>,
) -> Result<()> {
    let ix = create_ata_idempotent_ix(payer.key, account.key, wallet.key, mint.key);
    invoke_signed(
        &ix,
        &[
            payer.clone(),
            account.clone(),
            wallet.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
            ata_program.clone(),
        ],
        &[],
    )?;
    Ok(())
}

pub fn close_account<'info>(
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let ix = close_account_ix(account.key, destination.key, owner.key);
    invoke_signed(
        &ix,
        &[
            account.clone(),
            destination.clone(),
            owner.clone(),
            token_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

pub fn burn<'info>(
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    amount: u64,
    token_program: &AccountInfo<'info>,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let ix = burn_ix(account.key, mint.key, owner.key, amount);
    invoke_signed(
        &ix,
        &[
            account.clone(),
            mint.clone(),
            owner.clone(),
            token_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(n: u8) -> Pubkey {
        Pubkey::new_from_array([n; 32])
    }

    /// The ATA seeds (wallet, token program, mint) under the ATA program: what
    /// DBC's `associated_token` constraint on `withdraw_leftover` checks. The
    /// localnet run proves it against the real DBC binary.
    #[test]
    fn associated_token_address_uses_the_ata_seeds() {
        let wallet = k(9);
        let mint = k(8);
        let (want, _) = Pubkey::find_program_address(
            &[wallet.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
            &ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        assert_eq!(associated_token_address(&wallet, &mint), want);
    }

    #[test]
    fn encodings() {
        let ix = initialize_account3_ix(&k(1), &k(2), &k(3));
        assert_eq!(ix.program_id, TOKEN_PROGRAM_ID);
        assert_eq!(ix.data[0], 18);
        assert_eq!(&ix.data[1..], k(3).as_ref());
        assert_eq!(
            ix.accounts
                .iter()
                .map(|m| (m.pubkey, m.is_signer, m.is_writable))
                .collect::<Vec<_>>(),
            vec![(k(1), false, true), (k(2), false, false)]
        );

        let ix = close_account_ix(&k(1), &k(4), &k(5));
        assert_eq!(ix.data, vec![9]);
        assert_eq!(
            ix.accounts
                .iter()
                .map(|m| (m.pubkey, m.is_signer, m.is_writable))
                .collect::<Vec<_>>(),
            vec![
                (k(1), false, true),
                (k(4), false, true),
                (k(5), true, false)
            ]
        );

        let ix = create_ata_idempotent_ix(&k(1), &k(2), &k(3), &k(4));
        assert_eq!(ix.program_id, ASSOCIATED_TOKEN_PROGRAM_ID);
        assert_eq!(ix.data, vec![1]);
        assert_eq!(
            ix.accounts
                .iter()
                .map(|m| (m.pubkey, m.is_signer, m.is_writable))
                .collect::<Vec<_>>(),
            vec![
                (k(1), true, true),
                (k(2), false, true),
                (k(3), false, false),
                (k(4), false, false),
                (anchor_lang::system_program::ID, false, false),
                (TOKEN_PROGRAM_ID, false, false)
            ]
        );

        let ix = burn_ix(&k(1), &k(2), &k(5), 0x0102_0304_0506_0708);
        assert_eq!(ix.data, vec![8, 8, 7, 6, 5, 4, 3, 2, 1]);
        assert_eq!(
            ix.accounts
                .iter()
                .map(|m| (m.pubkey, m.is_signer, m.is_writable))
                .collect::<Vec<_>>(),
            vec![
                (k(1), false, true),
                (k(2), false, true),
                (k(5), true, false)
            ]
        );
    }
}
