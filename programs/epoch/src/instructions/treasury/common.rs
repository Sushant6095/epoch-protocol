//! What the treasury claims share: the DBC checks, the one-claim wrapped-SOL
//! account, the treasury's token account and its burn, and the pool credit.

use anchor_lang::{prelude::*, solana_program::program::invoke};

use crate::{
    constants::*,
    cpi::{
        system::{create_pda_account, transfer_from_pda},
        token::{
            associated_token_address, burn, close_account, create_ata_idempotent,
            initialize_account3_ix,
        },
    },
    errors::EpochError,
    meteora_account::{DbcPartnerTerms, DbcPool, SplTokenAccount, DBC_TOKEN_TYPE_SPL},
    state::Pool,
};

/// A DBC pool and its config, checked for a treasury claim: the pool is the
/// config's, both are SPL Token, and the quote is wrapped SOL.
pub struct DbcSource {
    pub pool: DbcPool,
    pub terms: DbcPartnerTerms,
}

impl DbcSource {
    pub fn load(pool: &AccountInfo, config: &AccountInfo) -> Result<Self> {
        let dbc_pool = DbcPool::load(pool)?;
        let terms = DbcPartnerTerms::load(config)?;
        require_keys_eq!(
            dbc_pool.config,
            config.key(),
            EpochError::InvalidClaimAccount
        );
        require!(
            dbc_pool.pool_type == DBC_TOKEN_TYPE_SPL
                && terms.token_type == DBC_TOKEN_TYPE_SPL
                && terms.quote_mint == NATIVE_MINT
                && terms.quote_token_flag == DBC_TOKEN_TYPE_SPL,
            EpochError::UnsupportedClaimPool
        );
        Ok(Self {
            pool: dbc_pool,
            terms,
        })
    }

    /// DBC only lets the config's fee claimer claim partner fees, surplus and
    /// the migration fee; checked here first for a clear error.
    pub fn require_fee_claimer(&self, treasury: &Pubkey) -> Result<()> {
        require_keys_eq!(
            self.terms.fee_claimer,
            *treasury,
            EpochError::NotTreasuryFeeClaimer
        );
        Ok(())
    }

    pub fn require_quote_vault(&self, quote_vault: &AccountInfo) -> Result<()> {
        require_keys_eq!(
            self.pool.quote_vault,
            quote_vault.key(),
            EpochError::InvalidClaimAccount
        );
        Ok(())
    }

    pub fn require_base(&self, base_mint: &AccountInfo, base_vault: &AccountInfo) -> Result<()> {
        require_keys_eq!(
            self.pool.base_mint,
            base_mint.key(),
            EpochError::InvalidClaimAccount
        );
        require_keys_eq!(
            self.pool.base_vault,
            base_vault.key(),
            EpochError::InvalidClaimAccount
        );
        Ok(())
    }

    pub fn curve_complete(&self) -> bool {
        self.pool.quote_reserve >= self.terms.migration_quote_threshold
    }
}

/// A token account a claim uses.
#[derive(Clone, Copy, Debug)]
pub struct Opened {
    /// Lamports the cranker paid to create it (refunded when the claim closes it).
    pub cranker_paid: u64,
    /// This claim created it, so it closes it again.
    pub created: bool,
    /// Its token amount before the claim.
    pub amount_before: u64,
}

/// The treasury and the accounts that pay for a claim.
pub struct ClaimSigner<'a, 'info> {
    pub cranker: &'a AccountInfo<'info>,
    pub treasury: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    /// `["treasury", pool, bump]`.
    pub treasury_seeds: &'a [&'a [u8]],
}

