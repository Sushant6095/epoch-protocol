//! Cross-program calls. `vote` builds vote-program instructions byte for byte
//! (verified against the upstream crate in tests) so the on-chain build does
//! not depend on `solana-vote-interface`'s type versions; `system` moves
//! lamports out of program-derived system accounts.

pub mod system;
pub mod vote;
