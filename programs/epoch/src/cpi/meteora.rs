//! Meteora CPIs, built by hand (discriminator + Borsh args + account metas)
//! so the program needs no Meteora crate: the `swap2` buys and the partner
//! treasury's claims.
//!
//! Both programs take the same `swap2(SwapParameters2 { amount_0: u64,
//! amount_1: u64, swap_mode: u8 })` payload behind the same discriminator
//! `sha256("global:swap2")[..8]`; `swap_mode` 0 = ExactIn, 1 = PartialFill,
//! 2 = ExactOut, and for ExactIn/PartialFill `amount_0` is the input and
//! `amount_1` the minimum output. The account lists below are the IDLs'
//! (`@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13, `@meteora-ag/cp-amm-sdk`
//! 1.5.1); the tests reproduce real mainnet `swap2` instructions byte for byte
//! and slot for slot. An absent optional `referral_token_account` is the
//! callee's program id (Anchor's `None`), as on mainnet.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};

use crate::constants::{
    CP_AMM_EVENT_AUTHORITY, CP_AMM_POOL_AUTHORITY, CP_AMM_POSITION_NFT_ACCOUNT_SEED,
    CP_AMM_PROGRAM_ID, DBC_EVENT_AUTHORITY, DBC_POOL_AUTHORITY, DBC_PROGRAM_ID, NATIVE_MINT,
    TOKEN_PROGRAM_ID,
};

/// `sha256("global:swap2")[..8]`, the same in both programs.
pub const SWAP2_DISCRIMINATOR: [u8; 8] = [65, 75, 63, 76, 235, 91, 91, 136];

pub const SWAP_MODE_EXACT_IN: u8 = 0;
pub const SWAP_MODE_PARTIAL_FILL: u8 = 1;

fn swap2_data(amount_0: u64, amount_1: u64, swap_mode: u8) -> Vec<u8> {
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&SWAP2_DISCRIMINATOR);
    data.extend_from_slice(&amount_0.to_le_bytes());
    data.extend_from_slice(&amount_1.to_le_bytes());
    data.push(swap_mode);
    data
}

/// The accounts a buy needs on either venue. "Token" is the revenue token
/// (DBC base, DAMM v2 token A); "quote" is wrapped SOL (DBC quote, token B).
#[derive(Clone, Copy, Debug)]
pub struct SwapKeys {
    pub pool: Pubkey,
    /// DBC only.
    pub config: Pubkey,
    pub input_token_account: Pubkey,
    pub output_token_account: Pubkey,
    pub token_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub token_mint: Pubkey,
    pub payer: Pubkey,
}

/// DBC `swap2`: quote (SOL) in, base (revenue token) out. 15 accounts.
pub fn dbc_swap2_ix(k: &SwapKeys, amount_in: u64, minimum_out: u64, swap_mode: u8) -> Instruction {
    Instruction {
        program_id: DBC_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
            AccountMeta::new_readonly(k.config, false),
            AccountMeta::new(k.pool, false),
            AccountMeta::new(k.input_token_account, false),
            AccountMeta::new(k.output_token_account, false),
            AccountMeta::new(k.token_vault, false),
            AccountMeta::new(k.quote_vault, false),
            AccountMeta::new_readonly(k.token_mint, false),
            AccountMeta::new_readonly(NATIVE_MINT, false),
            AccountMeta::new_readonly(k.payer, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
            AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
        ],
        data: swap2_data(amount_in, minimum_out, swap_mode),
    }
}

