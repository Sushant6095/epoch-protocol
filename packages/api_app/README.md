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
| `GET /v1/index/latest-final`                                                               | `FeeIndexLatestFinal`           | 15 s  | the FeeIndex account alone                                    |
| `GET /v1/network`                                                                          | `NetworkSnapshot`               | 15 s  | mainnet RPC, Stakewiz, Jito Kobe, Jupiter, the delegator scan |
| `GET /v1/network/stake-history?epochs=64`                                                  | `StakeHistory`, oldest first    | 5 min | StakeHistory sysvar                                           |
| `GET /v1/validators?tab=&chips=&q=&sort=&dir=&fee=&client=&country=&votes=&cursor=&limit=` | `ValidatorList`                 | 30 s  | as `/v1/network`                                              |
| `GET /v1/validators/:vote`                                                                 | `ValidatorProfile`              | 2 min | mainnet RPC, Stakewiz, Jito Kobe, validator history, MEV scan |
| `GET /v1/delegators/biggest?limit=10`                                                      | `BiggestDelegators`             | 5 min | the delegator scan                                            |
| `GET /v1/delegators/retail-magnets?limit=10`                                               | `RetailMagnets`                 | 5 min | the delegator scan                                            |
| `GET /v1/wallets/:address/stake`                                                           | `MyStake`                       | 60 s  | mainnet RPC (stake accounts, balance, `getInflationReward`)   |
| `GET /v1/activity?limit=50`                                                                | `ActivityFeed`, newest first    | 5 s   | program events (`program_events`), Predict calls              |
| `WS /v1/stream`                                                                            | channels, see below             | —     | mainnet RPC (`slot`), the bus, the providers                  |
| `GET /v1/vault`                                                                            | `VaultSnapshot`                 | 5 s   | the Epoch program (see below)                                 |
| `GET /v1/validators/:vote/position`                                                        | `OperatorPositionSnapshot`      | 10 s  | the Epoch program; mainnet rows for the estimate              |
| `GET /v1/validators/:vote/history`                                                         | `OnChainHistorySnapshot`        | 10 s  | the Epoch program's `ValidatorHistory` account (P1)           |
| `GET /v1/wallets/:address/lender`                                                          | `LenderPositionSnapshot`        | 5 s   | the Epoch program                                             |
| `GET /v1/market`                                                                           | `FeeMarketSnapshot`             | 5 s   | the Epoch program                                             |
| `GET /v1/launches`                                                                         | `LaunchList`                    | 60 s  | launch registry, DBC and DAMM v2 pools on devnet (see Launch) |
| `GET /v1/launches/:mint`                                                                   | `LaunchDetail`                  | 60 s  | as `/v1/launches`, plus `launch_price_samples`                |
| `GET /v1/launches/:mint/page` · `/market` · `/trades` · `/candles` · `/holders` · `/fees` · `/indexed` | the Launch page (see below) | 0–60 s | the pools, `launch_trades`, `launch_fee_events` (plan F13); `/indexed`: Meteora's DAMM v2 data API for a graduated pool |
| `POST /v1/launches/:mint/quote` · `POST /v1/launches/:mint/build`                          | `LaunchQuoteResponse`, `LaunchBuildResponse` | — | Meteora DBC / DAMM v2 via `@epoch/meteora`; unsigned transactions |
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
  `EPOCH_RPC_URL` with `https` → `wss`; a Solami RPC URL, `https://[<region>.]rpc.solami.dev/sol?api_key=…`, maps to
  Solami's websocket host `wss://[<region>.]ws.solami.dev/ws/sol?api_key=…` as its docs list it, and the Launch page's
  realtime connection does the same when `LAUNCH_RPC_WS_URL` is unset; set it for localnet, whose websocket is on port
  8900). Logs are parsed directly
  (block time = arrival time). Live events never move the cursor, so the next poll still walks every signature after
  it: a dropped websocket loses nothing, and `(signature, ix)` dedupes. When a poll finds transactions the websocket
  never delivered, the ingester reconnects and resubscribes.
- _Live over Solami gRPC_ (when `EPOCH_CLUSTER=mainnet` and `SOLAMI_TOKEN` is set): the program's transactions arrive
  over Yellowstone (`account_include` = the program, `failed = false`, `confirmed`) on the API's one Solami stream
  (`Sources/SolamiStream.ts`), instead of `logsSubscribe`; the websocket takes over while that stream is down for 30 s
  or refused, and steps back when it streams again. Duplicates are dropped by signature and `(signature, ix)`.
- Only `Program data:` lines written while the Epoch program is the innermost frame count (epoch-sdk
  `parseEventsFromLogs`): other programs' data in the same transaction is ignored. `ix` is the event's position among
  its transaction's events; `epoch` is the program cluster's epoch of the slot; `payload` is `eventToJson(event).data`.

**Latest final Fee Index** (`GET /v1/index/latest-final`, `Services/Program/FeeIndexLatestFinal.ts`). The provider-neutral
read for off-chain consumers (there is no Switchboard mirror: Switchboard shut down on 25 Sep 2026). Straight from the
FeeIndex account's last final point, nothing from events or Postgres, so anyone can check it against the chain:
`{ schemaVersion, kind, asOf, source, epoch, value, unit: "µL/CU", finalizedSlot, inputsHash, cluster, programId,
feeIndexAccount, methodology }`. `epoch` is the program epoch (the mainnet epoch when the program runs on mainnet),
`finalizedSlot` the program cluster's slot `finalize_index` ran in, `inputsHash` the hex sha256 the value was posted
with. A pending proposal never shows here. `404 NOT_FOUND` until the first value is final; `503
PROGRAM_NOT_CONFIGURED` without `EPOCH_PROGRAM_ID`. Programs read the same account on chain or call `get_sfi`
(`docs/FEE_INDEX_METHODOLOGY.md`, "Reading the index on chain").

**Fee Index** (`GET /v1/index`, `Services/Program/FeeIndexService.ts`). A bare `FeeIndexPoint[]`, newest first, each
`{ epoch, value, status?, mainnetEpoch, clusterEpoch }` in µL/CU, merged from:

1. the FeeIndex account: the last final value and its 16-epoch history are `final`; a pending proposal is `proposed`;
2. stored `IndexProposed` / `IndexFinalized` / `IndexVetoed` events: the newest event per epoch decides (finalized →
   `final`, proposed → `proposed`, vetoed → `vetoed`), so a vetoed proposal stays visible until a new one is posted for
   its epoch. Final is terminal; a veto newer than the proposal a cached account read still shows wins;
3. open `IndexBallot` accounts (operator consensus): an epoch still voting, or agreed and queued until the FeeIndex
   can take it, with no newer program fact is `voting` (value: the current weighted median, or the agreed value once
   reached); a ballot reopened after a veto replaces the vetoed point;
4. `epoch_index` rows the indexer computed (Postgres): only for epochs the program has no value for, without `status`.

