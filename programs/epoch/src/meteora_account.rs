//! Reads the Meteora and SPL Token accounts a revenue token depends on, at
//! fixed offsets, without the Meteora crates.
//!
//! The Meteora accounts are Anchor `zero_copy` (bytemuck, `repr(C)`, explicit
//! padding), so every field sits at a fixed offset after the 8-byte
//! discriminator. Offsets come from the IDLs shipped in
//! `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 and `@meteora-ag/cp-amm-sdk`
//! 1.5.1, were checked against the program sources, and are pinned by the
//! tests below on real mainnet accounts (a graduated DBC pool, its config, the
//! DAMM v2 config it migrated with and the DAMM v2 pool it created).
//!
//! ```text
//! DBC VirtualPool (424)   config 72 · creator 104 · base_mint 136 · base_vault 168 · quote_vault 200 ·
//!                         base_reserve 232 · quote_reserve 240 · protocol_base_fee 248 ·
//!                         partner_base_fee 264 · partner_quote_fee 272 · sqrt_price 280 (u128) ·
//!                         pool_type 304 · is_migrated 305 · is_partner_withdraw_surplus 306 ·
//!                         migration_progress 308 · is_withdraw_leftover 309 ·
//!                         migration_fee_withdraw_status 311 · creator_base_fee 352 ·
//!                         protocol_migration_base_fee_amount 384
//! DBC PoolConfig (1048)   quote_mint 8 · fee_claimer 40 · leftover_receiver 72 ·
//!                         base fee 104 {cliff_fee_numerator u64 · second_factor u64 112 ·
//!                         third_factor u64 120 · first_factor u16 128 · base_fee_mode 130} ·
//!                         partner vesting_percentage 185 · creator vesting_percentage 201 ·
//!                         migration_option 233 · token_type 237 · quote_token_flag 238 ·
//!                         partner_permanent_locked_liquidity_percentage 239 ·
//!                         partner_liquidity_percentage 240 ·
//!                         creator_permanent_locked_liquidity_percentage 241 ·
//!                         creator_liquidity_percentage 242 · migration_fee_option 243 ·
//!                         fixed_token_supply_flag 244 · creator_trading_fee_percentage 245 ·
//!                         migration_fee_percentage 247 · creator_migration_fee_percentage 248 ·
//!                         migration_quote_threshold 264 · migration_sqrt_price 280 ·
//!                         migrated_pool_fee_bps 362 (u16) · migrated_pool_base_fee_mode 364 ·
//!                         sqrt_start_price 392 · curve 408 (20 × {u128, u128})
//! DAMM v2 Pool (1112)     token_a_mint 168 · token_b_mint 200 · token_a_vault 232 · token_b_vault 264 ·
//!                         liquidity 360 · sqrt_max_price 440 · sqrt_price 456 · pool_status 481 ·
//!                         token_a_flag 482 · token_b_flag 483 · collect_fee_mode 484 · creator 648 ·
//!                         token_a_amount 680 · token_b_amount 688
//! DAMM v2 Config (328)    pool_creator_authority 40 · config_type 202
//! DAMM v2 Position (408)  pool 8 · nft_mint 40 · fee_a_pending 136 · fee_b_pending 144 ·
//!                         unlocked_liquidity 152 · vested_liquidity 168 ·
//!                         permanent_locked_liquidity 184 · total_claimed_a_fee 200 ·
//!                         total_claimed_b_fee 208
//! SPL Mint (82)           mint_authority 0 (COption) · supply 36 · decimals 44 · initialized 45 ·
//!                         freeze_authority 46 (COption)
//! SPL Token account (165) mint 0 · owner 32 · amount 64 · state 108 (Token-2022 accounts
//!                         share this base and add an account-type byte, 2, at 165)
//! ```

use anchor_lang::prelude::*;

use crate::{
    constants::{
        CP_AMM_PROGRAM_ID, DBC_PROGRAM_ID, MINT_LEN, TOKEN_2022_PROGRAM_ID, TOKEN_ACCOUNT_LEN,
        TOKEN_PROGRAM_ID,
    },
    errors::EpochError,
    math::CurvePoint,
};

