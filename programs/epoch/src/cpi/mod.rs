//! Cross-program calls. `vote` builds vote-program instructions byte for byte
//! (verified against the upstream crate in tests) so the on-chain build does
//! not depend on `solana-vote-interface`'s type versions; `system` moves
//! lamports out of program-derived system accounts; `meteora` builds the DBC
//! and DAMM v2 `swap2` CPIs (pinned to real mainnet instructions in tests);
//! `token` is the SPL Token subset revenue-token buybacks need.

pub mod meteora;
pub mod system;
pub mod token;
pub mod vote;
