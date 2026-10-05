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

## Amendment, 4 Oct 2026: the on-chain implementation

What the program does, and where it differs from the decision above.

- **Accounts.** `RevenueToken` at `["revenue_token", vote]` (503 bytes) records the terms, the Meteora pools and the buyback state. The share lands in a system-owned escrow at `["buyback", vote]`, kept rent-exempt. Each buyback slice wraps its SOL in a token account at `["buyback_wsol", vote]` that is created and closed inside the instruction, and the tokens arrive in `["buyback_tokens", vote]` (owned by the escrow), which is burned empty every slice. `ValidatorPosition.revenue_token` takes the 32 reserved bytes, so the account keeps its 415 bytes and every existing position reads "none".
- **Partner treasury.** The DBC config's `fee_claimer` (and `leftover_receiver`) must be the PDA `["treasury", pool]`, checked at registration. DBC's `claim_trading_fee` needs the fee claimer's signature, which a PDA cannot give off-chain, so the program claims for it: see the next amendment.
- **Where buybacks trade.** On the curve (DBC `swap2`, partial fill) until the token graduates, then on its DAMM v2 pool (`swap2`, exact in), after a permissionless `sync_revenue_token_pool` checks that the pool is the PDA of the DAMM v2 config DBC migrated with. Buybacks start on the first epoch of the term, not only after graduation. While the curve is complete and waiting for migration, slices fail with `VenueNotTrading`.
- **The share in the waterfall.** It comes off the top of gross revenue. One exception: when the open advance predates the token, the advance's remittance is computed on gross first and the share comes out of the validator's part, because those lenders underwrote gross revenue. The credit ring buffer records revenue net of the share, so new advances are sized on what is left.
- **Covenants.** `release_validator` and `close_revenue_token` wait for the end of the term. Neither commission can go below its level at registration while the term runs.
- **Sandwich bounds**, enforced by the program whatever the cranker passes:
  1. 12 slices across the first 9,000 slots (~1 hour) of each epoch. Each slice spends what is left of the epoch's budget divided by the slices still to run.
  2. A slice may move the price by at most `max_impact_bps` (default 100), computed on the pool state at execution. A sandwich gains at most that move but pays the pool fee twice, in and out (1% each on Epoch's preset), so it loses money. The admin should keep `max_impact_bps` at or below twice the pool fee (DBC allows fees down to 0.25%).
  3. `min_amount_out` must be at least the pool's fee-free output less `max_slippage_bps` (default 300). Both bounds use exact Rust mirrors of the DBC and DAMM v2 curve math. The admin can tune them per token (`configure_revenue_token`), but never the share or the term.
- **Redeem.** After the term, or during it when the admin sets `FLAG_REDEEM_DURING_TERM` (the fallback if buybacks cannot run), holders burn tokens for `escrow × amount / circulating`, rounded down. Circulating supply leaves out the DBC base vault, the DAMM v2 token vault, the buyback account and, when passed, the treasury's leftover account.
- **Proven on localnet** against the real DBC, DAMM v2 and Metaplex mainnet binaries: launch, registration, an exact share split on sweep, buybacks with burns on DBC and on DAMM v2, migration and sync, redeem during and after the term, release after the term and close. The SDK mirror reproduced the program's slice amount and fee-free output exactly, and every negative case returned its own error. See `programs/epoch/README.md`.

## Amendment, 4 Oct 2026: the treasury's Meteora fees go to lenders

**Decision.** Five permissionless instructions claim what Epoch earns as the curves' partner, the program signing each Meteora call with the treasury's seeds: DBC partner trading fees (`claim_partner_trading_fee`), the partner's share of a completed curve's surplus (`claim_partner_surplus`) and of the migration fee (`claim_partner_migration_fee`), the curve's unsold supply (`burn_leftover`) and the fees of DAMM v2 positions the treasury owns, whatever share of the graduated liquidity the config gives it (`claim_treasury_lp_fee`). SOL goes to the lending pool as income. Tokens are burned, the leftover included: Epoch does not sell or hold the supply it never sold.

- **SOL is pool income.** A claim adds exactly what reached the vault to `cash` and to `income_unallocated`, so `senior_assets + junior_assets + income_unallocated == cash + outstanding_principal` still holds, and the next `accrue` pays it out like every other income: the protocol fee, then the senior coupon, then junior. The senior tranche earns it first, up to its coupon; what is left goes to junior, which takes first loss.
- **Rejected: crediting `senior_assets` directly.** Senior withdrawals have no lock and the claims are permissionless, so anyone could deposit senior just before a large claim (a 3.5 SOL migration fee, say) and withdraw right after it with a slice of income they did not wait for. Through `accrue`, a late depositor earns one epoch's coupon at most, as with any other income. If senior must earn all of it, the way to do it is a senior-only income bucket paid at `accrue`. That needs a new `Pool` field and changes the ledger identity that the SDK, the API and the cranks check, so it is left for a later upgrade.
- **Who pays.** The cranker pays the transaction fee only. Rent for the one-claim wrapped-SOL account (`["treasury_wsol", pool]`) and for the treasury's associated token account comes back in the same instruction. cranks_app's `LaunchFeeClaimJob` sends the treasury's claims this way with the crank key; nobody holds a treasury key. Creator claims are still signed with the creator's own key.
- **No revenue token needed.** Claims read only the Meteora accounts, so they work after `close_revenue_token` and for launches that never registered. Every Meteora account is checked: program ids, pool and event authorities, the pool against its config or position, vaults and mints, SPL Token on both sides, wrapped SOL as the quote, and the position NFT's owner. Errors 6082–6089 are appended.
- **Surplus.** DBC's current swaps stop at the migration price, so a completed curve's surplus is a rounding lamport and the partner's 80% of it rounds to zero. The instruction is there for older pools and future DBC versions.
- **Proven on localnet** against the real DBC, DAMM v2 and Metaplex mainnet binaries: every claim with exact amounts against the SDK mirrors and the `@epoch/meteora` reader, the burns against the mint supply, the pool credit against the vault, and `accrue` paying the senior coupon first. See `programs/epoch/README.md`.

## Amendment, 5 Oct 2026: security review

The pre-mainnet review (`docs/security/revenue-tokens-review.md`) changed the program in five places.

- **Redeem counts pool tokens.** Circulating supply is the mint supply less the buyback and treasury token accounts
  only. Leaving pool balances out let a holder sell into the pool, redeem at the inflated rate and buy back for the
  price of the pool fee. Tokens in a pool now claim their share of the escrow by being bought; every token redeems at
  the same rate in any order.
- **Registration checks the whole launch.** A fixed-supply config must name the treasury as leftover receiver, the
  graduated liquidity must be 100% permanently locked, and the venues' lowest fee (curve schedule and graduated pool)
  is recorded as `fee_floor_bps`.
- **The sandwich bound is enforced.** `max_impact_bps` is capped at twice `fee_floor_bps` at registration and in
  `configure_revenue_token`, instead of relying on the admin.
- **The pool's pause stops buybacks.**
- **Closing cannot be blocked.** 30 epochs after the term (`REDEEM_GRACE_EPOCHS`) a token closes whatever its escrow
  holds; what holders left unclaimed becomes pool income, like the treasury's fees.

