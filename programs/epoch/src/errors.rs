use anchor_lang::prelude::*;

#[error_code]
pub enum EpochError {
    #[msg("Pool is paused")]
    Paused,
    #[msg("Requested amount exceeds the credit limit")]
    OverLimit,
    #[msg("Validator already has an open advance")]
    AdvanceAlreadyOpen,
    #[msg("Cannot release while an advance is open")]
    AdvanceOpen,
    #[msg("Already processed for this epoch")]
    AlreadyProcessedThisEpoch,
    #[msg("Score must be updated for this epoch first")]
    ScoreNotUpdated,
    #[msg("Fee index for this epoch has not been posted")]
    IndexMissing,
    #[msg("Order book for this epoch is closed")]
    BookClosed,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