One numbering: every point is numbered by MAINNET epoch (`epoch` = `mainnetEpoch`, the index's own numbering), and
`clusterEpoch` is the program-cluster epoch the value is (or will be) posted under, which quotes, swaps and ballots use.
The program's values come keyed by program epoch and are mapped the way publisher_app posts them
(`Index/EpochMapping.ts`): a recorded post first (`epoch_index.posted_signature` → its `IndexProposed` or
`IndexVoteCast` → the program epoch), then `FEE_INDEX_EPOCH_OFFSET` (`P = M + offset`). With the offset 0 (mainnet,
localnet) both numbers are equal. With `auto` (devnet) only recorded posts are known: a computed epoch not posted yet
has `clusterEpoch: null`, and a program value without a recorded post (posted by hand) is left out.

`from` / `to` (inclusive, mainnet epochs) and `limit` (1–500, default 50) apply after the merge. Without the program and without
Postgres: `503 PROGRAM_NOT_CONFIGURED`; when the account can't be read, the events alone are used (logged).
`FeeIndexService.latest()` (in PROGRAM epochs, like the quotes it is read with) gives `{ final: { epoch, value } | null, proposed: { epoch, value, disputeEndsSlot } | null,
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
| `RevenueTokenRegistered`, `RevenueShareSwept`, `BuybackExecuted`, `RevenueTokenPoolSynced`, `RevenueTokenRedeemed`, `RevenueTokenClosed` | `buyback` · "Kestrel Nodes · bought back and burned on the curve" (and the lifecycle's other steps) · the SOL moved |
| `TreasuryClaimed`                                  | `buyback` · "EUdJ…iDs1 · treasury: curve trading fees to lenders" (surplus, migration fee, DAMM v2 LP fees; "unsold supply burned" for the leftover; ", tokens burned" when it burned some) · `lamportsToPool` |
| `HistoryInitialized`                               | `score` · "Kestrel Nodes · on-chain history opened" · —                                                                    |
| `VoteAccountCopied`                                | `score` · "Kestrel Nodes · vote account copied on chain" · — (a validator's first copy of each epoch only, see below)      |
| `TipDistributionCopied` / `PriorityFeeDistributionCopied` | `score` · "Kestrel Nodes · Jito tips copied: 8% MEV commission" (priority fees: "· Jito priority fees copied: 50% commission") · `mevEarnedLamports` / `priorityFeesLamports` (— before the merkle root); not shown when `found` is false (no Jito account: devnet) |
| `StakeInfoUpdated`                                 | `score` · "Kestrel Nodes · stake rank #12, superminority posted by the scorer" · —                                       |
| `ScoreRefreshed`                                   | `score` · "Kestrel Nodes · score 87 from on-chain history (hedged)" (flags: delinquent, superminority, hedged) · — (only when the score or a flag changed, see below) |
| `ScoringConfigured`                                | `score` · "Scoring settings: 10-epoch credit window, cluster average at 99.5% of the maximum" · —                          |
| a Predict call                                     | `predict` · "<market label> · YES" · `value` = points, `unit: "points"`, no signature                                      |

Other events (accruals, `update_score`'s `ScoreUpdated`, bonds, quotes, admin) are not shown. The keepers' HistoryJob
copies the vote account and refreshes every score on each pass (every 30 minutes), so the `score` rows drop repeats
(`RepeatFilter` in `ActivityMapper.ts`): a validator's `VoteAccountCopied` shows once per epoch and its
`ScoreRefreshed` only when the score, delinquency, superminority or hedge flag changed from its previous refresh. The
feed judges this oldest first over the events it read (the oldest in that window always shows); the websocket over
the events it has pushed since the API started.

**Revenue-token buybacks and treasury claims** (`GET /v1/launches/:mint/buybacks`, `Services/Launch/BuybackFeed.ts`,
from the program's cluster). The mint's `RevenueToken` account (escrow, schedule, term, totals), its `BuybackExecuted`
events newest first (at most 200) and a `treasury` section from its `TreasuryClaimed` events: the partner treasury PDA
`address`, `totals` and `byKind` (`tradingFee`, `surplus`, `migrationFee`, `leftover`, `lpFee`) of SOL put in the
lending pool as income (`toLendersSol`) and tokens burned, the newest 200 `claims` (kind, epoch, source pool, LP
position, `toLendersSol`, `tokensBurned`, signature) and `claimable: "/v1/launches/<mint>/fees"`, where the Launch page
shows what is still unclaimed on Meteora. Treasury totals add up the newest 10,000 claims. The treasury section is
there for any mint, registered as a revenue token or not. Once a token closed after its term (`close_revenue_token`:
the account is gone, and the validator may have registered another mint on the same `["buyback", vote]` escrow), the
feed answers from the program's events instead (`closedFeed`): the term from `RevenueTokenRegistered`, the totals from
`RevenueTokenClosed`, every slice, and `closed` (epoch, signature, the unredeemed SOL that went to the pool).

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
{ "type": "hello", "channels": ["slot", "activity", "feeIndex", "launch:<key>"] }
{ "type": "subscribed", "channels": ["slot", "activity"] }
{ "type": "pong" }
{ "type": "error", "message": "Unknown or unavailable channel: vault (available: slot, activity, feeIndex)" }
{ "type": "error", "channel": "vault", "message": "…" }
{ "channel": "slot", "data": { "slot": 375840001, "epoch": 870, "slotIndex": 1, "slotsInEpoch": 432000, "leader": "<identity>", "leaderName": "Helius" }, "at": "2026-10-03T01:12:09+05:30" }
```

`hello` lists the channels this server can serve (`launch:<key>`: one channel per launch, by mint or symbol); `subscribed` answers every subscribe and unsubscribe with the
current set; data frames carry `channel`, `data` and `at` (when the data was read, IST).

| Channel    | `data`                                                                                                                                                   | When                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `slot`     | MAINNET `{ slot, epoch, slotIndex, slotsInEpoch, leader, leaderName, source }` (leader = identity key; `leaderName` from the validator table, null when unknown; `source`: `grpc` pushed by Solami, `rpc` polled) | with `SOLAMI_TOKEN`: each confirmed slot as Solami gRPC pushes it; otherwise (or while that stream is quiet) every `STREAM_SLOT_INTERVAL_MS` when the slot moved; only while someone subscribes; the last value right away to a new subscriber |
| `activity` | one `ActivityEvent` (as `GET /v1/activity`)                                                                                                              | each new program event the feed shows and each Predict call; events older than 10 minutes (a backfill after downtime) only appear in `GET /v1/activity`                              |
| `vault`    | the vault provider's snapshot (`VaultSnapshot`)                                                                                                          | on subscribe, then 2 s after the last pool event (`Deposited`, `Withdraw*`, `Accrued`, `AdvanceOpened`, `Swept`, `AdvanceRepaid`, `AdvanceDefaulted`, `BondPosted`, `BondWithdrawn`) |
| `feeIndex` | `{ points: FeeIndexPoint[16], final, proposed, avg8, ballot }` (`ballot`: the newest open `FeeIndexBallotView`, or null)                                                                                                   | on subscribe, then after `IndexProposed` / `IndexFinalized` / `IndexVetoed` and every ballot event (`IndexBallotOpened`, `IndexVoteCast`, `IndexConsensusReached`, `IndexBallotSubmitted`, `IndexBallotClosed`)                                                                                                          |
| `launch:<mint>` | `{ type: 'snapshot' \| 'trade' \| 'market' \| 'fee', … }` (`LaunchStreamMessage`; a symbol subscribes to its mint's channel) | a snapshot on subscribe, then each trade the ingester stores, the market after them, and claim / graduation events; at most 8 keyed channels per socket (docs/pages/launch.md) |
| `slots` | one `LiveSlot` (as `/v1/live/slots`) | each block processed live, with a database (see "Live" below) |
| `index:live` | the whole `LiveSummary` | on subscribe and on each estimate write, with a database (see "Live" below) |
| `predict:panta` | `PantaStreamData`: our markets' prices and forecasts | while someone listens, with Panta configured (see "Real-money Predict" below) |

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

- `scoreBreakdown` (P1, validator history; null when not onboarded): `source: "history"` when `refresh_score` wrote
  the score from the on-chain history (the history's last refresh is from the position's `last_scored_epoch`;
  `update_score` refuses once the epoch's vote copy exists, so it cannot have written later in that epoch), with the
  `inputs` it used (credits as a share of the TVC maximum and against the cluster reference, the highest commission,
  epochs active, delinquent, superminority, hedged, the hedge requirement); `source: "scorer"` when the Pool's scorer
  posted it with `update_score` (the fallback without fresh history; its inputs are not on chain, so `inputs` is
  null). `history` names the `ValidatorHistory` address, its freshness and the epoch of its newest vote copy, or is
  null before `init_validator_history`.

**`GET /v1/validators/:vote/history`** (P1): the validator's `ValidatorHistory` account (PDA `["history", vote]`,
read directly, not cached), decoded by epoch-sdk, plus the Pool's `ScoreConfig`. 404 before anyone ran
`init_validator_history` for the vote account (it is permissionless and not tied to onboarding: watch-list validators
have one too). Every number comes from the account; nothing is computed off chain except unit conversions.

- `entries`: the filled epochs, oldest first (at most 64; the ring holds epoch `e` at `e % 64`). Each field is null
  while the chain has not reported it (the program's all-ones "unknown" sentinel): `credits` / `maxCredits`
  (slots in the epoch × 16, the timely-vote-credit maximum) and `creditsOfMaxPct`; the inflation and block-revenue
  commissions (vote account), the MEV commission and `mevEarnedSol` (Jito tip-distribution
  `validator_commission_bps` and `merkle_root.max_total_claim`, the epoch's whole tip pot, once the root is
  uploaded), the priority-fee commission and `priorityFeesSol` (Jito priority-fee distribution
  `validator_commission_bps` and `total_lamports_transferred`); `voteAccountSol` and `revenueSol` (the sweep's rule:
  the most seen above rent + pending delegator rewards, plus the escrow above rent); `activatedStakeSol`,
  `stakeRank` and `superminority` (oracle: the Pool's scorer); `lastVotedSlot`, `updatedSlot`; `sources` (`vote`,
  `credits`, `tip`, `priorityFee`, `stake`: what filled the entry).
- `freshness`: `status` is `fresh` when the history holds a vote copy from the program cluster's current epoch (then
  `update_score` refuses and the keepers score with `refresh_score`), `stale` when the newest copy is older, `empty`
  before the first. `lastVoteCopyEpoch`, `lastVoteCopySlot`, `slotsSinceVoteCopy`; `maxCopyAgeSlots` (ScoreConfig);
  `stakeInfoPosted` (this epoch's `update_stake_info`); `refreshReady` = fresh, the copy at most `maxCopyAgeSlots`
  old, stake info posted and scoring configured: what `refresh_score` checks before it computes.
- `lastRefresh`: the last `refresh_score` from the account header (epoch, slot, score 0–100, credits of max and vs the
  cluster reference, commission, epochs active, the three flags, `hedgeRequiredSol`); null before the first.
- `scoring`: the Pool's ScoreConfig (credit window, cluster reference, whether block commission counts, max copy
  age, market maker); null before `configure_scoring`.

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
| `FEE_INDEX_EPOCH_OFFSET`                   | `0`                             | mainnet ↔ program epochs for the Fee Index points (`P = M + offset`, or `auto`); the same value publisher_app posts by |
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

## Jito MEV from mainnet (`validator_mev_epochs`, request #5b)

indexer_app's MEV scan reads every Jito validator's TipDistributionAccount (TDA) and PriorityFeeDistributionAccount per
mainnet epoch in bulk, and the ClaimStatus of each validator's commission node (see `packages/indexer_app/README.md`,
"Jito MEV scan"). The API keeps the last 20 epochs in memory (`MevHistoryLoader`, reloaded every 10 minutes, only with
`DATABASE_URL`); without them every field below falls back as described.

- **`GET /v1/validators` rows.** `mevCommissionPct` is chain-first: the validator's newest TDA of this or the last epoch
  (a TDA exists once the validator has led a slot with Jito), else Jito Kobe, else Stakewiz; `mevSource` says which
  (`chain`, `kobe`, `stakewiz`, or null when none knows). New: `mevTipsSol`, the tips of the validator's last finished
  epoch whose merkle root is uploaded (`mevTipsEpoch`), i.e. the whole TDA payout (stakers' share plus commission);
  null without a TDA.
- **`GET /v1/validators/:vote` `mevHistory`**, oldest first: per epoch `commissionBps`, `tipsSol`, `final` (root
  uploaded), `validatorShareSol` (the claimed amount; before the claim ⌊tips × bps ÷ 10,000⌋ with `estimated: true`, an
  upper bound at 100 % because the TipRouter protocol fee is paid first), `claimStatus`, `claimedSlot`,
  `pfCommissionBps` / `pfTransferredSol` / `pfClaimStatus` (priority-fee distribution and its validator node; null for
  almost everyone), and `source`: `chain`
  rows from the scan, `kobe` rows (commission and tips, no claims) for epochs before the scan's window.
- **`GET /v1/validators/:vote/position` `mev`** (`PositionMev`, null without the scan or a TDA): `commissionBps`,
  `lastEpoch`, and per mainnet epoch `tipsSol`, `final`, `validatorShareSol`, `estimated`, `claimStatus` and `sweptIn`.
  On a mainnet program the list starts at onboarding and a claimed commission of epoch X counts as swept at X + 1 once
  that sweep ran (cranks_app's `ClaimMevJob` holds the sweep until Jito's claim lands); on devnet (epochs are not
  mainnet's) it lists the last 10 mainnet epochs and `sweptIn` stays null. `pendingSol` = commission whose claim is still
  pending, plus, on mainnet, commission claimed but not swept yet.
- **Tips so far.** For an epoch without a root (the epoch in progress, and the first hours of the next) `tipsSol` is the
  TDA's balance minus its rent-exempt minimum as read from the RPC (`getMinimumBalanceForRentExemption(168)`):
  1,503,680 lamports on mainnet today, not the older 2,060,160, and never a hardcoded figure.
- **0 % commission is normal.** About half of Jito validators (317 of 635 in epoch 1050) charge 0 % MEV commission:
  their commission node is 0 and never gets a ClaimStatus, so `claimStatus: 'none'` is expected for them, not a missed
  claim. `pending` = commission above 0 and not claimed yet (epoch 1050's claims landed 1.2 to 3.1 hours after the
  boundary); `expired` = the TDA closed (10 epochs after its epoch) unclaimed.

## Validator history (`validator_epoch_stats`)

Not the on-chain `ValidatorHistory` (that one is `GET /v1/validators/:vote/history`, above): this is the API's own
mainnet record behind the validator table and the profile.

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
| `PREDICT_REAL_SOL`           | `false`                                    | Superseded (3 Oct 2026): real money is USDC through Panta, see `PANTA_TRADING_ENABLED` below.  |

## Real-money Predict through Panta (`/v1/predict/panta`)

Decision of 3 Oct 2026: Predict trades **real USDC** on [Panta](https://docs.panta.market) markets on Solana mainnet;
points mode (above) stays as the free tier, untouched. Built in `Services/Panta/` on `@epoch/panta`. Epoch's own
markets ("Will the Solana Fee Index for epoch N close above X µL/CU?") are created by `panta_bot_app` (`panta_markets`);
every trade made through Epoch is recorded in `panta_trades` and reported to Panta for attribution. The page contract
for the app is [docs/pages/predict.md](../../docs/pages/predict.md); response types are `src/types/Panta.types.ts`.

| Method and path | Returns | Who | Panta calls |
| --- | --- | --- | --- |
| `GET /v1/predict/panta/markets?category=&status=&q=&cursor=&limit=` | `PantaMarketsPage`: `access`, `ours` (our markets with prices and `intelligence`), `discover` (the catalog) | public | `GET /markets/{id}/` per our market, `GET /markets/` (cached) |
| `GET /v1/predict/panta/markets/:marketId` | `PantaMarketDetail`: the card and its public tape (share and fee amounts as decimals: Panta's live tape sends 1e6 base units) | public | `GET /markets/{id}/`, `GET /markets/{id}/trades/` |
| `GET /v1/predict/panta/categories` | `PantaCategoriesView` | public | `GET /categories/` (1 h) |
| `GET /v1/predict/panta/positions?wallet=` | `PantaPositionsView`: shares, `state` (open, claimable, won, lost, claimed, cancelled), display-only value | public | `GET /positions/`, `GET /markets/{id}/` |
| `GET /v1/predict/panta/stats` | `PantaStatsView`: our trades, wallets, volume, attribution, markets created, fees; Panta's account metrics; `traction` (Epoch on Panta: markets created, attributed volume, volume on our markets, traders, attributed trades, creator fees claimed, estimated protocol fees) | public | `GET /account/dashboard/`, `/account/metrics/`, `/account/creates/`, `/account/trades/`, `GET /markets/?createdBy=me` (together, cached 2 min, stale copy up to 30 min) |
| `GET /v1/predict/panta/forecast?epoch=` | `PantaForecastView`: the crowd's forecast of one epoch's index from its strikes' YES prices (implied, monotonic fit, lognormal curve and empirical probability per strike; median, expected value, 80% band) | public | `GET /markets/{id}/` per strike (cached) |
| `GET /v1/predict/panta/market-image.png` | the 1024×1024 PNG catalog image of our markets (the bot's default `PANTA_MARKET_IMAGE_URL`) | public | — |
| `POST /v1/predict/panta/quote` `{ wallet, marketId, side, amountUsdc }` | `PantaQuoteView` (~90 s quote, summary) | public | `POST /primaryorderquote/` |
| `POST /v1/predict/panta/build` `{ quoteId, wallet, consent: true, maxSlippageBps? }` | `PantaBuildView`: unsigned v0 transaction (base64), `tradeId`, summary, review | SIWS session of `wallet` | `POST /primaryorderbuild/` |
| `POST /v1/predict/panta/submit` `{ tradeId, signedTransaction }` or `{ tradeId, signature }` | `PantaSubmitView` | SIWS session of the trade's wallet | `POST /primaryordersubmit/` (buys) |
| `GET /v1/predict/panta/status/:tradeId` | `PantaTradeStatusView`: chain status, Panta's order status, attribution | public | `POST /primaryorderverify/` (5 s), `POST /trades/` |
| `POST /v1/predict/panta/claim/build` `{ wallet, marketId, consent: true }` | `PantaBuildView` for a win claim | SIWS session of `wallet` | `POST /claim/build/` |
| `GET /v1/index/epochs/:epoch` | `FeeIndexEpochView`: one MAINNET epoch's value and `status` (`pending` · `computed` · `voting` · `proposed` · `final` · `vetoed`), the program epoch, the `post_index` (or first `cast_index_vote`) and `finalize_index` signatures, and `ballot` (`FeeIndexBallotView`: round, status, threshold, tolerance, weights, agreeing share, median, consensus, and per operator its value, deviation, agreement and inputs hash; from the live `IndexBallot`, else rebuilt from the indexed events; null without consensus) | public | — (the resolution source of our markets) |
| `GET /v1/index/forecast` | `FeeIndexForecastCard`: the crowd forecast of the next epoch with markets, for the Terminal's Fee Index card (`available: false` with a reason instead of an error) | public | as `forecast` |
| `WS /v1/stream` channel `predict:panta` | `PantaStreamData`: our markets' prices, implied vs model probability, and each epoch's crowd forecast (`forecasts`) | — | `GET /markets/{id}/` every `PANTA_STREAM_INTERVAL_SECONDS` (≥ 10 s) while someone listens; doubles on failure up to 5 min |

**Attribution and freshness (Panta Terms of Use).** Every Panta-derived payload carries `poweredBy: "Panta"`,
`poweredByUrl`, `asOf` (when Panta answered, IST), `ageSeconds` and `stale`. Reads are cached `PANTA_CACHE_SECONDS`
(15 s); past that, one shared reload; only if the reload FAILS is the old answer served, with `stale: true` and its
original `asOf`, for at most 10 minutes; after that the route fails (`502 PANTA_UNAVAILABLE`). Nothing simulated or
cached is ever presented as live. The API key stays on the server (never in a response, log or URL).

**Trading flow.** quote → the user confirms the summary → build (`consent: true`; the transaction is compiled from
Panta's instructions with the wallet as fee payer and only signer; the trade row stores the summary, the consent time,
the session wallet and the message hash) → the wallet signs → submit: either the signed transaction (Epoch checks it is
exactly the built message, signed by the trade's wallet, records the signature, then broadcasts on `PANTA_RPC_URL`
with preflight) or the signature of a transaction the wallet broadcast itself → Panta is told (`primaryordersubmit`)
→ status / the attribution job follow the signature on chain (`confirmed`, `failed`, or `expired` once the block height
passed the transaction's last valid height) and report every confirmed trade to Panta (`POST /trades/`, idempotent per
signature, `clientOrderId` = the trade id) until Panta answers `processed`. Claims are the same without the order
session. Re-submitting the same trade is harmless; a different signature is `409 TRADE_ALREADY_SUBMITTED`.

**Who needs a session, and why.** Reads and quotes are public (rate-limited per IP): they show public catalog and
chain data, and the page works before a wallet connects. build, submit and claim/build need the SIWS session of the
very wallet that trades (`401` signed out, `403 WALLET_MISMATCH` another wallet): a build spends Panta's scarcest
budget (20 builds a minute for the whole app), so it is tied to a wallet that proved ownership and limited per wallet
(10/min) as well as per IP (30/min); and every attributed trade is linked to a signed-in Epoch wallet. Points-mode
players are signed in already. Our limits: reads 120/min per IP, quotes 20/min per IP. Under them, the client's
`RequestBudget` keeps the whole process within `PANTA_RATE_LIMIT_SHARE` (0.8) of Panta's per-account limits and fails
fast with `429 PANTA_BUSY` rather than queue.

**Geo and eligibility.** `PANTA_BLOCKED_COUNTRIES` (ISO codes) blocks trading (`403 PANTA_GEO_BLOCKED`, details
`country`) for visitors whose country the trusted proxy header names (`PANTA_GEO_HEADERS`: `cf-ipcountry`,
`x-vercel-ip-country`; with any blocklist, Tor exits `T1` too). They can still browse; `access.geoBlocked` tells the
page. Set the headers only behind a proxy that overwrites them. A request no trusted header places is allowed by
default; `PANTA_GEO_FAIL_CLOSED=true` refuses it as well (`403 PANTA_GEO_BLOCKED`, `country: null`, "needs your
region"), so a deployment without a geo-aware proxy cannot trade by mistake. Panta's own restrictions come back as
`403 PANTA_FORBIDDEN` (and `PANTA_CREATE_NOT_PERMITTED`) and are never worked around.

**Errors.** `503 PANTA_NOT_CONFIGURED` (no key) · `503 PANTA_TRADING_DISABLED` · `503 PANTA_AUTH_FAILED` (Panta refused
our key) · `400 CONSENT_REQUIRED` · `400 PANTA_AMOUNT_OUT_OF_RANGE` · `400 TX_INVALID` / `TX_MODIFIED` / `TX_NOT_SIGNED`
/ `TX_REJECTED` (with `reason`, `logs`) · `404 TRADE_NOT_FOUND` · `409 TRADE_ALREADY_SUBMITTED` · `429 PANTA_BUSY` /
`PANTA_RATE_LIMITED` (`retryAfterSeconds`) · `502 PANTA_UNAVAILABLE` / `PANTA_BAD_RESPONSE` / `RPC_UNAVAILABLE`, and
Panta's codes as `PANTA_*`: `AMOUNT_TOO_SMALL`, `INVALID_PARAMS` (details `field`, `fields`), `MARKET_NOT_FOUND`,
`MARKET_CLOSED` (not in primary), `QUOTE_EXPIRED`, `QUOTE_STALE`, `NOT_CLAIMABLE`, `TX_NOT_FOUND`, `TX_FAILED`,
`TX_MISMATCH`, `TX_FEE_MISMATCH`, `FORBIDDEN` (details carry `pantaCode` and `pantaMessage`).

**Crowd forecast** (`Services/Panta/CrowdForecast.ts`, informational). Each of our markets on an epoch is one strike K
(the bot's ladder, `PANTA_STRIKES_PER_EPOCH`). P(index > K) = YES / (YES + NO); a weighted pool-adjacent-violators fit
makes it non-increasing in K (weights grow with volume); a lognormal goes through the fitted points: with two or more
strikes, weighted least squares of Φ⁻¹(1 − p) on ln K gives μ and σ; with one strike (or a flat fit) σ is the index's
own log-change volatility over recent epochs. `median` = e^μ, `expected` = e^(μ + σ²/2), `band` = the 80% interval
e^(μ ± 1.2816σ). Without prices, `reason` says why and the numbers are null.

**Traction** (`stats.traction`). `marketsCreated` = Panta's registered creates for our account; `attributedVolumeUsdc` /
`attributedTrades` / `tradesByKind` = what Panta credits to Epoch; `marketsVolumeUsdc` = all-time volume on our own
markets in Panta's catalog (anyone, any app); `traders` = distinct wallets among Panta's attributed rows and
`panta_trades` (`tradersComplete: false` when Panta holds more rows than it returns); `creatorFeesClaimedUsdc` and
`creationFeesPaidUsdc` from `panta_markets`; `estimatedProtocolFeesUsdc` = our confirmed buy volume × 200 bps, as
Panta's metrics docs suggest. `sources` says which endpoints answered; `asOf` / `stale` as everywhere.

**Fee Index intelligence** (on our markets, labelled `informational`): `impliedProbability` = the YES price;
`modelProbability` = the share of the last `PANTA_MODEL_LOOKBACK_EPOCHS` (30) finished epochs whose index was strictly
above the threshold; `gapPct`; `index.last` (the newest final value, else the computed one) and `index.running` (the
running epoch's median of slot medians so far: unofficial).

### Configuration (`PantaTradingConfigSchema`)

| Variable | Default | Notes |
| --- | --- | --- |
| `PANTA_API_KEY` | — | Secret, `pk_live_…`. Unset: every Panta route answers 503. |
| `PANTA_API_URL` | `https://live-api.panta.market/api/v1` | |
| `PANTA_TRADING_ENABLED` | on when `PANTA_API_KEY` is set | Replaces `PREDICT_REAL_SOL`'s "must be false" (3 Oct 2026). `false`: browse only. |
| `PANTA_BLOCKED_COUNTRIES` | — | e.g. `US,GB` |
| `PANTA_GEO_HEADERS` | `cf-ipcountry,x-vercel-ip-country` | trusted proxy headers, first present wins |
| `PANTA_GEO_FAIL_CLOSED` | `false` | `true`: refuse trades when no trusted header names a country |
| `PANTA_MIN_TRADE_USDC` / `PANTA_MAX_TRADE_USDC` | `1` / `500` | per buy |
| `PANTA_RPC_URL`, `PANTA_RPC_FALLBACK_URL` | `DATA_RPC_URL`, else public mainnet | broadcast and confirmation |
| `PANTA_CACHE_SECONDS` | `15` | catalog freshness |
| `PANTA_STREAM_INTERVAL_SECONDS` | `15` (min 10) | WS polling |
| `PANTA_MODEL_LOOKBACK_EPOCHS` | `30` | informational model |
| `PANTA_ATTRIBUTION_INTERVAL_SECONDS` | `30` | the attribution job |
| `PANTA_RATE_LIMIT_SHARE` | `0.8` | of Panta's per-account limits (the bot takes `PANTA_BOT_RATE_LIMIT_SHARE`, 0.2) |
| `PANTA_TIMEOUT_MS` | `10000` | per Panta request |
| `PANTA_METHODOLOGY_URL` | the repo's `docs/FEE_INDEX_METHODOLOGY.md` | in `GET /v1/index/epochs/:epoch` |

Trading needs Postgres (`panta_trades`); without `DATABASE_URL` build, submit, status and stats answer
`503 DATABASE_NOT_CONFIGURED`.

## Launch: revenue tokens on Meteora

Request #22 (handover `pages/launch.md`, ADR 0006, plan F13). A validator sells a fixed share of its commission for a
fixed term as a token on a Meteora Dynamic Bonding Curve with Epoch as the partner; at the raise target it graduates to
a DAMM v2 pool. The launches come from a **registry file** (`LAUNCHES_PATH`, appended by the launch script in
[`packages/meteora/scripts`](../meteora/scripts/README.md)), and every pool read goes through
[`@epoch/meteora`](../meteora/README.md) on the launch cluster. Once the validator's operator registered a token with the
Epoch program (`register_revenue_token`), its terms, escrow and buybacks are the program's: `page.revenueToken` (below)
and `GET /v1/launches/:mint/buybacks`. Nothing here is an offer.

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
- **Escrow:** the SOL balance of the registry's `escrow` (the program's escrow PDA, rent included); `mode` is `buyback`,
  12 slices an epoch. `buybacks` stays `[]`: the program's buybacks are on `GET /v1/launches/:mint/buybacks`.
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
| `creator`, `feeClaimer`, `leftoverReceiver`, `signatures`         | Optional, written by the launch script: the pool creator (validator), the DBC partner (the program's treasury PDA), the leftover receiver, the launch transactions (and `registerRevenueToken`). |
| `programId`, `revenueToken`, `registeredEpoch`                    | Optional, written by the launch and register scripts: the Epoch program, its `RevenueToken` PDA, and the epoch of `register_revenue_token` (null until registered). |

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

### The Launch page (plan F13)

The page's live data, on top of the launch board above; the contract for the frontend, with examples, states and the
signing flow, is [docs/pages/launch.md](../../docs/pages/launch.md). Code: `Routes/LaunchPageRouters.ts` (mounted on
`/v1/launches` next to `launchRouter`), `Services/Launch/LaunchPageService.ts`, wiring in `Services/Launch/LaunchLive.ts`.

- **Trade feed.** `LaunchTradeIngester` reads each launch pool's transactions (`getSignaturesForAddress`, then
  `getTransaction` in JSON encoding, any version) every `LAUNCH_TRADES_POLL_SECONDS`: first the newest
  `LAUNCH_TRADES_BACKFILL_LIMIT` per pool, then everything after the pool's cursor (`indexer_cursors`,
  `launch_trades:<pool>`), oldest first. `@epoch/meteora` decodes the Anchor CPI events (DBC `EvtSwap2`, DAMM v2
  `EvtSwap2`, claims, `EvtCurveComplete`, `EvtInitializePool`) into `launch_trades` and `launch_fee_events` (Postgres;
  memory without `DATABASE_URL`). A graduation adds the DAMM v2 pool to the watch list. HTTP 429 backs off up to a
  minute; a transaction the node lists but cannot return holds the cursor for three polls; a cursor whose transaction
  the node no longer has (trimmed history) is read back to its slot. New rows go out on WS `launch:<mint>`. Run one
  ingester per database (`LAUNCH_TRADES_INGEST=false` on other replicas).
- **Realtime feed** (`Services/Launch/LaunchRealtime.ts`, `LAUNCH_REALTIME`). Each pool's transactions are pushed as
  they confirm, decoded with the same decoder and deduped on (signature, ix) with the polling, which stays as the
  backstop (every `LAUNCH_TRADES_BACKSTOP_SECONDS` while the push is healthy, `LAUNCH_TRADES_POLL_SECONDS` when it is
  down).
  - Mainnet launches with `SOLAMI_TOKEN` use a Yellowstone gRPC transaction subscription (`accountInclude` = the
    launch pools; RPC Fast as failover) through `@epoch/solana`'s `GrpcStream`.
  - Otherwise the launch RPC's websocket: `logsSubscribe` per pool, then `getTransaction`.
  - `/page` and `/trades` report it in `ingest.mode`, `lagSeconds` and `pollSeconds`.
- **Market** (`/market`): a fresh read of the curve and the DAMM v2 pool, cached `LAUNCH_MARKET_CACHE_SECONDS` and
  dropped on every new trade; venue, price (SOL and USD), fully diluted market cap, raise progress, liquidity,
  graduation state, implied yield per epoch (live share revenue ÷ market cap, never annualised) next to the share
  revenue the curve was priced at, and 24-hour stats from the feed.
- **Candles** (`/candles`): OHLC bucketed in SQL from `launch_trades` (1m to 1d, at most 1,000), empty buckets flat at
  the previous close; `launch_price_samples` before the first trade.
- **Holders** (`/holders`): `getTokenLargestAccounts` and the accounts' owners, labelled (curve vault, DAMM v2 pool,
  buyback escrow, Epoch's treasury PDA, leftover receiver, pool creator); kept 2 minutes, or read again on the next
  request after a trade or claim (at most every 5 s).
- **Fees** (`/fees`): partner (the treasury PDA), creator, LP position and leftover from the pools' state
  (`readLaunchClaims`), what is pending and claimed for lenders, and the claim history from `launch_fee_events`.
- **Ticket** (`/quote`, `/build`): quotes and unsigned transactions on the curve or, after graduation, DAMM v2;
  `build` needs `consent: true` and the signing wallet as `owner`; buys above `LAUNCH_TRADE_MAX_SOL` are refused;
  `LAUNCH_TRADE_REQUESTS_PER_MINUTE` per IP.
- **Revenue token** (`page.revenueToken`, `Services/Launch/RevenueTokenSource.ts`): the program's `RevenueToken` at
  `["revenue_token", vote]`, decoded with `@epoch/epoch-sdk`, and the escrow's balance above rent at `["buyback", vote]`,
  both read on the program's cluster (`EPOCH_PROGRAM_ID`, `EPOCH_CLUSTER`, `EPOCH_RPC_URL`) and reused for 10 s.
  - `source: "program"` gives the term, the commission floors, the buyback settings and lifetime totals.
  - Otherwise it is the registry's terms (`source: "registry"`), with a `note`. That happens when no program id is set,
    the launch has no vote account, the token is not registered (or the vote account registered another mint), or the
    read fails; a failed read is not cached.
- Every block says when it was read (`freshness`) and whether that is older than `LAUNCH_STALE_SECONDS`.

**Configuration** (`LaunchPageConfigSchema`; the cluster, RPC and registry come from `LaunchConfigSchema` above)

| Variable                           | Default | Notes                                                                 |
| ---------------------------------- | ------- | --------------------------------------------------------------------- |
| `LAUNCH_TRADES_INGEST`             | `true`  | Read the pools into `launch_trades` in this process (needs `LAUNCHES_PATH`). |
| `LAUNCH_TRADES_POLL_SECONDS`       | `10`    | 2–600.                                                                |
| `LAUNCH_REALTIME`                  | `auto`  | `grpc` (Solami; mainnet launches), `websocket`, `auto` (gRPC when usable, else websocket) or `off` (polling only). |
| `LAUNCH_RPC_WS_URL`                | derived | The launch RPC's websocket; unset = from `LAUNCH_RPC_URL`.            |
| `LAUNCH_TRADES_BACKSTOP_SECONDS`   | `60`    | 10–600: the polling interval while the realtime feed is healthy.      |
| `LAUNCH_TRADES_BACKFILL_LIMIT`     | `1000`  | Per pool on a first start; 0 = from the newest transaction on.        |
| `LAUNCH_MARKET_CACHE_SECONDS`      | `10`    |                                                                       |
| `LAUNCH_STALE_SECONDS`             | `120`   | Older reads are flagged `stale`.                                      |
| `LAUNCH_TRADE_MAX_SOL`             | `10`    | Largest buy `/build` and `/quote` accept.                             |
| `LAUNCH_TRADE_REQUESTS_PER_MINUTE` | `30`    | Quotes and builds per IP.                                             |
| `LAUNCH_TRADE_PRIORITY_MICROLAMPORTS` | `100000` | 0–10,000,000: the compute-unit price `/build` sets (200,000-unit limit; `priorityFeeSol` in the response). |
| `LAUNCH_INDEXED_DATA`              | `auto`  | Meteora's DAMM v2 data API for graduated pools (`market.indexed`, `/indexed`): `auto` (mainnet only, as the API indexes mainnet), `on`, `off`. |
| `LAUNCH_DAMM_DATA_API_URL`         | `https://damm-v2.datapi.meteora.ag` | Read through `@epoch/meteora` `DammDataApi`, cached 60 s (protocol totals 5 min); 10 requests a second at most. |

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

## Live: the Fee Index streamed from mainnet (Solami Track)

`indexer_app` computes the Solana Fee Index live from mainnet blocks streamed through Solami and writes it to Postgres
(`live_slots`, `slot_fees`, `fee_index_live`, `epoch_stakes`, `epoch_index`), announcing each committed write with
`NOTIFY epoch_live`. The API reads those tables and LISTENs on a dedicated connection (reconnecting with backoff). The
page contract, with example responses and the loading, empty, stale and error states, is
[`docs/pages/live.md`](../../docs/pages/live.md); the methodology is in
[`packages/indexer_app/README.md`](../indexer_app/README.md).

| Endpoint | Query | Returns | Cache |
| --- | --- | --- | --- |
| `GET /v1/live/summary` | — | `LiveSummary`: live flag, data source, stream health, tip / processed slot / lag, epoch progress, running estimate, last final value, fee composition of this epoch and the last (`fees`, `lastEpochFees`: base, priority, Jito tips, rewards, shares) | no-store |
| `GET /v1/live/slots` | `limit` 1–500 (60) | the newest blocks with median, p25/p75/p90, priced / unpriced / leader-paid / failed counts and `fees` (base, priority, Jito tips, reward; null before fees were recorded) | no-store |
| `GET /v1/live/leaders` | `epoch` (current), `limit` 1–5,000 (200) | per-leader median, slots, stake, weight, rank, and the leader whose median is the index | 5 s (10 s server) |
| `GET /v1/live/epochs/:epoch/distribution` | — | log-bucket histogram and percentiles of the epoch's slot medians, index marker | 5 s (10 s server) |
| `GET /v1/live/solami` | — | what Epoch uses of Solami, per component (indexer, api, publisher, cranks): gRPC streams (status, bytes, lag), RPC calls by method (p50/p95, errors, rate limits), Beam sends (landed, tips spent), the last error | no-store |

All five answer `503 DATABASE_NOT_CONFIGURED` without `DATABASE_URL`. Data is never presented as live when it is not:
`live` is true only while the indexer has processed a slot within `LIVE_STALE_AFTER_SECONDS` (default 20); otherwise
the last known state is served with `live: false` and `asOf` = when it was written. Types: `src/types/Live.types.ts`.

WS `/v1/stream` gains two channels, listed in `hello` when the API has a database:

| Channel | `data` | When |
| --- | --- | --- |
| `slots` | one `LiveSlot` (as in `/v1/live/slots`, with the leader's name) | each block processed live; nothing on subscribe |
| `index:live` | the whole `LiveSummary` | on subscribe, on each estimate write (at most 1 per second), at once on an epoch rollup and after a LISTEN reconnect |

| Variable | Default | Meaning |
| --- | --- | --- |
| `LIVE_STALE_AFTER_SECONDS` | `20` | older data is served with `live: false` |
| `LIVE_FEED_ENABLED` | `true` | LISTEN for the indexer's feed (needs `DATABASE_URL`) |
| `SOLAMI_TOKEN`, `SOLAMI_GRPC_URL`, `SOLAMI_GRPC_COMPRESSION` | unset, `grpc.solami.dev`, `none` | the API's own Solami stream: confirmed slots for the `slot` channel and, on mainnet, the program's transactions (one plan stream; Pro includes two: one for indexer_app, one here) |
| `SOLAMI_API_STREAM` | `true` | `false`: poll slots and use `logsSubscribe` even with a key |
| `SOLAMI_USAGE_STALE_SECONDS` | `120` | `GET /v1/live/solami` marks a component whose counters are older as stale (`offline`) |

The usage report comes from `solami_usage` (one row per component, rewritten every 10–30 s by indexer_app,
publisher_app and cranks_app from `@epoch/solana`'s `SolamiUsage` counters) plus this process's own counters (its
gRPC stream and every JSON-RPC call through `Lib/Http.ts`). Hosts are kept, keys never are.

## India page (Superteam India track)

Built in `Services/India/` (`getIndiaServices()`) on the mainnet services of `getServices()`, mounted at `/v1/india` in
`src/index.ts`. Public data, no sign-in, no database. The page contract (example responses, loading / empty / stale /
error states, copy) is `docs/pages/india.md`; response types are `src/types/India.types.ts`. Rupee amounts come as
`{ inr, formatted, compact }`: `₹1,23,45,678.90` in the Indian numbering system and `₹1.23 Cr` / `₹45.60 L`
(`Lib/Inr.ts`).

| Method and path                                         | Returns                     | Cache                                  | Data                                                                   |
| ------------------------------------------------------- | --------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| `GET /v1/india/summary`                                 | `IndiaSummary`              | 30 s                                   | the validator table, Stakewiz, validator profiles, the live price      |
| `GET /v1/india/price?days=0`                            | `IndiaPrice`                | 15 s (read once a minute)              | CoinGecko, else Jupiter × USD/INR; `days` adds CoinGecko daily prices  |
| `GET /v1/india/validators?…` (the `/v1/validators` query without `country`) | `IndiaValidatorList` | 30 s (built every 2 min) | as `/summary`                                         |
| `GET /v1/india/wallets/:address/rewards?fy=2026-27`     | `IndiaWalletRewards`        | 60 s once complete (kept 10 min)       | mainnet `getInflationReward`, Stakewiz epoch times, daily SOL/INR      |
| `GET /v1/india/wallets/:address/rewards.csv?fy=2026-27` | `text/csv` (UTF-8 with BOM) | 60 s                                   | as `/rewards`                                                          |

**How the figures are computed**

- **Live SOL/INR** (`InrPriceService`): CoinGecko `simple/price?vs_currencies=inr`, read at most once a minute. When it
  fails, or its `last_updated_at` is over 15 minutes old, Jupiter SOL/USD × USD/INR from MarketData's caches. When
  every source fails the last price is served with `stale: true` and a `staleReason` (sources are retried after 15 s);
  503 `PRICE_UNAVAILABLE` only before any source has answered. A CoinGecko HTTP 429 pauses CoinGecko until its
  `x-ratelimit-reset` (or `retry-after`); the free tier is about 30 calls a minute per IP.
- **Daily SOL/INR** (for past epochs): CoinGecko `market_chart?vs_currency=inr&days=365&interval=daily` (00:00 UTC
  points, re-read hourly). Days CoinGecko's free tier cannot serve (over 365 days ago), or all days while it is down:
  Binance's daily SOL/USDT open × the ECB's USD/INR rate of that day or the business day before (Frankfurter). An
  epoch is priced at the daily point nearest its end, within 36 hours; on 4 Oct 2025 the two sources differed by 0.04%.
- **Validators hosted in India**: rows of the validator table with `countryCode` `IN` (Stakewiz IP geolocation), plus
  `INDIA_VALIDATOR_VOTES` (operator-declared, `inIndiaBy: 'listed'`). India's share of validators and stake, its rank,
  cities (Stakewiz `ip_city`, `Unknown` when missing) and the country comparison (top ten, India, Singapore / UAE /
  Hong Kong / Japan) count geolocated validators only. When the table has no Stakewiz data, India's figures are
  `null` and `status` is `unknown`, never zero. On 3 Oct 2026 Stakewiz placed none of 683 staked validators in India.
- **Revenue and Epoch advance** per Indian validator: its profile's figures (`/v1/validators/:vote`: the vote account's
  inflation reward, Jito Kobe tips commission, block fees, vote fees; `creditEstimate` with the planned Pool
  parameters) when the profile answers within 8 s, else the table's rates (`basis: 'table-estimate'`, same formulas as
  "SOL kept per epoch"). Revenue is priced at the day its epoch ended, the advance at the live price. Always labelled
  an estimate.
- **Start a validator in India** (`prospect`): 50,000 / 150,000 / 500,000 SOL at 5% commission and 5% MEV commission,
  the median tips APY, blocks in proportion to stake, minus vote fees; advance = 25% (40% hedged) of 10 epochs of
  inflation + tips commission. Break-even as `/v1/network`.
- **Rewards by financial year** (`IndiaRewardsService`): the wallet's stake accounts as staker or withdrawer (the 100
  largest delegated, as My Stake), then `getInflationReward` for every finished epoch whose end (Stakewiz
  `all_epochs_history`: the next epoch's start) falls between 1 April 00:00 IST and the next 1 April, newest first,
  three calls at a time per wallet and `INDIA_RPC_CONCURRENCY` across wallets, in its own InflationRewards cache. The
  first request waits up to 8 s; then `status` is `loading` / `partial` with `retryAfterSeconds` and polls answer at
  once. `incomplete` = finished with unreadable epochs (listed; retried after a minute). On the public RPC a year
  (100–200 epochs) takes one to four minutes. Totals are the sum of the rows as shown (rounded to paise); months are
  IST calendar months. Only protocol staking rewards are counted: Jito MEV tips claimed into stake accounts,
  liquid-staking tokens and stake accounts closed before today are not, which the disclaimer says.
- **CSV**: one row per epoch with a reward (IST time, FY, SOL, price, price date and source, ₹), a total row, then the
  wallet, year, status, notes and the disclaimer; UTF-8 BOM, CRLF, `Content-Disposition: attachment`. 503
  `REWARDS_LOADING` until the year is read.

Limits per IP: `/rewards` 60 a minute, `/rewards.csv` 10 a minute, 20 new wallet-years an hour (429
`TOO_MANY_REQUESTS` with `retryAfterSeconds`); 25 wallet-years loading at once (503 `BUSY`). Errors: 400 `BAD_REQUEST`
(address or `fy` outside 2020-21 to the current year), 502 `CHAIN_ERROR` (stake accounts unreadable), 503
`EPOCH_TIMES_UNAVAILABLE` (Stakewiz epoch times never loaded).

**Configuration** (`IndiaConfigSchema` in `@epoch/config-sdk`; RPC, Stakewiz, Jupiter and USD/INR from
`MarketDataConfigSchema`)

| Variable                     | Default                                          | Notes                                                                                     |
| ---------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `COINGECKO_API_URL`          | `https://api.coingecko.com/api/v3`               | `https://pro-api.coingecko.com/api/v3` with a paid key (full history).                    |
| `COINGECKO_API_KEY`          | —                                                | Optional; sent only when set, in a header (`x-cg-demo-api-key`, or `x-cg-pro-api-key` on pro-api). |
| `INDIA_SOL_USD_HISTORY_URL`  | `https://data-api.binance.vision/api/v3/klines`  | Daily SOL/USDT for days CoinGecko cannot serve.                                           |
| `INDIA_FX_HISTORY_URL`       | `https://api.frankfurter.dev/v1`                 | Daily USD/INR (ECB) for those days.                                                       |
| `INDIA_VALIDATOR_VOTES`      | —                                                | Comma list of vote accounts to list as Indian validators (operator-declared).             |
| `INDIA_REWARDS_PER_MINUTE`   | `60`                                             | Per IP, `/rewards`.                                                                       |
| `INDIA_CSV_PER_MINUTE`       | `10`                                             | Per IP, `/rewards.csv`.                                                                   |
| `INDIA_NEW_WALLETS_PER_HOUR` | `20`                                             | Per IP, new wallet-years (each is 100–200 RPC calls).                                     |
| `INDIA_RPC_CONCURRENCY`      | `3`                                              | `getInflationReward` calls in flight across all wallet reads.                             |
