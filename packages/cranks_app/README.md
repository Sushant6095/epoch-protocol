# cranks_app

The Epoch program's permissionless cranks (plus the scorer). One loop wakes every `CRANK_POLL_SECONDS` (60), reads the
program cluster's epoch and runs:

| Order | Job | Instruction | Signer | Runs | Gate |
| --- | --- | --- | --- | --- | --- |
| 1 | `ClaimMevJob` | — | — | each boundary (logs once) | no |
| 2 | `UpdateScoreJob` | `update_score` | scorer (crank pays) | each boundary until done, then every 30 min | no |
| 3 | `SweepJob` | `sweep` | crank | each boundary until done | yes |
| 4 | `MarkDefaultJob` | `mark_default` | crank | each boundary until done | yes |
| 5 | `AccrueJob` | `accrue` | crank | each boundary until done | yes |
| 6 | `ProcessWithdrawalsJob` | `process_withdrawal` | crank | every tick once 3–5 are done | — |
| 7 | `FinalizeIndexJob` | `finalize_index` | crank | every tick | — |
| 8 | `SettleSwapsJob` | `settle_swap` | crank | every tick | — |

A job answers `done` or `retry` (waiting on the chain, or a transient failure). A gate that is not done holds the
steps after it until a later tick, so accrual always follows this epoch's sweeps and defaults, and withdrawals follow
accrual. A gate still unfinished `CRANK_ALERT_AFTER_MINUTES` (60) after the runner first saw the epoch logs
`ALERT: boundary job still not done` once. Every job reads the chain before acting, so restarts and repeats in the
same epoch are no-ops (or a transaction the program rejects harmlessly: already swept, already accrued…).

All program access goes through `ProgramClient` (`src/Chain`): reads with epoch-sdk decoders (`accountFilters`,
`fieldFilter`), sends through `@epoch/solana`'s `TransactionSender` with the crank keypair and
`CRANK_CU_PRICE_MICROLAMPORTS`, turns failures into named program errors (`parseEpochError`) and never re-sends a
deterministic program error. With `DRY_RUN=true` every transaction is simulated and logged, nothing is sent (an
identical simulation is repeated at most every 30 minutes). Every job is tested against an in-memory chain
(`src/__fixtures__/FakeChain.ts`): no deployed program is needed.

## What each job checks

- **SweepJob**: every position that is Active, Late or Defaulted with `last_swept_epoch < epoch` (never Released),
  with its open advance and `payout`. First waits while the EpochRewards sysvar is `active` (the program would fail
  with `RewardsInProgress`); positions without an advance are swept too, which records their revenue and late count.
