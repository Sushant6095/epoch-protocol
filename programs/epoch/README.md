# Epoch program

Anchor 1.2 program. An Epoch PDA holds each onboarded validator's vote-account
withdraw authority; advances are repaid at source every epoch; lenders fund
them through senior and junior tranches; the program publishes the Solana Fee
Index and settles fee swaps against it; validators can sell a share of their
revenue as a revenue token on Meteora that the program buys back and burns
every epoch, and the program claims Epoch's own Meteora fees (as the curves'
partner) into the pool as lender income (ADR 0006).

## Layout

| Path | What lives there |
| --- | --- |
| `src/lib.rs` | Dispatch only |
| `src/state/` | One account per file: `Pool`, `LenderShares`, `WithdrawRequest`, `ValidatorPosition`, `Advance`, `FeeIndex`, `FeeQuote`, `SwapPosition`, `RevenueToken` |
| `src/math/` | Pure arithmetic with unit tests: tranche shares with virtual offsets, sweep and income waterfalls, credit limit, Epoch Score, the revenue-share waterfall and buyback schedule (`revenue_token.rs`), Meteora DBC / DAMM v2 buy quotes (`amm.rs`) on a small 256-bit integer (`u256.rs`), what DBC owes the partner (`treasury.rs`: surplus, migration fee, leftover) |
| `src/meteora_account.rs` | Read-only views of DBC `VirtualPool` / `PoolConfig` (and its partner terms), DAMM v2 `Pool` / `Config` / `Position`, SPL mint / token accounts and Token-2022 accounts (position NFTs), owner- and discriminator-checked; offsets pinned by tests on real mainnet accounts |
| `src/vote_account.rs` | Reads the head of a vote account (v1.14.11, v3, v4) without deserialising the tower; layout pinned by tests against `solana-vote-interface` |
| `src/cpi/vote.rs` | Vote-program instruction encoders, byte-for-byte checked against the upstream crate in tests |
| `src/cpi/system.rs` | Lamport transfers out of program-derived system accounts; PDA account creation that survives a pre-funded address |
| `src/cpi/meteora.rs` | DBC and DAMM v2 `swap2` instructions, checked byte for byte against real mainnet swaps; the partner claims (DBC `claim_trading_fee`, `partner_withdraw_surplus`, `withdraw_migration_fee`, `withdraw_leftover`, DAMM v2 `claim_position_fee`), checked slot by slot against the IDLs |
| `src/cpi/token.rs` | SPL Token `InitializeAccount3`, `CloseAccount`, `Burn`; associated token account `CreateIdempotent` |
| `src/instructions/` | One file per instruction, grouped: `pool/`, `credit/`, `market/`, `revenue/`, `treasury/` |
| `src/events.rs` | One event per state change; the indexer replays these |

## Build phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Foundation: state, math, vote reader, CPI encoders, admin instructions | done |
| 2 | Pool: deposit, FIFO withdrawal queue (request, cancel, process), epoch accrual with senior→junior waterfall | done |
| 3 | Credit: onboard (one-tx authority handover), collectors, score, bonds, advance, sweep, default with bond-first write-off and 100% recovery, release, covenant-gated commission and identity changes | done |
| 4 | Fee Index (propose → dispute window → finalize, bounded moves, admin veto, 16-epoch history) and fee swaps (maker quotes, bounded payoff, permissionless settlement) | done |
| 5 | LiteSVM epoch-warp tests, fuzzing, invariants, program keys, IDL to `epoch-sdk`, devnet | next |
| 6 | Revenue tokens (ADR 0006): register, share on sweep, buybacks on DBC and DAMM v2 with burn, sync after graduation, redeem, configure, close; release and commission covenants | done (localnet against the real Meteora programs) |
| 7 | Partner treasury claims (ADR 0006 amendment): DBC trading fees, surplus, migration fee and leftover, DAMM v2 LP fees; SOL to pool income, tokens burned | done (localnet against the real Meteora programs) |

## Invariants

