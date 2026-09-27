# Epoch implementation plan

**Goal:** a real validator advance repaid on mainnet by **5 Oct 2026**, a polished four-screen app by **9 Oct**, and submissions on **12 Oct** (Colosseum) and **13 Oct 12:29 IST** (side tracks). All times are IST.

This plan has five parts: where the repo is today, the target structure, the two parallel workstreams, a spec for every feature, and a day-by-day schedule.

---

## 1. Repo analysis: where we are (27 Sep)

| Area | State today | Gap to close |
| --- | --- | --- |
| `programs/epoch` | Compiles on Anchor 1.2. One instruction (`initialize_pool`). Account structs for Pool, ValidatorPosition, Advance, FeeIndex, SwapPosition | No instructions beyond init; no vote-program CPI; no events; no math module; placeholder program ID |
| Tests | `tests/README.md` only | No unit, LiteSVM or integration tests; `Anchor.toml` test script points at a runner that isn't installed |
| `packages/sdk` | Seed constants only | No IDL, PDAs, instruction builders or account decoders |
| `services/*` | Five stubs with correct dependencies | No shared config, logging, DB access or retry logic |
| `app` | Next.js 16 page with a heading | No wallet provider, design system, routes or data hooks |
| Database | None | No schema or migrations |
| Scripts / infra | None | No deploy, key-sync, pool-init, CP1 or seed scripts; no Fly/Vercel config |
| CI | cargo check + TS typecheck (fix committed locally, not pushed) | No `anchor build`/tests in CI yet |
| Docs | README, architecture, threat model, plan, side tracks, community files | This plan, repo-structure guide and ADRs (added now) |

**Verified protocol facts the design relies on** (from `solana-vote-interface` 7.1.0, the crate Anchor 1.2 resolves):

- `UpdateCommissionCollector(CommissionKind)` exists (SIMD-0232). Signer: **the vote account's withdraw authority**. Collector must be the vote account itself or a system-owned, rent-exempt account.
- `UpdateCommission` / `update_commission_bps` also require **the withdraw authority** as signer.
- `Authorize(new, VoteAuthorize::Withdrawer)` and `Withdraw(lamports)` exist with instruction builders.
- `VoteStateV4` exposes `authorized_withdrawer`, `inflation_rewards_collector`, `block_revenue_collector`, both commission rates in bps, `epoch_credits`, and **`pending_delegator_rewards`**.

> **Design consequence found during analysis:** once SIMD-0123 is active, a vote account can hold `pending_delegator_rewards` that belong to stakers. `sweep` must never withdraw them. Withdrawable = balance − rent-exempt minimum − pending delegator rewards − admission-fee reserve.

---

## 2. Target repository structure

See [`REPO_STRUCTURE.md`](REPO_STRUCTURE.md) for the full tree and the rule for where new code goes. The headline changes:

- The program splits into `state/`, `instructions/{pool,credit,market}/`, `math/` (pure, unit-tested), `cpi/vote.rs` and `events.rs`.
- Two new shared packages: `packages/common` (env config, logger, RPC connection, retry) and `packages/db` (SQL migrations + typed queries).
- New `scripts/` (deploy, pool init, CP1 testnet proof, seeding) and `infra/` (Fly.io, Vercel, Supabase).
- The app moves to feature folders: `app/src/features/{terminal,validator,vault,market}`.

---

## 3. Workstreams and ownership

Two tracks run in parallel from day 1 and meet at the SDK.

| Track | Scope | Suggested owner |
| --- | --- | --- |
| **A: on-chain** | Program, math, CPI, LiteSVM tests, deploys, SDK generation, CP1 script, security review | Rust-leaning teammate |
| **B: off-chain + product** | Indexer, DB, API, cranks, publisher, Panta bot, app, videos | TypeScript-leaning teammate |

**Contract between tracks:** the IDL. Track A publishes a new IDL to `packages/sdk/src/idl/` on every program change; Track B only calls the program through `@epoch/sdk`.

**Shared by both:** the pitch, daily commits, the two weekly-update videos, and the submission forms.

---

## 4. Feature specs

Each feature lists files, logic, tests and a done-when. IDs match GitHub issues/milestones.

### F0 · Tooling and CI (Track A, 27 Sep)

- `anchor keys sync` to generate the real program ID; commit `Anchor.toml` + `lib.rs` change (keypair stays in `target/deploy/`, gitignored).
- Add `scripts/` with `deploy.ts`, `init-pool.ts`, `seed-devnet.ts`.
- CI: keep `cargo check` + typecheck now; add `anchor build` + LiteSVM tests once they exist (F2).
- Branch protection on `main` after the collaborator is added: require CI to pass; no force-push.

