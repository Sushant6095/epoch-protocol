//! One file per instruction, grouped by module. Handlers hold the logic;
//! `lib.rs` only dispatches.

pub mod credit;
pub mod market;
pub mod pool;
pub mod revenue;
pub mod treasury;

pub use credit::*;
pub use market::*;
pub use pool::*;
pub use revenue::*;
pub use treasury::*;
