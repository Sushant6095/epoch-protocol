use anchor_lang::prelude::*;

use crate::{
    constants::*,
    cpi::{system::transfer_from_signer, token::create_token_account},
    errors::EpochError,
    events::RevenueTokenRegistered,
    meteora_account::{DbcConfig, DbcPool, SplMint, DBC_MIGRATION_DAMM_V2, DBC_TOKEN_TYPE_SPL},
    state::*,
    vote_account::VoteHeader,
};

#[derive(Accounts)]
pub struct RegisterRevenueToken<'info> {
    /// Signs and pays the rent of the revenue token, its escrow and its token account.
    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, Pool>,

    #[account(
        mut,
        seeds = [POSITION_SEED, vote_account.key().as_ref()],
        bump = position.bump,
        has_one = pool,
        has_one = operator @ EpochError::NotOperator,
    )]
    pub position: Account<'info, ValidatorPosition>,

    /// CHECK: owner checked; the head is parsed in the handler.
    #[account(owner = VOTE_PROGRAM_ID @ EpochError::NotAVoteAccount)]
    pub vote_account: UncheckedAccount<'info>,

    /// CHECK: program signer; must still be the vote account's withdraw authority.
    #[account(seeds = [VOTE_AUTH_SEED, vote_account.key().as_ref()], bump = position.vote_auth_bump)]
    pub vote_auth: UncheckedAccount<'info>,

    #[account(
        init,
        payer = operator,
        space = 8 + RevenueToken::INIT_SPACE,
        seeds = [REVENUE_TOKEN_SEED, vote_account.key().as_ref()],
        bump,
    )]
    pub revenue_token: Account<'info, RevenueToken>,

    /// System-owned and rent-exempt from here on: every sweep's share lands here.
    #[account(mut, seeds = [BUYBACK_SEED, vote_account.key().as_ref()], bump)]
    pub buyback_escrow: SystemAccount<'info>,

    /// CHECK: created here as an SPL Token account for `mint`, owned by the escrow.
    #[account(mut, seeds = [BUYBACK_TOKENS_SEED, vote_account.key().as_ref()], bump)]
    pub buyback_tokens: UncheckedAccount<'info>,

    /// CHECK: checked in the handler: SPL Token mint, fixed supply, no authorities.
    pub mint: UncheckedAccount<'info>,

    /// CHECK: checked in the handler: the mint's DBC pool.
    pub dbc_pool: UncheckedAccount<'info>,

    /// CHECK: checked in the handler: the pool's DBC config.
    pub dbc_config: UncheckedAccount<'info>,

    /// CHECK: the Epoch partner treasury PDA (`["treasury", pool]`); the
    /// config's fee claimer must be this key.
    #[account(seeds = [PARTNER_TREASURY_SEED, pool.key().as_ref()], bump)]
    pub partner_treasury: UncheckedAccount<'info>,

    /// CHECK: the SPL Token program.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Sell `share_bps` of the validator's gross revenue for `term_epochs` epochs
