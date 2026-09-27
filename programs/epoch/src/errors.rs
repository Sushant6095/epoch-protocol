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
}
