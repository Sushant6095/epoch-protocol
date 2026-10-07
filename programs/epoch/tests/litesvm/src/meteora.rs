//! Fabricated SPL Token and Meteora DBC accounts, written at the offsets
//! `epoch::meteora_account` reads (its module docs list them), so the
//! revenue-token paths that only *read* Meteora state run without the
//! Meteora programs: `register_revenue_token`, the sweep share, `redeem`,
//! `configure_revenue_token`. The paths that CPI into DBC or DAMM v2
//! (`execute_buyback`, the treasury claims) need the program binaries; see
//! `tests/README.md` at the repo root.

use anchor_lang::prelude::Pubkey;
use epoch::constants::{DBC_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID};
use epoch::meteora_account::{
    DBC_POOL_CONFIG_DISCRIMINATOR, DBC_POOL_CONFIG_LEN, DBC_VIRTUAL_POOL_DISCRIMINATOR,
    DBC_VIRTUAL_POOL_LEN,
};
use solana_account::Account;

use crate::context::TestContext;

/// SPL Token `Mint` and `Account` sizes.
pub const MINT_LEN: usize = 82;
pub const TOKEN_ACCOUNT_LEN: usize = 165;

fn put(d: &mut [u8], at: usize, bytes: &[u8]) {
    d[at..at + bytes.len()].copy_from_slice(bytes);
}

/// `COption<Pubkey>`: a little-endian `u32` tag, then the key.
fn put_coption(d: &mut [u8], at: usize, key: Option<Pubkey>) {
    if let Some(k) = key {
        put(d, at, &1u32.to_le_bytes());
        put(d, at + 4, k.as_ref());
    }
}

/// A DBC `PoolConfig` an Epoch revenue token accepts: quotes wrapped SOL,
/// graduates to DAMM v2, SPL Token, fixed supply with the leftover to
/// `fee_claimer`, 100% of the graduated liquidity locked for good, a 1%
/// flat curve fee and a 1% migrated pool (fee floor 100 bps).
pub fn dbc_config_data(fee_claimer: Pubkey) -> Vec<u8> {
    let mut d = vec![0u8; DBC_POOL_CONFIG_LEN];
    put(&mut d, 0, &DBC_POOL_CONFIG_DISCRIMINATOR);
    put(&mut d, 8, NATIVE_MINT.as_ref());
    put(&mut d, 40, fee_claimer.as_ref());
    put(&mut d, 72, fee_claimer.as_ref()); // leftover receiver
    put(&mut d, 104, &10_000_000u64.to_le_bytes()); // cliff fee numerator: 1%
    d[130] = 0; // base fee mode: linear scheduler, no periods → flat
    d[233] = 1; // migration option: DAMM v2
    d[237] = 0; // token type: SPL Token
    d[239] = 100; // partner permanently locked liquidity, %
    d[243] = 2; // migration fee option: 1%
    d[244] = 1; // fixed token supply
    d
}

/// A DBC `VirtualPool` trading `mint` under `config`, still on its curve.
pub fn dbc_pool_data(config: Pubkey, mint: Pubkey) -> Vec<u8> {
    let mut d = vec![0u8; DBC_VIRTUAL_POOL_LEN];
    put(&mut d, 0, &DBC_VIRTUAL_POOL_DISCRIMINATOR);
    put(&mut d, 72, config.as_ref());
    put(&mut d, 136, mint.as_ref());
    d[304] = 0; // pool type: SPL Token
    d
}

/// An initialised SPL Token mint.
pub fn mint_data(supply: u64, decimals: u8, mint_authority: Option<Pubkey>) -> Vec<u8> {
    let mut d = vec![0u8; MINT_LEN];
    put_coption(&mut d, 0, mint_authority);
    put(&mut d, 36, &supply.to_le_bytes());
    d[44] = decimals;
    d[45] = 1;
    d
}

/// An initialised SPL Token account.
pub fn token_account_data(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; TOKEN_ACCOUNT_LEN];
    put(&mut d, 0, mint.as_ref());
    put(&mut d, 32, owner.as_ref());
    put(&mut d, 64, &amount.to_le_bytes());
    d[108] = 1; // AccountState::Initialized
    d
}

fn u64_at(d: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(d[at..at + 8].try_into().unwrap())
}