/// `sha256("account:VirtualPool")[..8]`.
pub const DBC_VIRTUAL_POOL_DISCRIMINATOR: [u8; 8] = [213, 224, 5, 209, 98, 69, 119, 92];
/// `sha256("account:PoolConfig")[..8]`.
pub const DBC_POOL_CONFIG_DISCRIMINATOR: [u8; 8] = [26, 108, 14, 123, 116, 230, 129, 43];
/// `sha256("account:Pool")[..8]` (the same name as Epoch's own `Pool`, so the
/// owner check matters).
pub const DAMM_POOL_DISCRIMINATOR: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
/// `sha256("account:Config")[..8]`.
pub const DAMM_CONFIG_DISCRIMINATOR: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];
/// `sha256("account:Position")[..8]` (DAMM v2).
pub const DAMM_POSITION_DISCRIMINATOR: [u8; 8] = [170, 188, 143, 228, 122, 64, 247, 208];

pub const DBC_VIRTUAL_POOL_LEN: usize = 424;
pub const DBC_POOL_CONFIG_LEN: usize = 1_048;
pub const DAMM_POOL_LEN: usize = 1_112;
pub const DAMM_CONFIG_LEN: usize = 328;
pub const DAMM_POSITION_LEN: usize = 408;
/// DBC configs hold at most 20 curve points.
pub const DBC_CURVE_POINTS: usize = 20;

/// DBC `migration_option` for DAMM v2.
pub const DBC_MIGRATION_DAMM_V2: u8 = 1;
/// DBC `token_type` / `pool_type` for SPL Token (1 = Token-2022).
pub const DBC_TOKEN_TYPE_SPL: u8 = 0;
/// DAMM v2 `collect_fee_mode` for compounding pools (`x·y = k`, no price range).
pub const DAMM_COLLECT_FEE_COMPOUNDING: u8 = 2;
/// DAMM v2 `token_a_flag` / `token_b_flag` for SPL Token (1 = Token-2022).
pub const DAMM_TOKEN_FLAG_SPL: u8 = 0;
/// Token-2022 `AccountType::Account`, the byte after the 165-byte base of an
/// account with extensions.
const TOKEN_2022_ACCOUNT_TYPE_ACCOUNT: u8 = 2;

fn key(d: &[u8], at: usize) -> Pubkey {
    let mut b = [0u8; 32];
    b.copy_from_slice(&d[at..at + 32]);
    Pubkey::new_from_array(b)
}

fn u64_at(d: &[u8], at: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&d[at..at + 8]);
    u64::from_le_bytes(b)
}

fn u128_at(d: &[u8], at: usize) -> u128 {
    let mut b = [0u8; 16];
    b.copy_from_slice(&d[at..at + 16]);
    u128::from_le_bytes(b)
}

fn u16_at(d: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([d[at], d[at + 1]])
}

/// A DBC config's base fee (`BaseFeeConfig`), numerators over 10⁹. Fee
/// scheduler modes (0 linear, 1 exponential): `first_factor` is the number of
/// periods, `second_factor` the period length, `third_factor` the reduction
/// per period. Rate limiter (2): the fee starts at the cliff and only rises
/// with the trade size.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DbcBaseFee {
    pub cliff_fee_numerator: u64,
    pub first_factor: u16,
    pub second_factor: u64,
    pub third_factor: u64,
    pub mode: u8,
}

/// How a DBC config splits the graduated pool's liquidity, percent.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DbcLiquiditySplit {
    pub partner_permanent_locked: u8,
    pub partner_unlocked: u8,
    pub partner_vesting: u8,
    pub creator_permanent_locked: u8,
    pub creator_unlocked: u8,
    pub creator_vesting: u8,
}

impl DbcLiquiditySplit {
    /// All of the liquidity is locked forever (DBC makes the six parts add
    /// up to 100, so the others are zero).
    pub fn fully_locked(&self) -> bool {
        u16::from(self.partner_permanent_locked) + u16::from(self.creator_permanent_locked) == 100
            && self.partner_unlocked == 0
            && self.partner_vesting == 0
            && self.creator_unlocked == 0
            && self.creator_vesting == 0
    }
}

/// The fields of a DBC `VirtualPool` that revenue tokens use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DbcPool {
    pub config: Pubkey,
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub base_reserve: u64,
    pub quote_reserve: u64,
    /// Unclaimed trading fees held in the vaults (base = the token).
    pub protocol_base_fee: u64,
    pub partner_base_fee: u64,
    pub partner_quote_fee: u64,
    pub creator_base_fee: u64,
    pub sqrt_price: u128,
    pub pool_type: u8,
    pub is_migrated: bool,
    pub is_partner_withdraw_surplus: bool,
    pub migration_progress: u8,
    pub is_withdraw_leftover: bool,
    /// Bit `0b100`: partner migration fee withdrawn; `0b010`: creator's.
    pub migration_fee_withdraw_status: u8,
    /// Base the protocol took at migration (still in the base vault until claimed).
    pub protocol_migration_base_fee_amount: u64,
}

