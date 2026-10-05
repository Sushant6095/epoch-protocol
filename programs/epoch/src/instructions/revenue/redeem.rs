use anchor_lang::prelude::*;

use crate::{
    constants::*,
    cpi::{system::transfer_from_pda, token::burn},
    errors::EpochError,
    events::RevenueTokenRedeemed,
    math::{circulating_supply, redeem_payout},
    meteora_account::{SplMint, SplTokenAccount},
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

    /// CHECK: optional: the Epoch treasury's associated token account for the
    /// mint (a DBC leftover waiting to be burned); checked in the handler.
    /// Leaving it out only lowers the payout.
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
/// Circulating supply = mint supply − the buyback token account − the
/// treasury's token account when passed (both are burned by the next slice
/// or claim). Tokens in the DBC curve or the DAMM v2 pool count: anyone can
/// buy and redeem them, and excluding pool balances would let a holder sell
/// into the pool, redeem at the inflated rate and buy back, for the price of
/// the pool fee. Every token therefore redeems at the same rate whatever the
/// order. Rounds down.
pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    require!(amount > 0, EpochError::ZeroAmount);
    let epoch = Clock::get()?.epoch;
    let rt = &ctx.accounts.revenue_token;
    require!(rt.redeem_open(epoch), EpochError::RedeemNotAllowed);

    // ── Circulating supply ──
    let mint = SplMint::load(&ctx.accounts.mint)?;
    let buyback = SplTokenAccount::load(&ctx.accounts.buyback_tokens)?;
    let mut held_by_epoch = buyback.amount;
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
        held_by_epoch =
            held_by_epoch.saturating_add(SplTokenAccount::load(treasury_tokens)?.amount);
    }
    let circulating = circulating_supply(mint.supply, held_by_epoch);
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
