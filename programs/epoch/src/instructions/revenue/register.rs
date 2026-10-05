use anchor_lang::prelude::*;

use crate::{
    constants::*,
    cpi::{system::transfer_from_signer, token::create_token_account},
    errors::EpochError,
    events::RevenueTokenRegistered,
    math::{
        dbc_migrated_fee_bps, dbc_min_base_fee_numerator, max_impact_bound, venue_fee_floor_bps,
    },
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
/// to DAMM v2 and names the Epoch treasury PDA as fee claimer and, for a
/// fixed supply, as leftover receiver (`NotTreasuryLeftoverReceiver`: the
/// treasury burns the unsold supply instead of someone selling it to
/// holders); it locks 100% of the graduated pool's liquidity permanently
/// (`LiquidityNotLocked`); its fees cannot fall so low that a slice at the
/// minimum impact cap would be worth sandwiching (`UnsupportedVenueFee`).
///
/// `fee_floor_bps` records the lowest fee the curve or the graduated pool can
/// charge; the default `max_impact_bps` is capped at twice it.
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
    let config = Box::new(DbcConfig::load(&ctx.accounts.dbc_config)?);
    let fee_floor_bps = check_launch_config(&config, &ctx.accounts.partner_treasury.key())?;
    let impact_bound = max_impact_bound(fee_floor_bps);

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
    rt.max_impact_bps = params.max_impact_bps.min(impact_bound);
    rt.fee_floor_bps = fee_floor_bps;
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

/// The DBC config checks, in order: quotes wrapped SOL, graduates to DAMM v2,
/// SPL Token (`InvalidDbcConfig`); the treasury is the fee claimer
/// (`InvalidDbcConfig`) and, for a fixed supply, the leftover receiver
/// (`NotTreasuryLeftoverReceiver`); the graduated pool's liquidity is all
/// locked forever (`LiquidityNotLocked`); the lowest fee the curve or the
/// graduated pool can charge allows at least the minimum impact cap
/// (`UnsupportedVenueFee`). Returns that fee floor, bps.
pub fn check_launch_config(config: &DbcConfig, treasury: &Pubkey) -> Result<u16> {
    require_keys_eq!(config.quote_mint, NATIVE_MINT, EpochError::InvalidDbcConfig);
    require!(
        config.migration_option == DBC_MIGRATION_DAMM_V2 && config.token_type == DBC_TOKEN_TYPE_SPL,
        EpochError::InvalidDbcConfig
    );
    require_keys_eq!(config.fee_claimer, *treasury, EpochError::InvalidDbcConfig);
    // A fixed-supply curve leaves its unsold tokens to the leftover receiver
    // after graduation (DBC burns them otherwise).
    if config.fixed_token_supply_flag == 1 {
        require_keys_eq!(
            config.leftover_receiver,
            *treasury,
            EpochError::NotTreasuryLeftoverReceiver
        );
    }
    require!(
        config.liquidity.fully_locked(),
        EpochError::LiquidityNotLocked
    );
    let curve_fee_floor = dbc_min_base_fee_numerator(
        config.base_fee.mode,
        config.base_fee.cliff_fee_numerator,
        config.base_fee.first_factor,
        config.base_fee.third_factor,
    )
    .ok_or(EpochError::UnsupportedVenueFee)?;
    let migrated_fee_bps = dbc_migrated_fee_bps(
        config.migration_fee_option,
        config.migrated_pool_fee_bps,
        config.migrated_pool_base_fee_mode,
    )
    .ok_or(EpochError::UnsupportedVenueFee)?;
    let fee_floor_bps = venue_fee_floor_bps(curve_fee_floor, migrated_fee_bps);
    require!(
        max_impact_bound(fee_floor_bps) >= MIN_MAX_IMPACT_BPS,
        EpochError::UnsupportedVenueFee
    );
    Ok(fee_floor_bps)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{meteora_account::DbcLiquiditySplit, test_fixtures::mainnet::DBC_CONFIG_6M7X};

    fn code(r: Result<u16>) -> std::result::Result<u16, u32> {
        r.map_err(|e| match e {
            anchor_lang::error::Error::AnchorError(e) => e.error_code_number,
            _ => 0,
        })
    }

    fn err(e: EpochError) -> std::result::Result<u16, u32> {
        Err(u32::from(e))
    }

    /// A real mainnet config (Token-2022, creator LP unlocked, 0.25% curve
    /// fee, 0.1% customizable migrated fee), patched into an Epoch-style
    /// config one field at a time.
    fn epoch_style(treasury: Pubkey) -> DbcConfig {
        let hex = DBC_CONFIG_6M7X;
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        let mut c = DbcConfig::parse(&bytes).unwrap();
        c.token_type = DBC_TOKEN_TYPE_SPL;
        c.fee_claimer = treasury;
        c.leftover_receiver = treasury;
        c.liquidity = DbcLiquiditySplit {
            partner_permanent_locked: 100,
            ..DbcLiquiditySplit::default()
        };
        c.base_fee.cliff_fee_numerator = 10_000_000; // 1%
        c.migration_fee_option = 2; // 1%
        c
    }

    #[test]
    fn an_epoch_style_config_passes_with_its_fee_floor() {
        let t = Pubkey::new_unique();
        assert_eq!(code(check_launch_config(&epoch_style(t), &t)), Ok(100));
        // The mainnet config's own fees: 0.25% curve, 0.1% migrated → 10 bps.
        let mut c = epoch_style(t);
        c.base_fee.cliff_fee_numerator = 2_500_000;
        c.migration_fee_option = 6;
        assert_eq!(code(check_launch_config(&c, &t)), Ok(10));
        assert_eq!(max_impact_bound(10), 20);
    }

    #[test]
    fn the_real_mainnet_config_is_refused() {
        let hex = DBC_CONFIG_6M7X;
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect();
        let real = DbcConfig::parse(&bytes).unwrap();
        // Token-2022, and the fee claimer is not an Epoch treasury.
        assert_eq!(
            code(check_launch_config(&real, &real.fee_claimer)),
            err(EpochError::InvalidDbcConfig)
        );
        // Even as SPL Token with the treasury as claimer: 89% of the graduated
        // liquidity is the creator's to withdraw.
        let mut c = real;
        c.token_type = DBC_TOKEN_TYPE_SPL;
        assert_eq!(
            code(check_launch_config(&c, &real.fee_claimer)),
            err(EpochError::LiquidityNotLocked)
        );
    }

    #[test]
    fn the_leftover_must_reach_the_treasury() {
        let t = Pubkey::new_unique();
        let mut c = epoch_style(t);
        c.leftover_receiver = Pubkey::new_unique();
        assert_eq!(
            code(check_launch_config(&c, &t)),
            err(EpochError::NotTreasuryLeftoverReceiver)
        );
        // Without a fixed supply DBC burns the leftover at migration.
        c.fixed_token_supply_flag = 0;
        assert_eq!(code(check_launch_config(&c, &t)), Ok(100));
    }

    #[test]
    fn the_graduated_liquidity_must_be_locked_forever() {
        let t = Pubkey::new_unique();
        let locked = |s: DbcLiquiditySplit| {
            let mut c = epoch_style(t);
            c.liquidity = s;
            code(check_launch_config(&c, &t))
        };
        let none = DbcLiquiditySplit::default();
        assert_eq!(
            locked(DbcLiquiditySplit {
                partner_permanent_locked: 60,
                creator_permanent_locked: 40,
                ..none
            }),
            Ok(100)
        );
        for split in [
            DbcLiquiditySplit {
                partner_permanent_locked: 99,
                creator_unlocked: 1,
                ..none
            },
            DbcLiquiditySplit {
                partner_permanent_locked: 90,
                partner_unlocked: 10,
                ..none
            },
            DbcLiquiditySplit {
                partner_permanent_locked: 50,
                creator_vesting: 50,
                ..none
            },
            DbcLiquiditySplit {
                creator_permanent_locked: 90,
                partner_vesting: 10,
                ..none
            },
        ] {
            assert_eq!(
                locked(split),
                err(EpochError::LiquidityNotLocked),
                "{split:?}"
            );
        }
    }

    #[test]
    fn fees_too_low_or_decaying_are_refused() {
        let t = Pubkey::new_unique();
        let mut c = epoch_style(t);
        // A curve fee that decays to 0.04%: the bound would be 8 bps < 10.
        c.base_fee.cliff_fee_numerator = 50_000_000;
        c.base_fee.first_factor = 10;
        c.base_fee.third_factor = 4_960_000;
        assert_eq!(
            code(check_launch_config(&c, &t)),
            err(EpochError::UnsupportedVenueFee)
        );
        // The same schedule ending at 0.05%: allowed, bound 10 bps.
        c.base_fee.third_factor = 4_950_000;
        assert_eq!(code(check_launch_config(&c, &t)), Ok(5));
        // Unknown base fee mode.
        let mut c = epoch_style(t);
        c.base_fee.mode = 9;
        assert_eq!(
            code(check_launch_config(&c, &t)),
            err(EpochError::UnsupportedVenueFee)
        );
        // A migrated pool whose fee falls with the market cap.
        let mut c = epoch_style(t);
        c.migration_fee_option = 6;
        c.migrated_pool_fee_bps = 100;
        c.migrated_pool_base_fee_mode = 3;
        assert_eq!(
            code(check_launch_config(&c, &t)),
            err(EpochError::UnsupportedVenueFee)
        );
        // A customizable migrated pool at 0.04%.
        c.migrated_pool_base_fee_mode = 0;
        c.migrated_pool_fee_bps = 4;
        assert_eq!(
            code(check_launch_config(&c, &t)),
            err(EpochError::UnsupportedVenueFee)
        );
    }

    #[test]
    fn quote_migration_and_claimer_are_still_checked() {
        let t = Pubkey::new_unique();
        let mut c = epoch_style(t);
        c.quote_mint = Pubkey::new_unique();
        assert_eq!(
            code(check_launch_config(&c, &t)),
            err(EpochError::InvalidDbcConfig)
        );
        let mut c = epoch_style(t);
        c.migration_option = 0;
        assert_eq!(
            code(check_launch_config(&c, &t)),
            err(EpochError::InvalidDbcConfig)
        );
        let c = epoch_style(t);
        assert_eq!(
            code(check_launch_config(&c, &Pubkey::new_unique())),
            err(EpochError::InvalidDbcConfig)
        );
    }
}