**Done when:** CI green on `main`; `anchor build` produces an IDL locally.

### F1 · CP1 mechanism proof on testnet (Track A, 27 Sep — today)

`scripts/cp1-testnet.ts` creates a throwaway vote account on testnet and proves, from a **program-derived signer**:

1. `Authorize(Withdrawer → PDA)` from the original withdrawer.
2. Program CPI `UpdateCommissionCollector(BlockRevenue → vote account)` signed by the PDA.
3. Program CPI `Withdraw` to a vault PDA, signed by the PDA.
4. A direct `UpdateCommission` from the original key **fails**.
5. Program CPI `Authorize(Withdrawer → original)` (release).

Needs a minimal `cp1_probe` instruction set behind a `cp1` Cargo feature, or the real `onboard_validator` / `sweep` / `release` if F3 is far enough along.

**Done when:** all five transaction signatures are recorded in `docs/cp1-results.md`. **If step 2 or 3 fails → kill rule K1** (see `THREAT_MODEL.md` / failure map).

> Note: new vote accounts may need `InitializeAccountV2` with a BLS key on testnet (Alpenglow prep). Check the testnet feature set first.

### F2 · Pool: deposits, withdrawals, accrual (Track A, 28–30 Sep)

**Accounts:** `Pool` (existing), `Vault` = system-owned PDA `["vault"]` holding SOL, `senior_mint` / `junior_mint` SPL mints with the Pool PDA as mint authority, `WithdrawRequest` `["wreq", owner, nonce]`.

**Instructions:** `initialize_pool`, `deposit(tranche, lamports)`, `request_withdraw(tranche, shares)`, `process_withdrawals` (crank), `accrue(epoch)`, `set_params` / `pause` / `unpause` (admin).

**Share maths** (`math/shares.rs`), with virtual offsets against first-depositor inflation:

```rust
const VIRTUAL_SHARES: u128 = 1_000_000;
const VIRTUAL_ASSETS: u128 = 1_000;
fn shares_for(assets_in, total_assets, total_shares) -> u64 {
    assets_in * (total_shares + VIRTUAL_SHARES) / (total_assets + VIRTUAL_ASSETS)   // round down
}
fn assets_for(shares, total_assets, total_shares) -> u64 {
    shares * (total_assets + VIRTUAL_ASSETS) / (total_shares + VIRTUAL_SHARES)       // round down
}
```

Assets are tracked in `Pool.senior_assets` / `junior_assets`, **never** read from the vault's raw balance (donations can't move share prices).

**Accrual** (`accrue(epoch)`, once per epoch after all sweeps): fee income collected this epoch pays senior up to `senior_assets × senior_target_bps / 10_000 / EPOCHS_PER_YEAR`; the rest goes to junior. Losses recognised by `mark_default` hit junior first, then the loss reserve, then senior.

**Tests:** unit tests for share rounding and accrual; LiteSVM: deposit → withdraw round-trip; donation attack does not change share price; junior lock-up enforced.

**Done when:** a devnet lender can deposit and withdraw both tranches, and invariants hold in fuzz tests.

### F3 · Credit: onboard, score, advance, sweep, default, release (Track A, 29 Sep – 3 Oct)

**PDAs:** `ValidatorPosition` `["validator", vote]`; per-validator authority `["vote_auth", vote]` (the withdrawer, isolating each validator); `Advance` `["advance", vote, nonce]`.

| Instruction | Signer | Logic |
| --- | --- | --- |
| `onboard_validator` | current withdrawer | Must follow an `Authorize(Withdrawer → vote_auth PDA)` in the same transaction. Reads vote state to confirm the PDA is now withdrawer; records `original_withdrawer`, identity, starting balance; CPI `UpdateCommissionCollector(BlockRevenue → vote)` and `(InflationRewards → vote)`; optional bond: stake account whose withdraw authority is moved to a PDA |
| `update_score` | anyone | Once per epoch. `revenue_e = balance_now − balance_after_last_sweep` (+ amounts withdrawn); push to ring buffer; recompute score and limit |
| `request_advance(lamports)` | identity or original withdrawer | `amount ≤ limit`, no open advance, pool not paused, per-validator and pool caps. Transfer from vault to identity. Create `Advance` |
| `sweep` | anyone | Requires `update_score` this epoch. Computes withdrawable (below), takes `sweep_bps` share to vault via CPI `Withdraw`, rest to identity. Runs waterfall; updates Late/Active/Closed |
| `mark_default` | anyone | Late ≥ 3 epochs → seize bond, write off shortfall (junior → reserve → senior) |
| `release` | original withdrawer | No open advance → CPI `Authorize(Withdrawer → original)`; close position |