- `senior_assets + junior_assets + income_unallocated == cash + outstanding_principal` after every instruction (`Pool::assert_ledger`).
- The vault always holds `cash + bond_total + rent`.
- A sweep never takes the vote account below rent + pending delegator rewards + the admission-ticket reserve.
- Rounding favours the pool: deposits mint fewer shares, redemptions pay fewer lamports.
- A sweep splits gross revenue exactly: `share + remit + to_operator == gross` (fuzzed in `math/revenue_token.rs`).
- A buyback slice never spends more than the escrow holds above rent, moves the pool price by at most `max_impact_bps`, accepts no `min_amount_out` below the pool's fee-free output less `max_slippage_bps`, and burns every token the escrow's token account holds. The cranker gets back the rent it fronts in the same instruction.
- Each slice runs at most once per epoch (`slices_done` bitmap), in the first `window_slots` slots, and during the term only after that epoch's sweep has paid the share.
- Redemptions pay `escrow × amount / circulating`, rounded down, so the holders who stay keep the rounding.
- A treasury claim adds exactly what reached the vault to both `cash` and `income_unallocated` (the ledger identity is asserted again), burns every token the treasury's token account holds, and refunds the cranker every lamport of rent it fronted: the cranker pays the transaction fee only.

## Revenue tokens

