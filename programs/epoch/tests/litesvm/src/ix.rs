//! One builder per program instruction, from the program's own Anchor
//! `accounts::` and `instruction::` types. Adding a test for a new
//! instruction starts with a builder here: fill the accounts struct, pass the
//! args struct, done.
//!
//! An absent optional account is passed as `Some(TEST_PROGRAM_ID)`: Anchor
//! decodes the program id in an `Option<Account>` slot as `None` (the SDK does
//! the same with the deployed id).

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use epoch::constants::{
    ASSOCIATED_TOKEN_PROGRAM_ID, CP_AMM_EVENT_AUTHORITY, CP_AMM_POOL_AUTHORITY, CP_AMM_PROGRAM_ID,
    DBC_EVENT_AUTHORITY, DBC_POOL_AUTHORITY, DBC_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID,
    VOTE_PROGRAM_ID,
};
use epoch::instructions::ScoreUpdate;
use epoch::state::{BuybackParams, PoolParams, Side, Tranche};
use epoch::{accounts as a, instruction as i};

use crate::pda::{self, TEST_PROGRAM_ID};

/// An instruction for the Epoch program.
pub fn build(accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
    Instruction {
        program_id: TEST_PROGRAM_ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

/// `Some(key)`, or the program id standing in for an absent optional account.
pub fn opt(key: Option<Pubkey>) -> Option<Pubkey> {
    Some(key.unwrap_or(TEST_PROGRAM_ID))
}

// ── pool ────────────────────────────────────────────────────────────────

pub fn initialize_pool(
    admin: Pubkey,
    treasury: Pubkey,
    scorer: Pubkey,
    params: PoolParams,
) -> Instruction {
    build(
        a::InitializePool {
            admin,
            pool: pda::pool(),
            vault: pda::vault(),
            treasury,
            scorer,
            system_program: system_program::ID,
        },
        i::InitializePool { params },
    )
}

pub fn update_params(admin: Pubkey, params: PoolParams) -> Instruction {
    build(
        a::AdminOnly {
            admin,
            pool: pda::pool(),
        },
        i::UpdateParams { params },
    )
}

pub fn set_paused(admin: Pubkey, paused: bool) -> Instruction {
    build(
        a::AdminOnly {
            admin,
            pool: pda::pool(),
        },
        i::SetPaused { paused },
    )
}

pub fn set_roles(
    admin: Pubkey,
    treasury: Pubkey,
    scorer: Pubkey,
    new_admin: Pubkey,
) -> Instruction {
    build(
        a::SetRoles {
            admin,
            pool: pda::pool(),
            treasury,
            scorer,
            new_admin,
        },
        i::SetRoles {},
    )
}

pub fn deposit(owner: Pubkey, tranche: Tranche, assets: u64) -> Instruction {
    build(
        a::Deposit {
            owner,
            pool: pda::pool(),
            vault: pda::vault(),
            lender: pda::lender(&owner, tranche),
            system_program: system_program::ID,
        },
        i::Deposit { tranche, assets },
    )
}

/// `seq` is the pool's current `withdraw_tail` (the request's queue slot).
pub fn request_withdraw(owner: Pubkey, tranche: Tranche, seq: u64, shares: u64) -> Instruction {
    build(
        a::RequestWithdraw {
            owner,
            pool: pda::pool(),
            lender: pda::lender(&owner, tranche),
            request: pda::withdraw_request(seq),
            system_program: system_program::ID,
        },
        i::RequestWithdraw { shares },
    )
}

pub fn cancel_withdraw(owner: Pubkey, tranche: Tranche, seq: u64) -> Instruction {
    build(
        a::CancelWithdraw {
            owner,
            pool: pda::pool(),
            lender: pda::lender(&owner, tranche),
            request: pda::withdraw_request(seq),
        },
        i::CancelWithdraw {},
    )
}

pub fn process_withdrawal(
    cranker: Pubkey,
    owner: Pubkey,
    tranche: Tranche,
    seq: u64,
) -> Instruction {
    build(
        a::ProcessWithdrawal {
            cranker,
            pool: pda::pool(),
            vault: pda::vault(),
            owner,
            lender: pda::lender(&owner, tranche),
            request: pda::withdraw_request(seq),
            system_program: system_program::ID,
        },
        i::ProcessWithdrawal {},
    )
}

pub fn accrue(cranker: Pubkey, treasury: Pubkey) -> Instruction {
    build(
        a::Accrue {
            cranker,
            pool: pda::pool(),
            vault: pda::vault(),
            treasury,
            system_program: system_program::ID,
        },
        i::Accrue {},
    )
}

// ── credit ──────────────────────────────────────────────────────────────

const CLOCK: Pubkey = anchor_lang::prelude::pubkey!("SysvarC1ock11111111111111111111111111111111");

/// `onboard_validator`: the operator (fee payer for the position) and the
/// vote account's current withdrawer both sign.
pub fn onboard_validator(
    operator: Pubkey,
    current_withdrawer: Pubkey,
    vote: Pubkey,
    payout: Pubkey,
) -> Instruction {
    build(
        a::OnboardValidator {
            operator,
            current_withdrawer,
            pool: pda::pool(),
            vote_account: vote,
            position: pda::position(&vote),
            vote_auth: pda::vote_auth(&vote),
            escrow: pda::escrow(&vote),
            payout,
            clock: CLOCK,
            vote_program: VOTE_PROGRAM_ID,
            system_program: system_program::ID,
        },
        i::OnboardValidator {},
    )
}

/// `set_collectors`: point both commission collectors at the escrow PDA.
pub fn set_collectors(cranker: Pubkey, vote: Pubkey) -> Instruction {
    build(
        a::SetCollectors {
            cranker,
            position: pda::position(&vote),
            vote_account: vote,
            vote_auth: pda::vote_auth(&vote),
            escrow: pda::escrow(&vote),
            vote_program: VOTE_PROGRAM_ID,
        },
        i::SetCollectors {},
    )
}

pub fn update_score(scorer: Pubkey, vote: Pubkey, update: ScoreUpdate) -> Instruction {
    build(
        a::UpdateScore {
            scorer,
            pool: pda::pool(),
            position: pda::position(&vote),
            history: pda::validator_history(&vote),
        },
        i::UpdateScore { update },
    )
}

fn bond_accounts(operator: Pubkey, vote: Pubkey) -> a::Bond {
    a::Bond {
        operator,
        pool: pda::pool(),
        vault: pda::vault(),
        position: pda::position(&vote),
        system_program: system_program::ID,
    }
}

pub fn post_bond(operator: Pubkey, vote: Pubkey, lamports: u64) -> Instruction {
    build(bond_accounts(operator, vote), i::PostBond { lamports })
}

pub fn withdraw_bond(operator: Pubkey, vote: Pubkey, lamports: u64) -> Instruction {
    build(bond_accounts(operator, vote), i::WithdrawBond { lamports })
}

/// `request_advance`: `seq` is the position's current `advance_seq`.
pub fn request_advance(
    operator: Pubkey,
    vote: Pubkey,
    payout: Pubkey,
    seq: u64,
    amount: u64,
) -> Instruction {
    build(
        a::RequestAdvance {
            operator,
            pool: pda::pool(),
            vault: pda::vault(),
            position: pda::position(&vote),
            advance: pda::advance(&vote, seq),
            payout,
            system_program: system_program::ID,
        },
        i::RequestAdvance { amount },
    )
}

/// `sweep` without a revenue token. `advance`: the open advance, if any.
pub fn sweep(
    cranker: Pubkey,
    vote: Pubkey,
    payout: Pubkey,
    advance: Option<Pubkey>,
) -> Instruction {
    sweep_with_token(cranker, vote, payout, advance, None)
}

/// `sweep` with the revenue-token pair `(revenue_token, buyback_escrow)` when one is registered.
pub fn sweep_with_token(
    cranker: Pubkey,
    vote: Pubkey,
    payout: Pubkey,
    advance: Option<Pubkey>,
    token: Option<(Pubkey, Pubkey)>,
) -> Instruction {
    build(
        a::Sweep {
            cranker,
            pool: pda::pool(),
            vault: pda::vault(),
            position: pda::position(&vote),
            vote_account: vote,
            vote_auth: pda::vote_auth(&vote),
            escrow: pda::escrow(&vote),
            payout,
            advance: opt(advance),
            vote_program: VOTE_PROGRAM_ID,
            system_program: system_program::ID,
            revenue_token: opt(token.map(|t| t.0)),
            buyback_escrow: opt(token.map(|t| t.1)),
        },
        i::Sweep {},
    )
}

pub fn mark_default(cranker: Pubkey, vote: Pubkey, advance: Pubkey) -> Instruction {
    build(
        a::MarkDefault {
            cranker,
            pool: pda::pool(),
            position: pda::position(&vote),
            advance,
        },
        i::MarkDefault {},
    )
}

pub fn release_validator(
    operator: Pubkey,
    vote: Pubkey,
    new_withdrawer: Pubkey,
    identity: Pubkey,
    revenue_token: Option<Pubkey>,
) -> Instruction {
    build(
        a::ReleaseValidator {
            operator,
            pool: pda::pool(),
            vault: pda::vault(),
            position: pda::position(&vote),
            vote_account: vote,
            vote_auth: pda::vote_auth(&vote),
            escrow: pda::escrow(&vote),
            new_withdrawer,
            identity,
            clock: CLOCK,
            vote_program: VOTE_PROGRAM_ID,
            system_program: system_program::ID,
            revenue_token: opt(revenue_token),
        },
        i::ReleaseValidator {},
    )
}

/// `update_commission`: `kind` 0 = inflation rewards, 1 = block revenue.
pub fn update_commission(
    operator: Pubkey,
    vote: Pubkey,
    kind: u8,
    commission_bps: u16,
    revenue_token: Option<Pubkey>,
) -> Instruction {
    build(
        a::UpdateCommission {
            operator,
            pool: pda::pool(),
            position: pda::position(&vote),
            vote_account: vote,
            vote_auth: pda::vote_auth(&vote),
            vote_program: VOTE_PROGRAM_ID,
            revenue_token: opt(revenue_token),
        },
        i::UpdateCommission {
            kind,
            commission_bps,
        },
    )
}

pub fn update_identity(operator: Pubkey, new_identity: Pubkey, vote: Pubkey) -> Instruction {
    build(
        a::UpdateIdentity {
            operator,
            new_identity,
            position: pda::position(&vote),
            vote_account: vote,
            vote_auth: pda::vote_auth(&vote),
            vote_program: VOTE_PROGRAM_ID,
        },
        i::UpdateIdentity {},
    )
}

// ── Fee Index ───────────────────────────────────────────────────────────

pub fn initialize_index(
    admin: Pubkey,
    publisher: Pubkey,
    dispute_window_slots: u64,
    max_move_bps: u16,
) -> Instruction {
    build(
        a::InitializeIndex {
            admin,
            pool: pda::pool(),
            fee_index: pda::fee_index(),
            publisher,
            system_program: system_program::ID,
        },
        i::InitializeIndex {
            dispute_window_slots,
            max_move_bps,
        },
    )
}

pub fn configure_index(
    admin: Pubkey,
    publisher: Pubkey,
    dispute_window_slots: u64,
    max_move_bps: u16,
) -> Instruction {
    build(
        a::ConfigureIndex {
            admin,
            pool: pda::pool(),
            fee_index: pda::fee_index(),
            publisher,
        },
        i::ConfigureIndex {
            dispute_window_slots,
            max_move_bps,
        },
    )
}

pub fn post_index(publisher: Pubkey, epoch: u64, value: u64, inputs_hash: [u8; 32]) -> Instruction {
    build(
        a::PostIndex {
            publisher,
            fee_index: pda::fee_index(),
        },
        i::PostIndex {
            epoch,
            value,
            inputs_hash,
        },
    )
}

pub fn finalize_index(cranker: Pubkey) -> Instruction {
    build(
        a::FinalizeIndex {
            cranker,
            fee_index: pda::fee_index(),
        },
        i::FinalizeIndex {},
    )
}

pub fn veto_index(admin: Pubkey) -> Instruction {
    build(
        a::VetoIndex {
            admin,
            pool: pda::pool(),
            fee_index: pda::fee_index(),
        },
        i::VetoIndex {},
    )
}

// ── Fee market (quotes and swaps) ───────────────────────────────────────

pub fn post_quote(
    maker: Pubkey,
    epoch: u64,
    fixed_rate: u64,
    max_notional: u64,
    max_move_bps: u16,
    expiry_slot: u64,
) -> Instruction {
    build(
        a::PostQuote {
            maker,
            pool: pda::pool(),
            fee_index: pda::fee_index(),
            quote: pda::quote(&maker, epoch),
            system_program: system_program::ID,
        },
        i::PostQuote {
            epoch,
            fixed_rate,
            max_notional,
            max_move_bps,
            expiry_slot,
        },
    )
}

pub fn withdraw_quote(maker: Pubkey, epoch: u64) -> Instruction {
    build(
        a::WithdrawQuote {
            maker,
            fee_index: pda::fee_index(),
            quote: pda::quote(&maker, epoch),
        },
        i::WithdrawQuote {},
    )
}

pub fn open_swap(taker: Pubkey, quote: Pubkey, notional: u64, side: Side) -> Instruction {
    build(
        a::OpenSwap {
            taker,
            pool: pda::pool(),
            fee_index: pda::fee_index(),
            quote,
            swap: pda::swap(&quote, &taker),
            system_program: system_program::ID,
        },
        i::OpenSwap { notional, side },
    )
}

pub fn settle_swap(cranker: Pubkey, quote: Pubkey, taker: Pubkey) -> Instruction {
    build(
        a::SettleSwap {
            cranker,
            fee_index: pda::fee_index(),
            quote,
            taker,
            swap: pda::swap(&quote, &taker),
        },
        i::SettleSwap {},
    )
}

// ── Revenue tokens ──────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
pub fn register_revenue_token(
    operator: Pubkey,
    vote: Pubkey,
    mint: Pubkey,
    dbc_pool: Pubkey,
    dbc_config: Pubkey,
    share_bps: u16,
    term_epochs: u16,
) -> Instruction {
    build(
        a::RegisterRevenueToken {
            operator,
            pool: pda::pool(),
            position: pda::position(&vote),
            vote_account: vote,
            vote_auth: pda::vote_auth(&vote),
            revenue_token: pda::revenue_token(&vote),
            buyback_escrow: pda::buyback(&vote),
            buyback_tokens: pda::buyback_tokens(&vote),
            mint,
            dbc_pool,
            dbc_config,
            partner_treasury: pda::partner_treasury(),
            token_program: TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        },
        i::RegisterRevenueToken {
            share_bps,
            term_epochs,
        },
    )
}

pub fn configure_revenue_token(admin: Pubkey, vote: Pubkey, params: BuybackParams) -> Instruction {
    build(
        a::ConfigureRevenueToken {
            admin,
            pool: pda::pool(),
            revenue_token: pda::revenue_token(&vote),
        },
        i::ConfigureRevenueToken { params },
    )
}

/// `redeem` without the optional treasury token account.
pub fn redeem(
    holder: Pubkey,
    holder_tokens: Pubkey,
    vote: Pubkey,
    mint: Pubkey,
    amount: u64,
) -> Instruction {
    build(
        a::Redeem {
            holder,
            holder_tokens,
            revenue_token: pda::revenue_token(&vote),
            buyback_escrow: pda::buyback(&vote),
            buyback_tokens: pda::buyback_tokens(&vote),
            mint,
            treasury_tokens: opt(None),
            token_program: TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        },
        i::Redeem { amount },
    )
}

// ── Partner treasury claims ─────────────────────────────────────────────

/// The DBC accounts a treasury claim names.
#[derive(Clone, Copy, Debug)]
pub struct DbcAccounts {
    pub pool: Pubkey,
    pub config: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub base_mint: Pubkey,
}

pub fn associated_token(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), TOKEN_PROGRAM_ID.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// The accounts of `claim_partner_trading_fee` (a test can swap any of them).
pub fn claim_partner_trading_fee_accounts(
    cranker: Pubkey,
    d: &DbcAccounts,
) -> a::ClaimPartnerTradingFee {
    a::ClaimPartnerTradingFee {
        cranker,
        pool: pda::pool(),
        vault: pda::vault(),
        treasury: pda::partner_treasury(),
        treasury_wsol: pda::treasury_wsol(),
        treasury_tokens: associated_token(&pda::partner_treasury(), &d.base_mint),
        dbc_pool: d.pool,
        dbc_config: d.config,
        base_vault: d.base_vault,
        quote_vault: d.quote_vault,
        base_mint: d.base_mint,
        wsol_mint: NATIVE_MINT,
        dbc_pool_authority: DBC_POOL_AUTHORITY,
        dbc_event_authority: DBC_EVENT_AUTHORITY,
        dbc_program: DBC_PROGRAM_ID,
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: system_program::ID,
    }
}

pub fn claim_partner_trading_fee(cranker: Pubkey, d: &DbcAccounts) -> Instruction {
    build(
        claim_partner_trading_fee_accounts(cranker, d),
        i::ClaimPartnerTradingFee {},
    )
}

/// The accounts of `claim_partner_surplus` and `claim_partner_migration_fee`.
pub fn claim_partner_quote_accounts(cranker: Pubkey, d: &DbcAccounts) -> a::ClaimPartnerQuote {
    a::ClaimPartnerQuote {
        cranker,
        pool: pda::pool(),
        vault: pda::vault(),
        treasury: pda::partner_treasury(),
        treasury_wsol: pda::treasury_wsol(),
        dbc_pool: d.pool,
        dbc_config: d.config,
        quote_vault: d.quote_vault,
        wsol_mint: NATIVE_MINT,
        dbc_pool_authority: DBC_POOL_AUTHORITY,
        dbc_event_authority: DBC_EVENT_AUTHORITY,
        dbc_program: DBC_PROGRAM_ID,
        token_program: TOKEN_PROGRAM_ID,
        system_program: system_program::ID,
    }
}

pub fn claim_partner_surplus(cranker: Pubkey, d: &DbcAccounts) -> Instruction {
    build(
        claim_partner_quote_accounts(cranker, d),
        i::ClaimPartnerSurplus {},
    )
}

pub fn claim_partner_migration_fee(cranker: Pubkey, d: &DbcAccounts) -> Instruction {
    build(
        claim_partner_quote_accounts(cranker, d),
        i::ClaimPartnerMigrationFee {},
    )
}

/// `close_revenue_token`: `operator` must be the token's recorded operator.
pub fn close_revenue_token(
    cranker: Pubkey,
    operator: Pubkey,
    vote: Pubkey,
    mint: Pubkey,
) -> Instruction {
    build(
        a::CloseRevenueToken {
            cranker,
            operator,
            pool: pda::pool(),
            vault: pda::vault(),
            revenue_token: pda::revenue_token(&vote),
            buyback_escrow: pda::buyback(&vote),
            buyback_tokens: pda::buyback_tokens(&vote),
            mint,
            position: pda::position(&vote),
            token_program: TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        },
        i::CloseRevenueToken {},
    )
}

pub fn burn_leftover(cranker: Pubkey, d: &DbcAccounts) -> Instruction {
    build(
        a::BurnLeftover {
            cranker,
            pool: pda::pool(),
            treasury: pda::partner_treasury(),
            treasury_tokens: associated_token(&pda::partner_treasury(), &d.base_mint),
            dbc_pool: d.pool,
            dbc_config: d.config,
            base_vault: d.base_vault,
            base_mint: d.base_mint,
            dbc_pool_authority: DBC_POOL_AUTHORITY,
            dbc_event_authority: DBC_EVENT_AUTHORITY,
            dbc_program: DBC_PROGRAM_ID,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        },
        i::BurnLeftover {},
    )
}

pub fn sync_revenue_token_pool(
    cranker: Pubkey,
    vote: Pubkey,
    dbc_pool: Pubkey,
    damm_config: Pubkey,
    damm_pool: Pubkey,
) -> Instruction {
    build(
        a::SyncRevenueTokenPool {
            cranker,
            revenue_token: pda::revenue_token(&vote),
            dbc_pool,
            damm_config,
            damm_pool,
        },
        i::SyncRevenueTokenPool {},
    )
}

/// The DAMM v2 accounts of `claim_treasury_lp_fee`.
#[derive(Clone, Copy, Debug)]
pub struct DammAccounts {
    pub pool: Pubkey,
    pub position: Pubkey,
    pub position_nft_account: Pubkey,
    pub token_a_vault: Pubkey,
    pub token_b_vault: Pubkey,
    pub token_a_mint: Pubkey,
}

pub fn claim_treasury_lp_fee_accounts(cranker: Pubkey, d: &DammAccounts) -> a::ClaimTreasuryLpFee {
    a::ClaimTreasuryLpFee {
        cranker,
        pool: pda::pool(),
        vault: pda::vault(),
        treasury: pda::partner_treasury(),
        treasury_wsol: pda::treasury_wsol(),
        treasury_tokens: associated_token(&pda::partner_treasury(), &d.token_a_mint),
        damm_pool: d.pool,
        position: d.position,
        position_nft_account: d.position_nft_account,
        token_a_vault: d.token_a_vault,
        token_b_vault: d.token_b_vault,
        token_a_mint: d.token_a_mint,
        wsol_mint: NATIVE_MINT,
        damm_pool_authority: CP_AMM_POOL_AUTHORITY,
        damm_event_authority: CP_AMM_EVENT_AUTHORITY,
        damm_program: CP_AMM_PROGRAM_ID,
        token_program: TOKEN_PROGRAM_ID,
        associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
        system_program: system_program::ID,
    }
}

/// The venue accounts of `execute_buyback` on a revenue token still on its DBC curve.
#[derive(Clone, Copy, Debug)]
pub struct CurveVenue {
    pub dbc_pool: Pubkey,
    pub dbc_config: Pubkey,
    pub token_vault: Pubkey,
    pub quote_vault: Pubkey,
}

pub fn execute_buyback_accounts(
    cranker: Pubkey,
    vote: Pubkey,
    mint: Pubkey,
    v: &CurveVenue,
) -> a::ExecuteBuyback {
    a::ExecuteBuyback {
        cranker,
        pool: pda::pool(),
        revenue_token: pda::revenue_token(&vote),
        buyback_escrow: pda::buyback(&vote),
        buyback_wsol: pda::buyback_wsol(&vote),
        buyback_tokens: pda::buyback_tokens(&vote),
        mint,
        wsol_mint: NATIVE_MINT,
        dbc_config: v.dbc_config,
        venue_pool: v.dbc_pool,
        venue_token_vault: v.token_vault,
        venue_quote_vault: v.quote_vault,
        venue_pool_authority: DBC_POOL_AUTHORITY,
        venue_event_authority: DBC_EVENT_AUTHORITY,
        venue_program: DBC_PROGRAM_ID,
        token_program: TOKEN_PROGRAM_ID,
        system_program: system_program::ID,
    }
}

pub fn execute_buyback(
    cranker: Pubkey,
    vote: Pubkey,
    mint: Pubkey,
    v: &CurveVenue,
    slice: u8,
    min_amount_out: u64,
) -> Instruction {
    build(
        execute_buyback_accounts(cranker, vote, mint, v),
        i::ExecuteBuyback {
            slice,
            min_amount_out,
        },
    )
}
