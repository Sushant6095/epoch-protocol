# ADR 0006: Revenue tokens launched on Meteora DBC, bought back at source

**Status:** accepted · 27 Sep 2026

**Context.** Epoch already holds each onboarded validator's withdraw authority and sweeps its revenue every epoch. Borrowing is one way to turn that revenue into cash today. Selling a slice of it is the other, and there is no venue on Solana where a validator's cashflow trades as an asset. Meteora's Dynamic Bonding Curve gives us price discovery, graduation and a DAMM v2 pool without writing an AMM. Meteora's side track rewards deep use of DBC and new asset classes.

**Decision.**

- A validator can issue a revenue token: a fixed share (`share_bps`) of its commission for a fixed term (`term_epochs`). Both are immutable once registered.
- Epoch is the DBC partner. Each launch uses a revenue-anchored custom curve (60–95% of the share's present value), a small raise target, a 70% creator migration fee (upfront SOL to the validator) and 100% permanently locked DAMM v2 liquidity.
- Partner trading fees are claimed by an Epoch treasury PDA for the senior tranche.
- The share comes off the top of every sweep into a buyback escrow. A permissionless instruction swaps it for the token on DAMM v2 in slices with a min-out, then burns it.
- The validator cannot `release` the withdraw authority before the term ends, and cannot lower commission, because both need the authority Epoch holds.

**Consequences.** The same mechanism now backs two products (advances and revenue tokens), which strengthens the platform story and produces real mainnet volume every epoch. The advance limit shrinks by the share sold. The DAMM v2 CPI is new integration risk; `redeem` (burn for a pro-rata share of the escrow) is the fallback. A revenue-share token can be treated as a security in many countries, so v1 is a hackathon demo at small size with no public marketing, and needs legal review and a geo-restricted front end before any public launch.
