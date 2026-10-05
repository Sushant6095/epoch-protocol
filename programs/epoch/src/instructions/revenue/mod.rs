//! Validator revenue tokens on Meteora (ADR 0006, plan F13): register a token
//! launched on a DBC curve, sync the DAMM v2 pool it graduates to, buy back
//! and burn every epoch's share in slices, redeem against the escrow, and
//! close it after the term. The share itself is taken in `credit/sweep.rs`;
//! `release` and `update_commission` enforce the term.

pub mod close;
pub mod configure;
pub mod execute_buyback;
pub mod redeem;
pub mod register;
pub mod sync_pool;
pub mod venue;

pub use close::*;
pub use configure::*;
pub use execute_buyback::*;
pub use redeem::*;
pub use register::*;
pub use sync_pool::*;