| Instruction | Signer | What it does |
| --- | --- | --- |
| `register_revenue_token(share_bps, term_epochs)` | operator | Checks the mint (classic SPL, fixed supply, no mint or freeze authority), its DBC pool and config (quotes SOL, graduates to DAMM v2, fee claimer = `["treasury", pool]` and, for a fixed supply, leftover receiver too; 100% of the graduated liquidity locked forever; venue fees that allow sandwich-proof slices: records `fee_floor_bps` and caps `max_impact_bps` at twice it), snapshots both commissions, creates the escrow and its token account, and points the position at the token. Share 1–5,000 bps, term 10–1,000 epochs, starting next epoch. |
| `sweep` | anyone | Requires the token and escrow when the position has one (`RevenueTokenAccountsMissing` otherwise); moves the share first. |
| `execute_buyback(slice, min_amount_out)` | anyone | One slice on the current venue: wrap, swap, check output ≥ min-out, unwrap, refund the cranker's rent, burn. Stopped by the pool's pause and by the token's own flag. |
| `sync_revenue_token_pool` | anyone | After DBC migrated: verifies the DAMM v2 pool (`["pool", config, max(mint, wsol), min(mint, wsol)]`, config created for DBC's pool authority) and moves buybacks there. |
| `redeem(amount)` | holder | Burns `amount` for its pro-rata share of the escrow, after the term (or during it with `FLAG_REDEEM_DURING_TERM`). Circulating supply is the supply less the buyback and treasury token accounts; pool balances count, so selling into a pool cannot raise a payout. |
| `configure_revenue_token(params)` | pool admin | Slices, window, slippage and impact bounds (`max_impact_bps` ≤ twice `fee_floor_bps`), and the pause and redeem-during-term flags. Never the share or the term. |
| `close_revenue_token` | anyone | After the term, once at most 100,000 lamports above rent remain (all to the operator) or, whatever the escrow holds, 30 epochs after it (`REDEEM_GRACE_EPOCHS`; the rest becomes pool income): returns the rent to the operator and clears the position's pointer. |

`release_validator` and `update_commission` take the revenue token as an optional trailing account and refuse a release or a commission cut while the term runs. Seeds: `["revenue_token", vote]`, `["buyback", vote]`, `["buyback_wsol", vote]`, `["buyback_tokens", vote]`, `["treasury", pool]`.

## Partner treasury claims

Epoch is the DBC partner of every revenue token: its config names the PDA `["treasury", pool]` as fee claimer
(checked at registration) and as leftover receiver. A PDA cannot sign, so these permissionless instructions make the
claims and the program signs each Meteora CPI with the treasury's seeds. They need no `RevenueToken` account, so fees
stay claimable after `close_revenue_token` and for launches that never registered.

| Instruction | Meteora CPI | SOL | Tokens | Refuses with |
| --- | --- | --- | --- | --- |
| `claim_partner_trading_fee` | DBC `claim_trading_fee(u64::MAX, u64::MAX)` | pool income | burned (pools that collect fees in the output token) | `NotTreasuryFeeClaimer`, `NothingToClaim` |
| `claim_partner_surplus` | DBC `partner_withdraw_surplus` | pool income | – | `ClaimNotReady` (curve not complete), `AlreadyClaimed`, `NothingToClaim` |
| `claim_partner_migration_fee` | DBC `withdraw_migration_fee(0)` | pool income | – | `ClaimNotReady`, `AlreadyClaimed`, `NothingToClaim` |
| `burn_leftover` | DBC `withdraw_leftover` (or nothing, when someone already withdrew it to the treasury) | – | all burned | `NotTreasuryLeftoverReceiver`, `UnsupportedClaimPool` (not fixed supply), `ClaimNotReady` (no DAMM v2 pool yet), `NothingToClaim`, `AlreadyClaimed` |
| `claim_treasury_lp_fee` | DAMM v2 `claim_position_fee` | pool income | burned | `NotTreasuryPosition` (the NFT account holding exactly one position NFT is not the treasury's), `NothingToClaim` |

Every claim checks the Meteora program ids and pool / event authorities, that the pool is the config's (DBC) or the
position's (DAMM v2), its vaults and mints, SPL Token on both sides and wrapped SOL as the quote / token B
(`InvalidClaimAccount`, `UnsupportedClaimPool`), and that the Epoch pool is not paused. The SOL arrives in a one-claim
wrapped-SOL account at `["treasury_wsol", pool]` (created with the cranker's rent, closed into the vault, rent refunded
from the vault); tokens arrive in the treasury's associated token account, which is burned empty and closed again if
the claim created it. One event, `TreasuryClaimed { kind, mint, source, position, lamports_claimed, lamports_to_pool,
tokens_claimed, tokens_burned, pool_cash, income_unallocated }`.

**Where the SOL goes.** `cash += x` and `income_unallocated += x`, exactly the vault's gain. The next `accrue` pays it
out like every other income: the protocol fee, then the senior coupon (`senior_assets × rate × epochs`), then junior.
Crediting `senior_assets` directly was rejected: senior withdrawals have no lock, so anyone could deposit senior just
before a permissionless claim and withdraw after it.

**Proven on localnet** (4 Oct 2026, `agent-mprogram/it`, the real DBC, DAMM v2 and Metaplex mainnet binaries): 26 new
checks next to the 35 revenue-token ones, all passing, plus one run of cranks_app's `LaunchFeeClaimJob` through the
program route. Exact amounts every time: DBC trading fees 80,808,198 lamports (SOL-only preset) and 384,090,475
tokens + 4,041,171 lamports (output-token fees); the partner migration fee 3,500,004,976 lamports (= the SDK mirror and
the `@epoch/meteora` reader); a 571,446,000,027-token leftover burned (supply down by exactly that); DAMM v2 LP fees in
SOL (8,270,208) and in both tokens (42,844,885 tokens burned + 8,164,070 lamports); the creator's position refused;
a leftover someone else withdrew still burned. Seven claims put 3,601,288,623 lamports in the vault and in
`income_unallocated`; `accrue` then paid 360,128,862 protocol fee, the 24,000,000 senior coupon and 3,217,159,761 to
junior, identical to `distribute_income`. The cranker paid 5,000 lamports per claim and nothing else. Compute: 16k to
75k CU. DBC's current swaps stop at the migration price, so a completed curve's surplus is a rounding lamport and the
partner's share of it rounds to zero (`NothingToClaim`, checked on both launches).

## Commands

```bash
cargo test -p epoch                          # unit tests (incl. Meteora layouts on real mainnet accounts)
cargo clippy -p epoch --all-targets -- -D warnings
anchor build                                 # needs the Solana toolchain
```
