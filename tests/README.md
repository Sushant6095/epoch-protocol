# Tests

Every suite in the repo and how to run it. CI (`.github/workflows/ci.yml`) runs all of them on every push and pull
request.

| Suite | Where | What it proves | Command |
| --- | --- | --- | --- |
| Program unit tests | `programs/epoch/src/**` (`#[cfg(test)]`) | each module's logic: math worked examples, vote-state reader, CPI encoders, account sizes | `cargo test -p epoch --lib` |
| Program property tests | `programs/epoch/tests/props.rs` | the math invariants over the whole input space (proptest): shares never leak value through rounding, waterfalls conserve lamports, credit-limit caps, score bounds, revenue-token payouts, fee-swap payoffs within the collateral, the DBC leftover | `cargo test -p epoch --test props` |
| Program LiteSVM suite | `programs/epoch/tests/litesvm/` | every instruction end to end against the SBF build, with real vote accounts and the vote program's CPIs | see below |
| TypeScript packages | `packages/*/src/**/*.test.ts` | API, indexer, cranks, SDK (Jest; DB tests need Postgres) | `pnpm test` |

`cargo test` at the repo root runs the unit and property tests.

## LiteSVM suite

```bash
# 1. Agave CLI (cargo-build-sbf + platform-tools), once:
sh -c "$(curl -sSfL https://release.anza.xyz/v4.3.0/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# 2. Build the program the suite loads (target/litesvm/epoch.so):
programs/epoch/tests/build-sbf.sh

# 3. Run it:
cargo test --manifest-path programs/epoch/tests/litesvm/Cargo.toml
```

`EPOCH_LITESVM_SO=/path/to/epoch.so` runs the suite against another build; `CARGO_TARGET_DIR` is honoured by both the
script and the suite. `EPOCH_METEORA_SO_DIR=/dir/with/dbc.so+cp_amm.so` also runs the Meteora CPI test (below). The
suite takes about 25 s on two cores (each test loads the program into a fresh SVM).

### What the scenarios cover

