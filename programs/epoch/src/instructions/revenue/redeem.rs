use anchor_lang::prelude::*;

use crate::{
    constants::*,
    cpi::{system::transfer_from_pda, token::burn},
    errors::EpochError,
    events::RevenueTokenRedeemed,
    math::redeem_payout,
    meteora_account::{DammPool, DbcPool, SplMint, SplTokenAccount},
    state::*,
};

#[derive(Accounts)]
pub struct Redeem<'info> {
    /// Burns its tokens (signs the burn) and receives the SOL.
    #[account(mut)]
    pub holder: Signer<'info>,

    /// CHECK: the holder's token account for the mint; the token program
    /// checks mint and authority on the burn.
    #[account(mut)]
    pub holder_tokens: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [REVENUE_TOKEN_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.bump,
    )]
    pub revenue_token: Account<'info, RevenueToken>,

    #[account(
        mut,
        seeds = [BUYBACK_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.escrow_bump,
    )]
    pub buyback_escrow: SystemAccount<'info>,

    /// CHECK: the escrow's token account (its balance is not circulating).
    #[account(
        seeds = [BUYBACK_TOKENS_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.tokens_bump,
    )]
    pub buyback_tokens: UncheckedAccount<'info>,

    /// CHECK: the revenue token's mint.
    #[account(mut, address = revenue_token.mint @ EpochError::InvalidVenueAccount)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: the token's DBC pool (address checked).
    #[account(address = revenue_token.dbc_pool @ EpochError::InvalidVenueAccount)]
    pub dbc_pool: UncheckedAccount<'info>,

    /// CHECK: the DBC pool's base vault (unsold supply and leftover), checked in the handler.
    pub dbc_base_vault: UncheckedAccount<'info>,

    /// CHECK: after graduation: the DAMM v2 pool (address checked in the handler).
    pub damm_pool: Option<UncheckedAccount<'info>>,

    /// CHECK: after graduation: the pool's token A vault, checked in the handler.
    pub damm_token_vault: Option<UncheckedAccount<'info>>,

    /// CHECK: optional: the Epoch treasury's associated token account for the
    /// mint (DBC leftover withdrawn to the leftover receiver); checked in the handler.
    pub treasury_tokens: Option<UncheckedAccount<'info>>,

    /// CHECK: the SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Burn `amount` tokens for `amount / circulating` of the buyback escrow.
///
/// Open after the term ends (the escrow then holds whatever buybacks did not
/// spend), and during the term only when the pool admin set
/// `FLAG_REDEEM_DURING_TERM`: the fallback for when buybacks cannot run (ADR
/// 0006). It is off by default because during the term the escrow holds one
/// epoch's budget waiting to be bought back, so redeeming early would pay a
/// small fraction of a token's value and race the buyback schedule.
///
/// Circulating supply = mint supply − the DBC base vault (unsold tokens and
/// DBC leftover) − the DAMM v2 token vault after graduation (liquidity, 100%
/// locked by Epoch) − the buyback token account − the treasury's token
/// account when passed. Tokens in pools are not claims on the escrow, so they
/// do not dilute holders. Rounds down.
pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    require!(amount > 0, EpochError::ZeroAmount);
    let epoch = Clock::get()?.epoch;
    let rt = &ctx.accounts.revenue_token;
    require!(rt.redeem_open(epoch), EpochError::RedeemNotAllowed);

    // ── Circulating supply ──
    let mint = SplMint::load(&ctx.accounts.mint)?;
    let mut held_elsewhere: u64 = 0;
    let dbc = DbcPool::load(&ctx.accounts.dbc_pool)?;
    require_keys_eq!(
        dbc.base_vault,
        ctx.accounts.dbc_base_vault.key(),
        EpochError::InvalidVenueAccount
    );
    held_elsewhere =
        held_elsewhere.saturating_add(SplTokenAccount::load(&ctx.accounts.dbc_base_vault)?.amount);
    if rt.graduated() {
        let (pool_info, vault_info) =
            match (&ctx.accounts.damm_pool, &ctx.accounts.damm_token_vault) {
                (Some(p), Some(v)) => (p, v),
                _ => return err!(EpochError::InvalidVenueAccount),
            };
        require_keys_eq!(
            pool_info.key(),
            rt.damm_pool,
            EpochError::InvalidVenueAccount
        );
        let pool = DammPool::load(pool_info)?;
        require_keys_eq!(
            pool.token_a_vault,
            vault_info.key(),
            EpochError::InvalidVenueAccount
        );
        held_elsewhere = held_elsewhere.saturating_add(SplTokenAccount::load(vault_info)?.amount);
    }
    let buyback = SplTokenAccount::load(&ctx.accounts.buyback_tokens)?;
    held_elsewhere = held_elsewhere.saturating_add(buyback.amount);
    if let Some(treasury_tokens) = &ctx.accounts.treasury_tokens {
        let (treasury, _) = Pubkey::find_program_address(
            &[PARTNER_TREASURY_SEED, rt.pool.as_ref()],
            ctx.program_id,
        );
        let (ata, _) = Pubkey::find_program_address(
            &[
                treasury.as_ref(),
                TOKEN_PROGRAM_ID.as_ref(),
                rt.mint.as_ref(),
            ],
            &ASSOCIATED_TOKEN_PROGRAM_ID,
        );
        require_keys_eq!(treasury_tokens.key(), ata, EpochError::InvalidVenueAccount);
        held_elsewhere =
            held_elsewhere.saturating_add(SplTokenAccount::load(treasury_tokens)?.amount);
    }
    let circulating = mint.supply.saturating_sub(held_elsewhere);
    require!(amount <= circulating, EpochError::RedeemTooLarge);

    // ── Payout ──
    let escrow_info = ctx.accounts.buyback_escrow.to_account_info();
    let escrow_available = escrow_info
        .lamports()
        .saturating_sub(Rent::get()?.minimum_balance(0));
    let payout =
        redeem_payout(escrow_available, amount, circulating).ok_or(EpochError::MathOverflow)?;
    require!(payout > 0, EpochError::ZeroAmount);

    burn(
        &ctx.accounts.holder_tokens.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.holder.to_account_info(),
        amount,
        &ctx.accounts.token_program.to_account_info(),
        &[],
    )?;
    let vote = rt.vote;
    let escrow_seeds: &[&[u8]] = &[BUYBACK_SEED, vote.as_ref(), &[rt.escrow_bump]];
    transfer_from_pda(
        &escrow_info,
        &ctx.accounts.holder.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        payout,
        &[escrow_seeds],
    )?;

    let rt = &mut ctx.accounts.revenue_token;
    rt.total_redeemed = rt.total_redeemed.saturating_add(amount);
    rt.total_redeemed_lamports = rt.total_redeemed_lamports.saturating_add(payout);

    emit!(RevenueTokenRedeemed {
        vote,
        mint: rt.mint,
        holder: ctx.accounts.holder.key(),
        tokens_burned: amount,
        lamports_out: payout,
        circulating_supply: circulating,
        epoch,
    });
    Ok(())
}
