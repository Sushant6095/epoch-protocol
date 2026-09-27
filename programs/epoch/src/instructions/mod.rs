//! One file per instruction, grouped by module. Handlers hold the logic;
//! `lib.rs` only dispatches.

pub mod pool;

pub use pool::*;