- **MarkDefaultJob**: an open advance (state `Open`, the position's `open_advance`, position Active or Late) with
  `late_epochs >= 3` or `epoch >= opened_epoch + max_advance_epochs` (`mark_default.rs`). Simulated first; sent only if
  the simulation passes. Runs before accrual and withdrawals so nobody exits at a price that ignores a known loss.
- **AccrueJob**: once, when `pool.last_accrued_epoch < epoch`; the protocol fee goes to `pool.treasury`.
- **ProcessWithdrawalsJob**: the queue head only (the program accepts nothing else), repeatedly: cancelled requests
  just advance the head, a junior request that would breach the junior floor is bounced (shares back), otherwise it
  is paid whole if `pool.cash` covers it (mirror of the program's maths); it stops at a head that waits for cash
  (`InsufficientLiquidity`) and comes back next tick, so a request is paid as soon as a sweep brings the cash.
- **FinalizeIndexJob**: when a proposal is pending and `slot >= proposed_slot + dispute_window_slots`. Nothing else
  calls it, and `post_index` refuses the next epoch while a proposal is pending.
- **SettleSwapsJob**: every open swap whose epoch has a final value (`feeIndexValueFor`), oldest first, cranker = the
  crank key, taker = the swap's taker (receives collateral ± P&L and the rent); at most 20 per tick. The FeeIndex keeps
  the current value plus 16 earlier ones: a swap whose value is 3 finalizations or fewer from eviction logs
  `ALERT: swap is about to leave the 16-entry history unsettled`, and one whose epoch has no final value even though a
  later epoch is final logs `ALERT: swap can never settle on-chain` (never posted, vetoed or evicted: its collateral
  and the maker's are locked).
- **ClaimMevJob**: not implemented. Jito's tip-distribution `claim` requires the `merkle_root_upload_authority` signer,
  so claims are permissioned and Jito's own crank submits them; the validator's commission is claimed to the vote
  account and the next sweep collects it. The precise TODO (verify the ClaimStatus PDA before sweeping) is in the file.

## Scores and the hedged flag

`UpdateScoreJob` posts `update_score` for every onboarded position, signed by `SCORER_KEYPAIR_PATH` (must be the
Pool's `scorer`; the crank pays the fee). Inputs, from the data cluster (`DATA_RPC_URL`, mainnet) and Jito Kobe:

- credits ratio: credits earned in the last finished epoch ÷ the average of voting validators that earned any, bps;
- commission: max(inflation commission from the vote account, Jito MEV commission from Kobe), bps;
- epochs active: epochs with credits in the vote account's history (up to 64; tenure is full at 30);
- delinquent (getVoteAccounts) and superminority (the fewest largest stakes holding more than a third).

Same rules as `api_app`'s Epoch Score, so the site and the chain agree. A position whose vote account is not on the
data cluster is skipped with a warning (devnet-only test validators need `DATA_RPC_URL` pointed at devnet). If Kobe
or the RPC fails, nothing is posted and the job retries. A score is skipped when neither the score nor the hedged flag
would change and the posted score stays fresh through the next epoch (`epoch + 1 <= last_scored_epoch +
score_ttl_epochs`), so it never goes stale. Between boundaries it re-checks every 30 minutes, so a hedge opened
mid-epoch raises the credit limit (40% instead of 25%) without waiting up to two days; it posts only on a change.

**Hedged** (plan F7, decision 21, request #21): the operator (`position.operator`, the taker) holds Receive-fixed swaps
on **each** of the next 5 program epochs (current + 1 … current + 5), each epoch's notional at least 50% of the
position's average revenue per epoch (trailing revenue ÷ `revenue_count`, rounded up, never 0). Only swaps against
quotes of `EPOCH_MARKET_MAKER` count (`["quote", maker, epoch]`): `post_quote` is open to any key, so otherwise a
validator could hedge against its own 1-bps quote for almost nothing and borrow at 40% instead of 25%. Without
`EPOCH_MARKET_MAKER` nobody is hedged (the safe default).

Note for Sushant: `programs/epoch/src/instructions/credit/update_score.rs` documents `ScoreUpdate.hedged` as "the
validator holds a Fee Market hedge for the coming epoch". The scorer implements the five-epoch rule above; the comment
is what disagrees (the program does not check the flag, it trusts the scorer).

## Configuration (`CranksConfigSchema`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `EPOCH_CLUSTER`, `EPOCH_RPC_URL`, `EPOCH_RPC_FALLBACK_URL` | devnet | the program's cluster |
| `EPOCH_PROGRAM_ID` | required | the deployed program |
| `CRANK_KEYPAIR_PATH` | required | keypair FILE that signs and pays every crank transaction |
| `SCORER_KEYPAIR_PATH` | unset = scores off | keypair FILE of the Pool's `scorer` |
| `EPOCH_MARKET_MAKER` | unset = nobody hedged | Epoch's market maker public key |
| `CRANK_CU_PRICE_MICROLAMPORTS` | 10000 | priority fee |
| `DATA_RPC_URL`, `DATA_RPC_FALLBACK_URL` | mainnet public RPC | where validator data is read |
| `JITO_KOBE_API_URL` | https://kobe.mainnet.jito.network | MEV commissions |
| `DRY_RUN` | false | simulate and log; send nothing |
| `CRANK_POLL_SECONDS` | 60 | tick interval |
| `CRANK_ALERT_AFTER_MINUTES` | 60 | alert on an unfinished gate |

```bash
pnpm --filter @epoch/cranks_app build
DRY_RUN=true node packages/cranks_app/dist/index.js --env .env.devnet     # watch what it would do
```

## Launch fee claims (plan F13, ADR 0006)

**Graduation first.** Every pass starts with `LaunchMigrationJob` (`src/Jobs/LaunchMigrationJob.ts`): for each launch
whose curve is complete it sends DBC `migration_damm_v2` (permissionless; the payer is the crank key, else
`TREASURY_KEYPAIR_PATH`, ≈ 0.023 SOL; 600,000 CU at the claims' priority fee). Meteora's mainnet keepers only migrate
SOL curves whose `migration_quote_threshold` is 10 SOL (docs.meteora.ag, DBC "Migration Keepers"), and Epoch's raises
are 0.5–5 SOL, so without it a completed curve would stop trading until someone ran Meteora's manual migrator. It reads
each pool first (`migrationReadiness`), so a pool on its curve, already migrated (by a keeper or anyone) or
misconfigured is skipped; with `LAUNCH_CLAIMS_DRY_RUN` or no payer key it simulates instead. Off with
`LAUNCH_MIGRATE_ENABLED=false`. Tests: `src/Jobs/LaunchMigrationJob.test.ts`; on the round-3 stand-in it graduated
`rR3E` (`docs/runbooks/meteora-e2e-2026-10-06.json`).

`LaunchFeeClaimJob` claims what Epoch and the launches' creators are owed from each revenue token's Meteora pools, for
every launch in the registry (`LAUNCHES_PATH`) on `LAUNCH_CLUSTER`. It runs on its own loop, every
`LAUNCH_CLAIM_INTERVAL_MINUTES` (30) and once at start, next to the program cranks (`index.ts`), or alone with
`pnpm --filter @epoch/cranks_app start:claims` (`dist/launch-claims.js`, `--once` for one pass).

| Kind                                   | From                         | Treasury PDA as fee claimer: sent as     | Default |
| -------------------------------------- | ---------------------------- | ---------------------------------------- | ------- |
| `partnerTradingFee`                    | DBC curve trading fees       | `claim_partner_trading_fee`: SOL → pool income, tokens burned | on |
| `partnerSurplus`, `partnerMigrationFee` | DBC, after the raise        | `claim_partner_surplus` / `claim_partner_migration_fee`: SOL → pool income | on |
| `lpFee`                                | the treasury's DAMM v2 LP position | `claim_treasury_lp_fee`: SOL → pool income, tokens burned | on |
| `leftover`                             | the unsold supply after graduation | `burn_leftover`: all burned        | on      |
| `creatorMigrationFee` (the 70%), `creatorSurplus`, `creatorTradingFee`, the creator's `lpFee` | DBC, DAMM v2 | signed by the pool creator (validator) → itself | on, if its key is configured |

Epoch's launches name the treasury PDA `["treasury", pool]` as fee claimer and leftover receiver. A PDA cannot sign,
so with `EPOCH_PROGRAM_ID` and the crank key (`CRANK_KEYPAIR_PATH`; `index.ts` passes its own) the job sends those
claims as Epoch program instructions: the crank pays the fee only, the SOL becomes pool income for lenders (senior
coupon first at `accrue`) and the tokens are burned (`src/Launch/TreasuryClaims.ts`, 150,000 CU each; 16k–75k
measured). DBC lets anyone withdraw the leftover to the receiver's token account; when that already happened to the
treasury, the job reads that account and burns what it holds. This needs `LAUNCH_CLUSTER` to be the program's `EPOCH_CLUSTER`; otherwise the treasury's claims are
simulated. A fee claimer that is a plain wallet (a rehearsal) still signs its own claims with `TREASURY_KEYPAIR_PATH`.

Every run reads the pools first (`@epoch/meteora` `readLaunchClaims`) and claims only what is available, so repeats are
no-ops: one-shot withdrawals (migration fee, surplus, leftover) are flagged on the pool after they happen, and trading
and LP fees under `LAUNCH_CLAIM_MIN_SOL` (0.001) wait to accumulate. A claim whose signer's key is not configured (no
`TREASURY_KEYPAIR_PATH`, say, when the treasury is a multisig) is simulated and logged instead of sent, and so is every
claim with `LAUNCH_CLAIMS_DRY_RUN=true`. Sends go through `@epoch/solana`'s `TransactionSender`; an execution failure is
not retried. Tests: `src/Jobs/LaunchFeeClaimJob.test.ts`, `src/Launch/TreasuryClaims.test.ts`; the devnet-stand-in run
is in `docs/runbooks/meteora-devnet-rehearsal.md` (4 claims, then nothing to claim). On localnet against the real
Meteora programs, one run with no treasury key sent 3 program claims (two DAMM v2 LP fees, one DBC trading fee) and
simulated the creators' 3; the next run found nothing to claim.

| Variable                              | Default                       | Meaning                                                             |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `LAUNCH_CLAIMS_ENABLED`               | false                         | turn the job on                                                     |
| `LAUNCHES_PATH`                       | required when enabled         | the launch registry                                                 |
| `LAUNCH_CLUSTER`                      | devnet                        | only these registry entries                                         |
| `LAUNCH_RPC_URL`, `LAUNCH_RPC_FALLBACK_URL` | `EPOCH_RPC_URL`         | the pools' cluster                                                  |
| `TREASURY_KEYPAIR_PATH`               | unset                         | keypair FILE of a fee claimer that is a plain wallet (not needed for the treasury PDA) |
| `LAUNCH_CREATOR_KEYPAIR_PATHS`        | none                          | comma-separated keypair FILES of pool creators that let Epoch claim |
| `LAUNCH_CLAIM_KINDS`                  | all                           | comma list of the kinds above                                       |
| `LAUNCH_CLAIM_MIN_SOL`                | 0.001                         | smallest trading / LP fee worth a claim                             |
| `LAUNCH_CLAIM_INTERVAL_MINUTES`       | 30                            | loop interval                                                       |
| `LAUNCH_CLAIMS_DRY_RUN`               | false                         | simulate and log every claim; send nothing                          |
| `LAUNCH_CLAIM_CU_PRICE_MICROLAMPORTS` | 10000                         | priority fee                                                        |
| `LAUNCH_MIGRATE_ENABLED`              | true                          | graduate completed curves to DAMM v2 (`LaunchMigrationJob`), below  |
