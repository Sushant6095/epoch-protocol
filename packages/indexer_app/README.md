# indexer_app

The **Solana Fee Index, computed live from mainnet blocks streamed through Solami.** Every confirmed block's
non-vote transactions arrive over Solami's Yellowstone gRPC; each slot's median priority fee (µL/CU) is written to
Postgres within about a second, the current epoch's running index is updated every 2 seconds, and when an epoch ends
its final value goes to `epoch_index`, which `publisher_app` posts on-chain. The Terminal's Live page reads it through
`api_app` (`/v1/live`, WS `slots` and `index:live`; page contract in [`docs/pages/live.md`](../../docs/pages/live.md)).

```mermaid
flowchart LR
  subgraph SOLAMI["Solami"]
    G["Yellowstone gRPC<br/>grpc.solami.dev · x-token"]
    R["RPC<br/>rpc.solami.dev/sol?api_key="]
    B["Beam over HTTP<br/>sendTransaction + tip"]
  end
  G -- "firehose: non-vote txs + block meta + slots<br/>confirmed · from_slot replay" --> SS["SlotStream"]
  R -- "getBlock: gap fill, hybrid, rpc<br/>getSlotLeaders · getVoteAccounts" --> SS
  SS --> BF["BlockFees<br/>slot median · leader-paid out"]
  BF --> ET["EpochTracker<br/>running stake-weighted median"]
  BF -- "one transaction: slot_fees + live_slots<br/>+ cursor + NOTIFY epoch_live" --> PG[("Postgres")]
  ET -- "fee_index_live + NOTIFY, every 2 s" --> PG
  SS -- "epoch fully covered → rollup" --> EI["epoch_index"]
  PG -- "LISTEN epoch_live" --> API["api_app<br/>/v1/live · WS slots, index:live"]
  API --> UI["Terminal · Live page"]
  EI --> PUB["publisher_app · post_index"]
  PUB -. "mainnet, SOLAMI_BEAM_URL" .-> B
  CR["cranks_app · every send"] -. "mainnet, SOLAMI_BEAM_URL" .-> B
  G -- "confirmed slots + program txs" --> API
  SS & API & PUB & CR -. "usage counters" .-> U["solami_usage → GET /v1/live/solami"]

  classDef solami fill:#ffd8a8,stroke:#e8590c,color:#1b1b1b
  classDef ours fill:#a5d8ff,stroke:#1971c2,color:#1b1b1b
  class G,R,B solami
  class SS,BF,ET,EI,API,PUB,CR,U ours
```

## Run it with your own Solami key

1. **Sign up** at <https://solami.dev/signup?ref=st-earn-sep-26>. In the dashboard, **API keys → create a Standard
   key**: one key works for RPC (`?api_key=`) and gRPC (`x-token`). gRPC comes with the Pro plan ($99/month: two
   streams, 200 RPC requests per second, per `api.solami.dev/pricing` on 5 Oct 2026), with gRPC pay-as-you-go, or as a
   standalone stream ($10/day); Solami's llms.txt mentions a 2-day gRPC trial. Two streams fit exactly: one for
   indexer_app, one for api_app (its `slot` channel and program events).