/// as the SPL token `mint`, already launched on its Meteora DBC curve with
/// Epoch as the partner. Share and term are fixed for good.
///
/// From the next epoch, every sweep moves the share into the buyback escrow
/// first; until the term ends the validator cannot `release` the withdraw
/// authority or cut either commission below today's.
///
/// Checks, in order: pool not paused; share 1–5,000 bps; term 10–1,000 epochs;
/// position Active and without a revenue token; the program still holds the
/// vote account's withdraw authority; the mint is a classic SPL Token mint
/// with supply > 0 and **no mint or freeze authority** (DBC creates the mint,
/// mints the whole supply into its vault and revokes the mint authority in
/// the same instruction, `initialize_virtual_pool_with_spl_token`, so a fixed
/// supply is already true at launch; a freeze authority could freeze the
/// buyback account); the DBC pool is owned by DBC, is an SPL Token pool and
/// trades this mint; its config is the pool's, quotes wrapped SOL, graduates
/// to DAMM v2 and names the Epoch treasury PDA as fee claimer.
pub fn register_revenue_token(
    ctx: Context<RegisterRevenueToken>,
    share_bps: u16,
    term_epochs: u16,
) -> Result<()> {
    require!(!ctx.accounts.pool.paused, EpochError::Paused);
    RevenueToken::validate_terms(share_bps, term_epochs)?;
    let position = &ctx.accounts.position;
    require!(
        position.status == PositionStatus::Active,
        EpochError::PositionNotActive
    );
    require!(
        !position.has_revenue_token(),
        EpochError::RevenueTokenExists
    );

    let header = VoteHeader::load(&ctx.accounts.vote_account)?;
    require_keys_eq!(
        header.authorized_withdrawer,
        ctx.accounts.vote_auth.key(),
        EpochError::ProgramNotWithdrawAuthority
    );

    // ── The token ──
    let mint = SplMint::load(&ctx.accounts.mint)?;
    require!(
        mint.is_initialized
            && mint.supply > 0
            && mint.mint_authority.is_none()
            && mint.freeze_authority.is_none(),
        EpochError::InvalidRevenueMint
    );

    // ── Its curve ──
    let dbc_pool = DbcPool::load(&ctx.accounts.dbc_pool)?;
    require_keys_eq!(
        dbc_pool.base_mint,
        ctx.accounts.mint.key(),
        EpochError::InvalidDbcPool
    );
    require_keys_eq!(
        dbc_pool.config,
        ctx.accounts.dbc_config.key(),
        EpochError::InvalidDbcPool
    );
    require!(
        dbc_pool.pool_type == DBC_TOKEN_TYPE_SPL,
        EpochError::InvalidDbcPool
    );
    let config = DbcConfig::load(&ctx.accounts.dbc_config)?;
    require_keys_eq!(config.quote_mint, NATIVE_MINT, EpochError::InvalidDbcConfig);
    require!(
        config.migration_option == DBC_MIGRATION_DAMM_V2 && config.token_type == DBC_TOKEN_TYPE_SPL,
        EpochError::InvalidDbcConfig
    );
    require_keys_eq!(
        config.fee_claimer,
        ctx.accounts.partner_treasury.key(),
        EpochError::InvalidDbcConfig
    );

    // ── Escrow (rent-exempt, so any share can land in it) and token account ──
    let rent_min = Rent::get()?.minimum_balance(0);
    let top_up = rent_min.saturating_sub(ctx.accounts.buyback_escrow.lamports());
    transfer_from_signer(
        &ctx.accounts.operator.to_account_info(),
        &ctx.accounts.buyback_escrow.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        top_up,
    )?;
    let vote_key = ctx.accounts.vote_account.key();
    let tokens_bump = ctx.bumps.buyback_tokens;
    let tokens_seeds: &[&[u8]] = &[BUYBACK_TOKENS_SEED, vote_key.as_ref(), &[tokens_bump]];
    create_token_account(
        &ctx.accounts.operator.to_account_info(),
        &ctx.accounts.buyback_tokens.to_account_info(),
        &ctx.accounts.mint.to_account_info(),
        &ctx.accounts.buyback_escrow.key(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        tokens_seeds,
    )?;
    let (_, wsol_bump) =
        Pubkey::find_program_address(&[BUYBACK_WSOL_SEED, vote_key.as_ref()], ctx.program_id);

    // ── The record ──
    let epoch = Clock::get()?.epoch;
    let start_epoch = epoch.checked_add(1).ok_or(EpochError::MathOverflow)?;
    let term_end_epoch = start_epoch
        .checked_add(u64::from(term_epochs))
        .ok_or(EpochError::MathOverflow)?;
    let params = BuybackParams::default();
    let position_key = ctx.accounts.position.key();
    let advance_seq = ctx.accounts.position.advance_seq;

    let rt = &mut ctx.accounts.revenue_token;
    rt.pool = ctx.accounts.pool.key();
    rt.position = position_key;
    rt.vote = vote_key;
    rt.operator = ctx.accounts.operator.key();
    rt.mint = ctx.accounts.mint.key();
    rt.token_program = TOKEN_PROGRAM_ID;
    rt.dbc_pool = ctx.accounts.dbc_pool.key();
    rt.dbc_config = ctx.accounts.dbc_config.key();
    rt.damm_pool = Pubkey::default();
    rt.share_bps = share_bps;
    rt.term_epochs = term_epochs;
    rt.registered_epoch = epoch;
    rt.start_epoch = start_epoch;
    rt.term_end_epoch = term_end_epoch;
    rt.advance_seq_at_registration = advance_seq;
    rt.inflation_commission_bps = header.inflation_rewards_commission_bps;
    rt.block_commission_bps = header.block_revenue_commission_bps;
    rt.bump = ctx.bumps.revenue_token;
    rt.escrow_bump = ctx.bumps.buyback_escrow;
    rt.tokens_bump = tokens_bump;
    rt.wsol_bump = wsol_bump;
    rt.slices_per_epoch = params.slices_per_epoch;
    rt.window_slots = params.window_slots;
    rt.max_slippage_bps = params.max_slippage_bps;
    rt.max_impact_bps = params.max_impact_bps;
    rt.flags = params.flags;
    // A curve that graduated already moves to `Graduated` through
    // `sync_revenue_token_pool`, which verifies the DAMM v2 pool.
    rt.status = RevenueTokenStatus::Curve;
    rt.buyback_epoch = 0;
    rt.epoch_budget = 0;
    rt.epoch_spent = 0;
    rt.slices_done = 0;
    rt.last_share_epoch = 0;

    ctx.accounts.position.revenue_token = rt.key();

    emit!(RevenueTokenRegistered {
        pool: rt.pool,
        vote: vote_key,
        revenue_token: rt.key(),
        mint: rt.mint,
        dbc_pool: rt.dbc_pool,
        share_bps,
        term_epochs,
        start_epoch,
        term_end_epoch,
        inflation_commission_bps: rt.inflation_commission_bps,
        block_commission_bps: rt.block_commission_bps,
    });
    Ok(())
}
