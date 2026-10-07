use anchor_lang::prelude::*;

#[error_code]
pub enum EpochError {
    // ── Admin / config ───────────────────────────────────────────────────
    #[msg("Pool is paused")]
    Paused,
    #[msg("Signer is not the pool admin")]
    NotAdmin,
    #[msg("Signer is not the scorer authority")]
    NotScorer,
    #[msg("Signer is not the index publisher")]
    NotPublisher,
    #[msg("A basis-point parameter is above 10,000")]
    BpsOutOfRange,
    #[msg("Pool parameters are inconsistent")]
    InvalidParams,

    // ── Arithmetic ───────────────────────────────────────────────────────
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    // ── Pool ─────────────────────────────────────────────────────────────
    #[msg("Deposit would push the pool above its asset cap")]
    PoolCapExceeded,
    #[msg("Not enough shares")]
    InsufficientShares,
    #[msg("Not enough cash in the vault; try again after the next sweep")]
    InsufficientLiquidity,
    #[msg("Junior tranche is still locked")]
    JuniorLocked,
    #[msg("Withdrawal would push the junior tranche below its floor")]
    JuniorFloorBreached,
    #[msg("Withdrawal requests are processed in order; this one is not next")]
    NotHeadOfQueue,
    #[msg("Withdrawal request was already cancelled")]
    RequestCancelled,
    #[msg("Accrual already ran for this epoch")]
    AlreadyAccrued,
    #[msg("Vault balance does not cover the pool's ledger; refusing to proceed")]
    VaultLedgerMismatch,

    // ── Validator / credit ───────────────────────────────────────────────
    #[msg("Account is not owned by the vote program or is not a vote account")]
    NotAVoteAccount,
    #[msg("Vote account data is not a supported vote state version")]
    UnsupportedVoteState,
    #[msg("Signer is not the vote account's current withdraw authority")]
    NotWithdrawAuthority,
    #[msg("The program is not the vote account's withdraw authority")]
    ProgramNotWithdrawAuthority,
    #[msg("Vote account identity changed outside the program")]
    IdentityMismatch,
    #[msg("Signer is not the position's operator")]
    NotOperator,
    #[msg("Payout account does not match the position")]
    PayoutMismatch,
    #[msg("Validator position is not active")]
    PositionNotActive,
    #[msg("Validator already has an open advance")]
    AdvanceAlreadyOpen,
    #[msg("Advance account does not match the position's open advance")]
    AdvanceMismatch,
    #[msg("Cannot do this while an advance is open")]
    AdvanceOpen,
    #[msg("No open advance")]
    NoOpenAdvance,
    #[msg("Advance is not in the expected state")]
    AdvanceStateInvalid,
    #[msg("Score is too low to borrow")]
    ScoreTooLow,
    #[msg("Score is stale; update it first")]
    ScoreStale,
    #[msg("Requested amount exceeds the credit limit")]
    OverLimit,
    #[msg("Amount is below the minimum advance")]
    BelowMinimum,
    #[msg("Advance would push utilisation above the cap")]
    UtilizationCapExceeded,
    #[msg("Not enough revenue history yet")]
    InsufficientHistory,
    #[msg("Already swept this epoch")]
    AlreadySweptThisEpoch,
    #[msg("Epoch rewards are still being distributed; sweep after they finish")]
    RewardsInProgress,
    #[msg("Advance is not eligible for default yet")]
    NotDefaultable,
    #[msg("Commission below the pool minimum")]
    CommissionTooLow,
    #[msg("Commission changes are limited while an advance is open")]
    CommissionChangeBlocked,
    #[msg("Bond cannot be withdrawn while an advance is open")]
    BondLocked,

    // ── Fee index ────────────────────────────────────────────────────────
    #[msg("Fee index epoch must be greater than the last finalized epoch")]
    IndexEpochNotNewer,
    #[msg("Index move exceeds the per-epoch bound")]
    IndexMoveTooLarge,
    #[msg("No index proposal pending")]
    NoProposal,
    #[msg("Dispute window has not elapsed")]
    DisputeWindowOpen,
    #[msg("Dispute window has elapsed; the proposal can no longer be vetoed")]
    DisputeWindowClosed,
    #[msg("Fee index for this epoch has not been finalized")]
    IndexMissing,

    // ── Market ───────────────────────────────────────────────────────────
    #[msg("Quote has expired")]
    QuoteExpired,
    #[msg("Quote is for a different epoch")]
    QuoteEpochMismatch,
    #[msg("Notional exceeds what the quote has left")]
    QuoteCapacityExceeded,
    #[msg("Quote still has open swaps")]
    QuoteHasOpenSwaps,
    #[msg("Swap already settled")]
    AlreadySettled,
    #[msg("Signer is not the quote maker")]
    NotMaker,