**Withdrawable and waterfall** (`math/waterfall.rs`):

```rust
let reserve = rent_exempt(vote_len) + state.pending_delegator_rewards + ADMISSION_FEE_RESERVE;
let withdrawable = balance.saturating_sub(reserve);
let to_pool = min(withdrawable * sweep_bps / 10_000, advance.owed());
let to_identity = withdrawable - to_pool;
// split to_pool: fee portion first to income (senior target, then junior), principal portion restores assets
```

**Credit limit** (`math/credit_limit.rs`): `min(rate × Σ revenue[10], bond_multiplier × bond, max_per_validator)`, rate 2,500 bps unhedged / 4,000 hedged.

**Score v1** (`math/score.rs`, 0–10,000): 50% uptime proxy (epoch credits vs. maximum possible, calibrated on day 3 against real validators), 20% commission stability (no changes in 30 epochs), 15% age, 15% revenue stability (1 − coefficient of variation). Positions below 6,000 cannot borrow.

**Events** (`events.rs`) for the indexer and Terminal feed: `ValidatorOnboarded`, `ScoreUpdated`, `AdvanceOpened`, `Swept`, `AdvanceClosed`, `Defaulted`, `Released`, `Deposited`, `Withdrawn`.

**Tests:** unit tests for waterfall and limit; LiteSVM full cycle across warped epochs (onboard → advance → 5 sweeps → closed → release), including: double sweep rejected, pending delegator rewards untouched, reserve never breached, release blocked while open.

**Done when:** full cycle passes on LiteSVM and on devnet with a real test vote account (Gate 1, 1 Oct).

### F4 · Indexer and database (Track B, 27 Sep – 1 Oct)

- `packages/db/migrations/*.sql` tables: `slot_fees(slot, leader, p50_cu_price, tx_count)`, `epoch_index(epoch, value, posted_sig)`, `validators(vote, identity, name, onboarded_at)`, `validator_epochs(vote, epoch, revenue, credits, commission_bps)`, `program_events(sig, slot, kind, payload jsonb)`.
- `services/indexer`: Yellowstone gRPC subscription (Solami primary, RPC Fast failover), saves `last_slot` to resume; per-slot median priority fee excluding leader-paid transactions; epoch rollup = stake-weighted median across leaders; decodes Epoch program events.
- **Done when:** running on mainnet since 1 Oct with < 150 slots of lag; `epoch_index` has a value for the last finished epoch.

### F5 · API and Terminal (Track B, 30 Sep – 3 Oct)

- `services/api`: `GET /index?from&to`, `GET /validators`, `GET /validators/:vote`, `GET /book`, `GET /events?cursor`; websocket `/live` pushes new events and slot fees.
- `app/src/features/terminal`: epoch progress (from RPC `getEpochInfo`), KPI tiles, fee-index chart, live feed, validator table. Mobile layout.
- **Done when:** public Terminal URL loads in < 2 s and updates live (this is the Solami demo).

### F6 · Validator Console and Vault UI (Track B, 3–7 Oct)

- Validator Console: vote-account lookup with instant limit estimate (no wallet); onboarding flow that builds the `Authorize` + `onboard_validator` transaction; advance request; repayment projection; hedge toggle.
- Vault: tranche cards, deposit/withdraw, share-price chart, book health, loan list.
- **Done when:** all actions work on devnet end-to-end with Phantom.

### F7 · Fee Market v1 (Track A program, 5–8 Oct; Track B UI 7–9 Oct)

To ship in time, v1 uses **quote-based swaps against a seeded market-maker vault** instead of a full order book (ADR 0004). An order book is v2.

- Accounts: `FeeQuote` `["quote", epoch]` (fixed rate, max notional, `open_until_slot` = before the epoch starts); `MarketVault` PDA; `SwapPosition` (existing).
- Instructions: `post_quote` (publisher), `open_swap(epoch, side, notional)` with margin, `post_index(epoch, value)` (bounded move, dispute window), `settle_epoch(epoch)`.
- Hedged flag: a validator's position is hedged when it holds receive-fixed swaps covering the next 5 epochs with notional ≥ 50% of average revenue.
- **Done when:** one epoch has settled on devnet (Gate 3, 9 Oct).

