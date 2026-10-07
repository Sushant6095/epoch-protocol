use anchor_lang::prelude::*;

use crate::{constants::*, errors::EpochError, events::ScoringConfigured, state::*};

/// Settings for `refresh_score`; see `ScoreConfig`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ScoringParams {
    pub market_maker: Pubkey,
    pub credits_window_epochs: u8,
    pub count_block_commission: bool,
    pub credits_reference_bps: u16,
    pub max_copy_age_slots: u32,
}

impl ScoringParams {
    pub fn validate(&self) -> Result<()> {
        require!(
            (1..=MAX_CREDITS_WINDOW_EPOCHS).contains(&self.credits_window_epochs),
            EpochError::InvalidScoreConfig
        );
        require!(
            (MIN_CREDITS_REFERENCE_BPS..=BPS_DENOMINATOR as u16)
                .contains(&self.credits_reference_bps),
            EpochError::InvalidScoreConfig
        );
        require!(
            (MIN_MAX_COPY_AGE_SLOTS..=MAX_MAX_COPY_AGE_SLOTS).contains(&self.max_copy_age_slots),
            EpochError::InvalidScoreConfig
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ConfigureScoring<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin @ EpochError::NotAdmin)]
    pub pool: Account<'info, Pool>,

    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + ScoreConfig::INIT_SPACE,
        seeds = [SCORE_CONFIG_SEED, pool.key().as_ref()],
        bump,
    )]
    pub score_config: Account<'info, ScoreConfig>,

    pub system_program: Program<'info, System>,
}

/// Create or update the pool's scoring settings (admin).
pub fn configure_scoring(ctx: Context<ConfigureScoring>, params: ScoringParams) -> Result<()> {
    params.validate()?;
    let pool = ctx.accounts.pool.key();
    let cfg = &mut ctx.accounts.score_config;
    cfg.pool = pool;
    cfg.market_maker = params.market_maker;
    cfg.credits_window_epochs = params.credits_window_epochs;
    cfg.count_block_commission = params.count_block_commission;
    cfg.credits_reference_bps = params.credits_reference_bps;
    cfg.max_copy_age_slots = params.max_copy_age_slots;
    cfg.bump = ctx.bumps.score_config;

    emit!(ScoringConfigured {
        pool,
        market_maker: params.market_maker,
        credits_window_epochs: params.credits_window_epochs,
        count_block_commission: params.count_block_commission,
        credits_reference_bps: params.credits_reference_bps,
        max_copy_age_slots: params.max_copy_age_slots,
    });
    Ok(())
}
