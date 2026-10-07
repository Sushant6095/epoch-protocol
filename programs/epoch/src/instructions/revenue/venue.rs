//! Where a revenue token trades, read and checked from the accounts a
//! cranker passed: the DBC curve until the token graduates and its DAMM v2
//! pool is synced, then that pool. Every key is compared with what the
//! `RevenueToken` recorded (pools, config) or with the Meteora programs'
//! fixed PDAs (authorities), and every pool field is read from an account
//! whose owner and discriminator were checked, so a cranker cannot substitute
//! a pool, a vault or a price.

use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    math::{
        damm_compounding_buy, damm_compounding_max_quote_in, damm_concentrated_buy,
        damm_concentrated_max_quote_in, dbc_buy, dbc_max_quote_in, impact_target_sqrt_price,
        BuyFill,
    },
    meteora_account::{DammPool, DbcConfig, DbcPool, DAMM_COLLECT_FEE_COMPOUNDING},
    outbound::meteora::{
        damm_swap2_ix, dbc_swap2_ix, SwapKeys, SWAP_MODE_EXACT_IN, SWAP_MODE_PARTIAL_FILL,
    },
    state::{BuybackVenue, RevenueToken},
};

pub enum Venue {
    /// The config (its 20-point curve) is boxed: it keeps the SBF stack frame small.
    Dbc {
        pool: DbcPool,
        config: Box<DbcConfig>,
    },
    Damm {
        pool: DammPool,
    },
}

/// The venue accounts as passed (all `UncheckedAccount`s in the instruction).
pub struct VenueAccounts<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub pool_authority: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub pool: &'a AccountInfo<'info>,
    pub token_vault: &'a AccountInfo<'info>,
    pub quote_vault: &'a AccountInfo<'info>,
    pub dbc_config: &'a AccountInfo<'info>,
}

impl Venue {
    /// Check the accounts against the revenue token and read the pool.
    pub fn load(rt: &RevenueToken, a: &VenueAccounts) -> Result<Self> {
        if rt.graduated() {
            require_keys_eq!(
                *a.program.key,
                CP_AMM_PROGRAM_ID,
                EpochError::InvalidVenueAccount
            );
            require_keys_eq!(*a.pool.key, rt.damm_pool, EpochError::InvalidVenueAccount);
            require_keys_eq!(
                *a.pool_authority.key,
                CP_AMM_POOL_AUTHORITY,
                EpochError::InvalidVenueAccount
            );
            require_keys_eq!(
                *a.event_authority.key,
                CP_AMM_EVENT_AUTHORITY,
                EpochError::InvalidVenueAccount
            );
            let pool = DammPool::load(a.pool)?;
            require_keys_eq!(
                pool.token_a_vault,
                *a.token_vault.key,
                EpochError::InvalidVenueAccount
            );
            require_keys_eq!(
                pool.token_b_vault,
                *a.quote_vault.key,
                EpochError::InvalidVenueAccount
            );
            require_keys_eq!(pool.token_a_mint, rt.mint, EpochError::InvalidVenueAccount);
            Ok(Venue::Damm { pool })
        } else {
            require_keys_eq!(
                *a.program.key,
                DBC_PROGRAM_ID,
                EpochError::InvalidVenueAccount
            );
            require_keys_eq!(*a.pool.key, rt.dbc_pool, EpochError::InvalidVenueAccount);
            require_keys_eq!(
                *a.pool_authority.key,
                DBC_POOL_AUTHORITY,
                EpochError::InvalidVenueAccount
            );
            require_keys_eq!(
                *a.event_authority.key,
                DBC_EVENT_AUTHORITY,
                EpochError::InvalidVenueAccount
            );
            require_keys_eq!(
                *a.dbc_config.key,
                rt.dbc_config,
                EpochError::InvalidVenueAccount
            );
            let pool = DbcPool::load(a.pool)?;
            require_keys_eq!(pool.config, rt.dbc_config, EpochError::InvalidVenueAccount);
            require_keys_eq!(
                pool.base_vault,
                *a.token_vault.key,
                EpochError::InvalidVenueAccount
            );
            require_keys_eq!(
                pool.quote_vault,
                *a.quote_vault.key,
                EpochError::InvalidVenueAccount
            );
            let config = Box::new(DbcConfig::load(a.dbc_config)?);
            Ok(Venue::Dbc { pool, config })
        }
    }

