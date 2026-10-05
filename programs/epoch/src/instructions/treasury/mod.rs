//! Partner treasury claims (ADR 0006 amendment, 4 Oct 2026).
//!
//! Every revenue token's DBC config names the PDA `["treasury", pool]` as fee
//! claimer (checked by `register_revenue_token`) and should name it leftover
//! receiver too. A PDA cannot sign a transaction, so these permissionless
//! cranks claim on its behalf: the program signs each Meteora CPI with the
//! treasury's seeds, then
//!
//! - **SOL** (wrapped SOL from Meteora) is unwrapped into the pool vault and
//!   booked as pool income (`cash` and `income_unallocated` grow by the same
//!   amount, so the ledger identity holds). The next `accrue` pays it out
//!   like any other income: the protocol fee, then the senior coupon, then
//!   junior;
//! - **tokens** (the DBC base / DAMM v2 token A side) are burned.
//!
//! | Instruction                    | Meteora CPI                         | SOL          | Tokens |
//! |--------------------------------|-------------------------------------|--------------|--------|
//! | `claim_partner_trading_fee`    | DBC `claim_trading_fee`             | pool income  | burned |
//! | `claim_partner_surplus`        | DBC `partner_withdraw_surplus`      | pool income  | –      |
//! | `claim_partner_migration_fee`  | DBC `withdraw_migration_fee(0)`     | pool income  | –      |
//! | `burn_leftover`                | DBC `withdraw_leftover`             | –            | burned |
//! | `claim_treasury_lp_fee`        | DAMM v2 `claim_position_fee`        | pool income  | burned |
//!
//! The cranker pays the transaction fee only: it fronts the rent of the
//! one-claim wrapped-SOL account (and of the treasury's token account when it
//! has to be created) and gets it back in the same instruction. Claims need
//! no `RevenueToken` account, so fees stay claimable after
//! `close_revenue_token` and for launches that never registered.

pub mod burn_leftover;
pub mod claim_lp_fee;
pub mod claim_quote;
pub mod claim_trading_fee;
pub mod common;

pub use burn_leftover::*;
pub use claim_lp_fee::*;
pub use claim_quote::*;
pub use claim_trading_fee::*;
