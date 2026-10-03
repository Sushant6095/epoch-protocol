# @epoch/api_app

REST API for the Epoch app. Every response is `{ ok: true, data }`; errors are
`{ ok: false, error: { code, message, details }, traceId }`. Payloads carry `schemaVersion`, `kind`,
`asOf` (IST) and `source`, and units live in field names (`…Sol`, `…Pct`, `…Epoch`). `null` means "not
known yet" and the app shows "—".

## Endpoints

| Method and path                                                                            | Returns                         | Cache | Data                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------- | ----- | ------------------------------------------------------------- |
| `GET /health`                                                                              | `{ status, time }`              | —     | —                                                             |
| `GET /v1/index?from=&to=&limit=`                                                           | `FeeIndexPoint[]`, newest first | 15 s  | the FeeIndex account, index events, Postgres `epoch_index`    |
| `GET /v1/network`                                                                          | `NetworkSnapshot`               | 15 s  | mainnet RPC, Stakewiz, Jito Kobe, Jupiter, the delegator scan |
| `GET /v1/network/stake-history?epochs=64`                                                  | `StakeHistory`, oldest first    | 5 min | StakeHistory sysvar                                           |
| `GET /v1/validators?tab=&chips=&q=&sort=&dir=&fee=&client=&country=&votes=&cursor=&limit=` | `ValidatorList`                 | 30 s  | as `/v1/network`                                              |
| `GET /v1/validators/:vote`                                                                 | `ValidatorProfile`              | 2 min | mainnet RPC, Stakewiz, Jito Kobe, validator history           |
| `GET /v1/delegators/biggest?limit=10`                                                      | `BiggestDelegators`             | 5 min | the delegator scan                                            |
| `GET /v1/delegators/retail-magnets?limit=10`                                               | `RetailMagnets`                 | 5 min | the delegator scan                                            |
| `GET /v1/wallets/:address/stake`                                                           | `MyStake`                       | 60 s  | mainnet RPC (stake accounts, balance, `getInflationReward`)   |
| `GET /v1/activity?limit=50`                                                                | `ActivityFeed`, newest first    | 5 s   | program events (`program_events`), Predict calls              |
| `WS /v1/stream`                                                                            | channels, see below             | —     | mainnet RPC (`slot`), the bus, the providers                  |
| `GET /v1/vault`                                                                            | `VaultSnapshot`                 | 5 s   | the Epoch program (see below)                                 |
| `GET /v1/validators/:vote/position`                                                        | `OperatorPositionSnapshot`      | 10 s  | the Epoch program; mainnet rows for the estimate              |
| `GET /v1/wallets/:address/lender`                                                          | `LenderPositionSnapshot`        | 5 s   | the Epoch program                                             |
| `GET /v1/market`                                                                           | `FeeMarketSnapshot`             | 5 s   | the Epoch program                                             |
| `GET /v1/launches`                                                                         | `LaunchList`                    | 60 s  | launch registry, DBC and DAMM v2 pools on devnet (see Launch) |
| `GET /v1/launches/:mint`                                                                   | `LaunchDetail`                  | 60 s  | as `/v1/launches`, plus `launch_price_samples`                |
| `POST /v1/auth/siws/nonce` · `POST /v1/auth/siws/verify` · `POST /v1/auth/logout` · `GET /v1/auth/session` | sign-in (SIWS), session cookie | — | Postgres `auth_nonces`, `sessions`; roles from mainnet stake accounts and the program |
| `GET` · `PUT /v1/me/watchlist`, `GET` · `PUT /v1/me/alerts`, `POST /v1/me/alerts/telegram-link`, `POST /v1/me/alerts/test` | `Watchlist`, `AlertPrefs` | — | Postgres `watchlists`, `alert_prefs` |
| `GET /v1/predict/markets` · `POST /v1/predict/calls` · `GET /v1/predict/leaderboard?epochs=30` | `PredictSnapshot`, `PredictLeaderboard` | — | Postgres `predict_markets`, `predict_calls`; the Fee Index |
`/v1/validators` query: `tab` = `all | healthy | watch | watchlist` (watch includes offline); `chips` =
comma list of `below, dep, hide-top18, firedancer, zero-fee`; `q` searches names and vote keys; `sort` =
`stake | apy | score | kept | dels | fee | blocks | up` with `dir` = `desc | asc` (nulls last, stake breaks
ties); `fee=0-10` (commission %); `client=agave,firedancer`; `country=DE,US`; `votes=<vote>,<vote>` (at most
200, the watchlist); `limit` 1–1,000 (default 50) and `cursor` from the previous page's `nextCursor`. The
Terminal's top validators are `?sort=stake&limit=8`. `facets` count clients and countries after the tab,
chips and search, before the popover's own filters.

`/v1/validators/:vote` answers `400 BAD_REQUEST` for a key that is not base58 of 32 bytes and `404 NOT_FOUND` for a
vote account without stake; profiles are kept per validator (the 200 most recently asked for). `/v1/wallets/:address/stake`
answers 400 for a bad address and is kept 60 s per wallet (500 kept). Response types: `src/types/Wallet.types.ts`.

The delegator endpoints answer `503 NOT_READY` (with scan progress in `details`) until the first stake-account
scan has finished, a few minutes after start. `/v1/network` answers right away with `delegators: null`
until then. On 1 Oct 2026 a full scan on the public RPC read 1,160,560 stake accounts (581,356 wallets) in
about 5 minutes, and the process sat at about 430 MB of memory afterwards: give the API at least 1 GB.

## Program events, activity, Fee Index status and the stream (requests #3, #4)

Built in `Services/Program/ProgramServices.ts` (`getProgramServices()`) and started in `src/index.ts` after the HTTP
server. The Epoch program runs on devnet for now, and its id is still a placeholder: until `EPOCH_PROGRAM_ID` is set the
ingester stays off and the program parts below answer `503 PROGRAM_NOT_CONFIGURED` (or are left out when Postgres
can fill in).

**Ingester** (`Services/Program/ProgramEventIngester.ts`, when `EPOCH_PROGRAM_ID` is set and `PROGRAM_EVENTS_INGEST`
is true). Writes `program_events` (Postgres, or the last 5,000 in memory without `DATABASE_URL`) and, for every event
it had not stored yet, drops the program caches the event makes stale and emits `programEvent` on the in-process bus.

- _Backfill and catch-up_: at start and every 60 s, `getSignaturesForAddress(programId)` pages back to the cursor
  (`indexer_cursors.name = program_events:<programId>`: every transaction up to it has been read), or the newest
  `PROGRAM_EVENTS_BACKFILL_LIMIT` signatures on a first start (0 = start from the newest transaction). Transactions are
  read oldest first with `getTransaction` (2 at a time, `maxSupportedTransactionVersion: 0`, `confirmed`), backing off
  on HTTP 429 (1 s, 2 s … 30 s). Failed transactions are skipped; the cursor advances after each batch, so a restart
  resumes where it stopped. A transaction the RPC lists but cannot return holds the cursor for up to three passes,
  then is skipped with an error log.
