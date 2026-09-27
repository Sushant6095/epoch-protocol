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