/// DAMM v2 `swap2`: token B (SOL) in, token A (revenue token) out. 14 accounts.
pub fn damm_swap2_ix(k: &SwapKeys, amount_in: u64, minimum_out: u64, swap_mode: u8) -> Instruction {
    Instruction {
        program_id: CP_AMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(CP_AMM_POOL_AUTHORITY, false),
            AccountMeta::new(k.pool, false),
            AccountMeta::new(k.input_token_account, false),
            AccountMeta::new(k.output_token_account, false),
            AccountMeta::new(k.token_vault, false),
            AccountMeta::new(k.quote_vault, false),
            AccountMeta::new_readonly(k.token_mint, false),
            AccountMeta::new_readonly(NATIVE_MINT, false),
            AccountMeta::new_readonly(k.payer, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(CP_AMM_PROGRAM_ID, false),
            AccountMeta::new_readonly(CP_AMM_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(CP_AMM_PROGRAM_ID, false),
        ],
        data: swap2_data(amount_in, minimum_out, swap_mode),
    }
}

/// Invoke a swap built above. `infos` must hold every account the instruction
/// names (duplicates are fine) plus the callee program; `extra` is appended to
/// the metas as remaining accounts (the instructions sysvar for pools whose
/// rate limiter wants it).
pub fn invoke_swap<'info>(
    mut ix: Instruction,
    infos: &[AccountInfo<'info>],
    extra: &[AccountInfo<'info>],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut all = infos.to_vec();
    for info in extra {
        ix.accounts
            .push(AccountMeta::new_readonly(*info.key, false));
        all.push(info.clone());
    }
    invoke_signed(&ix, &all, signer_seeds)?;
    Ok(())
}

// ── Partner treasury claims ───────────────────────────────────────────────
//
// Account lists from the same IDLs (DBC `claim_trading_fee`,
// `partner_withdraw_surplus`, `withdraw_migration_fee`, `withdraw_leftover`;
// cp-amm `claim_position_fee`), pinned slot by slot in the tests below. Every
// list ends with Anchor's `#[event_cpi]` pair: event authority, program. The
// discriminators are the IDLs' (`sha256("global:<name>")[..8]`, checked when
// this was written) and the localnet run executes each one against the real
// mainnet binaries.

/// `sha256("global:claim_trading_fee")[..8]` (DBC, partner).
pub const DBC_CLAIM_TRADING_FEE_DISCRIMINATOR: [u8; 8] = [8, 236, 89, 49, 152, 125, 177, 81];
/// `sha256("global:partner_withdraw_surplus")[..8]`.
pub const DBC_PARTNER_WITHDRAW_SURPLUS_DISCRIMINATOR: [u8; 8] =
    [168, 173, 72, 100, 201, 98, 38, 92];
/// `sha256("global:withdraw_migration_fee")[..8]`.
pub const DBC_WITHDRAW_MIGRATION_FEE_DISCRIMINATOR: [u8; 8] = [237, 142, 45, 23, 129, 6, 222, 162];
/// `sha256("global:withdraw_leftover")[..8]`.
pub const DBC_WITHDRAW_LEFTOVER_DISCRIMINATOR: [u8; 8] = [20, 198, 202, 237, 235, 243, 183, 66];
/// `sha256("global:claim_position_fee")[..8]` (DAMM v2).
pub const CP_AMM_CLAIM_POSITION_FEE_DISCRIMINATOR: [u8; 8] = [180, 38, 154, 17, 133, 33, 162, 211];
/// `withdraw_migration_fee` flag: 0 = partner (the fee claimer), 1 = creator.
pub const DBC_MIGRATION_FEE_FLAG_PARTNER: u8 = 0;

/// The accounts of a DBC partner claim. `base_account` is the treasury's
/// associated token account for the base mint, `quote_account` its one-claim
/// wrapped-SOL account, `treasury` the fee claimer (and leftover receiver).
#[derive(Clone, Copy, Debug)]
pub struct DbcClaimKeys {
    pub pool: Pubkey,
    pub config: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub base_mint: Pubkey,
    pub base_account: Pubkey,
    pub quote_account: Pubkey,
    pub treasury: Pubkey,
}

/// DBC `claim_trading_fee(max_amount_a, max_amount_b)`: base fees to
/// `base_account`, quote fees to `quote_account`. 14 accounts.
pub fn dbc_claim_trading_fee_ix(k: &DbcClaimKeys, max_base: u64, max_quote: u64) -> Instruction {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&DBC_CLAIM_TRADING_FEE_DISCRIMINATOR);
    data.extend_from_slice(&max_base.to_le_bytes());
    data.extend_from_slice(&max_quote.to_le_bytes());
    Instruction {
        program_id: DBC_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
            AccountMeta::new_readonly(k.config, false),
            AccountMeta::new(k.pool, false),
            AccountMeta::new(k.base_account, false),
            AccountMeta::new(k.quote_account, false),
            AccountMeta::new(k.base_vault, false),
            AccountMeta::new(k.quote_vault, false),
            AccountMeta::new_readonly(k.base_mint, false),
            AccountMeta::new_readonly(NATIVE_MINT, false),
            AccountMeta::new_readonly(k.treasury, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
        ],
        data,
    }
}

/// The 10 accounts `partner_withdraw_surplus` and `withdraw_migration_fee`
/// share: pool authority, config, pool (w), quote destination (w), quote
/// vault (w), quote mint, signer, quote token program, event authority,
/// program.
fn dbc_quote_claim_accounts(k: &DbcClaimKeys) -> Vec<AccountMeta> {
    vec![
        AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
        AccountMeta::new_readonly(k.config, false),
        AccountMeta::new(k.pool, false),
        AccountMeta::new(k.quote_account, false),
        AccountMeta::new(k.quote_vault, false),
        AccountMeta::new_readonly(NATIVE_MINT, false),
        AccountMeta::new_readonly(k.treasury, true),
        AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
        AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
        AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
    ]
}

/// DBC `partner_withdraw_surplus`: the partner's share of a completed curve's
/// surplus to `quote_account`. 10 accounts.
pub fn dbc_partner_withdraw_surplus_ix(k: &DbcClaimKeys) -> Instruction {
    Instruction {
        program_id: DBC_PROGRAM_ID,
        accounts: dbc_quote_claim_accounts(k),
        data: DBC_PARTNER_WITHDRAW_SURPLUS_DISCRIMINATOR.to_vec(),
    }
}

/// DBC `withdraw_migration_fee(flag)`: with flag 0 the partner's share of the
/// migration fee to `quote_account`. 10 accounts.
pub fn dbc_withdraw_migration_fee_ix(k: &DbcClaimKeys, flag: u8) -> Instruction {
    let mut data = DBC_WITHDRAW_MIGRATION_FEE_DISCRIMINATOR.to_vec();
    data.push(flag);
    Instruction {
        program_id: DBC_PROGRAM_ID,
        accounts: dbc_quote_claim_accounts(k),
        data,
    }
}

/// DBC `withdraw_leftover`: the unsold supply of a graduated fixed-supply
/// curve to `base_account`, which must be the leftover receiver's associated
/// token account. The receiver does not sign. 10 accounts.
pub fn dbc_withdraw_leftover_ix(k: &DbcClaimKeys) -> Instruction {
    Instruction {
        program_id: DBC_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(DBC_POOL_AUTHORITY, false),
            AccountMeta::new_readonly(k.config, false),
            AccountMeta::new(k.pool, false),
            AccountMeta::new(k.base_account, false),
            AccountMeta::new(k.base_vault, false),
            AccountMeta::new_readonly(k.base_mint, false),
            AccountMeta::new_readonly(k.treasury, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(DBC_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(DBC_PROGRAM_ID, false),
        ],
        data: DBC_WITHDRAW_LEFTOVER_DISCRIMINATOR.to_vec(),
    }
}

/// The accounts of a DAMM v2 position-fee claim. Token A is the revenue token,
/// token B wrapped SOL; `owner` holds the position NFT and signs.
#[derive(Clone, Copy, Debug)]
pub struct DammClaimKeys {
    pub pool: Pubkey,
    pub position: Pubkey,
    pub token_a_account: Pubkey,
    pub token_b_account: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub token_a_mint: Pubkey,
    pub position_nft_account: Pubkey,
    pub owner: Pubkey,
}

/// DAMM v2 `claim_position_fee`: every fee the position earned, token A to
/// `token_a_account`, token B to `token_b_account`. 15 accounts.
pub fn damm_claim_position_fee_ix(k: &DammClaimKeys) -> Instruction {
    Instruction {
        program_id: CP_AMM_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(CP_AMM_POOL_AUTHORITY, false),
            AccountMeta::new_readonly(k.pool, false),
            AccountMeta::new(k.position, false),
            AccountMeta::new(k.token_a_account, false),
            AccountMeta::new(k.token_b_account, false),
            AccountMeta::new(k.token_a_vault, false),
            AccountMeta::new(k.token_b_vault, false),
            AccountMeta::new_readonly(k.token_a_mint, false),
            AccountMeta::new_readonly(NATIVE_MINT, false),
            AccountMeta::new_readonly(k.position_nft_account, false),
            AccountMeta::new_readonly(k.owner, true),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new_readonly(CP_AMM_EVENT_AUTHORITY, false),
            AccountMeta::new_readonly(CP_AMM_PROGRAM_ID, false),
        ],
        data: CP_AMM_CLAIM_POSITION_FEE_DISCRIMINATOR.to_vec(),
    }
}

/// The DAMM v2 position NFT account for `nft_mint` (owned by Token-2022).
pub fn damm_position_nft_account(nft_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[CP_AMM_POSITION_NFT_ACCOUNT_SEED, nft_mint.as_ref()],
        &CP_AMM_PROGRAM_ID,
    )
    .0
}

