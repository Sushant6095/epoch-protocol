//! Account types. One file per account; every account carries a `bump` and a
//! `_reserved` tail so it can grow without a migration.

pub mod advance;
pub mod fee_index;
pub mod fee_quote;
pub mod lender;
pub mod pool;
pub mod revenue_token;
pub mod swap_position;
pub mod validator_position;
pub mod withdraw_request;

pub use advance::*;
pub use fee_index::*;
pub use fee_quote::*;
pub use lender::*;
pub use pool::*;
pub use revenue_token::*;
pub use swap_position::*;
pub use validator_position::*;
pub use withdraw_request::*;

use anchor_lang::prelude::*;

/// The two lender tranches. Senior is paid first and takes losses last.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Tranche {
    Senior,
    Junior,
}

impl Tranche {
    pub fn as_u8(self) -> u8 {
        match self {
            Tranche::Senior => 0,
            Tranche::Junior => 1,
        }
    }
}