    // ── Revenue tokens (appended: earlier codes never move) ──────────────
    #[msg("Validator already has a revenue token")]
    RevenueTokenExists,
    #[msg("Revenue share must be 1 to 5,000 bps")]
    ShareOutOfRange,
    #[msg("Revenue token term must be 10 to 1,000 epochs")]
    TermOutOfRange,
    #[msg("Mint must be an SPL Token mint with a fixed supply and no mint or freeze authority")]
    InvalidRevenueMint,
    #[msg("Not a Meteora DBC pool for this mint")]
    InvalidDbcPool,
    #[msg(
        "DBC config must quote SOL, graduate to DAMM v2 and name the Epoch treasury as fee claimer"
    )]
    InvalidDbcConfig,
    #[msg("Revenue token account does not match the position")]
    RevenueTokenMismatch,
    #[msg("This position has a revenue token: pass its revenue token and buyback escrow accounts")]
    RevenueTokenAccountsMissing,
    #[msg("Not allowed before the revenue token's term ends")]
    RevenueTokenTermActive,
    #[msg("Commission cannot go below its level when the revenue token was registered")]
    CommissionBelowSnapshot,
    #[msg("The DBC pool has not graduated to DAMM v2 yet")]
    PoolNotMigrated,
    #[msg("Not the DAMM v2 pool this DBC pool graduated to")]
    InvalidDammPool,
    #[msg("The DBC pool graduated: sync its DAMM v2 pool first")]
    PoolNotSynced,
    #[msg("The curve is complete and waits for migration; buybacks resume on DAMM v2")]
    VenueNotTrading,
    #[msg("A Meteora account does not match the revenue token's pool")]
    InvalidVenueAccount,
    #[msg("Outside this epoch's buyback window")]
    OutsideBuybackWindow,
    #[msg("This buyback slice is not due yet")]
    SliceNotDue,
    #[msg("This buyback slice already ran this epoch")]
    SliceAlreadyExecuted,
    #[msg("Slice index is out of range")]
    InvalidSlice,
    #[msg("Sweep this epoch's revenue share before buying back")]
    SweepPending,
    #[msg("Nothing to buy back this slice")]
    NothingToBuy,
    #[msg("min_amount_out is below the floor computed from the pool price")]
    MinOutTooLow,
    #[msg("The swap returned less than min_amount_out")]
    BuybackOutputTooLow,
    #[msg("Buybacks are paused for this revenue token")]
    BuybacksPaused,
    #[msg("Redemptions open when the term ends")]
    RedeemNotAllowed,
    #[msg("Amount exceeds the circulating supply")]
    RedeemTooLarge,
    #[msg("The buyback escrow still holds SOL")]
    EscrowNotEmpty,
    #[msg("Buyback parameters are out of range")]
    InvalidBuybackParams,

    // ── Treasury claims (appended: earlier codes never move) ─────────────
    #[msg("The DBC config's fee claimer is not the Epoch treasury")]
    NotTreasuryFeeClaimer,
    #[msg("The DBC config's leftover receiver is not the Epoch treasury")]
    NotTreasuryLeftoverReceiver,
    #[msg("The Epoch treasury does not own this DAMM v2 position")]
    NotTreasuryPosition,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Not claimable yet: the curve is not complete or the DAMM v2 pool does not exist yet")]
    ClaimNotReady,
    #[msg("The treasury already claimed this")]
    AlreadyClaimed,
    #[msg("Only SPL Token pools that quote wrapped SOL are supported (and a fixed supply for leftover)")]
    UnsupportedClaimPool,
    #[msg("A Meteora account does not match the pool being claimed")]
    InvalidClaimAccount,

    // ── Security review (appended: earlier codes never move) ─────────────
    #[msg("The DBC config must lock all of the graduated pool's liquidity permanently")]
    LiquidityNotLocked,
    #[msg("The venue's fee is too low, or can fall too low, for sandwich-proof buybacks")]
    UnsupportedVenueFee,
    #[msg("max_impact_bps may be at most twice the venue's lowest fee")]
    ImpactAboveFeeBound,

    // ── Validator history and the permissionless score (appended) ────────
    #[msg("The epoch is outside the history's 64-epoch window, or a newer epoch holds its entry")]
    HistoryEpochOutOfRange,
    #[msg("The validator history belongs to another vote account")]
    HistoryVoteMismatch,
    #[msg("The validator history has no recent vote-account copy for this epoch")]
    HistoryStale,
    #[msg("No stake info has been posted for this epoch")]
    StakeInfoStale,
    #[msg("Not the Jito distribution account for this vote account and epoch")]
    InvalidDistributionAccount,
    #[msg("A hedge account is not an unsettled receive-fixed swap of this operator against the market maker")]
    InvalidHedgeAccount,
    #[msg("This validator has fresh on-chain history: use refresh_score")]
    HistoryIsFresh,
    #[msg("Score configuration is out of range")]
    InvalidScoreConfig,
}