impl DbcPool {
    pub fn parse(d: &[u8]) -> Option<Self> {
        if d.len() < DBC_VIRTUAL_POOL_LEN || d[..8] != DBC_VIRTUAL_POOL_DISCRIMINATOR {
            return None;
        }
        Some(Self {
            config: key(d, 72),
            creator: key(d, 104),
            base_mint: key(d, 136),
            base_vault: key(d, 168),
            quote_vault: key(d, 200),
            base_reserve: u64_at(d, 232),
            quote_reserve: u64_at(d, 240),
            protocol_base_fee: u64_at(d, 248),
            partner_base_fee: u64_at(d, 264),
            partner_quote_fee: u64_at(d, 272),
            creator_base_fee: u64_at(d, 352),
            sqrt_price: u128_at(d, 280),
            pool_type: d[304],
            is_migrated: d[305] == 1,
            is_partner_withdraw_surplus: d[306] != 0,
            migration_progress: d[308],
            is_withdraw_leftover: d[309] != 0,
            migration_fee_withdraw_status: d[311],
            protocol_migration_base_fee_amount: u64_at(d, 384),
        })
    }

    pub fn load(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*account.owner, DBC_PROGRAM_ID, EpochError::InvalidDbcPool);
        let data = account.try_borrow_data()?;
        Self::parse(&data).ok_or_else(|| error!(EpochError::InvalidDbcPool))
    }
}

/// The fields of a DBC `PoolConfig` that revenue tokens use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DbcConfig {
    pub quote_mint: Pubkey,
    pub fee_claimer: Pubkey,
    pub leftover_receiver: Pubkey,
    pub base_fee: DbcBaseFee,
    pub liquidity: DbcLiquiditySplit,
    pub migration_option: u8,
    pub token_type: u8,
    /// The graduated DAMM v2 pool's fee: 0–5 = 25, 30, 100, 200, 400, 600
    /// bps; 6 = customizable (`migrated_pool_fee_bps`).
    pub migration_fee_option: u8,
    /// 1 = fixed supply: the leftover goes to `leftover_receiver` (otherwise
    /// DBC burns it at migration).
    pub fixed_token_supply_flag: u8,
    pub migrated_pool_fee_bps: u16,
    /// DAMM v2 base fee mode of a customizable migrated pool (0/1 = fixed fee).
    pub migrated_pool_base_fee_mode: u8,
    pub migration_quote_threshold: u64,
    pub migration_sqrt_price: u128,
    pub sqrt_start_price: u128,
    pub curve: [CurvePoint; DBC_CURVE_POINTS],
}

impl DbcConfig {
    pub fn parse(d: &[u8]) -> Option<Self> {
        if d.len() < DBC_POOL_CONFIG_LEN || d[..8] != DBC_POOL_CONFIG_DISCRIMINATOR {
            return None;
        }
        let mut curve = [CurvePoint::default(); DBC_CURVE_POINTS];
        for (i, point) in curve.iter_mut().enumerate() {
            let at = 408 + i * 32;
            *point = CurvePoint {
                sqrt_price: u128_at(d, at),
                liquidity: u128_at(d, at + 16),
            };
        }
        Some(Self {
            quote_mint: key(d, 8),
            fee_claimer: key(d, 40),
            leftover_receiver: key(d, 72),
            base_fee: DbcBaseFee {
                cliff_fee_numerator: u64_at(d, 104),
                second_factor: u64_at(d, 112),
                third_factor: u64_at(d, 120),
                first_factor: u16_at(d, 128),
                mode: d[130],
            },
            liquidity: DbcLiquiditySplit {
                partner_permanent_locked: d[239],
                partner_unlocked: d[240],
                partner_vesting: d[185],
                creator_permanent_locked: d[241],
                creator_unlocked: d[242],
                creator_vesting: d[201],
            },
            migration_option: d[233],
            token_type: d[237],
            migration_fee_option: d[243],
            fixed_token_supply_flag: d[244],
            migrated_pool_fee_bps: u16_at(d, 362),
            migrated_pool_base_fee_mode: d[364],
            migration_quote_threshold: u64_at(d, 264),
            migration_sqrt_price: u128_at(d, 280),
            sqrt_start_price: u128_at(d, 392),
            curve,
        })
    }