| Module (`tests/scenarios/`) | Scenarios | Instructions |
| --- | --- | --- |
| `pool.rs` | init and parameter validation, `update_params`, pause, the junior floor, the pool cap, a donation does not move the share price | `initialize_pool`, `update_params`, `set_paused`, `deposit` |
| `withdrawals.rs` | FIFO queue for both tranches: strict order, cancel (owner only), the junior lock, a junior request that would breach the floor bounces instead of blocking the queue | `request_withdraw`, `process_withdrawal`, `cancel_withdraw` |
| `vote_cpi.rs` | the vote program's `Authorize`, `Withdraw`, `UpdateCommissionCollector`, `UpdateCommissionBps` under LiteSVM | (vote program) |
| `credit.rs` | onboard → collectors → bond → sweeps → advance → repaying sweeps → release; double sweep; accrual over epochs (protocol fee → senior coupon → junior); late ×3 → `mark_default` (bond, then junior; senior untouched); commission and identity updates | `onboard_validator`, `set_collectors`, `post_bond`, `withdraw_bond`, `update_score`, `request_advance`, `sweep`, `accrue`, `mark_default`, `release_validator`, `update_commission`, `update_identity` |
| `market.rs` | Fee Index: post → dispute window (to the slot) → finalize, one proposal at a time, epochs only forward, the move limit both ways, admin veto, reconfiguration, a 16-point history; quotes and swaps: validation, collateral, capacity, `IndexMissing` until final, trading closes at the quoted epoch, settlement both ways and clipped, maker-only withdrawal, lamports conserved | `initialize_index`, `configure_index`, `post_index`, `finalize_index`, `veto_index`, `post_quote`, `open_swap`, `settle_swap`, `withdraw_quote` |
| `revenue.rs` | launch checks (operator, share and term bounds, mint authority, crossed pool, foreign fee claimer, non-DBC owner, double registration); the share swept into the escrow first and kept out of the revenue history; missing or wrong token accounts on sweep; redeem closed during the term unless the admin opens it, one rate for every holder, burns; graduation sync accepts only the DAMM v2 pool DBC's migration created (not migrated, other curve, lookalike address, foreign config, wrong orientation; re-sync is a no-op); buyback slices follow the schedule (slice index, not due yet, outside the window, paused by the admin, minimum output, the epoch's sweep first) before the venue is checked; close after the grace period books the unclaimed escrow as pool income | `register_revenue_token`, `sweep`, `configure_revenue_token`, `redeem`, `sync_revenue_token_pool`, `execute_buyback`, `close_revenue_token` |
| `treasury.rs` | every account check of the partner claims (PDAs, Meteora program and authorities, pool/config/vault/mint links, fee claimer and leftover receiver, owner, graduation, pause) and of the LP-fee claim (DAMM v2 pool, vaults, mint, the position's pool, the treasury owning the position NFT); with the dumps, a full trading-fee claim and a full leftover burn through the real DBC program, and the LP-fee claim reaching DAMM v2 | `claim_partner_trading_fee`, `claim_partner_surplus`, `claim_partner_migration_fee`, `burn_leftover`, `claim_treasury_lp_fee` |
| `roles.rs` | every role with a wrong signer: an intruder in the role's slot, and the right key without its signature | all admin, scorer, publisher, operator and lender-owner instructions |

After each state-changing step that touches the pool, `ctx.assert_ledger()` checks the pool's ledger identity and that
the vault holds at least what the ledger says.

### Meteora (DBC and DAMM v2)

Revenue tokens and the treasury claims read Meteora accounts and CPI into Meteora. The harness covers them in two layers:

- **Fabricated accounts** (`src/meteora.rs`): SPL mints and token accounts and DBC `VirtualPool` / `PoolConfig`
  accounts written at the offsets `epoch::meteora_account` reads. Everything that only reads Meteora state runs on
  every commit: registration, the sweep share, `redeem`, `configure_revenue_token`, `sync_revenue_token_pool` (with
  fabricated DAMM v2 configs and pools), `close_revenue_token` and every check the treasury claims make before their
  CPI.
- **The real programs**, when `EPOCH_METEORA_SO_DIR` points at a directory with `dbc.so` and `cp_amm.so` (mainnet
  dumps: `solana program dump dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN dbc.so`, same for
  `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`). LiteSVM 0.15 loads and runs both. The fabricated pool and config pass
  DBC's own account checks, so two whole flows run through the real DBC program: a trading-fee claim (DBC pays the
  partner fee into the treasury's wrapped-SOL account, Epoch unwraps it into the vault as pool income) and a leftover
  burn (DBC sends a graduated curve's unsold supply to the treasury, Epoch burns it). The dumps are not committed
  (third-party binaries), so CI runs these two tests as skips.

Not covered end to end yet, because they need state only Meteora can create consistently (a curve with reserves and a
price, a graduated pool with fee growth on a position): a buyback swap (`execute_buyback`: its schedule checks and the venue
program check are covered, the DBC / DAMM v2 swap is not) and a paying `claim_treasury_lp_fee` (its account checks
are covered, and with the dump the CPI reaches DAMM v2, which then rejects the fabricated position).
They are covered by the program's unit tests and the localnet end-to-end run (`scratchpad/localnet`). The next step is
to create the curve through DBC itself in the test (`create_config`, `initialize_virtual_pool_with_spl_token`, swaps)
with the dumps loaded.

**Why a build script.** Anchor's entrypoint rejects any program id other than `declare_id!`, and the repo declares the
placeholder `11111111111111111111111111111111` (the System Program's address) until a real id is set with
`scripts/set-program-id.sh`. `build-sbf.sh` copies the crate into `target/litesvm/src`, sets `declare_id!` to the test
id `7pyci4ooVzsJH6Q5whahGNFwyjqhRhhm365jQkeWQ6tg` in that copy only, and builds it with the repo's `Cargo.lock`. The
harness deploys the binary at that id and derives every PDA from it. Rebuild after every program change.

**Why its own `Cargo.lock`.** `programs/epoch/tests/litesvm` is a separate workspace. Every LiteSVM release that builds
on the repo's Rust 1.89 (0.14 to 0.16, Agave 4.1 and 4.2) is compiled against the Solana SDK crates that use `wincode`
0.5, while the program's dev-dependencies (`solana-vote-interface` 7.1, `solana-pubkey` 4.4) lock the `wincode` 0.6
generation, and a lockfile holds one version per semver line. LiteSVM 0.17 (Agave 4.3) needs Rust 1.97. With its own
lockfile the suite resolves `epoch`'s normal dependencies to the generation LiteSVM 0.15.2 needs, the program's lock
is untouched, and the Agave crates are pinned to 4.1.2 there (their caret requirements would otherwise pull 4.3).

**Cluster.** `TestContext::new()` is LiteSVM with every feature active (the set `solana-test-validator` runs; the vote
program's `UpdateCommissionCollector` and `UpdateCommissionBps` need SIMD-0185, -0232, -0249 and -0291), the program
loaded, a dedicated fee payer (role balances move only by protocol effects), the clock at epoch 800 with 432,000-slot
epochs and an `EpochSchedule` without warm-up to match (LiteSVM's default schedule has warm-up epochs, so its epoch and
slot index would disagree with the warped clock), and a fresh blockhash per transaction.

### Writing a test

```rust
use epoch::errors::EpochError;
use epoch::state::Tranche;
use epoch_litesvm_tests::context::{code, sol, TestContext};
use epoch_litesvm_tests::{ix, ExpectErr};

#[test]
fn senior_needs_junior_cover() {
    let mut ctx = TestContext::with_pool(); // pool initialised by "admin" with the seed's parameters
    ctx.deposit("lender1", Tranche::Senior, sol(10.0)).fails_with(code(EpochError::JuniorFloorBreached));
    ctx.deposit("lender2", Tranche::Junior, sol(20.0)).unwrap();
    ctx.assert_ledger();
}
```

- Wallets are named: `ctx.wallet("operator1")` creates and funds one on first use; `ctx.send_as(&[ix], &["operator1"])`
  signs with it.
- `ix::<instruction>(…)` builds any instruction from the program's own Anchor `accounts::` and `instruction::` types.
  A new instruction needs one builder there (fill the accounts struct, pass the args struct) and, if it is common, a
  one-line wrapper in `setup.rs`.
- `TxOk::event::<E>()` / `events::<E>()` decode the `emit!`ted events; `fails_with(code(EpochError::X))` and
  `fails_with_ix(InstructionError::…)` assert failures and print the program logs when they do not match.
- `ctx.get::<T>(&key)` reads a program account; `ctx.vote_state(&vote)` decodes a vote account with the vote
  interface; `ctx.create_vote_account(name, withdrawer, inflation_bps, block_bps)` creates one through the vote program.
- Time: `ctx.advance_epochs(n)`, `ctx.advance_slots(n)`, `ctx.warp_to_epoch(e)`.
- Raw accounts: `ctx.set_mint`, `ctx.set_token_account`, `ctx.set_dbc_config`, `ctx.set_dbc_pool`, `ctx.set_raw` with
  `meteora::damm_config_data` / `damm_pool_data`, `ctx.patch(key, offset, bytes)`, `ctx.token_amount`, `ctx.mint_supply`.
- A role check for a new instruction is one `case(name, role_wallet, expected_error, |signer| ix::…)` line in
  `roles.rs`: the helper sends it signed by an intruder and, with the role's key, unsigned.
