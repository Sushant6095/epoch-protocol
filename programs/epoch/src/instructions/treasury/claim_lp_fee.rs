use anchor_lang::prelude::*;

use super::common::{credit_pool_income, ClaimSigner};
use crate::{
    constants::*,
    cpi::meteora::{damm_claim_position_fee_ix, invoke_claim, DammClaimKeys},
    errors::EpochError,
    events::{TreasuryClaimKind, TreasuryClaimed},
    meteora_account::{DammPool, DammPosition, SplTokenAccount, DAMM_TOKEN_FLAG_SPL},
    state::*,
};

#[derive(Accounts)]
pub struct ClaimTreasuryLpFee<'info> {
    /// Anyone may claim. Pays the transaction fee and fronts the rent of the
    /// claim's token accounts, refunded before the instruction ends.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    /// Receives the SOL side as pool cash.
    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    /// CHECK: the partner treasury PDA; owns the position NFT and signs the claim.
    #[account(seeds = [PARTNER_TREASURY_SEED, pool.key().as_ref()], bump)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: `["treasury_wsol", pool]`: created, paid and closed here.
    #[account(mut, seeds = [TREASURY_WSOL_SEED, pool.key().as_ref()], bump)]
    pub treasury_wsol: UncheckedAccount<'info>,

    /// CHECK: the treasury's associated token account for token A (checked in
    /// the handler; created when missing and then closed again).
    #[account(mut)]
    pub treasury_tokens: UncheckedAccount<'info>,

    /// CHECK: the DAMM v2 pool (owner, layout, mints and vaults checked in the handler).
    pub damm_pool: UncheckedAccount<'info>,

    /// CHECK: a DAMM v2 position in that pool (checked in the handler).
    #[account(mut)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: the Token-2022 account holding the position NFT; the treasury
    /// must own it (checked in the handler).
    pub position_nft_account: UncheckedAccount<'info>,

    /// CHECK: the pool's token A vault.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,

    /// CHECK: the pool's token B (wrapped SOL) vault.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,

    /// CHECK: the pool's token A mint (its supply drops by the burn).
    #[account(mut)]
    pub token_a_mint: UncheckedAccount<'info>,

    /// CHECK: wrapped SOL, the pool's token B.
    #[account(address = NATIVE_MINT @ EpochError::InvalidClaimAccount)]
    pub wsol_mint: UncheckedAccount<'info>,

    /// CHECK: DAMM v2's pool authority.
    #[account(address = CP_AMM_POOL_AUTHORITY @ EpochError::InvalidClaimAccount)]
    pub damm_pool_authority: UncheckedAccount<'info>,

    /// CHECK: DAMM v2's event authority.
    #[account(address = CP_AMM_EVENT_AUTHORITY @ EpochError::InvalidClaimAccount)]
    pub damm_event_authority: UncheckedAccount<'info>,

    /// CHECK: the DAMM v2 program.
    #[account(address = CP_AMM_PROGRAM_ID @ EpochError::InvalidClaimAccount)]
    pub damm_program: UncheckedAccount<'info>,

    /// CHECK: the SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,

    /// CHECK: the associated token account program.
    #[account(address = ASSOCIATED_TOKEN_PROGRAM_ID @ EpochError::InvalidClaimAccount)]
    pub associated_token_program: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Claim the fees of a DAMM v2 position the treasury owns (the partner's share
/// of the graduated pool's liquidity, permanently locked or not): the SOL side
/// becomes pool income, the token side is burned. When a config splits the
/// liquidity between partner and creator, each owns its own position; only
/// the treasury's can be claimed here (the creator claims its own).
///
/// Checks: pool not paused; a DAMM v2 pool of an SPL Token against wrapped SOL
/// (token B), with these vaults and mint; the position is that pool's; the
/// treasury owns the account holding exactly one position NFT
/// (`NotTreasuryPosition`); some fee arrived (`NothingToClaim`).
pub fn claim_treasury_lp_fee(ctx: Context<ClaimTreasuryLpFee>) -> Result<()> {
    let a = &ctx.accounts;
    require!(!a.pool.paused, EpochError::Paused);
    require_keys_eq!(
        *a.damm_pool.owner,
        CP_AMM_PROGRAM_ID,
        EpochError::InvalidClaimAccount
    );
    let damm =
        DammPool::parse(&a.damm_pool.try_borrow_data()?).ok_or(EpochError::InvalidClaimAccount)?;
    require!(
        damm.token_b_mint == NATIVE_MINT
            && damm.token_a_mint != NATIVE_MINT
            && damm.token_a_flag == DAMM_TOKEN_FLAG_SPL
            && damm.token_b_flag == DAMM_TOKEN_FLAG_SPL,
        EpochError::UnsupportedClaimPool
    );
    require_keys_eq!(
        damm.token_a_mint,
        a.token_a_mint.key(),
        EpochError::InvalidClaimAccount
    );
    require_keys_eq!(
        damm.token_a_vault,
        a.token_a_vault.key(),
        EpochError::InvalidClaimAccount
    );
    require_keys_eq!(
        damm.token_b_vault,
        a.token_b_vault.key(),
        EpochError::InvalidClaimAccount
    );
    let position = DammPosition::load(&a.position)?;
    require_keys_eq!(
        position.pool,
        a.damm_pool.key(),
        EpochError::InvalidClaimAccount
    );
    let nft = SplTokenAccount::load_token_2022(&a.position_nft_account)?;
    require!(
        nft.mint == position.nft_mint && nft.amount == 1 && nft.owner == a.treasury.key(),
        EpochError::NotTreasuryPosition
    );

    let pool_key = a.pool.key();
    let treasury_seeds: &[&[u8]] = &[
        PARTNER_TREASURY_SEED,
        pool_key.as_ref(),
        &[ctx.bumps.treasury],
    ];
    let wsol_seeds: &[&[u8]] = &[
        TREASURY_WSOL_SEED,
        pool_key.as_ref(),
        &[ctx.bumps.treasury_wsol],
    ];
    let vault_seeds: &[&[u8]] = &[VAULT_SEED, pool_key.as_ref(), &[a.pool.vault_bump]];

    let cranker = a.cranker.to_account_info();
    let treasury = a.treasury.to_account_info();
    let token_program = a.token_program.to_account_info();
    let system_program = a.system_program.to_account_info();
    let wsol = a.treasury_wsol.to_account_info();
    let tokens = a.treasury_tokens.to_account_info();
    let token_a_mint = a.token_a_mint.to_account_info();
    let vault = a.vault.to_account_info();
    let signer = ClaimSigner {
        cranker: &cranker,
        treasury: &treasury,
        token_program: &token_program,
        system_program: &system_program,
        treasury_seeds,
    };

    let wsol_opened = signer.open_wsol(&wsol, &a.wsol_mint, wsol_seeds)?;
    let tokens_opened = signer.open_tokens(&tokens, &token_a_mint, &a.associated_token_program)?;

    let keys = DammClaimKeys {
        pool: a.damm_pool.key(),
        position: a.position.key(),
        token_a_account: tokens.key(),
        token_b_account: wsol.key(),
        token_a_vault: a.token_a_vault.key(),
        token_b_vault: a.token_b_vault.key(),
        token_a_mint: token_a_mint.key(),
        position_nft_account: a.position_nft_account.key(),
        owner: treasury.key(),
    };
    invoke_claim(
        &damm_claim_position_fee_ix(&keys),
        &[
            a.damm_pool_authority.to_account_info(),
            a.damm_pool.to_account_info(),
            a.position.to_account_info(),
            tokens.clone(),
            wsol.clone(),
            a.token_a_vault.to_account_info(),
            a.token_b_vault.to_account_info(),
            token_a_mint.clone(),
            a.wsol_mint.to_account_info(),
            a.position_nft_account.to_account_info(),
            treasury.clone(),
            token_program.clone(),
            a.damm_event_authority.to_account_info(),
            a.damm_program.to_account_info(),
        ],
        &[treasury_seeds],
    )?;

    let (tokens_claimed, tokens_burned) =
        signer.burn_tokens(&tokens, &tokens_opened, &token_a_mint)?;
    let (lamports_claimed, lamports_to_pool) =
        signer.settle_wsol(&wsol, &wsol_opened, &vault, vault_seeds)?;
    require!(
        tokens_claimed > 0 || lamports_claimed > 0,
        EpochError::NothingToClaim
    );

    let mint = token_a_mint.key();
    let source_key = a.damm_pool.key();
    let position_key = a.position.key();
    let cranker_key = cranker.key();
    let pool = &mut ctx.accounts.pool;
    credit_pool_income(pool, lamports_to_pool)?;
    emit!(TreasuryClaimed {
        pool: pool_key,
        kind: TreasuryClaimKind::LpFee,
        mint,
        source: source_key,
        position: position_key,
        cranker: cranker_key,
        lamports_claimed,
        lamports_to_pool,
        tokens_claimed,
        tokens_burned,
        pool_cash: pool.cash,
        income_unallocated: pool.income_unallocated,
    });
    Ok(())
}