    pub fn load(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*account.owner, DBC_PROGRAM_ID, EpochError::InvalidDbcConfig);
        let data = account.try_borrow_data()?;
        Self::parse(&data).ok_or_else(|| error!(EpochError::InvalidDbcConfig))
    }
}

/// The partner's terms in a DBC `PoolConfig`: what the treasury claims read.
/// Kept apart from `DbcConfig` so claims do not copy the 640-byte curve.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DbcPartnerTerms {
    pub quote_mint: Pubkey,
    pub fee_claimer: Pubkey,
    pub leftover_receiver: Pubkey,
    pub token_type: u8,
    /// 0 = SPL Token.
    pub quote_token_flag: u8,
    /// 1 = fixed supply (the only kind DBC lets withdraw leftover).
    pub fixed_token_supply_flag: u8,
    pub creator_trading_fee_percentage: u8,
    pub migration_fee_percentage: u8,
    pub creator_migration_fee_percentage: u8,
    pub migration_quote_threshold: u64,
}

impl DbcPartnerTerms {
    pub fn parse(d: &[u8]) -> Option<Self> {
        if d.len() < DBC_POOL_CONFIG_LEN || d[..8] != DBC_POOL_CONFIG_DISCRIMINATOR {
            return None;
        }
        Some(Self {
            quote_mint: key(d, 8),
            fee_claimer: key(d, 40),
            leftover_receiver: key(d, 72),
            token_type: d[237],
            quote_token_flag: d[238],
            fixed_token_supply_flag: d[244],
            creator_trading_fee_percentage: d[245],
            migration_fee_percentage: d[247],
            creator_migration_fee_percentage: d[248],
            migration_quote_threshold: u64_at(d, 264),
        })
    }

    pub fn load(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(
            *account.owner,
            DBC_PROGRAM_ID,
            EpochError::InvalidClaimAccount
        );
        let data = account.try_borrow_data()?;
        Self::parse(&data).ok_or_else(|| error!(EpochError::InvalidClaimAccount))
    }
}

/// The fields of a DAMM v2 `Pool` that revenue tokens use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DammPool {
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub liquidity: u128,
    pub sqrt_max_price: u128,
    pub sqrt_price: u128,
    /// 0 = enabled.
    pub pool_status: u8,
    /// 0 = SPL Token, 1 = Token-2022.
    pub token_a_flag: u8,
    pub token_b_flag: u8,
    pub collect_fee_mode: u8,
    pub creator: Pubkey,
    pub token_a_amount: u64,
    pub token_b_amount: u64,
}

impl DammPool {
    pub fn parse(d: &[u8]) -> Option<Self> {
        if d.len() < DAMM_POOL_LEN || d[..8] != DAMM_POOL_DISCRIMINATOR {
            return None;
        }
        Some(Self {
            token_a_mint: key(d, 168),
            token_b_mint: key(d, 200),
            token_a_vault: key(d, 232),
            token_b_vault: key(d, 264),
            liquidity: u128_at(d, 360),
            sqrt_max_price: u128_at(d, 440),
            sqrt_price: u128_at(d, 456),
            pool_status: d[481],
            token_a_flag: d[482],
            token_b_flag: d[483],
            collect_fee_mode: d[484],
            creator: key(d, 648),
            token_a_amount: u64_at(d, 680),
            token_b_amount: u64_at(d, 688),
        })
    }

    pub fn load(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(
            *account.owner,
            CP_AMM_PROGRAM_ID,
            EpochError::InvalidDammPool
        );
        let data = account.try_borrow_data()?;
        Self::parse(&data).ok_or_else(|| error!(EpochError::InvalidDammPool))
    }
}

/// The DAMM v2 `Config` a pool was created with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DammConfig {
    /// Only this key may create pools with the config (DBC's pool authority
    /// for every config DBC migrates with).
    pub pool_creator_authority: Pubkey,
    pub config_type: u8,
}

impl DammConfig {
    pub fn parse(d: &[u8]) -> Option<Self> {
        if d.len() < DAMM_CONFIG_LEN || d[..8] != DAMM_CONFIG_DISCRIMINATOR {
            return None;
        }
        Some(Self {
            pool_creator_authority: key(d, 40),
            config_type: d[202],
        })
    }