    pub fn kind(&self) -> BuybackVenue {
        match self {
            Venue::Dbc { .. } => BuybackVenue::Dbc,
            Venue::Damm { .. } => BuybackVenue::DammV2,
        }
    }

    /// Fail early, with a clear error, when the venue cannot take a buy now.
    pub fn require_trading(&self) -> Result<()> {
        match self {
            Venue::Dbc { pool, config } => {
                // Migrated but not synced: point the buyback at DAMM v2 first.
                require!(!pool.is_migrated, EpochError::PoolNotSynced);
                // Complete, waiting for migration: DBC rejects swaps (PoolIsCompleted).
                require!(
                    pool.quote_reserve < config.migration_quote_threshold,
                    EpochError::VenueNotTrading
                );
            }
            Venue::Damm { pool } => {
                require!(pool.pool_status == 0, EpochError::VenueNotTrading);
            }
        }
        Ok(())
    }

    /// The most SOL one slice may spend before the price moves `max_impact_bps`.
    pub fn max_quote_in(&self, max_impact_bps: u16) -> Result<u64> {
        let v = match self {
            Venue::Dbc { pool, config } => {
                let target = impact_target_sqrt_price(pool.sqrt_price, max_impact_bps);
                target.and_then(|t| {
                    dbc_max_quote_in(
                        &config.curve,
                        pool.sqrt_price,
                        config.migration_sqrt_price,
                        t,
                    )
                })
            }
            Venue::Damm { pool } if pool.collect_fee_mode == DAMM_COLLECT_FEE_COMPOUNDING => {
                damm_compounding_max_quote_in(pool.token_b_amount, max_impact_bps)
            }
            Venue::Damm { pool } => impact_target_sqrt_price(pool.sqrt_price, max_impact_bps)
                .and_then(|t| {
                    damm_concentrated_max_quote_in(
                        pool.sqrt_price,
                        pool.liquidity,
                        pool.sqrt_max_price,
                        t,
                    )
                }),
        };
        v.ok_or_else(|| error!(EpochError::MathOverflow))
    }

    /// The pool's output for `amount` SOL before fees (DBC: a partial fill
    /// stops at the curve's migration price).
    pub fn fee_free_buy(&self, amount: u64) -> Result<BuyFill> {
        let v = match self {
            Venue::Dbc { pool, config } => dbc_buy(
                &config.curve,
                pool.sqrt_price,
                config.migration_sqrt_price,
                amount,
            ),
            Venue::Damm { pool } if pool.collect_fee_mode == DAMM_COLLECT_FEE_COMPOUNDING => {
                damm_compounding_buy(pool.token_a_amount, pool.token_b_amount, amount)
            }
            Venue::Damm { pool } => {
                damm_concentrated_buy(pool.sqrt_price, pool.liquidity, pool.sqrt_max_price, amount)
            }
        };
        v.ok_or_else(|| error!(EpochError::MathOverflow))
    }

    /// The `swap2` instruction: DBC in partial-fill mode (the buy that
    /// completes the curve fills up to the migration price and leaves the rest
    /// of the SOL), DAMM v2 exact-in.
    pub fn swap_ix(
        &self,
        a: &VenueAccounts,
        keys_in: &SwapIo,
        amount_in: u64,
        minimum_out: u64,
    ) -> anchor_lang::solana_program::instruction::Instruction {
        let keys = SwapKeys {
            pool: *a.pool.key,
            config: *a.dbc_config.key,
            input_token_account: keys_in.input,
            output_token_account: keys_in.output,
            token_vault: *a.token_vault.key,
            quote_vault: *a.quote_vault.key,
            token_mint: keys_in.mint,
            payer: keys_in.payer,
        };
        match self {
            Venue::Dbc { .. } => {
                dbc_swap2_ix(&keys, amount_in, minimum_out, SWAP_MODE_PARTIAL_FILL)
            }
            Venue::Damm { .. } => damm_swap2_ix(&keys, amount_in, minimum_out, SWAP_MODE_EXACT_IN),
        }
    }
}

/// The buyback's own side of the swap.
pub struct SwapIo {
    pub input: Pubkey,
    pub output: Pubkey,
    pub mint: Pubkey,
    pub payer: Pubkey,
}
