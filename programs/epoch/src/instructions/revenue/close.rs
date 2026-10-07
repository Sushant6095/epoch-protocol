use anchor_lang::prelude::*;

use crate::{
    constants::*,
    errors::EpochError,
    events::RevenueTokenClosed,
    instructions::treasury::common::credit_pool_income,
    meteora_account::SplTokenAccount,
    outbound::{
        system::transfer_from_pda,
        token::{burn, close_account},
    },
    state::*,
};

#[derive(Accounts)]
pub struct CloseRevenueToken<'info> {
    /// Anyone may close a finished revenue token.
    pub cranker: Signer<'info>,

    /// CHECK: the operator that paid the rent; receives the rent back (and
    /// the dust of a spent escrow).
    #[account(mut, address = revenue_token.operator @ EpochError::PayoutMismatch)]
    pub operator: UncheckedAccount<'info>,

    /// Books an escrow left unclaimed after the grace period as income.
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,

    /// Receives an escrow left unclaimed after the grace period.
    #[account(mut, seeds = [VAULT_SEED, pool.key().as_ref()], bump = pool.vault_bump)]
    pub vault: SystemAccount<'info>,

    #[account(
        mut,
        close = operator,
        seeds = [REVENUE_TOKEN_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.bump,
        has_one = pool,
    )]
    pub revenue_token: Account<'info, RevenueToken>,

    #[account(
        mut,
        seeds = [BUYBACK_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.escrow_bump,
    )]
    pub buyback_escrow: SystemAccount<'info>,

    /// CHECK: the escrow's token account, burned empty and closed here.
    #[account(
        mut,
        seeds = [BUYBACK_TOKENS_SEED, revenue_token.vote.as_ref()],
        bump = revenue_token.tokens_bump,
    )]
    pub buyback_tokens: UncheckedAccount<'info>,

    /// CHECK: the revenue token's mint.
    #[account(mut, address = revenue_token.mint @ EpochError::InvalidVenueAccount)]
    pub mint: UncheckedAccount<'info>,

    /// CHECK: `["position", vote]`. If the position still exists and points at
    /// this revenue token, the pointer is cleared so later sweeps do not ask
    /// for the closed account; a released (closed) position is left alone.
    #[account(mut, seeds = [POSITION_SEED, revenue_token.vote.as_ref()], bump)]
    pub position: UncheckedAccount<'info>,

    /// CHECK: the SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Close a revenue token after its term, once the escrow is spent (at most
/// `MAX_CLOSE_DUST_LAMPORTS` above rent may remain; it goes to the operator
/// with the rent) or, whatever it holds, once holders had
/// `REDEEM_GRACE_EPOCHS` after the term to redeem (the unclaimed SOL becomes
/// pool income, so a donation to the escrow cannot keep a token open).
/// Burns anything left in the buyback token account, returns the rent to the
/// operator and clears `position.revenue_token`, which lets the position
/// register a new token.
pub fn close_revenue_token(ctx: Context<CloseRevenueToken>) -> Result<()> {
    let epoch = Clock::get()?.epoch;
    let rt = &ctx.accounts.revenue_token;
    require!(!rt.term_active(epoch), EpochError::RevenueTokenTermActive);
    let escrow_info = ctx.accounts.buyback_escrow.to_account_info();
    let rent_min = Rent::get()?.minimum_balance(0);
    let escrow_available = escrow_info.lamports().saturating_sub(rent_min);
    let mode = rt
        .close_mode(epoch, escrow_available)
        .ok_or(EpochError::EscrowNotEmpty)?;

    let vote = rt.vote;
    let escrow_seeds: &[&[u8]] = &[BUYBACK_SEED, vote.as_ref(), &[rt.escrow_bump]];
    let token_program = ctx.accounts.token_program.to_account_info();
    let tokens_info = ctx.accounts.buyback_tokens.to_account_info();
    let operator = ctx.accounts.operator.to_account_info();
    let mut burned = 0;
    if tokens_info.owner == &TOKEN_PROGRAM_ID {
        burned = SplTokenAccount::load(&tokens_info)?.amount;
        burn(
            &tokens_info,
            &ctx.accounts.mint.to_account_info(),
            &escrow_info,
            burned,
            &token_program,
            &[escrow_seeds],
        )?;
        close_account(
            &tokens_info,
            &operator,
            &escrow_info,
            &token_program,
            &[escrow_seeds],
        )?;
    }
    let system_program = ctx.accounts.system_program.to_account_info();
    let lamports_to_pool = match mode {
        CloseMode::Spent => 0,
        CloseMode::Unclaimed => escrow_available,
    };
    if lamports_to_pool > 0 {
        transfer_from_pda(
            &escrow_info,
            &ctx.accounts.vault.to_account_info(),
            &system_program,
            lamports_to_pool,
            &[escrow_seeds],
        )?;
        credit_pool_income(&mut ctx.accounts.pool, lamports_to_pool)?;
    }
    transfer_from_pda(
        &escrow_info,
        &operator,
        &system_program,
        escrow_info.lamports(),
        &[escrow_seeds],
    )?;

    // Clear the position's pointer if it still names this token.
    let position = ctx.accounts.position.to_account_info();
    if position.owner == ctx.program_id && position.data_len() > 0 {
        let mut data = position.try_borrow_mut_data()?;
        let mut account = ValidatorPosition::try_deserialize(&mut &data[..])?;
        if account.revenue_token == rt.key() {
            account.revenue_token = Pubkey::default();
            let mut writer: &mut [u8] = &mut data;
            account.try_serialize(&mut writer)?;
        }
    }

    let rt = &ctx.accounts.revenue_token;
    emit!(RevenueTokenClosed {
        vote,
        mint: rt.mint,
        total_escrowed: rt.total_escrowed,
        total_spent: rt.total_spent,
        total_burned: rt.total_burned.saturating_add(burned),
        total_redeemed: rt.total_redeemed,
        lamports_to_pool,
    });
    Ok(())
}