- _Live_: `logsSubscribe` (mentions = the program, `confirmed`) on a dedicated connection to `EPOCH_RPC_WS_URL` (or
  `EPOCH_RPC_URL` with `https` → `wss`; set it for localnet, whose websocket is on port 8900). Logs are parsed directly
  (block time = arrival time). Live events never move the cursor, so the next poll still walks every signature after
  it: a dropped websocket loses nothing, and `(signature, ix)` dedupes. When a poll finds transactions the websocket
  never delivered, the ingester reconnects and resubscribes.
- Only `Program data:` lines written while the Epoch program is the innermost frame count (epoch-sdk
  `parseEventsFromLogs`): other programs' data in the same transaction is ignored. `ix` is the event's position among
  its transaction's events; `epoch` is the program cluster's epoch of the slot; `payload` is `eventToJson(event).data`.

**Fee Index** (`GET /v1/index`, `Services/Program/FeeIndexService.ts`). A bare `FeeIndexPoint[]`, newest first, each
`{ epoch, value, status? }` in µL/CU, merged from:

1. the FeeIndex account: the last final value and its 16-epoch history are `final`; a pending proposal is `proposed`;
2. stored `IndexProposed` / `IndexFinalized` / `IndexVetoed` events: the newest event per epoch decides (finalized →
   `final`, proposed → `proposed`, vetoed → `vetoed`), so a vetoed proposal stays visible until a new one is posted for
   its epoch. Final is terminal; a veto newer than the proposal a cached account read still shows wins;
3. `epoch_index` rows the indexer computed (Postgres): only for epochs the program has no value for, without `status`.

`from` / `to` (inclusive) and `limit` (1–500, default 50) apply after the merge. Without the program and without
Postgres: `503 PROGRAM_NOT_CONFIGURED`; when the account can't be read, the events alone are used (logged).
`FeeIndexService.latest()` gives `{ final: { epoch, value } | null, proposed: { epoch, value, disputeEndsSlot } | null,
avg8 }` (the program cluster's slot when anyone can finalize; `avg8` = mean of the last 8 final values, rounded, null
before the first) for the Fee Market snapshot.

**Activity** (`GET /v1/activity?limit=50`, 1–200, `Services/Activity/`). An `ActivityFeed` (`kind: "real"`, `asOf` in
IST) of program events and Predict calls, newest first by block time / `created_at`. Program rows have
`id = <signature>:<ix>` and the devnet `signature` for the explorer link; validators are named from the validator table
by vote key, else by short key (`FzUN…AmMk`). `503 PROGRAM_NOT_CONFIGURED` without the program and without Postgres.

| Event                                              | Row (`kind` · `text` · amount)                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Swept`                                            | `sweep` · "Kestrel Nodes · repaid at source" · `remitted` (or "· swept, nothing owed" · `gross` when nothing was remitted) |
| `Deposited`                                        | `deposit` · "Senior tranche · deposit" (or Junior) · `assets`                                                              |
| `WithdrawRequested`                                | `withdraw` · "Senior tranche · withdrawal queued" · —                                                                      |
| `WithdrawProcessed`                                | `withdraw` · "Junior tranche · queue paid" · `assets`                                                                      |
| `WithdrawCancelled` (reason 1)                     | `withdraw` · "Junior tranche · withdrawal bounced at the floor" · — (reason 0, the owner's own cancel, is not shown)       |
| `ValidatorOnboarded`                               | `advance` · "Kestrel Nodes · onboarded" · —                                                                                |
| `AdvanceOpened`                                    | `advance` · "Kestrel Nodes · drew credit" · `principal`                                                                    |
| `AdvanceRepaid`                                    | `advance` · "Kestrel Nodes · advance repaid" · —                                                                           |
| `AdvanceDefaulted`                                 | `advance` · "Kestrel Nodes · defaulted, bond applied" · `bondApplied`                                                      |
| `IndexProposed` / `IndexFinalized` / `IndexVetoed` | `index` · "Epoch 1043 Fee Index proposed" (final, vetoed) · `value` in µL/CU                                               |
| `SwapOpened`                                       | `swap` · "Pay fixed · epoch 1045" (or Receive fixed) · `notional`                                                          |
| `SwapSettled`                                      | `swap` · "Swap settled · epoch 1042" · the taker's P&L (negative when the taker lost)                                      |
| a Predict call                                     | `predict` · "<market label> · YES" · `value` = points, `unit: "points"`, no signature                                      |

Other events (accruals, scores, bonds, quotes, admin) are not shown.

**Pool snapshots** (`Services/Program/PoolSnapshotRecorder.ts`, with Postgres and the program). On each new `Accrued`
event the Pool is read and `pool_snapshots` gets (or replaces) the row of the event's epoch: senior/junior assets and
shares, outstanding principal, cash, the event's senior/junior share prices (e9) and utilization in bps (outstanding ×
10,000 ÷ senior + junior assets). At start, an empty table is filled from the stored `Accrued` events: their prices,
the other fields from the current Pool, all with the same `recorded_at`.

### WS /v1/stream

One websocket per page, on the API's own port: `ws://localhost:4000/v1/stream` (`wss://` in production). The
`Origin` header must be one of `API_CORS_ORIGINS` unless that is `*` (a client without Origin, a script, is allowed).

Client → server (JSON text frames, at most 4 KiB, at most 50 per 10 s):

```json
{ "op": "subscribe", "channels": ["slot", "activity"] }
{ "op": "unsubscribe", "channels": ["slot"] }
{ "op": "ping" }
```

Channels can also be given on the URL: `/v1/stream?channels=slot,activity`.

Server → client:

```json
{ "type": "hello", "channels": ["slot", "activity", "feeIndex"] }
{ "type": "subscribed", "channels": ["slot", "activity"] }
{ "type": "pong" }
{ "type": "error", "message": "Unknown or unavailable channel: vault (available: slot, activity, feeIndex)" }
{ "type": "error", "channel": "vault", "message": "…" }
{ "channel": "slot", "data": { "slot": 375840001, "epoch": 870, "slotIndex": 1, "slotsInEpoch": 432000, "leader": "<identity>", "leaderName": "Helius" }, "at": "2026-10-03T01:12:09+05:30" }
```

`hello` lists the channels this server can serve; `subscribed` answers every subscribe and unsubscribe with the
current set; data frames carry `channel`, `data` and `at` (when the data was read, IST).

| Channel    | `data`                                                                                                                                                   | When                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `slot`     | MAINNET `{ slot, epoch, slotIndex, slotsInEpoch, leader, leaderName }` (leader = identity key; `leaderName` from the validator table, null when unknown) | every `STREAM_SLOT_INTERVAL_MS` when the slot moved; polled only while someone subscribes; the last value right away to a new subscriber                                             |
| `activity` | one `ActivityEvent` (as `GET /v1/activity`)                                                                                                              | each new program event the feed shows and each Predict call; events older than 10 minutes (a backfill after downtime) only appear in `GET /v1/activity`                              |
| `vault`    | the vault provider's snapshot (`VaultSnapshot`)                                                                                                          | on subscribe, then 2 s after the last pool event (`Deposited`, `Withdraw*`, `Accrued`, `AdvanceOpened`, `Swept`, `AdvanceRepaid`, `AdvanceDefaulted`, `BondPosted`, `BondWithdrawn`) |
| `feeIndex` | `{ points: FeeIndexPoint[16], final, proposed, avg8 }`                                                                                                   | on subscribe, then after `IndexProposed` / `IndexFinalized` / `IndexVetoed`                                                                                                          |