    pub fn load(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(
            *account.owner,
            CP_AMM_PROGRAM_ID,
            EpochError::InvalidDammPool
        );
        let data = account.try_borrow_data()?;
        Self::parse(&data).ok_or_else(|| error!(EpochError::InvalidDammPool))
    }
}

/// A DAMM v2 `Position`. Its owner is whoever holds the position NFT.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DammPosition {
    pub pool: Pubkey,
    pub nft_mint: Pubkey,
    /// Fees settled into the position but not claimed (stale until the next
    /// liquidity change or claim updates them).
    pub fee_a_pending: u64,
    pub fee_b_pending: u64,
    pub unlocked_liquidity: u128,
    pub vested_liquidity: u128,
    pub permanent_locked_liquidity: u128,
    pub total_claimed_a_fee: u64,
    pub total_claimed_b_fee: u64,
}

impl DammPosition {
    pub fn parse(d: &[u8]) -> Option<Self> {
        if d.len() < DAMM_POSITION_LEN || d[..8] != DAMM_POSITION_DISCRIMINATOR {
            return None;
        }
        Some(Self {
            pool: key(d, 8),
            nft_mint: key(d, 40),
            fee_a_pending: u64_at(d, 136),
            fee_b_pending: u64_at(d, 144),
            unlocked_liquidity: u128_at(d, 152),
            vested_liquidity: u128_at(d, 168),
            permanent_locked_liquidity: u128_at(d, 184),
            total_claimed_a_fee: u64_at(d, 200),
            total_claimed_b_fee: u64_at(d, 208),
        })
    }

    pub fn load(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(
            *account.owner,
            CP_AMM_PROGRAM_ID,
            EpochError::InvalidClaimAccount
        );
        let data = account.try_borrow_data()?;
        Self::parse(&data).ok_or_else(|| error!(EpochError::InvalidClaimAccount))
    }
}

/// An SPL Token mint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SplMint {
    pub mint_authority: Option<Pubkey>,
    pub supply: u64,
    pub decimals: u8,
    pub is_initialized: bool,
    pub freeze_authority: Option<Pubkey>,
}

fn coption_key(d: &[u8], at: usize) -> Option<Option<Pubkey>> {
    match u32::from_le_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]]) {
        0 => Some(None),
        1 => Some(Some(key(d, at + 4))),
        _ => None,
    }
}

impl SplMint {
    pub fn parse(d: &[u8]) -> Option<Self> {
        if d.len() != MINT_LEN {
            return None;
        }
        Some(Self {
            mint_authority: coption_key(d, 0)?,
            supply: u64_at(d, 36),
            decimals: d[44],
            is_initialized: d[45] == 1,
            freeze_authority: coption_key(d, 46)?,
        })
    }

    /// A classic SPL Token mint (Token-2022 mints are rejected in v1).
    pub fn load(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(
            *account.owner,
            TOKEN_PROGRAM_ID,
            EpochError::InvalidRevenueMint
        );
        let data = account.try_borrow_data()?;
        Self::parse(&data).ok_or_else(|| error!(EpochError::InvalidRevenueMint))
    }
}

/// An SPL Token account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SplTokenAccount {
    pub mint: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    /// 0 = uninitialized, 1 = initialized, 2 = frozen.
    pub state: u8,
}

impl SplTokenAccount {
    pub fn parse(d: &[u8]) -> Option<Self> {
        if d.len() != TOKEN_ACCOUNT_LEN {
            return None;
        }
        Some(Self {
            mint: key(d, 0),
            owner: key(d, 32),
            amount: u64_at(d, 64),
            state: d[108],
        })
    }

    pub fn load(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(
            *account.owner,
            TOKEN_PROGRAM_ID,
            EpochError::InvalidVenueAccount
        );
        let data = account.try_borrow_data()?;
        Self::parse(&data).ok_or_else(|| error!(EpochError::InvalidVenueAccount))
    }

    /// A Token-2022 account: the SPL base plus, when it has extensions, the
    /// account-type byte (rejects Token-2022 mints, whose type byte is 1).
    pub fn parse_token_2022(d: &[u8]) -> Option<Self> {
        match d.len() {
            TOKEN_ACCOUNT_LEN => Self::parse(d),
            n if n > TOKEN_ACCOUNT_LEN
                && d[TOKEN_ACCOUNT_LEN] == TOKEN_2022_ACCOUNT_TYPE_ACCOUNT =>
            {
                Self::parse(&d[..TOKEN_ACCOUNT_LEN])
            }
            _ => None,
        }
    }