2. **For the full gRPC firehose** (`SLOT_SOURCE=grpc`), turn on **gRPC pay-as-you-go** on the dashboard's
   Pay-as-you-go page (prepaid balance, minimum $5). Plan-included streams refuse unscoped transaction filters
   ("firehose"); without PAYG the indexer detects the refusal and runs `hybrid` (block meta over gRPC, each block over
   Solami RPC), which needs nothing beyond the plan. See [cost](#bandwidth-and-cost) before leaving it running.
3. **Configure** `.env` at the repo root (never commit it):

   ```bash
   SOLAMI_TOKEN=<your key>                                   # gRPC x-token
   SOLAMI_RPC_URL=https://rpc.solami.dev/sol?api_key=<your key>
   SLOT_SOURCE=auto                                          # grpc → hybrid if the firehose is refused
   DATABASE_URL=postgres://epoch:epoch@localhost:5432/epoch
   INDEXER_BACKFILL_EPOCH=true                               # optional: complete the current epoch from its first slot
   GAP_FILL_RPS=30                                           # backfill speed: ~200k slots in ~2 h (Pro: 200 RPS)
   SOLAMI_BEAM_URL=https://rpc.solami.dev/sol?api_key=<your key>   # optional: mainnet sends through Beam
   ```

4. **Install, build, migrate, check, run:**

   ```bash
   pnpm install && pnpm build
   pnpm db:up && pnpm db:migrate          # local Postgres (docker) and the tables
   pnpm solami:check                      # read-only key check (below); never prints a key
   node packages/indexer_app/dist/index.js        # or: pm2 start pm2.config.js --only epoch-indexer
   node packages/api_app/dist/index.js            # /v1/live and WS /v1/stream on :4000
   curl -s localhost:4000/v1/live/summary | jq '.data | {live, dataSource, processedSlot, lagSlots, estimate}'
   curl -s localhost:4000/v1/live/solami | jq '.data | {inUse, grpc, beamTotals, lastError}'
   pnpm demo:solami                       # the stream in a terminal (in memory, next to the indexer)
   ```

## Demo (2–3 minutes)

`pnpm demo:solami [--seconds 180] [--every 3] [--stride N]` runs the same pipeline in memory (it never writes to
Postgres, so it can run next to indexer_app) and prints, every few seconds: the source and lag, the newest block's
median and counts, the epoch's running Fee Index, and what was used of Solami (gRPC bytes, RPC calls with p50/p95,
errors). Without a key it polls public RPC, one slot in four, so it works anywhere.

1. **0:00 The problem (20 s).** Validators earn priority fees, but nobody can price them: there is no reference rate.
   Epoch's Solana Fee Index is that rate, computed from every mainnet block and posted on-chain each epoch.
2. **0:20 Solami is the data path (40 s).** `pnpm solami:check`: the key, the gRPC replay window, block metas timed
   against RPC, the firehose's measured MiB/s and $/day, Beam's tip addresses and HTTP endpoint. Then
   `pnpm demo:solami`: blocks arrive over Yellowstone gRPC; each line shows the slot's median, the transactions left
   out (unpriced, leader-paid) and the running index moving.
3. **1:00 The product (50 s).** The Terminal's Live page: the slot strip filling block by block (WS `slots`), the big
   number (`index:live`), the leaders table (who sets the index), the distribution, and the slot ticker (`slot`,
   `"source": "grpc"`). Kill the indexer for 20 s: the badge goes grey ("never presents stale data as live"), then
   it reconnects with `from_slot` and fills the gap.
4. **1:50 Proof of use (30 s).** `curl /v1/live/solami`: gRPC streaming with bytes and lag, `rpc.solami.dev` calls by
   method with p50/p95, Beam sends with landings and tips (publisher `post_index` on mainnet), the last error.
5. **2:20 Close (20 s).** The epoch's value goes to `epoch_index`, `publisher_app` posts it through Beam, and
   validators borrow against it in the Epoch program.

## Verify

`pnpm solami:check` (`node packages/indexer_app/dist/solami-check.js [--slots 20] [--firehose-seconds 5]`) checks, with
the keys from the environment, and prints a pass/fail table:

| Check | What it does | PASS means |
| --- | --- | --- |
| `rpc` | `getVersion`, `getSlot`, `getEpochInfo` on `SOLAMI_RPC_URL` | the RPC key works; latencies printed |
| `grpc endpoint` | gRPC `GetVersion`, `SubscribeReplayInfo`, `GetSlot` | the endpoint answers; shows the `from_slot` replay window (≈ 3,000 slots, 20 min, on 3 Oct 2026). These calls need no key |
| `grpc key` | subscribes to block meta for N slots and times each against RPC `getSlot('confirmed')` | the `x-token` key streams; how many ms gRPC is ahead of RPC |
| `grpc firehose` | the indexer's own firehose request for a few seconds | PASS: your key may run `SLOT_SOURCE=grpc`, with measured MiB/s, GiB/day and $/day at the live PAYG price (`api.solami.dev/pricing`); WARN: refused on a plan stream, the indexer will use `hybrid` |
| `beam tips` | `GET api.solami.dev/onchain/tip-addresses` (no auth) | the live list (15 addresses on 5 Oct 2026), and how many of the 10 pinned from Solami's SDK are still in it |
| `beam http` | a JSON-RPC `getHealth` to `SOLAMI_BEAM_URL` (or, unset, to `beam-http.solami.dev` from llms.txt) | the Beam endpoint answers; a configured one that refuses the key FAILs. Nothing is sent |
| `beam landing` | `GET api.solami.dev/swqos/tx/<a signature it never saw>` | the landing lookup answers (404), as senders use after each Beam send |

