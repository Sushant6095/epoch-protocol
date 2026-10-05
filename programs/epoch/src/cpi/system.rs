//! Lamport movement. Program-derived system accounts (the pool vault and
//! every validator escrow) hold zero data, so the only way to move lamports
//! out of them is a system-program transfer signed with their seeds.

use anchor_lang::{
    prelude::*,
    system_program::{transfer, Transfer},
};

/// Transfer from a PDA that the system program owns.
pub fn transfer_from_pda<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    lamports: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    transfer(
        CpiContext::new_with_signer(
            *system_program.key,
            Transfer {
                from: from.clone(),
                to: to.clone(),
            },
            signer_seeds,
        ),
        lamports,
    )
}

/// Transfer from a transaction signer.
pub fn transfer_from_signer<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    lamports: u64,
) -> Result<()> {
    if lamports == 0 {
        return Ok(());
    }
    transfer(
        CpiContext::new(
            *system_program.key,
            Transfer {
                from: from.clone(),
                to: to.clone(),
            },
        ),
        lamports,
    )
}

/// Lamports above the rent-exempt minimum for a zero-data account.
pub fn spendable(account: &AccountInfo, rent: &Rent) -> u64 {
    account.lamports().saturating_sub(rent.minimum_balance(0))
}

/// Create a rent-exempt account of `space` bytes owned by `owner` at a PDA,
/// paid by `payer` (a transaction signer). Anyone can send lamports to a PDA's
/// address before it exists, which makes a plain `CreateAccount` fail; in that
/// case the account is topped up, allocated and assigned instead, so a dust
/// transfer cannot block the instruction. Returns the lamports `payer` paid.
pub fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    space: usize,
    owner: &Pubkey,
    system_program: &AccountInfo<'info>,
    account_seeds: &[&[u8]],
) -> Result<u64> {
    use anchor_lang::system_program::{
        allocate, assign, create_account, Allocate, Assign, CreateAccount,
    };

    let required = Rent::get()?.minimum_balance(space);
    let current = account.lamports();
    if current == 0 {
        create_account(
            CpiContext::new_with_signer(
                *system_program.key,
                CreateAccount {
                    from: payer.clone(),
                    to: account.clone(),
                },
                &[account_seeds],
            ),
            required,
            space as u64,
            owner,
        )?;
        return Ok(required);
    }
    let top_up = required.saturating_sub(current);
    transfer_from_signer(payer, account, system_program, top_up)?;
    allocate(
        CpiContext::new_with_signer(
            *system_program.key,
            Allocate {
                account_to_allocate: account.clone(),
            },
            &[account_seeds],
        ),
        space as u64,
    )?;
    assign(
        CpiContext::new_with_signer(
            *system_program.key,
            Assign {
                account_to_assign: account.clone(),
            },
            &[account_seeds],
        ),
        owner,
    )?;
    Ok(top_up)
}