The server pings every 30 s and drops a socket that misses a pong; browsers answer pings by themselves. A dropped
socket keeps nothing: reconnect, then subscribe again (the `vault` and `feeIndex` channels send their current value).

## The Epoch program: Vault, Manage tab, lender, Fee Market

These read the program on its own cluster (`EPOCH_CLUSTER`, devnet for now) through `Sources/EpochProgramSource.ts`
(epoch-sdk decoders, short caches that program events invalidate) and the ingested program events
(`getServices().events`: `program_events` in Postgres, else the last 5,000 in memory). Every epoch in them is the
**program cluster's** epoch. They answer `503 PROGRAM_NOT_CONFIGURED` until `EPOCH_PROGRAM_ID` is set and
`503 POOL_NOT_INITIALIZED` until the Pool exists (the not-onboarded estimate excepted, below); a vote or wallet that
isn't a base58 public key is `400 BAD_REQUEST`. The session (`currentSession`) is optional: it only adds
`isMine`, the "You" rows, `myHedge` and `myPositions`. Amounts are computed in lamports and converted once, so SOL
values are exact to the lamport; shares are UI shares (1e12 raw shares, 1.0 SOL at par) and share prices are
`share_price_e9 ÷ 1e6`. Services: `Services/Program/` (`getProgramServices()`; `vault.snapshot()` without a session
is the WS `vault` channel's payload). Tests drive the services through `src/__fixtures__/ProgramSim.ts`, a small
in-memory program that applies each instruction's ledger math with epoch-sdk.

**`GET /v1/vault`** (requests #8, #8c)

- TVL = senior + junior assets + `income_unallocated`; lenders = wallets with shares or queued shares; live since =
  the `PoolInitialized` event's epoch (else the first `Deposited`); utilization = outstanding ÷ total assets.
- Lost by lenders = `Pool.total_defaulted` = Σ `AdvanceDefaulted.principal_lost`. `mark_default` emits the loss
  **after** the bond (principal outstanding − bond applied): what it wrote off junior, then senior. Later recoveries
  are income and are not netted. Defaults = advances ever written off (events ∪ Defaulted accounts).
- Senior: APY = target bps × epochs a year ÷ 100 (3 bps → 8.1%); room before junior must grow =
  `junior × (10,000 − min_junior_bps) ÷ min_junior_bps − senior` (null when the floor is off).
  **Coupon met**: `distribute_income` pays senior `min(net income, assets × rate × epochs)` and junior the rest, so
  an accrual met the target when junior gained anything, or when the senior `share_price_e9` grew by at least
  `rate × Δepochs` (less two units of rounding) since the previous `Accrued` (par before the first). Epochs are
  counted (an accrual after a missed crank covers two); accruals before the first senior deposit are skipped.
- Junior: APY since launch = (price − 1) × epochs a year ÷ epochs since launch (inclusive); bonds under open advances
  = bonds of positions with `open_advance` set.
- Series: `pool_snapshots` when it has rows; otherwise each `Accrued` event gives the prices, and lent out right after
  that accrual is found by walking back from today's Pool through the later events (deposits, paid withdrawals,
  accrual gains, write-offs, advances, the principal part of each remittance). Every array has one entry per point.
- Loan book: open advances by size, then closed ones, newest first (50). Status: Open → `late` while the position is
  Late, else `active`; Defaulted → `recovered` once repaid ≥ total due, else `defaulted`; Repaid → `recovered` when
  it was written off first (the program flips a recovered advance to Repaid), else `repaid`.
- Queue: open requests (owner-cancelled ones excluded, valued at today's price) and paid ones from
  `WithdrawProcessed` in the last 20 epochs, newest first; `signature` is the request transaction. Bounced requests
  are in the lender endpoint.
- Lenders: five biggest wallets per tranche, the session wallet as "You", then "N other wallets".
- Cycle: rewards done when the EpochRewards sysvar is inactive (after 4,000 slots if it can't be read); sweeps when
  every onboarded position was swept this epoch; accrue when `last_accrued_epoch` = this epoch; withdrawals when the
  queue is empty or its head waits for cash; index when the FeeIndex holds a final value or a proposal for the last
  epoch. The first step not done is `running`; once all are done, `collecting` runs.
- Params: every PoolParams field with a display string and its raw value (lamports for lamport fields).

**`GET /v1/validators/:vote/position`** (request #8b): `OperatorPosition` plus `schemaVersion`, `kind`, `asOf`, `source`.

- Not onboarded: name and score from the mainnet row (404 when the vote is neither on mainnet nor onboarded);
  sweepable per epoch = inflation commission + MEV commission per epoch from that row (the `healthPerEpochSol` terms,
  block fees left out); limits = what 10 such epochs allow at 25% / 40%, capped at `max_advance_lamports`; bond for
  the full limit = ⌈limit ÷ bond_multiplier⌉. Before the Pool exists (or without `EPOCH_PROGRAM_ID`) the planned
  parameters are used and the payload says `kind: "sample"` with a note.
- Onboarded: state, score, swept epochs, bond and the limits the program would allow now (`credit_limit` with the
  bond cap); the open advance, or one closed in the last 10 epochs, with past sweeps (`paid`, or `late` when it
  found no revenue), the `due` row (the next epoch once this one is swept) and `upcoming` rows remitting
  `remit_bps` of the average swept revenue (all of it once defaulted) until repaid. `epochsLeft` = the due and
  upcoming rows; with no revenue in the window, the epochs until the advance may be written off for age.

**`GET /v1/wallets/:address/lender`** (request #8d): the wallet's Lender PDAs (shares it can still request, their
value, the junior lock), its open requests (`queued`) and requests the crank bounced at the junior floor in the last
30 epochs (`WithdrawCancelled` reason 1, shares and epoch from the request's event: `bounced`).

**`GET /v1/market`** (request #19)

- Quotes: only `EPOCH_MARKET_MAKER`'s (none, with a note, while it is unset): its FeeQuote accounts plus the quotes
  it closed in the last 16 epochs, rebuilt from `QuotePosted`, `SwapOpened` and `SwapSettled`. Status: `open` before
  its epoch and expiry, `live` during its epoch (or once trading closed early), then `settling` while swaps remain
  and `settled`. Each quote's index is final (account or `IndexFinalized`), the pending proposal, or `vetoed`.
- Stats: open interest and swaps on Epoch's quotes, hedged validators (`ValidatorPosition.hedged`), the newest settled
  epoch with swaps.
- Signed in: `myHedge` for an operator (minimum notional = half its average swept revenue; hedged epochs hold a
  Receive-fixed swap at least that size), `myPositions` (open accounts with a payoff from the final or proposed
  index via `taker_pnl`, settled ones from `SwapSettled`), "You" in recent swaps (the last 30 on Epoch's quotes).

| Variable                                   | Default                         | Notes                                                                                 |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------- |
| `EPOCH_CLUSTER`                            | `devnet`                        | Names the cluster in `source` and `network`.                                          |
| `EPOCH_RPC_URL` · `EPOCH_RPC_FALLBACK_URL` | `https://api.devnet.solana.com` | The program's cluster (not mainnet).                                                  |
| `EPOCH_PROGRAM_ID`                         | —                               | Unset: 503 `PROGRAM_NOT_CONFIGURED` (the not-onboarded estimate answers as a sample). |
| `EPOCH_MARKET_MAKER`                       | —                               | Epoch's maker key; unset: `/v1/market` lists no quote.                                |
| `DATABASE_URL`                             | —                               | `program_events` survive restarts and `pool_snapshots` feed the Vault series.         |

## One validator: `GET /v1/validators/:vote`

Built on demand from the validator's row plus one read each of its vote account (`getAccountInfo`, `jsonParsed`) and its
stake accounts (one filtered `getProgramAccounts`, the scan's 136-byte slice with each account's address).

- **Gauges.** `voteCreditsPct` = credits in the last finished epoch ÷ (slots in an epoch × 16, the timely-vote-credit
  maximum: 6,912,000). `skippedBlocksPct` = this epoch's skipped leader slots (`getBlockProduction`), Stakewiz's
  `skip_rate` before the first leader slot. `uptime30dPct` = Stakewiz `uptime`.
- **Delegators** (`tiles.delegators`, `biggestDelegatorSharePct`, `delegatorSplit`, `ifBiggestDelegatorLeftSol`,
  `medianWalletSol`) count withdraw authorities with active or activating stake, from this read (fresher than the scan).
  The split groups the Foundation (`FOUNDATION_AUTHORITIES`), liquid-staking pools (stake-pool withdraw authorities),
  each other wallet named in `DELEGATOR_LABELS_PATH`, then "N other wallets".
- **This epoch and stake moves.** Arriving = stake accounts activating this epoch, leaving = deactivating this epoch
  (accounts activated and deactivated in the same epoch never count). `stakeMoves` = accounts that started or stopped in
  this or the last epoch, newest and largest first, at most 50, with an Orb link.
- **Revenue** for the last finished epoch (`revenueEpoch`, `revenueLastEpochSol`): `inflationCommission` = the vote
  account's `getInflationReward` (its reward is its commission share); `tipsCommission` = Jito Kobe's tips for that
  epoch × MEV commission; `blockFeesEstimate` = blocks per epoch at this epoch's rate × the average fee per block in a
  sample of recent blocks (the public RPC refuses `getBlockProduction` for past epochs); `voteFees` = −(slots × 5,000
  lamports).
- **Credit estimate.** Sweepable = inflation commission + tips commission, for the last epoch and summed over the last 10.
  The limits apply the planned Pool rates (`CREDIT_PARAMS` in `Services/Validator/ValidatorProfileBuilder.ts`: 25%, 40%
  hedged, 4 × bond, 10 epochs; read them from the Pool account once it is live).
- **Vote rewards in the background.** On the public RPC one `getInflationReward` call for a past epoch takes 5–9 s (32
  addresses at most), so `VoteRewardsWarmer` reads every staked vote account for the last 10 epochs (newest first, 32 per
  call, ~22 calls an epoch) and then checks for a new epoch every 10 minutes. A profile reads the last epoch itself only
  until the warmer has it; an older epoch not read yet is estimated as that epoch's stake × the gross staking yield × the
  commission, and `note` says which.
- **Series.** `stakeByEpoch` = Stakewiz `/validator_total_stakes/<vote>` (30 epochs) overlaid with the recorded history,
  ending with the live stake; up to 64 points, so it starts at about 30 and grows by one an epoch while the recorder
  runs. `voteCreditsByEpoch` = the vote account's `epochCredits` (63 finished epochs). `jitoTipsTotalByEpochSol` = Kobe
  `/api/v1/validators/<vote>` (`mev_rewards`, ~165 epochs kept; the last 64 sent).
- **`commission.unchangedEpochs`** = epochs since the inflation or MEV commission last changed: Stakewiz's
  `/commission_history/<vote>` (newest entry, dated with `/all_epochs_history`) and Kobe's MEV commission per epoch;
  without Stakewiz, the recorded history (a lower bound).
- **Tags**: client and version (gossip), city and country, host (Stakewiz `ip_org`), Jito fee, Foundation-backed,
  epochs active (Stakewiz `first_epoch_with_stake`), Top-18 (superminority).

## One wallet: `GET /v1/wallets/:address/stake`

- **Stake accounts** = every stake account where the address is staker or withdrawer (two filtered `getProgramAccounts`),
  delegated ones listed with `status`: `activating` (delegated this epoch), `active`, `deactivating` (still earns this
  epoch) or `inactive` (cooled down; `sol` is then its whole balance, what a withdrawal returns). Health and APY come
  from the validator's row; a vote account missing from the table reads "no active stake yet", "not voting" or "vote
  account not found". The 500 largest are listed.
- **Idle SOL** = the wallet's own balance plus undelegated (initialized) stake accounts.
- **Rewards** = `getInflationReward` for the 100 largest delegated accounts over the last five finished epochs (read in
  parallel and kept, since a finished epoch never changes): `rewardsByEpoch`, `perEpochSol` (the last epoch), `monthSol`
  (the average over epochs with earning stake × epochs in 30 days), `yearSol` (last epoch × epochs a year), `lifetimeSol`
  (the five epochs only; `note` says which). These are staking rewards; Jito tips are claimed separately and are not in
  them. `blendedApyPct` = stake-weighted `apyPct` of the active and activating accounts.
- **Suggestions**: three validators outside the top 18, Healthy, commission ≤ 5%, MEV commission ≤ 10%, uptime ≥ 99%,
  at least 100 delegators and none over 30% (the two delegator rules wait for the scan), highest APY first, never one
  the wallet already stakes with.

## Validator history (`validator_epoch_stats`)

`ValidatorHistoryRecorder` runs only with `DATABASE_URL`: once at start, then hourly. Each run upserts, for every
validator with stake, this epoch's inflation commission, MEV commission, active stake and credits so far, and the final
credits of the four earlier epochs `getVoteAccounts` lists; then it reloads the last 64 epochs into memory for the table
and the profile. History from before the first run comes from Stakewiz, once per validator per process, for validators
missing any of the last nine finished epochs: `/commission_history/<vote>` (the value in force at each epoch's end; an
empty log, about a quarter of validators, means Stakewiz never saw a change, so today's commission is used from the
validator's first epoch with stake; epochs before a validator's first logged value stay unknown) and
`/validator_total_stakes/<vote>` (30 epochs of stake), both at once and then a 0.5 s pause (about 20 minutes for 700
validators, written every ~13; ten failures in a row stop it until the next run). `getInflationReward` cannot be used for this: on
mainnet vote accounts are VoteStateV4 and their rewards carry `commission: null`.

Until the recorder has run: without Postgres, rows have no `commissionHistory` / `stakeHistorySol` and the profile's
`stakeByEpoch` is Stakewiz's 30 epochs. With Postgres and the backfill, rows get 10 commission epochs and ~30 stake epochs
right after the first backfill, and the stake history grows to 64 epochs over the next ~34 epochs. Without the backfill
(`VALIDATOR_HISTORY_BACKFILL=false`) both start at one epoch and grow by one an epoch (10 epochs ≈ 13 days for the
commission window, 64 ≈ 86 days for the stake history).

## Sign-in, watchlist, alerts and Predict (requests #7, #11, #14, #15)

All of these need Postgres (`DATABASE_URL`, migration 0001); without it they answer `503 DATABASE_NOT_CONFIGURED`,
every request is signed out and the jobs below do not start. Times in responses are IST (`+05:30`).

| Method and path                    | Session  | Body / query                       | Returns                                      |
| ---------------------------------- | -------- | ---------------------------------- | -------------------------------------------- |
| `POST /v1/auth/siws/nonce`         | —        | —                                  | `SiwsNonce`                                  |
| `POST /v1/auth/siws/verify`        | —        | `{ message, signature, address? }` | `SessionView` + `Set-Cookie`                 |
| `POST /v1/auth/logout`             | optional | —                                  | `{ signedOut: true }` + cookie cleared       |
| `GET /v1/auth/session`             | optional | —                                  | `SessionView` or `null` (200 either way)     |
| `GET /v1/me/watchlist`             | required | —                                  | `{ votes }`                                  |
| `PUT /v1/me/watchlist`             | required | `{ votes: string[] }`              | `{ votes }` (de-duplicated, ≤ 200)           |
| `GET /v1/me/alerts`                | required | —                                  | `AlertPrefs`                                 |
| `PUT /v1/me/alerts`                | required | `{ rules, channels?, reminders? }` | `AlertPrefs`                                 |
| `POST /v1/me/alerts/telegram-link` | required | —                                  | `{ url, code, expiresAt }`                   |
| `POST /v1/me/alerts/test`          | required | —                                  | `{ email, telegram }`: `sent·skipped·failed` |
| `GET /v1/predict/markets`          | optional | —                                  | `PredictSnapshot`                            |
| `POST /v1/predict/calls`           | required | `{ marketId, side, points }`       | `PredictSnapshot` for the wallet             |
| `GET /v1/predict/leaderboard`      | —        | `?epochs=30` (1–365)               | `PredictLeaderboard`                         |

Types are in `src/types/Account.types.ts` (the handover contract's `Watchlist`, `AlertPrefs`, `PredictSnapshot`,
`PredictCallRequest`, plus the new `SiwsNonce`, `SessionView`, `TelegramLink`, `AlertTestResult` and
`PredictLeaderboard`).

**Session.** `sessionMiddleware` (registered with `.use()` before the routes) reads the cookie, looks the session up
(cached 30 s per token; a logout here takes effect at once, other processes within 30 s), bumps `last_seen_at` at most
every 5 minutes and sets `res.locals.session`. A bad, expired or revoked cookie, or a database error, just means signed
out. **A browser request whose `Origin` is not one of `SIWS_ALLOWED_DOMAINS` is treated as signed out**, and sign-in
and every write (`POST`/`PUT` above) from such an origin answers `403 ORIGIN_NOT_ALLOWED`; requests without an `Origin`
(curl, servers) are not affected. So another site can neither act with the cookie nor read the wallet's data, even
with `SameSite=None` and `API_CORS_ORIGINS=*`. Still set `API_CORS_ORIGINS` to the app's origins in production.

### Sign-In With Solana (`/v1/auth`)

`POST /v1/auth/siws/nonce` (30 per minute per IP, then `429`):

```json
{
  "nonce": "LoyybBuVRuDnGmJttyyCXL",
  "statement": "Sign in to Epoch. This request will not send a transaction or cost any SOL.",
  "issuedAt": "2026-10-03T01:43:48+05:30",
  "expirationTime": "2026-10-03T01:53:48+05:30",
  "domains": ["localhost:3000"]
}
```

The app passes these to the wallet's `signIn()` with `domain: window.location.host` (decision 7) and sends back the
exact text the wallet signed (`signedMessage` as UTF-8) and the 64-byte signature (base58 or base64):

```text
localhost:3000 wants you to sign in with your Solana account:
BVCpyR5E3wfGMnzMF5ruDJUpLjAde15pG5okzDDAoF3j

Sign in to Epoch. This request will not send a transaction or cost any SOL.

URI: http://localhost:3000
Version: 1
Chain ID: mainnet
Nonce: LoyybBuVRuDnGmJttyyCXL
Issued At: 2026-10-03T01:43:48+05:30
Expiration Time: 2026-10-03T01:53:48+05:30
```

Every line after the address is optional (the Nonce is required by the API); lines must be in this order, `Resources:`
last. `POST /v1/auth/siws/verify` checks, in order, and answers one code per failure:

| Check                                                                  | Status    | Code                                                                                 |
| ---------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| signature is 64 bytes, base58 or base64                                | 400       | `SIWS_SIGNATURE_MALFORMED`                                                           |
| the message parses strictly                                            | 400       | `SIWS_MESSAGE_INVALID` (`details.reason`)                                            |
| domain is in `SIWS_ALLOWED_DOMAINS`                                    | 401       | `SIWS_DOMAIN_NOT_ALLOWED`                                                            |
| address is a 32-byte base58 key, and equals `address` when sent        | 400 / 401 | `SIWS_ADDRESS_INVALID` / `SIWS_ADDRESS_MISMATCH`                                     |
| the nonce exists, is unused and unexpired (consumed atomically)        | 400 / 401 | `SIWS_NONCE_MISSING` / `SIWS_NONCE_UNKNOWN`, `SIWS_NONCE_USED`, `SIWS_NONCE_EXPIRED` |
| Issued At at most 5 min ahead; Expiration Time future; Not Before past | 401       | `SIWS_ISSUED_IN_FUTURE`, `SIWS_MESSAGE_EXPIRED`, `SIWS_NOT_YET_VALID`                |
| ed25519 signature over the UTF-8 message (Node `crypto.verify`)        | 401       | `SIWS_SIGNATURE_INVALID`                                                             |

On success it stores sha256(token) as the session id and sets `SESSION_COOKIE_NAME=<32 random bytes, base64url>;
Path=/; Max-Age=<SESSION_TTL_HOURS × 3,600>; HttpOnly` (+ `Secure`, `SameSite`, `Domain` from config), answering:

```json
{
  "address": "BVCpyR5E3wfGMnzMF5ruDJUpLjAde15pG5okzDDAoF3j",
  "roles": ["delegator"],
  "expiresAt": "2026-10-10T01:43:48+05:30"
}
```

`roles` come from chain, cached 60 s per wallet: `delegator` (mainnet stake accounts as staker or withdrawer),
`lender` (a Lender PDA with shares or pending shares), `operator` (a ValidatorPosition whose operator is the wallet). A
lookup that fails or takes over 8 s (RPC down, `PROGRAM_NOT_CONFIGURED`) leaves its role out with a warning; it never
fails sign-in.

### Watchlist (`/v1/me/watchlist`)

`PUT { "votes": ["FzUN…AmMk", "he1i…uBtk", "FzUN…AmMk"] }` → `{ "votes": ["FzUN…AmMk", "he1i…uBtk"] }`: each vote must
be a 32-byte base58 key (`400`), duplicates are dropped keeping order, more than 200 → `400 WATCHLIST_TOO_LONG`
(`details: { max, count }`). `GET` with nothing saved → `{ "votes": [] }`.

### Alerts (`/v1/me/alerts`) and the sender

```json
{
  "rules": { "offline": true, "feeUp": true, "losingMoney": true, "rewardsLanded": false },
  "channels": { "email": null, "telegram": null },
  "reminders": []
}
```

That is `GET` before anything is saved. `PUT` takes the same shape: `rules` in full; a channel left out keeps its value,
`null` or `""` turns it off (email format checked; Telegram = a chat id, digits with an optional `-`); `reminders` (at
most 20, `{ kind: "move-step-2", epoch, stakeAccount }`, duplicates dropped) left out keep theirs. The job's memory
(`alert_prefs.state`) is never touched by `PUT`.

- `POST /v1/me/alerts/telegram-link` → `{ "url": "https://t.me/<TELEGRAM_BOT_USERNAME>?start=<code>", "code",
"expiresAt" }` (15 minutes; `503 TELEGRAM_NOT_CONFIGURED` without `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME`).
  The **TelegramLinker** long-polls `getUpdates` (only with a token; Telegram allows one poller per bot, so run it in one
  process) and on `/start <code>` sets the wallet's Telegram chat and replies "Connected: Epoch alerts for BVCp…oF3j will
  arrive here." Used, expired and unknown codes get an explanation instead.
- `POST /v1/me/alerts/test` → `{ "email": "sent", "telegram": "skipped" }`: "Test alert from Epoch" to each channel
  the wallet set and the API has credentials for (5 per 10 minutes per wallet).
- **AlertJob** (every `ALERTS_CHECK_MINUTES` when `ALERTS_ENABLED`): for each wallet with a channel and a rule or
  reminder, its mainnet stake accounts (cached 30 min) → the validators it stakes with → their ValidatorTable rows.
  Rules (pure functions in `Services/Alerts/AlertRules.ts`): **offline** = delinquent in two checks at least 10 minutes
  apart (`offline:<vote>:<epoch>`); **feeUp** = commission or MEV commission above the last value seen (first sight only
  records; `fee:<vote>:<epoch>`); **losingMoney** = `healthPerEpochSol < 0` (`breakeven:<vote>:<epoch>`);
  **rewardsLanded** = once per new epoch, ~1,000 slots in, `getInflationReward` for the wallet's stake accounts in the
  previous epoch: "Rewards landed: 0.037784 SOL for epoch 900." (`rewards:<epoch>`); **reminders** whose epoch has come:
  "Step 2 of your stake move: …", then removed (`reminder:<stakeAccount>:<epoch>`). Each delivery inserts its
  `alert_deliveries` row first (unique per wallet, key and channel), sends, then records `sent` or `failed` with the
  reason (never a token), so a rerun or a second process never sends twice. A channel without credentials is skipped.
  Links point to `APP_PUBLIC_URL` + `/me` or `/validators/<vote>`.

### Predict in points mode (`/v1/predict`)

Index epochs: with `EPOCH_PROGRAM_ID` set, the program cluster's epoch and final values from the FeeIndex account
(current final + 16-epoch history); otherwise the mainnet epoch and, only with `PREDICT_RESOLVE_FROM_DB=true`, the
indexer's `epoch_index` table. This sits behind `FeeIndexOracle` (`Services/Predict/FeeIndexOracle.ts`) so it can be
swapped. `PREDICT_REAL_SOL=true` changes nothing (a warning is logged; Predict stays in points).

- **PredictMarketMaker** (at start and every 10 min): for each epoch from current + 1 to current +
  `PREDICT_MARKETS_AHEAD` without a market, "Will epoch E’s Fee Index close above X µL/CU?" with X the latest final
  value rounded to the nearest 50 (`fee-index-<E>-above-<X>`); nothing before the first final value.
- **PredictResolver** (every 5 min): each open market whose epoch is over and whose final value is known settles in one
  transaction: YES if value > X; W = points on the winning side, L = the losing side; W = 0 → `refunded` (every call
  gets its points back), else each winner gets `points + floor(points × L / W)`, losers 0. Idempotent.
- `GET /v1/predict/markets` → the `PredictSnapshot` of `fixtures/predict.sample.json`, real: open, closed and recently
  settled markets newest first (`yesShare` 0.5 for an empty pool; `nowNote` "Epoch N is running; its index is posted
  when it ends" · "Proposed X µL/CU, in its dispute window" · "Waiting for epoch N’s Fee Index" · "Final X µL/CU: YES" ·
  "Final X µL/CU: nobody called the winning side, calls refunded", and "Final X µL/CU: settling" in the minutes between
  a final value and the resolver); with a session also `pointsLeftThisEpoch` and `myCalls` (last 30 epochs;
  `estPayoutPoints = round(a + a × L / W)` while open or settling, `netPoints` once settled); `leaderboard` = top 10.
- `POST /v1/predict/calls { "marketId": "fee-index-1048-above-1300", "side": "yes", "points": 50 }` (10, 25, 50 or 100)
  → the fresh snapshot. `404` unknown market, `409 MARKET_CLOSED` once the market's epoch has started, `409
NOT_ENOUGH_POINTS` (`details.pointsLeft`) over `PREDICT_POINTS_PER_EPOCH` this epoch; a per-wallet advisory lock makes
  parallel calls safe. Each call is emitted on the bus (`predictCall`) for the activity feed.
- `GET /v1/predict/leaderboard?epochs=30` → `{ schemaVersion, kind, asOf, source, epochs, rows: [{ rank, walletShort,
netPoints, hitPct, calls }] }`, top 50 over markets settled with an epoch ≥ current − epochs; refunded calls count in
  `calls` but not in `hitPct`.

### Configuration (`AuthConfigSchema`, `AlertsConfigSchema`, `PredictConfigSchema`)

| Variable                     | Default                                    | Notes                                                                                          |
| ---------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `SIWS_ALLOWED_DOMAINS`       | `localhost:3000`                           | Comma list of the app's hosts (`window.location.host`): sign-in domains and trusted `Origin`s. |
| `SIWS_STATEMENT`             | "Sign in to Epoch. This request will not…" | Sent with the nonce.                                                                           |
| `SIWS_NONCE_TTL_MINUTES`     | `10`                                       |                                                                                                |
| `SESSION_TTL_HOURS`          | `168`                                      | Cookie Max-Age and session expiry.                                                             |
| `SESSION_COOKIE_NAME`        | `epoch_session`                            |                                                                                                |
| `SESSION_COOKIE_SECURE`      | `auto` (true when `NODE_ENV=production`)   | Must be `true` with `SameSite=None`.                                                           |
| `SESSION_COOKIE_SAMESITE`    | `lax`                                      | `none` when the app and the API are on different sites (Vercel app + API host).                |
| `SESSION_COOKIE_DOMAIN`      | —                                          |                                                                                                |
| `API_TRUST_PROXY`            | `false`                                    | `true` behind Fly/nginx, or every user shares the proxy's IP in the nonce rate limit.          |
| `ALERTS_ENABLED`             | `true`                                     | The sender job.                                                                                |
| `ALERTS_CHECK_MINUTES`       | `5`                                        |                                                                                                |
| `TELEGRAM_BOT_TOKEN`         | —                                          | Secret. Enables Telegram sends and the linker.                                                 |
| `TELEGRAM_BOT_USERNAME`      | —                                          | For the t.me link.                                                                             |
| `SMTP_URL`                   | —                                          | Secret (`smtps://user:pass@host:465`). Enables email.                                          |
| `ALERTS_EMAIL_FROM`          | `Epoch alerts <alerts@epoch.local>`        |                                                                                                |
| `APP_PUBLIC_URL`             | `http://localhost:3000`                    | Links in alerts.                                                                               |
| `PREDICT_POINTS_PER_EPOCH`   | `100`                                      |                                                                                                |
| `PREDICT_LEADERBOARD_EPOCHS` | `30`                                       |                                                                                                |
| `PREDICT_MARKETS_AHEAD`      | `2`                                        |                                                                                                |
| `PREDICT_RESOLVE_FROM_DB`    | `false`                                    | Without the program: open and settle markets from `epoch_index` (demo).                        |
| `PREDICT_REGIONS`            | `where allowed`                            | Shown in `rules.regions`.                                                                      |
| `PREDICT_REAL_SOL`           | `false`                                    | Ignored: points only.                                                                          |

## Launch: revenue tokens on Meteora

Request #22 (handover `pages/launch.md`, ADR 0006, plan F13). A validator sells a fixed share of its commission for a
fixed term as a token on a Meteora Dynamic Bonding Curve with Epoch as the partner; at the raise target it graduates to
a DAMM v2 pool. The Epoch program does not have `register_revenue_token`, `execute_buyback` or `redeem` yet, so the
launches come from a **registry file** (`LAUNCHES_PATH`, appended by the launch script in
[`packages/meteora/scripts`](../meteora/scripts/README.md)) and every chain read goes through
[`@epoch/meteora`](../meteora/README.md) on the launch cluster (devnet, decision 6). Nothing here is an offer.

- `GET /v1/launches` → `LaunchList`: every registry entry on `LAUNCH_CLUSTER`, in registry order. Without
  `LAUNCHES_PATH` it answers `{ launches: [] }` with a note; a registry that is not valid JSON or does not match the
  schema answers `503 LAUNCH_REGISTRY_INVALID` with the issues.
- `GET /v1/launches/:mint` → `LaunchDetail`, by mint or by symbol (`/v1/launches/rKEST`, case-insensitive); `404` for an
  unknown token.

`kind` is `real` when the registry has launches and every chain read succeeded, `sample` otherwise (the note says which
read failed). `network` is `LAUNCH_CLUSTER`. One read of every launch is cached for `LAUNCH_CACHE_SECONDS` (60), holders
for `LAUNCH_HOLDERS_CACHE_MINUTES` (10).

**How the figures are computed**

- **Status:** `ended` once the launch cluster's epoch is past `endEpoch` (`startEpoch + termEpochs − 1`); `upcoming`
  before `opensAtEpoch` or while the curve pool does not exist; `graduated` once the DBC pool migrated (or the DAMM v2
  pool exists); else `curve`. Epochs are the launch cluster's: the program that will register the token and buy it back
  runs there.
- **Raise:** target = DBC `migrationQuoteThreshold`; raised = the pool's quote reserve; progress = reserve ÷ threshold
  (`getPoolQuoteTokenCurveProgress`), 100% once graduated. **Buyers** = token accounts with a balance, without the pool
  vaults, the escrow and the leftover receiver (a buyer who sold everything is not counted); **holders** = every token
  account with a balance (one `getProgramAccounts` on the mint's token program).
- **Price:** the curve's price while on the curve, the DAMM v2 pool's after graduation; null while upcoming.
- **Band:** the curve's start and migration prices from its DBC config; before the pool exists, 60% and 95% of
  `avgRevenueSol × share × term ÷ supply` from the registry. `valuePerTokenSol` = band high ÷ 0.95.
- **Market cap** (fully diluted) = price × (supply − burned); **burned** = registry `supply` − the mint's supply now.
- **Share revenue per epoch** = revenue × `shareBps`, where revenue is the mainnet estimate from the validator table
  (inflation commission + MEV commission per epoch, `Services/Launch/LaunchRevenue.ts`) when the registry's vote account
  is a mainnet validator; otherwise 0, with a note, and implied yield and backing are null. It becomes the 10-epoch
  average of swept revenue once launches are registered on-chain.
- **Implied yield** = share revenue ÷ market cap, % per epoch (never annualised); **backing** = share revenue × epochs
  left (counting the current one) ÷ market cap.
- **Curve:** `creatorMigrationFeePct` = migration fee % × creator share % (70); `lockedLiquidityPct` = partner + creator
  permanently locked LP (100); `graduatedEpoch` from the registry, else estimated from the curve's finish time.
- **Fees and graduation:** `partnerFeesToSeniorSol` = the partner's share of the curve's lifetime trading fees
  (`getPoolFeeBreakdown`); `upfrontToValidatorSol` = raise × 70% once graduated.
- **Escrow:** the SOL balance of the registry's `escrow`; `mode` is `buyback`, 12 slices an epoch. `buybacks` is `[]`
  until the program's `execute_buyback` ships.
- **Price series:** the `LaunchPriceSampler` job stores every priced launch in `launch_price_samples` (mint, time,
  epoch, price) every `LAUNCH_SAMPLE_SECONDS` while the API runs with Postgres and a registry; the detail returns them
  oldest first, thinned in SQL to at most 500 points. Without Postgres the series is empty, with a note.
- **Risks:** the Launch page's four lines, with the validator's name and the term's last epoch.

**Registry** (`launches.example.json`; schema `LaunchRegistryEntrySchema` in `Services/Launch/LaunchRegistry.ts`): a
JSON array, one object per launch, re-read when the file changes:

| Field                                                             |                                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `mint`, `symbol`, `name`                                          | The token. Mints are unique.                                                                    |
| `validator`                                                       | `{ name, vote }`: `vote` is the validator's mainnet vote account (the revenue source), or null. |
| `shareBps`, `termEpochs`, `startEpoch`                            | The share sold and its term, on the launch cluster's epochs.                                    |
| `opensAtEpoch`                                                    | Optional: the curve opens later.                                                                |
| `dbcPool`, `dbcConfig`, `dammPool`, `escrow`                      | Optional addresses; the DAMM v2 pool is derived from the curve when omitted.                    |
| `supply`, `decimals`                                              | The fixed supply at launch (UI units). `burned` is a fallback when the mint cannot be read.     |
| `cluster`                                                         | `devnet` or `mainnet`; only `LAUNCH_CLUSTER` entries are served.                                |
| `avgRevenueSol`, `raiseTargetSol`, `graduatedEpoch`, `launchedAt` | Optional, written by the launch script.                                                         |

**Configuration** (`LaunchConfigSchema` in `@epoch/config-sdk`)

| Variable                       | Default         | Notes                                                                                              |
| ------------------------------ | --------------- | -------------------------------------------------------------------------------------------------- |
| `LAUNCHES_PATH`                | —               | The registry. Unset: no launches. A missing file is an empty registry.                             |
| `LAUNCH_CLUSTER`               | `devnet`        | The response's `network`; registry entries on other clusters are skipped.                          |
| `LAUNCH_RPC_URL`               | `EPOCH_RPC_URL` | Pools, mints and token accounts. The public devnet RPC works; it rate-limits `getProgramAccounts`. |
| `LAUNCH_RPC_FALLBACK_URL`      | —               | Tried when the primary fails.                                                                      |
| `LAUNCH_CACHE_SECONDS`         | `60`            |                                                                                                    |
| `LAUNCH_HOLDERS_CACHE_MINUTES` | `10`            |                                                                                                    |
| `LAUNCH_SAMPLER_ENABLED`       | `true`          | The price sampler also needs `LAUNCHES_PATH` and `DATABASE_URL`.                                   |
| `LAUNCH_SAMPLE_SECONDS`        | `60`            |                                                                                                    |

## How the derived figures are computed

- **Validators** = every vote account with stake (`getVoteAccounts` current + delinquent). **Delinquent** =
  delinquent now but earned vote credits in this or the last epoch (long-dead accounts are not counted).
- **Superminority** = the fewest largest validators holding more than a third of stake (`top18`).
- **Epoch Score** = the program's formula (`programs/epoch/src/math/score.rs`, ported in `Lib/EpochScore.ts`
  with the same tests): credits in the last finished epoch vs the cluster mean, commission = the higher of
  inflation and MEV commission, tenure from Stakewiz's first epoch with stake. Shown 0–100.
- **SOL kept per epoch** (`healthPerEpochSol`) = inflation commission (stake × gross staking yield per epoch
  × commission; yield = inflation rate × supply ÷ total stake ÷ epochs a year) + MEV commission (from the
  tips stakers earn, Stakewiz `jito_apy`, and the MEV commission) + block fees (blocks produced this epoch,
  scaled to a full epoch, × the average leader fee per block from a sample of recent blocks) − vote fees
  (slots per epoch × 5,000 lamports).
- **Break-even stake** = the stake at which a validator charging the median commission covers its vote fees
  from inflation commission plus the block fees its stake share earns.
- **Health** = the app's rules (`01-PRODUCT-AND-USERS.md`): offline when delinquent; watch when SOL kept < 0,
  one delegator holds over 50% or uptime < 99%; else healthy. "Commission raised in the last 10 epochs" waits
  for commission history from the indexer.
- **Client** = gossip `clientId` (`getClusterNodes`): Firedancer, Frankendancer, HarmonicFiredancer and FireBAM
  count as Firedancer; the rest (Agave, AgaveBam, JitoLabs, HarmonicAgave…) as Agave.
- **Median / top APY** = median and 90th percentile of Stakewiz `total_apy` across voting validators.
- **Delegators** = a scan of every delegated stake account (one filtered `getProgramAccounts` per vote account,
  136-byte slices), grouped by withdraw authority. Retail < 1,000 SOL in total, mid-size up to 100,000 SOL,
  allocators above. Stake pools on the configured stake-pool programs are named from their token symbol
  (JitoSOL, JupSOL…); other wallets are named only through `DELEGATOR_LABELS_PATH`.
- **Activating / deactivating this epoch** come from the scan when it ran this epoch, otherwise from the newest
  StakeHistory entry (the last finished epoch).
- **Commission history** (`commissionHistory` on each row: the last 10 epochs, inflation commission) and **stake
  history** (`stakeHistorySol`: up to 64 epochs) come from the validator history recorder below; without Postgres the
  rows leave them out. A raise in that window puts the validator on Watch ("commission raised 5% → 8%").

## Configuration (`MarketDataConfigSchema` in `@epoch/config-sdk`)

| Variable                        | Default                                    | Notes                                                                                                                               |
| ------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_RPC_URL`                  | `https://api.mainnet-beta.solana.com`      | Mainnet, even when the program runs on devnet. Use a paid RPC in production: the public one rate-limits (HTTP 429) during the scan. |
| `DATA_RPC_FALLBACK_URL`         | —                                          | Tried when the primary fails.                                                                                                       |
| `STAKEWIZ_API_URL`              | `https://api.stakewiz.com`                 | Names, countries, APY, uptime, tenure.                                                                                              |
| `JITO_KOBE_API_URL`             | `https://kobe.mainnet.jito.network`        | MEV commission.                                                                                                                     |
| `PRICE_API_URL`                 | `https://lite-api.jup.ag/price/v3`         | SOL/USD.                                                                                                                            |
| `TOKEN_API_URL`                 | `https://lite-api.jup.ag/tokens/v2/search` | Stake-pool token symbols.                                                                                                           |
| `FX_API_URL`                    | `https://open.er-api.com/v6/latest/USD`    | USD/INR.                                                                                                                            |
| `DELEGATOR_SCAN_ENABLED`        | `true`                                     |                                                                                                                                     |
| `DELEGATOR_SCAN_INTERVAL_HOURS` | `12`                                       | Plus one run at start.                                                                                                              |
| `DELEGATOR_SCAN_CONCURRENCY`    | `4`                                        | Parallel `getProgramAccounts` calls.                                                                                                |
| `DELEGATOR_SCAN_VOTE_LIMIT`     | `0`                                        | Development only: scan the N largest validators.                                                                                    |
| `DELEGATOR_LABELS_PATH`         | —                                          | JSON `[{ "address", "name", "kind", "entity"? }]`; rows sharing an `entity` are summed (several Foundation wallets → one row).      |
| `FOUNDATION_AUTHORITIES`        | —                                          | Comma list of the Solana Foundation's withdraw authorities; enables `foundationSharePct` and `dependOnFoundation`.                  |
| `STAKE_POOL_PROGRAM_IDS`        | SPL + two Sanctum programs                 | Stake-pool programs whose pools are named as liquid staking.                                                                        |
| `VALIDATOR_HISTORY_ENABLED`     | `true`                                     | `ValidatorHistoryConfigSchema`. Records validator history when `DATABASE_URL` is set; turn off on extra replicas.                   |
| `VALIDATOR_HISTORY_BACKFILL`    | `true`                                     | Fill the last epochs from Stakewiz once (two calls per validator).                                                                  |

### The Epoch program and the stream (`EpochProgramConfigSchema`, `StreamConfigSchema`)

| Variable                        | Default                         | Notes                                                                                                            |
| ------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `EPOCH_CLUSTER`                 | `devnet`                        | Named in the activity `source`.                                                                                  |
| `EPOCH_RPC_URL`                 | `https://api.devnet.solana.com` | The program's cluster (not mainnet).                                                                             |
| `EPOCH_RPC_FALLBACK_URL`        | —                               | Tried for program reads (and the ingester's HTTP reads) when the primary fails; not for HTTP 429.                |
| `EPOCH_RPC_WS_URL`              | `EPOCH_RPC_URL` as `wss://`     | The ingester's `logsSubscribe`. Localnet: `ws://127.0.0.1:8900`.                                                 |
| `EPOCH_PROGRAM_ID`              | —                               | Unset → no ingestion; `/v1/index` and `/v1/activity` use Postgres alone, or answer `503 PROGRAM_NOT_CONFIGURED`. |
| `PROGRAM_EVENTS_INGEST`         | `true`                          | `false` keeps the API from reading program events (another process may fill `program_events`).                   |
| `PROGRAM_EVENTS_BACKFILL_LIMIT` | `2000`                          | Transactions to read on a first start (no cursor yet); 0 = from the newest one on.                               |
| `STREAM_SLOT_INTERVAL_MS`       | `2000`                          | How often the `slot` channel polls mainnet `getEpochInfo` while someone listens (400–60,000).                    |

`API_PORT`, `API_CORS_ORIGINS` and `API_TRUST_PROXY` come from `ApiConfigSchema` / `AuthConfigSchema`. `DATABASE_URL` turns on sign-in, the watchlist, alerts, Predict, the Fee Index history (`epoch_index`), durable program-event history, `pool_snapshots`, launch price samples and the validator history recorder; without it those answer `503 DATABASE_NOT_CONFIGURED` or keep their data in memory.