### F8 · Cranks (Track B, 2–5 Oct)

`services/cranks` listens for epoch changes and runs, in order: claim MEV (Jito tip distributor claim for each vote account), wait for epoch rewards to finish, `update_score` → `sweep` for each position → `settle_epoch` → `accrue`. Idempotent; retries through RPC Fast; alerts after 60 minutes without a sweep.

### F9 · Publisher + Switchboard (Track B, 6–8 Oct)

Signs and posts `post_index` / `post_quote`; publishes the index as a Switchboard On-Demand custom feed. **Cut first if late.**

### F10 · Panta bot (Track B, 8–9 Oct)

Creates the next epoch's parimutuel market and resolves the finished one. Blocked on Panta confirming a market can resolve from our index. **Cut first if late.**

### F11 · Security hardening (Track A, 3 Oct)

Written threat review of `sweep`, `withdraw`, `onboard_validator`; property/fuzz tests on waterfall and shares; caps (e.g. 25 SOL per validator, 200 SOL pool); `pause`; upgrade and admin keys moved to a Squads multisig before mainnet.

### F12 · Mainnet launch and submission (both, 4–13 Oct)

Deploy (4 Oct) → partner onboarding and first advance (5 Oct) → record boundary sweep (7 Oct) → feature freeze (9 Oct) → videos (10 Oct) → dry-run submission (11 Oct) → submit (12 Oct) → side tracks (13 Oct 12:29 IST).

---

## 5. Day-by-day schedule (IST)

| Day | Date | Track A (on-chain) | Track B (off-chain + app) | Gate / checkpoint |
| --- | --- | --- | --- | --- |
| 1 | Sat 27 Sep | F0 keys + scripts; F1 CP1 on testnet | F4 DB schema; indexer gRPC skeleton; Solami Pro | **CP1** |
| 2 | Sun 28 Sep | F3 `cpi/vote.rs`, `onboard_validator`, `release` | F4 per-slot fees + epoch rollup | |
| 3 | Mon 29 Sep | F2 pool deposit/withdraw + shares | F4 indexer on mainnet; score calibration data | **CP2** design partner |
| 4 | Tue 30 Sep | F3 `update_score`, `request_advance` | F5 API endpoints | |
| 5 | Wed 1 Oct | F3 `sweep` + waterfall; LiteSVM full cycle | F5 Terminal live on mainnet | **Gate 1** |
| 6 | Thu 2 Oct | F3 `mark_default`; events | F8 cranks | |
| 7 | Fri 3 Oct | F11 security review, fuzzing, caps, Squads | F6 Validator Console; weekly update #1 | **CP3** |
| 8 | Sat 4 Oct | Mainnet deploy; `init-pool` | F6 Vault | |
| 9 | Sun 5 Oct | Partner onboarding; first advance | Terminal shows the live advance | **Gate 2** |
| 10 | Mon 6 Oct | F7 quotes + swaps | F9 publisher | |
| 11 | Tue 7 Oct | F7 `post_index`, `settle_epoch`, hedged flag | Record boundary sweep | **CP4** |
| 12 | Wed 8 Oct | Bug fixes | F7 Market UI; F10 Panta bot; 20-second pitch test | **CP5** |
| 13 | Thu 9 Oct | Freeze | Freeze; polish | **Gate 3** |
| 14 | Fri 10 Oct | Demo script | Record pitch + demo; weekly update #2 | |
| 15 | Sat 11 Oct | README, docs | Submission dry run | **CP6** |
| 16 | Sun 12 Oct | Submit Colosseum | | |
| — | Mon 13 Oct | | Side tracks by 12:29 IST | |

**Cut order if behind:** Panta (F10) → Switchboard (F9) → Fee Market (F7). Credit + Terminal alone is a complete entry.

---

## 6. How we work

- **Issues and milestones:** one GitHub issue per feature task, milestones = gates (Gate 1, Gate 2, Gate 3, Submission). Labels: `track:a`, `track:b`, `program`, `app`, `service`, `blocker`.
- **Branches:** `feat/f3-sweep`, `fix/indexer-resume`. PRs small; CI must pass; squash-merge with a Conventional Commit title.
- **Daily:** at least one merged PR per track per day (the manual's winners' median is 60 commits).
- **Definition of done:** code + tests + docs updated + deployed to devnet (or mainnet after 4 Oct) + visible in the Terminal where relevant.