    pub fn load_token_2022(account: &AccountInfo) -> Result<Self> {
        require_keys_eq!(
            *account.owner,
            TOKEN_2022_PROGRAM_ID,
            EpochError::InvalidClaimAccount
        );
        let data = account.try_borrow_data()?;
        Self::parse_token_2022(&data).ok_or_else(|| error!(EpochError::InvalidClaimAccount))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{DBC_POOL_AUTHORITY, NATIVE_MINT};

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    fn k(s: &str) -> Pubkey {
        s.parse().unwrap()
    }

    use crate::test_fixtures::mainnet::*;

    #[test]
    fn reads_a_real_graduated_dbc_pool_and_its_config() {
        let pool = DbcPool::parse(&hex(DBC_POOL_2K7B)).unwrap();
        assert_eq!(
            pool.config,
            k("6m7XSKNZtiMz3yXfAk8QK5dejQb4aMHjc4bQrqi8h4VD")
        );
        assert_eq!(
            pool.base_mint,
            k("3SLNKtp6yyumAcKEZ5SvA92vF76boHQKMnjKqLCiTUNd")
        );
        assert_eq!(
            pool.base_vault,
            k("HnmJqLkRjdE1nXwtNEMcgV519y3aTcHbBc5krptgY5Vw")
        );
        assert_eq!(
            pool.quote_vault,
            k("2ePcacrPfMUNyzfKpddPzZsyE76D64JLnCdVNRn9nHSM")
        );
        assert_eq!(pool.quote_reserve, 10_950_000_000);
        assert_eq!(pool.sqrt_price, 412_481_736_339_710_312);
        assert_eq!(pool.pool_type, 1); // Token-2022: v1 revenue tokens would reject it
        assert!(pool.is_migrated);
        assert_eq!(pool.migration_progress, 3);

        let config = DbcConfig::parse(&hex(DBC_CONFIG_6M7X)).unwrap();
        assert_eq!(config.quote_mint, NATIVE_MINT);
        assert_eq!(
            config.fee_claimer,
            k("CtNKS1hARwNwArgAGDjoF8xPHjapGj2qaHfY8LW2bfzn")
        );
        assert_eq!(config.migration_option, DBC_MIGRATION_DAMM_V2);
        assert_eq!(config.token_type, 1);
        assert_eq!(config.migration_quote_threshold, 10_950_000_000);
        assert_eq!(config.migration_sqrt_price, 412_481_737_123_559_485);
        assert_eq!(config.sqrt_start_price, 321_471_537_732_820_387);
        assert_eq!(
            config.curve[0],
            CurvePoint {
                sqrt_price: 412_481_737_123_559_485,
                liquidity: 40_941_476_260_114_986_346_290_802_090_718
            }
        );
        assert_eq!(config.curve[2], CurvePoint::default());
        // Fees and the liquidity split (the security-review checks read these).
        assert_eq!(
            config.base_fee,
            DbcBaseFee {
                cliff_fee_numerator: 2_500_000,
                first_factor: 0,
                second_factor: 0,
                third_factor: 0,
                mode: 0
            }
        );
        assert_eq!(
            (
                config.migration_fee_option,
                config.migrated_pool_fee_bps,
                config.migrated_pool_base_fee_mode
            ),
            (6, 10, 0)
        );
        assert_eq!(config.fixed_token_supply_flag, 1);
        assert_eq!(
            config.liquidity,
            DbcLiquiditySplit {
                creator_unlocked: 89,
                creator_vesting: 11,
                ..DbcLiquiditySplit::default()
            }
        );
        assert!(!config.liquidity.fully_locked());
        // The curve's quote reserve at the migration price equals the threshold
        // (the pool completed): Δquote from start to migration with curve[0]'s L.
        let raised = crate::math::delta_quote(
            config.sqrt_start_price,
            config.migration_sqrt_price,
            config.curve[0].liquidity,
            false,
        )
        .unwrap()
        .to_u64()
        .unwrap();
        assert!(
            raised.abs_diff(config.migration_quote_threshold) <= 1,
            "{raised}"
        );
    }

    #[test]
    fn reads_the_damm_v2_pool_it_graduated_to() {
        let pool = DammPool::parse(&hex(DAMM_POOL_F3S7)).unwrap();
        assert_eq!(
            pool.token_a_mint,
            k("3SLNKtp6yyumAcKEZ5SvA92vF76boHQKMnjKqLCiTUNd")
        );
        assert_eq!(pool.token_b_mint, NATIVE_MINT);
        assert_eq!(
            pool.token_a_vault,
            k("Gt3rHeZgG49ShZj42yDobrncAB5m9hcG5r6WfA8j7Yd3")
        );
        assert_eq!(
            pool.token_b_vault,
            k("5WTdcTpgrDZMBt1DJNzLKQyoEGfacQjSgDgqLRorCYCa")
        );
        assert_eq!(pool.creator, DBC_POOL_AUTHORITY);
        assert_eq!(pool.pool_status, 0);
        assert_eq!(pool.token_a_flag, 1);
        assert!(pool.liquidity > 0 && pool.sqrt_price > 0);

        let config = DammConfig::parse(&hex(DAMM_CONFIG_A8GM)).unwrap();
        assert_eq!(config.pool_creator_authority, DBC_POOL_AUTHORITY);
        assert_eq!(config.config_type, 1); // dynamic (the Customizable migration option)

        // The graduated pool is the DAMM v2 PDA ["pool", config, max(mint, wsol), min(mint, wsol)].
        let mint = pool.token_a_mint;
        let (hi, lo) = if mint > NATIVE_MINT {
            (mint, NATIVE_MINT)
        } else {
            (NATIVE_MINT, mint)
        };
        let (derived, _) = Pubkey::find_program_address(
            &[
                b"pool",
                k("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck").as_ref(),
                hi.as_ref(),
                lo.as_ref(),
            ],
            &CP_AMM_PROGRAM_ID,
        );
        assert_eq!(derived, k("F3s7grue6Lpi1JKE5CqFv6YGMELFg6KfT2an3XiJsAbe"));
    }

    #[test]
    fn reads_the_claim_fields_of_the_same_pool_and_config() {
        let pool = DbcPool::parse(&hex(DBC_POOL_2K7B)).unwrap();
        assert_eq!(
            pool.creator,
            k("6HXaCcB5sLFLNp7VkLLJULKjJMqfAo159HyW8Ztt7FJS")
        );
        assert_eq!(pool.protocol_base_fee, 31_637_637_373);
        assert_eq!(
            (
                pool.partner_base_fee,
                pool.partner_quote_fee,
                pool.creator_base_fee
            ),
            (0, 0, 0)
        );
        assert_eq!(pool.protocol_migration_base_fee_amount, 43_800_000_455);
        assert!(pool.is_withdraw_leftover);
        assert!(!pool.is_partner_withdraw_surplus);
        assert_eq!(pool.migration_fee_withdraw_status, 0);

        let terms = DbcPartnerTerms::parse(&hex(DBC_CONFIG_6M7X)).unwrap();
        let fee_claimer = k("CtNKS1hARwNwArgAGDjoF8xPHjapGj2qaHfY8LW2bfzn");
        assert_eq!(terms.fee_claimer, fee_claimer);
        assert_eq!(terms.leftover_receiver, fee_claimer);
        assert_eq!(terms.quote_mint, NATIVE_MINT);
        assert_eq!((terms.token_type, terms.quote_token_flag), (1, 0));
        assert_eq!(terms.fixed_token_supply_flag, 1);
        assert_eq!(
            (
                terms.creator_trading_fee_percentage,
                terms.migration_fee_percentage,
                terms.creator_migration_fee_percentage
            ),
            (0, 0, 0)
        );
        assert_eq!(terms.migration_quote_threshold, 10_950_000_000);
        // The same bytes as the full config reader.
        let config = DbcConfig::parse(&hex(DBC_CONFIG_6M7X)).unwrap();
        assert_eq!(
            (config.fee_claimer, config.migration_quote_threshold),
            (terms.fee_claimer, terms.migration_quote_threshold)
        );
        assert!(DbcPartnerTerms::parse(&hex(DBC_POOL_2K7B)).is_none());

        let damm = DammPool::parse(&hex(DAMM_POOL_F3S7)).unwrap();
        assert_eq!((damm.token_a_flag, damm.token_b_flag), (1, 0));
    }

    /// The graduated pool's only position and its NFT account. That config
    /// gives the partner no liquidity, so the position belongs to the DBC
    /// pool's creator: exactly what `claim_treasury_lp_fee` must refuse.
    #[test]
    fn reads_a_real_damm_v2_position_and_its_nft_account() {
        let position = DammPosition::parse(&hex(DAMM_POSITION_BUCK)).unwrap();
        assert_eq!(
            position.pool,
            k("F3s7grue6Lpi1JKE5CqFv6YGMELFg6KfT2an3XiJsAbe")
        );
        let nft_mint = k("2QfLSQLpqFRAkKFQx51iGRoZ3R91WWUvJues9MEDDMBM");
        assert_eq!(position.nft_mint, nft_mint);
        assert_eq!((position.fee_a_pending, position.fee_b_pending), (0, 0));
        assert_eq!(position.unlocked_liquidity, 0);
        assert_eq!(
            position.vested_liquidity,
            991_681_178_047_270_730_718_219_105_698
        );
        assert_eq!(position.permanent_locked_liquidity, 0);
        assert_eq!(
            (position.total_claimed_a_fee, position.total_claimed_b_fee),
            (57_354_357_808, 34_222_530)
        );

        let nft = SplTokenAccount::parse_token_2022(&hex(POSITION_NFT_ACCOUNT_9RJB)).unwrap();
        assert_eq!(nft.mint, nft_mint);
        assert_eq!(nft.amount, 1);
        assert_eq!(nft.state, 1);
        let pool = DbcPool::parse(&hex(DBC_POOL_2K7B)).unwrap();
        assert_eq!(nft.owner, pool.creator);
        assert_eq!(
            crate::cpi::meteora::damm_position_nft_account(&nft_mint),
            k("9RjbRGAnCD6RmX4Rh6uoFNLiAhdiLXYGtkikyFBH9cuD")
        );
        assert!(DammPosition::parse(&hex(DAMM_POOL_F3S7)).is_none());
        assert!(DammPosition::parse(&hex(DAMM_POSITION_BUCK)[..407]).is_none());
    }

    #[test]
    fn token_2022_accounts_with_extensions() {
        let base = hex(POSITION_NFT_ACCOUNT_9RJB);
        // An account with extensions: the type byte (2) then TLV data.
        let mut ext = base.clone();
        ext.extend_from_slice(&[2, 7, 0, 0, 0]);
        assert_eq!(
            SplTokenAccount::parse_token_2022(&ext),
            SplTokenAccount::parse(&base)
        );
        // A Token-2022 mint padded to 165 bytes carries type byte 1.
        ext[165] = 1;
        assert!(SplTokenAccount::parse_token_2022(&ext).is_none());
        assert!(SplTokenAccount::parse_token_2022(&base[..164]).is_none());
    }

    #[test]
    fn rejects_wrong_discriminators_and_lengths() {
        let pool = hex(DBC_POOL_2K7B);
        assert!(DbcConfig::parse(&pool).is_none());
        assert!(DammPool::parse(&pool).is_none());
        assert!(DbcPool::parse(&pool[..400]).is_none());
        let damm = hex(DAMM_POOL_F3S7);
        assert!(DbcPool::parse(&damm).is_none());
        assert!(DammConfig::parse(&damm).is_none());
        assert!(SplMint::parse(&[0u8; 81]).is_none());
        let mut bad = [0u8; 82];
        bad[0] = 2; // COption tag 2
        assert!(SplMint::parse(&bad).is_none());
    }

    #[test]
    fn spl_layouts() {
        let mut mint = [0u8; 82];
        mint[36..44].copy_from_slice(&1_000_000u64.to_le_bytes());
        mint[44] = 6;
        mint[45] = 1;
        let m = SplMint::parse(&mint).unwrap();
        assert_eq!(
            m,
            SplMint {
                mint_authority: None,
                supply: 1_000_000,
                decimals: 6,
                is_initialized: true,
                freeze_authority: None
            }
        );
        mint[0] = 1;
        mint[4..36].copy_from_slice(&[7u8; 32]);
        assert_eq!(
            SplMint::parse(&mint).unwrap().mint_authority,
            Some(Pubkey::new_from_array([7; 32]))
        );
        let mut acc = [0u8; 165];
        acc[..32].copy_from_slice(&[1u8; 32]);
        acc[32..64].copy_from_slice(&[2u8; 32]);
        acc[64..72].copy_from_slice(&42u64.to_le_bytes());
        acc[108] = 1;
        let a = SplTokenAccount::parse(&acc).unwrap();
        assert_eq!(
            (a.mint, a.owner, a.amount, a.state),
            (
                Pubkey::new_from_array([1; 32]),
                Pubkey::new_from_array([2; 32]),
                42,
                1
            )
        );
    }
}