/// Invoke a claim built above. `infos` must hold every account the
/// instruction names plus the callee program.
pub fn invoke_claim<'info>(
    ix: &Instruction,
    infos: &[AccountInfo<'info>],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    invoke_signed(ix, infos, signer_seeds)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(s: &str) -> Pubkey {
        s.parse().unwrap()
    }

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    /// Mainnet DBC swap2 47zF52fnEKVHqWYx4jyw65L38x325wgyXRa9JFWmzFdrK51Ax8vKD9ShmHszHd2VJ3QvSVyrHFEL12j669XSjPev:
    /// a buy of base 3SLN… for SOL on pool 2k7B… (account list in transaction order).
    #[test]
    fn dbc_swap2_matches_a_mainnet_instruction() {
        let keys = SwapKeys {
            pool: k("2k7BV8AJ2SdAVK6ePyCRVre6Y4NuNLQHUiAUgZ8BRwtt"),
            config: k("6m7XSKNZtiMz3yXfAk8QK5dejQb4aMHjc4bQrqi8h4VD"),
            input_token_account: k("3Ux172uaFpzMizri2SVyZL6a1ZGch5CyvEb9Lrtkbb1Q"),
            output_token_account: k("8G53nzWm37tt87S2myibbfdCWDa16oE5CVVYCBMEFjnD"),
            token_vault: k("HnmJqLkRjdE1nXwtNEMcgV519y3aTcHbBc5krptgY5Vw"),
            quote_vault: k("2ePcacrPfMUNyzfKpddPzZsyE76D64JLnCdVNRn9nHSM"),
            token_mint: k("3SLNKtp6yyumAcKEZ5SvA92vF76boHQKMnjKqLCiTUNd"),
            payer: k("CEN3gYDHzchvzu8GpHmGUHoYqe24ttj49VUrjJP22cv8"),
        };
        let data = hex("414b3f4ceb5b5b885f39e90900000000eb86c2065300000000");
        let amount_0 = u64::from_le_bytes(data[8..16].try_into().unwrap());
        let amount_1 = u64::from_le_bytes(data[16..24].try_into().unwrap());
        let ix = dbc_swap2_ix(&keys, amount_0, amount_1, data[24]);
        assert_eq!(ix.data, data);
        let mainnet = [
            "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM",
            "6m7XSKNZtiMz3yXfAk8QK5dejQb4aMHjc4bQrqi8h4VD",
            "2k7BV8AJ2SdAVK6ePyCRVre6Y4NuNLQHUiAUgZ8BRwtt",
            "3Ux172uaFpzMizri2SVyZL6a1ZGch5CyvEb9Lrtkbb1Q",
            "8G53nzWm37tt87S2myibbfdCWDa16oE5CVVYCBMEFjnD",
            "HnmJqLkRjdE1nXwtNEMcgV519y3aTcHbBc5krptgY5Vw",
            "2ePcacrPfMUNyzfKpddPzZsyE76D64JLnCdVNRn9nHSM",
            "3SLNKtp6yyumAcKEZ5SvA92vF76boHQKMnjKqLCiTUNd",
            "So11111111111111111111111111111111111111112",
            "CEN3gYDHzchvzu8GpHmGUHoYqe24ttj49VUrjJP22cv8",
            // That pool is Token-2022 (base program first); ours are SPL Token.
            "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
            "8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF",
            "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
        ];
        assert_eq!(ix.accounts.len(), mainnet.len());
        for (i, (meta, want)) in ix.accounts.iter().zip(mainnet).enumerate() {
            if i == 10 {
                assert_eq!(meta.pubkey, TOKEN_PROGRAM_ID);
                continue;
            }
            assert_eq!(meta.pubkey, k(want), "slot {i}");
        }
        assert!(ix.accounts[9].is_signer);
        assert_eq!(ix.accounts.iter().filter(|m| m.is_signer).count(), 1);
        let writable: Vec<usize> = (0..15).filter(|i| ix.accounts[*i].is_writable).collect();
        assert_eq!(writable, vec![2, 3, 4, 5, 6]);
    }

    /// Mainnet DAMM v2 swap2 4GCYQzcMpubG2n2WTwCs8ziD9LSrYskeUsfS9a9QhSHjxNvkfHgjA7mJdzNuSeDfhqeweTW2zPrhQXXhmExfWK5Q.
    #[test]
    fn damm_swap2_matches_a_mainnet_instruction() {
        // That pool has SOL as token A; the slot order is what matters here.
        let keys = SwapKeys {
            pool: k("8ESbLWScWK3MBy65sbzgBf9V442Whz6sbCHwrNsSFMWB"),
            config: Pubkey::default(),
            input_token_account: k("5hWMfM4tcDExzJLjJmgtsnRuCXgbN7W2DEb5diNxe6qq"),
            output_token_account: k("H3PWBY2SGejfL5zSCvFBNq4fd5sN1B2P48nhKiv7s6xJ"),
            token_vault: k("eoZsmGf6fkYtdGzz8371LvGgDiUAZxSz27xExjC88Zq"),
            quote_vault: k("BXv7KuvTtv96TviVHwQDketgMqsttYxsGbTmbdPRp9QJ"),
            token_mint: k("So11111111111111111111111111111111111111112"),
            payer: k("F393sG5z8sjAWMTehMnpPizNKfkTYMoieXuYQRwrXyUk"),
        };
        let data = hex("414b3f4ceb5b5b882904e0feee080000060050960000000002");
        let amount_0 = u64::from_le_bytes(data[8..16].try_into().unwrap());
        let amount_1 = u64::from_le_bytes(data[16..24].try_into().unwrap());
        let ix = damm_swap2_ix(&keys, amount_0, amount_1, data[24]);
        assert_eq!(ix.data, data);
        let mainnet = [
            "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC",
            "8ESbLWScWK3MBy65sbzgBf9V442Whz6sbCHwrNsSFMWB",
            "5hWMfM4tcDExzJLjJmgtsnRuCXgbN7W2DEb5diNxe6qq",
            "H3PWBY2SGejfL5zSCvFBNq4fd5sN1B2P48nhKiv7s6xJ",
            "eoZsmGf6fkYtdGzz8371LvGgDiUAZxSz27xExjC88Zq",
            "BXv7KuvTtv96TviVHwQDketgMqsttYxsGbTmbdPRp9QJ",
            "So11111111111111111111111111111111111111112",
            // token B of that pool; ours is always wrapped SOL in slot 7.
            "hLNEjUAqYrgupZgLXGEGL1dhE86s8j8aNfgedTLRoP4",
            "F393sG5z8sjAWMTehMnpPizNKfkTYMoieXuYQRwrXyUk",
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
            "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
            "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
            "3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet",
            "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
        ];
        assert_eq!(ix.accounts.len(), mainnet.len());
        for (i, (meta, want)) in ix.accounts.iter().zip(mainnet).enumerate() {
            if i == 7 || i == 10 {
                continue;
            }
            assert_eq!(meta.pubkey, k(want), "slot {i}");
        }
        assert!(ix.accounts[8].is_signer);
        let writable: Vec<usize> = (0..14).filter(|i| ix.accounts[*i].is_writable).collect();
        assert_eq!(writable, vec![1, 2, 3, 4, 5]);
    }

    fn n(b: u8) -> Pubkey {
        Pubkey::new_from_array([b; 32])
    }

    fn metas(ix: &Instruction) -> Vec<(Pubkey, bool, bool)> {
        ix.accounts
            .iter()
            .map(|m| (m.pubkey, m.is_signer, m.is_writable))
            .collect()
    }

    const R: (bool, bool) = (false, false);
    const W: (bool, bool) = (false, true);
    const S: (bool, bool) = (true, false);

    fn expect(list: &[(Pubkey, (bool, bool))]) -> Vec<(Pubkey, bool, bool)> {
        list.iter().map(|(k, (s, w))| (*k, *s, *w)).collect()
    }

    fn dbc_keys() -> DbcClaimKeys {
        DbcClaimKeys {
            pool: n(1),
            config: n(2),
            base_vault: n(3),
            quote_vault: n(4),
            base_mint: n(5),
            base_account: n(6),
            quote_account: n(7),
            treasury: n(8),
        }
    }

    /// Slot order and flags from the DBC IDL (`dynamic_bonding_curve` 0.2.1).
    #[test]
    fn dbc_claim_trading_fee_follows_the_idl() {
        let ix = dbc_claim_trading_fee_ix(&dbc_keys(), 7, u64::MAX);
        assert_eq!(ix.program_id, DBC_PROGRAM_ID);
        assert_eq!(ix.data[..8], DBC_CLAIM_TRADING_FEE_DISCRIMINATOR);
        assert_eq!(ix.data[8..16], 7u64.to_le_bytes());
        assert_eq!(ix.data[16..24], u64::MAX.to_le_bytes());
        assert_eq!(ix.data.len(), 24);
        // pool_authority, config, pool, token_a_account, token_b_account,
        // base_vault, quote_vault, base_mint, quote_mint, fee_claimer,
        // token_base_program, token_quote_program, event_authority, program
        assert_eq!(
            metas(&ix),
            expect(&[
                (DBC_POOL_AUTHORITY, R),
                (n(2), R),
                (n(1), W),
                (n(6), W),
                (n(7), W),
                (n(3), W),
                (n(4), W),
                (n(5), R),
                (NATIVE_MINT, R),
                (n(8), S),
                (TOKEN_PROGRAM_ID, R),
                (TOKEN_PROGRAM_ID, R),
                (DBC_EVENT_AUTHORITY, R),
                (DBC_PROGRAM_ID, R),
            ])
        );
    }

    #[test]
    fn dbc_quote_claims_follow_the_idl() {
        // pool_authority, config, virtual_pool, token_quote_account,
        // quote_vault, quote_mint, fee_claimer | sender, token_quote_program,
        // event_authority, program
        let want = expect(&[
            (DBC_POOL_AUTHORITY, R),
            (n(2), R),
            (n(1), W),
            (n(7), W),
            (n(4), W),
            (NATIVE_MINT, R),
            (n(8), S),
            (TOKEN_PROGRAM_ID, R),
            (DBC_EVENT_AUTHORITY, R),
            (DBC_PROGRAM_ID, R),
        ]);
        let surplus = dbc_partner_withdraw_surplus_ix(&dbc_keys());
        assert_eq!(
            surplus.data,
            DBC_PARTNER_WITHDRAW_SURPLUS_DISCRIMINATOR.to_vec()
        );
        assert_eq!(metas(&surplus), want);
        let fee = dbc_withdraw_migration_fee_ix(&dbc_keys(), DBC_MIGRATION_FEE_FLAG_PARTNER);
        assert_eq!(fee.data[..8], DBC_WITHDRAW_MIGRATION_FEE_DISCRIMINATOR);
        assert_eq!(fee.data[8..], [0]);
        assert_eq!(metas(&fee), want);
    }

    #[test]
    fn dbc_withdraw_leftover_follows_the_idl() {
        let ix = dbc_withdraw_leftover_ix(&dbc_keys());
        assert_eq!(ix.data, DBC_WITHDRAW_LEFTOVER_DISCRIMINATOR.to_vec());
        // pool_authority, config, virtual_pool, token_base_account, base_vault,
        // base_mint, leftover_receiver (not a signer), token_base_program,
        // event_authority, program
        assert_eq!(
            metas(&ix),
            expect(&[
                (DBC_POOL_AUTHORITY, R),
                (n(2), R),
                (n(1), W),
                (n(6), W),
                (n(3), W),
                (n(5), R),
                (n(8), R),
                (TOKEN_PROGRAM_ID, R),
                (DBC_EVENT_AUTHORITY, R),
                (DBC_PROGRAM_ID, R),
            ])
        );
    }

    /// Slot order and flags from the cp-amm IDL (`cp_amm` 0.2.5).
    #[test]
    fn damm_claim_position_fee_follows_the_idl() {
        let keys = DammClaimKeys {
            pool: n(1),
            position: n(2),
            token_a_account: n(3),
            token_b_account: n(4),
            token_a_vault: n(5),
            token_b_vault: n(6),
            token_a_mint: n(7),
            position_nft_account: n(8),
            owner: n(9),
        };
        let ix = damm_claim_position_fee_ix(&keys);
        assert_eq!(ix.program_id, CP_AMM_PROGRAM_ID);
        assert_eq!(ix.data, CP_AMM_CLAIM_POSITION_FEE_DISCRIMINATOR.to_vec());
        // pool_authority, pool, position, token_a_account, token_b_account,
        // token_a_vault, token_b_vault, token_a_mint, token_b_mint,
        // position_nft_account, signer, token_a_program, token_b_program,
        // event_authority, program
        assert_eq!(
            metas(&ix),
            expect(&[
                (CP_AMM_POOL_AUTHORITY, R),
                (n(1), R),
                (n(2), W),
                (n(3), W),
                (n(4), W),
                (n(5), W),
                (n(6), W),
                (n(7), R),
                (NATIVE_MINT, R),
                (n(8), R),
                (n(9), S),
                (TOKEN_PROGRAM_ID, R),
                (TOKEN_PROGRAM_ID, R),
                (CP_AMM_EVENT_AUTHORITY, R),
                (CP_AMM_PROGRAM_ID, R),
            ])
        );
    }

    #[test]
    fn position_nft_account_is_the_cp_amm_pda() {
        let mint = n(42);
        let (want, _) = Pubkey::find_program_address(
            &[b"position_nft_account", mint.as_ref()],
            &CP_AMM_PROGRAM_ID,
        );
        assert_eq!(damm_position_nft_account(&mint), want);
    }

    #[test]
    fn authorities_are_the_programs_pdas() {
        let pda = |seed: &[u8], program: &Pubkey| Pubkey::find_program_address(&[seed], program).0;
        assert_eq!(pda(b"pool_authority", &DBC_PROGRAM_ID), DBC_POOL_AUTHORITY);
        assert_eq!(
            pda(b"__event_authority", &DBC_PROGRAM_ID),
            DBC_EVENT_AUTHORITY
        );
        assert_eq!(
            pda(b"pool_authority", &CP_AMM_PROGRAM_ID),
            CP_AMM_POOL_AUTHORITY
        );
        assert_eq!(
            pda(b"__event_authority", &CP_AMM_PROGRAM_ID),
            CP_AMM_EVENT_AUTHORITY
        );
    }
}