impl<'info> ClaimSigner<'_, 'info> {
    /// Create the one-claim wrapped-SOL account at `["treasury_wsol", pool]`,
    /// owned by the treasury, with the cranker fronting its rent. Lamports
    /// someone already sent to the address are kept (and end up in the pool).
    pub fn open_wsol(
        &self,
        wsol: &AccountInfo<'info>,
        wsol_mint: &AccountInfo<'info>,
        wsol_seeds: &[&[u8]],
    ) -> Result<Opened> {
        let cranker_paid = create_pda_account(
            self.cranker,
            wsol,
            TOKEN_ACCOUNT_LEN,
            &TOKEN_PROGRAM_ID,
            self.system_program,
            wsol_seeds,
        )?;
        invoke(
            &initialize_account3_ix(wsol.key, &NATIVE_MINT, self.treasury.key),
            &[wsol.clone(), wsol_mint.clone(), self.token_program.clone()],
        )?;
        Ok(Opened {
            cranker_paid,
            created: true,
            amount_before: SplTokenAccount::load(wsol)?.amount,
        })
    }

    /// Unwrap into the pool: close the wrapped-SOL account into the vault and
    /// refund the cranker's rent from it. Returns `(claimed, to_pool)`: the
    /// wrapped SOL Meteora paid, and the lamports the vault kept.
    pub fn settle_wsol(
        &self,
        wsol: &AccountInfo<'info>,
        opened: &Opened,
        vault: &AccountInfo<'info>,
        vault_seeds: &[&[u8]],
    ) -> Result<(u64, u64)> {
        let claimed = SplTokenAccount::load(wsol)?
            .amount
            .checked_sub(opened.amount_before)
            .ok_or(EpochError::MathOverflow)?;
        let vault_before = vault.lamports();
        close_account(
            wsol,
            vault,
            self.treasury,
            self.token_program,
            &[self.treasury_seeds],
        )?;
        transfer_from_pda(
            vault,
            self.cranker,
            self.system_program,
            opened.cranker_paid,
            &[vault_seeds],
        )?;
        let to_pool = vault
            .lamports()
            .checked_sub(vault_before)
            .ok_or(EpochError::MathOverflow)?;
        Ok((claimed, to_pool))
    }

    /// The treasury's associated token account for `mint` (an SPL Token
    /// mint), created with the cranker fronting the rent when missing.
    pub fn open_tokens(
        &self,
        account: &AccountInfo<'info>,
        mint: &AccountInfo<'info>,
        ata_program: &AccountInfo<'info>,
    ) -> Result<Opened> {
        require_keys_eq!(
            account.key(),
            associated_token_address(self.treasury.key, mint.key),
            EpochError::InvalidClaimAccount
        );
        let created = account.data_is_empty();
        if created {
            create_ata_idempotent(
                self.cranker,
                account,
                self.treasury,
                mint,
                self.system_program,
                self.token_program,
                ata_program,
            )?;
        }
        let held = SplTokenAccount::load(account)?;
        require_keys_eq!(held.mint, mint.key(), EpochError::InvalidClaimAccount);
        require_keys_eq!(
            held.owner,
            self.treasury.key(),
            EpochError::InvalidClaimAccount
        );
        Ok(Opened {
            cranker_paid: 0,
            created,
            amount_before: held.amount,
        })
    }

    /// Burn everything the treasury's token account holds, then close it if
    /// this claim created it (all its lamports go back to the cranker).
    /// Returns `(claimed, burned)`.
    pub fn burn_tokens(
        &self,
        account: &AccountInfo<'info>,
        opened: &Opened,
        mint: &AccountInfo<'info>,
    ) -> Result<(u64, u64)> {
        let held = SplTokenAccount::load(account)?.amount;
        let claimed = held
            .checked_sub(opened.amount_before)
            .ok_or(EpochError::MathOverflow)?;
        burn(
            account,
            mint,
            self.treasury,
            held,
            self.token_program,
            &[self.treasury_seeds],
        )?;
        if opened.created {
            close_account(
                account,
                self.cranker,
                self.treasury,
                self.token_program,
                &[self.treasury_seeds],
            )?;
        }
        Ok((claimed, held))
    }
}

/// Book lamports that just reached the vault as pool income: `cash` and
/// `income_unallocated` grow together, so the ledger identity holds, and the
/// next `accrue` distributes it (protocol fee, senior coupon, junior).
pub fn credit_pool_income(pool: &mut Pool, lamports: u64) -> Result<()> {
    pool.cash = pool
        .cash
        .checked_add(lamports)
        .ok_or(EpochError::MathOverflow)?;
    pool.income_unallocated = pool
        .income_unallocated
        .checked_add(lamports)
        .ok_or(EpochError::MathOverflow)?;
    pool.assert_ledger()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{math::distribute_income, state::PoolParams};

    fn pool() -> Pool {
        Pool {
            admin: Pubkey::default(),
            treasury: Pubkey::default(),
            scorer: Pubkey::default(),
            params: PoolParams {
                senior_rate_bps_per_epoch: 10,
                protocol_fee_bps: 1_000,
                ..PoolParams::default()
            },
            bump: 0,
            vault_bump: 0,
            paused: false,
            cash: 6_000_000_000,
            outstanding_principal: 4_000_000_000,
            expected_fees: 40_000_000,
            income_unallocated: 0,
            bond_total: 1_000_000_000,
            senior_assets: 8_000_000_000,
            senior_shares: 8_000_000_000,
            junior_assets: 2_000_000_000,
            junior_shares: 2_000_000_000,
            senior_pending_shares: 0,
            junior_pending_shares: 0,
            withdraw_head: 0,
            withdraw_tail: 0,
            last_accrued_epoch: 0,
            validators: 0,
            open_advances: 0,
            total_advanced: 0,
            total_repaid: 0,
            total_defaulted: 0,
            _reserved: [0; 64],
        }
    }

    #[test]
    fn a_claim_is_pool_income_and_keeps_the_ledger_identity() {
        let mut p = pool();
        p.assert_ledger().unwrap();
        credit_pool_income(&mut p, 123_456_789).unwrap();
        assert_eq!(p.cash, 6_123_456_789);
        assert_eq!(p.income_unallocated, 123_456_789);
        // Tranche assets move only at accrue.
        assert_eq!(
            (p.senior_assets, p.junior_assets),
            (8_000_000_000, 2_000_000_000)
        );
        p.assert_ledger().unwrap();
        // The vault requirement grows by exactly what the vault received.
        assert_eq!(p.required_vault_lamports(890_880).unwrap(), 7_124_347_669);
        assert!(credit_pool_income(&mut p, u64::MAX).is_err());
    }

    #[test]
    fn senior_is_paid_first_at_accrue() {
        let mut p = pool();
        credit_pool_income(&mut p, 10_000_000).unwrap();
        // 10% protocol fee, then the coupon on 8 SOL at 10 bps = 8,000,000.
        let d = distribute_income(
            p.income_unallocated,
            p.senior_assets,
            p.params.senior_rate_bps_per_epoch,
            1,
            p.params.protocol_fee_bps,
        )
        .unwrap();
        assert_eq!(d.protocol_fee, 1_000_000);
        assert_eq!(d.senior_gain, 8_000_000);
        assert_eq!(d.junior_gain, 1_000_000);
        // What accrue then books keeps the identity.
        p.income_unallocated = 0;
        p.cash -= d.protocol_fee;
        p.senior_assets += d.senior_gain;
        p.junior_assets += d.junior_gain;
        p.assert_ledger().unwrap();
    }
}