`--compression zstd` (or `SOLAMI_GRPC_COMPRESSION`) runs the gRPC checks over a compressed channel: grpc.solami.dev
accepted zstd and gzip for GetVersion, SubscribeReplayInfo and GetSlot on 5 Oct 2026. Without a valid key the endpoint
check still passes and the key check fails with Solami's own message (`"invalid api key"`) and what to change. Once running: `indexer_app` logs `indexer ready`, then `new epoch` / `epoch rolled up`;
`select * from fee_index_live` shows the running estimate; `/v1/live/summary` says `"live": true`.

## Methodology (Fee Index v1)

The index is defined in [`src/Processors/FeeProcessor.ts`](src/Processors/FeeProcessor.ts) and
[`src/Blocks/BlockFees.ts`](src/Blocks/BlockFees.ts); `publisher_app` hashes the per-slot results (`slot_fees`) into the
`inputs_hash` it posts with each value ([publisher README](../publisher_app/README.md#inputs-hash)).

| Step | Rule |
| --- | --- |
| Transactions | Every transaction of the slot's confirmed block except **simple vote transactions** (Agave's definition, which is also Yellowstone's `isVote`: legacy, < 3 signatures, one instruction, on the vote program). **Failed transactions are included**: they paid their priority fee to the leader, which is what the index tracks. |
| Leader-paid | Transactions whose fee payer (account key 0) is the slot leader's identity are left out: a leader cannot set its own slots' median. They are real: one in about half of the 99 blocks sampled on 3 Oct 2026. |
| Price (µL/CU) | legacy and v0: the ComputeBudget `SetComputeUnitPrice` instruction (data = `03` + u64 LE price, invoked from a static account key; two of them make the runtime reject the transaction). **v1 transactions (SIMD-0385)** carry the *total* priority fee in lamports and the compute-unit limit in the message, and the runtime ignores their ComputeBudget instructions: price = ⌊fee × 10⁶ ÷ limit⌋. |
| Unpriced | Transactions without a positive price (no instruction, an explicit 0, a v1 transaction with no fee or a zero limit, or under 1 µL/CU) are left out of the median and counted (`unpricedTxs`). A third or more of non-vote transactions set no price (34% over 99 sampled blocks, 43% in the recorded block 452,937,393); counting them as 0 drags the median toward 0 (slot 452,935,957: 7,760 µL/CU over priced transactions, 655 with zeros) and would measure how many senders skip the fee rather than what priority costs. |
| Slot | Median of the priced prices (⌊(a + b) ÷ 2⌋ for an even count) → `slot_fees.median_cu_price`, `tx_count` = transactions in the median. A slot without a priced transaction gets no row. |
| Leader | Median of the leader's slot medians in the epoch (same rule). |
| Epoch | **Stake-weighted median** of the leader medians, weights = each leader identity's activated stake from `getVoteAccounts`, snapshotted while the epoch runs (`epoch_stakes`). Leaders without stake weigh nothing. |
| Leader of a slot | The cluster leader schedule (`getSlotLeaders`, 4,000-slot chunks, cached); the block's Fee reward is the fallback, mapped from a vote account to its identity when the block-revenue collector was redirected (SIMD-0232). |
| Completeness | `epoch_index` is written only for an epoch whose every slot is accounted for: indexed, confirmed skipped, or given up after 20 failed fetches (logged as lost). A value already posted on-chain is never rewritten. The running estimate (`fee_index_live`) is never posted. |

Measured on mainnet (epoch 1048): in slot 452,935,957, 180 of the 1,077 transactions were v1 and v1 carried 52% of
the priced transactions. That is why the stream cannot be scoped to the ComputeBudget program.

## Data sources (`SLOT_SOURCE`)

| Mode | gRPC request (`src/Streams/SlotRequest.ts`) | Block contents | Needs |
| --- | --- | --- | --- |
| `grpc` | `transactions: { fees: { vote: false } }` (failed included), `blocksMeta`, `slots` (all statuses, for the tip), commitment `confirmed`, `fromSlot` on reconnect | the firehose: a slot's transactions arrive, then its block meta closes it | Solami gRPC PAYG (or a firehose allowance) |
| `hybrid` | `blocksMeta` + `slots` only | Solami RPC `getBlock` per block, as each block meta confirms it | the Pro plan |
| `rpc` | none | `getSlot` polling + `getBlock` | any RPC; the documented fallback |
| `auto` (default) | `grpc`; on Solami's firehose refusal → `hybrid`; on a refused key → `rpc`; without `SOLAMI_TOKEN` → `rpc` | | |

`RPC_SLOT_STRIDE=N` (rpc mode only) samples one slot in N, for demos on public RPC: the estimate is marked
`sampled`, nothing is gap-filled and no final value is written.

**Cursor, replay and gaps.** `indexer_cursors` keeps the contiguous run (`slot_stream` = every slot up to here is done,
`slot_stream_start` = where the run began). A reconnect resubscribes with `fromSlot` = the next slot when the endpoint
can still replay it (`SubscribeReplayInfo`; Solami keeps about 3,000 slots), otherwise live; any slot the live source
did not deliver, and anything below where it started, is fetched by the **gap filler** over RPC (`GAP_FILL_RPS`,
`GAP_FILL_CONCURRENCY`). Live `getBlock` calls (`hybrid`, `rpc`) have their own budget (20 per second, 8 in flight),
so a long gap fill never delays the newest blocks. A restart rolls up again only the epoch just before the one its
cursor ended in (a crash may have come between that epoch's last batch and its rollup), never every epoch since the
run began. Skipped slots come from each block's parent slot (or `-32007`/`-32009` from RPC). Lag is
logged and exposed: `processedSlot`, `tipSlot` (from the stream's slot statuses) and the watermark in
`fee_index_live`, and `lagSlots` in `/v1/live/summary`.

## Bandwidth and cost

Solami bills PAYG gRPC per byte received ($0.08/GB, live at `api.solami.dev/pricing`). Per-block sizes below were
measured by encoding four real mainnet blocks (3 Oct 2026, epoch 1048, 886–1,077 transactions each) into the
`SubscribeUpdate` messages each request would deliver (decoded protobuf bytes; compression not counted). At ~205,000
blocks a day:

| Request | Bytes per block (avg) | GiB/day | PAYG $/day | Verdict |
| --- | --- | --- | --- | --- |
| **`transactions(vote: false)` + `blocksMeta` + `slots`** (used) | 1.41 MB | ≈ 270 | ≈ $21 (≈ $43 per epoch) | every priced transaction |
| same with `failed: false` | 1.07 MB | ≈ 205 | ≈ $16 | drops fees leaders were paid |
| `transactions` with `account_include: [ComputeBudget]` | 0.90 MB | ≈ 172 | ≈ $14 | misses v1 transactions: wrong index |
| `blocks` with transactions | 1.80 MB | ≈ 344 | ≈ $28 | also carries every vote |
| `blocksMeta` + `slots` (`hybrid`) | ~0.2 KB | < 0.1 | ≈ $0 | plus one `getBlock` per block on Solami RPC (≈ 2.4 per second, within the Pro plan's 200 RPS) |

Transaction metadata (logs, balances, inner instructions) is most of each message and Yellowstone cannot strip it.
Ways to spend less: run `grpc` only while you demo (a reconnect within ~20 minutes replays the gap from `from_slot`;
anything older is gap-filled over RPC), use `hybrid` for long runs, or try `SOLAMI_GRPC_COMPRESSION=zstd`
(accepted by grpc.solami.dev on 5 Oct 2026; whether billing counts compressed bytes is not documented, so compare
`GET /auth/grpc-usage` in the dashboard). `pnpm solami:check` measures the real rate on your key, and
`GET /v1/live/solami` shows the bytes each stream received.

## Configuration (`IndexerConfigSchema` in `@epoch/config-sdk`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SOLAMI_GRPC_URL` | `https://grpc.solami.dev` | Yellowstone endpoint (`grpc.solami.dev:443` also accepted; a region: `https://fra.grpc.solami.dev`) |
| `SOLAMI_TOKEN` | — | Solami key, sent as the `x-token` header. Unset: `auto` uses RPC polling |
| `RPC_FAST_GRPC_URL`, `RPC_FAST_TOKEN` | — | optional failover stream, tried only after Solami fails |
| `SOLAMI_RPC_URL` | — | `https://rpc.solami.dev/sol?api_key=<key>`: gap fill, leader schedule, stake snapshots, `hybrid` and `rpc` blocks |
| `DATA_RPC_URL` | public mainnet | used instead of `SOLAMI_RPC_URL` when that is unset (rate-limited) |
| `SLOT_SOURCE` | `auto` | `auto`, `grpc`, `hybrid`, `rpc` (above) |
| `SOLAMI_GRPC_COMPRESSION` | `none` | `zstd` or `gzip` to compress the stream |
| `GAP_FILL_RPS` / `GAP_FILL_CONCURRENCY` | `8` / `4` | RPC `getBlock` rate and parallelism (gap fill and the `hybrid`/`rpc` sources) |
| `GAP_FILL_MAX_SLOTS` | `432000` | a saved cursor further behind than this starts a new run instead of filling the gap |
| `INDEXER_BACKFILL_EPOCH` | `false` | on a fresh start, begin at the current epoch's first slot so that epoch gets a final value |
| `RPC_POLL_MS` | `400` | `rpc` mode: how often to read the confirmed slot |
| `RPC_SLOT_STRIDE` | `1` | `rpc` mode: sample one slot in N (no final values) |
| `LIVE_INDEX_INTERVAL_MS` | `2000` | how often `fee_index_live` is written and announced |
| `LIVE_SLOTS_KEEP` | `20000` | rows kept in `live_slots` (≈ 2 hours) |
| `DATABASE_URL`, `DATABASE_POOL_SIZE` | — / `10` | Postgres (required) |
| `LOG_LEVEL` | `info` | `debug` adds a heartbeat with lag and gap counts |

Keys are read from the environment only and never logged; RPC URLs are logged by host.

## Tables

| Table | Written | Read by |
| --- | --- | --- |
| `slot_fees` | per slot with priced transactions: median, leader, count | rollup, publisher (inputs hash), `/v1/live/leaders`, `/distribution` |
| `live_slots` | every block: median, p25/p75/p90, priced/unpriced/leader-paid/failed counts, block time, source | `/v1/live/slots` |
| `fee_index_live` | the running estimate and stream health, every `LIVE_INDEX_INTERVAL_MS` | `/v1/live/summary`, WS `index:live` |
| `epoch_stakes` | stake per identity, once per epoch | rollup, `/v1/live/leaders` |
| `epoch_index` | an epoch's final value, once complete | publisher_app, `/v1/index`, `/v1/live/summary` |
| `indexer_cursors` | `slot_stream`, `slot_stream_start` | restart |
| `solami_usage` | each component's Solami counters (gRPC, RPC by method, Beam, last error), every 10 s here | `/v1/live/solami` |

Each block's rows, the cursor and its `NOTIFY epoch_live` go in one transaction, so listeners only hear about committed
data. Payloads are ~300 bytes (`@epoch/pg_models` `LiveFeed.ts`; the limit is 8,000).

## Solami across the repo

| Component | Variable | Solami product |
| --- | --- | --- |
| indexer_app | `SOLAMI_GRPC_URL`, `SOLAMI_TOKEN` | Yellowstone gRPC: the firehose or block meta, `from_slot` replay |
| indexer_app | `SOLAMI_RPC_URL` | RPC: gap fill, `getSlotLeaders`, `getVoteAccounts`, hybrid/rpc blocks |
| api_app | `SOLAMI_TOKEN` (same key) | one Yellowstone stream: confirmed slots for the WS `slot` channel and, when `EPOCH_CLUSTER=mainnet`, the Epoch program's transactions (`account_include`, `failed = false`) for program events; polling and `logsSubscribe` are the fallbacks |
| api_app | `DATA_RPC_URL=https://rpc.solami.dev/sol?api_key=<key>` | RPC for every mainnet read (`/v1/network`, `/v1/validators`, the `slot` channel's leaders and epoch, `/v1/live` tip) |
| cranks_app | `DATA_RPC_URL` (same) | RPC for the scorer's mainnet data |
| publisher_app | `SOLAMI_BEAM_URL` | Beam for `post_index` and the maker's quotes on mainnet (below) |
| cranks_app | `SOLAMI_BEAM_URL` | Beam for every crank send on mainnet: sweeps, accruals, buyback slices, settlements, finalization, treasury and launch fee claims |
| all of them | (counters) | `GET /v1/live/solami`: gRPC status and bytes, RPC calls by method with p50/p95 and errors, Beam sends, landings and tips, the last error, per component (`solami_usage`) |

For api_app keep `DATA_RPC_FALLBACK_URL` set to another RPC (or `DELEGATOR_SCAN_ENABLED=false`): the delegator scan uses
`getProgramAccounts`, which Solami caps per plan and points to its paginated `getProgramAccountsV2`; the client falls
back to the second URL when a call fails. URLs are only ever logged by host. Transactions built by Panta are sent
unchanged (their message is signed as built), and operator_cli's sends are not routed yet (a one-line change: pass
`{ beam }` to its `TransactionSender`).

## Beam

Every transaction we sign on mainnet goes through Solami Beam when `SOLAMI_BEAM_URL` is set (`@epoch/solana`
`TransactionSender`, used by publisher_app and cranks_app):

1. **Tip.** A transfer of `SOLAMI_BEAM_TIP_LAMPORTS` (≥ 100,000 = 0.0001 SOL, Beam's floor) to one of the current tip
   addresses, picked at random as Solami's SDK does. The list comes from `GET api.solami.dev/onchain/tip-addresses`
   (no auth) and is cached 10 minutes; if that API cannot be read and nothing is cached, the ten addresses pinned in
   Solami's SDK (`solami` 0.1.56 `TIP_ACCOUNTS`, all still listed on 5 Oct 2026) are used and the API is tried again a
   minute later. With no address at all the transaction goes out the normal way and is counted as a fallback.
2. **Simulate.** The signed transaction is simulated on the normal RPC first (Solami's advice): one that would fail is
   never sent, so it pays neither fee nor tip, and its program logs come back as the error.
3. **Send.** A JSON-RPC `sendTransaction` (base64, `maxRetries: 0`) to `SOLAMI_BEAM_URL`: your Solami RPC URL, where a
   tipped `sendTransaction` over HTTP goes out through Beam (Solami's policy docs: `beam_tip_from_balance_rpc`; tips of
   transactions that do not land are refunded). llms.txt also names `https://beam-http.solami.dev`; that host did not
   resolve on 5 Oct 2026 (NXDOMAIN), and `pnpm solami:check` reports whether it does now.
4. **Confirm** through the normal RPC, then look the signature up at `GET api.solami.dev/swqos/tx/{signature}`
   (landed, via Jito or not, region) for the debug log. Sends, landings, failures and tips spent go to the usage
   report.

Beam is off off-mainnet (`EPOCH_CLUSTER`, or `LAUNCH_CLUSTER` for launch fee claims), where its tip accounts and
leaders do not exist. Beam over QUIC (`beam.solami.dev:11000`, a client certificate from a swQoS keypair) and Beam's
gRPC `Submit` (an `accepted` answer with `tip_missing` / `tip_too_low` reasons) are next steps.

## Errors, explained

`@epoch/solana`'s `explainSolamiError` turns Solami's answers (the strings its "Errors" and "Troubleshooting" docs list)
into one line saying what to change; the indexer's logs, `pnpm solami:check`, the API's RPC client and the Beam sender
use it, and `GET /v1/live/solami` shows the newest one.

| Solami says | Meaning | The hint |
| --- | --- | --- |
| RPC HTTP 401 `unauthorized` | no key, or not a live one | `SOLAMI_RPC_URL` must be `https://rpc.solami.dev/sol?api_key=<a live key>` |
| RPC `-32005 Rate limited` (HTTP 200) | over the plan's requests per second | lower `GAP_FILL_RPS` / `GAP_FILL_CONCURRENCY`, or turn on RPC pay-as-you-go (the API's client backs off and retries it like a 429) |
| HTTP 403 `this key does not have RPC access`, `IP not allowed for this key` | wrong key type, or an allowlist | use a Standard or RpcKey key; edit the allowlist |
| gRPC `UNAUTHENTICATED` (`missing api key`, `invalid api key`, `api key revoked`) | `SOLAMI_TOKEN` refused | the indexer falls back to RPC polling; the API to slot polling and `logsSubscribe` |
| gRPC `PERMISSION_DENIED … firehose subscriptions are not allowed on non-PAYG streams` | plan streams refuse the firehose | turn on gRPC PAYG, or `SLOT_SOURCE=hybrid` (`auto` switches by itself) |
| gRPC `RESOURCE_EXHAUSTED … max concurrent streams` | the plan's streams are in use | Pro has two: indexer_app and api_app hold one each |
| gRPC `UNAVAILABLE`, `session expired` | a restart or failover | reconnects, replaying from `from_slot` |
| Beam `tip_missing`, `tip_too_low`, an unresolvable host | no current tip address, a tip under 100,000 lamports, a wrong `SOLAMI_BEAM_URL` | refreshes the tip list; raise the tip; use your Solami RPC URL |

## Tests and fixtures

`pnpm --filter @epoch/indexer_app test` (DB tests run with `TEST_DATABASE_URL`). `src/__fixtures__/mainnet-blocks.json`
holds four real mainnet blocks (epoch 1048) recorded with `getBlock(slot, { encoding: 'base64',
maxSupportedTransactionVersion: 1 })` from public RPC and trimmed (raw transaction bytes kept; logs, balances and inner
instructions dropped; ~420 KB). Slot 452,937,393 keeps every non-vote transaction (its real median: 10,000 µL/CU over
132 priced transactions); the others keep a sample covering every version, price and failure case, plus two real priced
transactions re-keyed so the leader pays them. Each block carries a reference computed by an independent Python
decoder; the tests check the RPC path and the Yellowstone path (the same blocks as `SubscribeUpdate` messages through
the real protobuf codec) against it. Note that `maxSupportedTransactionVersion: 0` no longer works on mainnet blocks
(`-32015`: v1 transactions).

## Next steps

- **Solami's Onchain API: not integrated, on purpose.** Its four routes (5 Oct 2026, solami.dev/docs): `POST
  /onchain/build-unsigned` builds pump.fun buys and sells only; `POST /onchain/solana/build-and-execute-instructions`
  and `POST /onchain/solana/sign-prebuilt-transaction` sign with a wallet Solami holds, behind a signed-in dashboard
  session, and broadcast without landing guarantees; `GET /onchain/tip-addresses` is used (Beam tips). Epoch's
  publisher and crank keys must stay ours (a custodial wallet would change who controls the Fee Index), and a session
  token cannot run unattended, so the signing routes add nothing here. If Solami adds API-key auth and lets those
  routes send through Beam, the crank could drop its own blockhash and confirm handling.
- Beam over QUIC (`beam.solami.dev:11000`, a swQoS keypair) or Beam's gRPC `Submit` (accepted / rejected with a
  reason) for the publisher and cranks; operator_cli through Beam.
- Mirage (the same `SubscribeUpdate` frames over WebSocket) as a second transport when gRPC is blocked.
- Solami Webhooks / Blur / the data API: decoded DEX events; not needed for the Fee Index.