impl TestContext {
    /// Write a rent-exempt account with `data`, owned by `owner`.
    pub fn set_raw(&mut self, key: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.rent_exempt(data.len());
        self.svm
            .set_account(
                key,
                Account {
                    lamports,
                    data,
                    owner,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .expect("set account");
    }

    pub fn set_mint(&mut self, key: Pubkey, supply: u64, mint_authority: Option<Pubkey>) {
        self.set_raw(key, TOKEN_PROGRAM_ID, mint_data(supply, 6, mint_authority));
    }

    pub fn set_token_account(&mut self, key: Pubkey, mint: Pubkey, owner: Pubkey, amount: u64) {
        self.set_raw(
            key,
            TOKEN_PROGRAM_ID,
            token_account_data(mint, owner, amount),
        );
    }

    pub fn set_dbc_config(&mut self, key: Pubkey, fee_claimer: Pubkey) {
        self.set_raw(key, DBC_PROGRAM_ID, dbc_config_data(fee_claimer));
    }

    pub fn set_dbc_pool(&mut self, key: Pubkey, config: Pubkey, mint: Pubkey) {
        self.set_raw(key, DBC_PROGRAM_ID, dbc_pool_data(config, mint));
    }

    /// The token balance of an SPL Token account.
    #[track_caller]
    pub fn token_amount(&self, key: &Pubkey) -> u64 {
        u64_at(&self.account(key).expect("token account").data, 64)
    }

    /// The supply of an SPL Token mint.
    #[track_caller]
    pub fn mint_supply(&self, key: &Pubkey) -> u64 {
        u64_at(&self.account(key).expect("mint").data, 36)
    }
}

impl TestContext {
    /// Overwrite `bytes` at offset `at` of an existing account's data.
    pub fn patch(&mut self, key: Pubkey, at: usize, bytes: &[u8]) {
        let mut acc = self.account(&key).expect("account to patch");
        acc.data[at..at + bytes.len()].copy_from_slice(bytes);
        self.svm.set_account(key, acc).expect("set account");
    }
}

/// A DAMM v2 `Config` whose pools only `pool_creator_authority` can create.
pub fn damm_config_data(pool_creator_authority: Pubkey) -> Vec<u8> {
    use epoch::meteora_account::{DAMM_CONFIG_DISCRIMINATOR, DAMM_CONFIG_LEN};
    let mut d = vec![0u8; DAMM_CONFIG_LEN];
    put(&mut d, 0, &DAMM_CONFIG_DISCRIMINATOR);
    put(&mut d, 40, pool_creator_authority.as_ref());
    d
}

/// A DAMM v2 `Pool` trading SPL Token `token_a` against `token_b`.
pub fn damm_pool_data(token_a: Pubkey, token_b: Pubkey) -> Vec<u8> {
    use epoch::meteora_account::{DAMM_POOL_DISCRIMINATOR, DAMM_POOL_LEN};
    let mut d = vec![0u8; DAMM_POOL_LEN];
    put(&mut d, 0, &DAMM_POOL_DISCRIMINATOR);
    put(&mut d, 168, token_a.as_ref());
    put(&mut d, 200, token_b.as_ref());
    d[482] = 0; // token A: SPL Token
    d
}

/// The address DAMM v2 gives the pool of `config` for `mint` / wrapped SOL:
/// `["pool", config, max(mint, wsol), min(mint, wsol)]`.
pub fn damm_pool_address(config: &Pubkey, mint: &Pubkey) -> Pubkey {
    let wsol = epoch::constants::NATIVE_MINT;
    let (hi, lo) = if *mint > wsol {
        (*mint, wsol)
    } else {
        (wsol, *mint)
    };
    Pubkey::find_program_address(
        &[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()],
        &epoch::constants::CP_AMM_PROGRAM_ID,
    )
    .0
}

/// A DAMM v2 `Position` in `pool`, represented by the NFT `nft_mint`.
pub fn damm_position_data(pool: Pubkey, nft_mint: Pubkey) -> Vec<u8> {
    use epoch::meteora_account::{DAMM_POSITION_DISCRIMINATOR, DAMM_POSITION_LEN};
    let mut d = vec![0u8; DAMM_POSITION_LEN];
    put(&mut d, 0, &DAMM_POSITION_DISCRIMINATOR);
    put(&mut d, 8, pool.as_ref());
    put(&mut d, 40, nft_mint.as_ref());
    d
}
