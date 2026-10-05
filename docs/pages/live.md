# Live page: page contract

The Terminal's **Live** page shows the Solana Fee Index being computed from mainnet as it happens: each new block's
median priority fee, the current epoch's running index, the leaders whose medians form it, and how the slot medians are
distributed. Data comes from `indexer_app` (Solami Yellowstone gRPC → Postgres) through `api_app`.

Everything below is served by `api_app` on its own port (`http://localhost:4000` locally). REST answers are wrapped as
`{ "ok": true, "data": … }` (errors: `{ "ok": false, "error": { "code", "message" } }`). Prices are **µL/CU**
(micro-lamports per compute unit). Times are ISO 8601 in **IST** (`+05:30`). The examples are real responses recorded
on 3 Oct 2026 (mainnet epoch 1048) from a smoke run of `indexer_app` in RPC sampling mode, trimmed where marked `…`.

## What the page uses

| Data | Source | When |
| --- | --- | --- |
| Header: data source, live badge, tip / processed slot, lag, epoch progress | `GET /v1/live/summary`, then WS `index:live` | load, then every push (≈ 2 s) |
| Big number: running index for the epoch, coverage, last finished epoch | same | same |
| Slot strip: the newest blocks, one bar per slot (median, p25–p75 band, counts) | `GET /v1/live/slots?limit=60`, then WS `slots` | load, then one frame per block (≈ 2.5 per second with `grpc`) |
| Leaders table: per-leader median, slots, stake, rank, which leader sets the index | `GET /v1/live/leaders?limit=50` | load, then every 30 s |
| Distribution: histogram of this epoch's slot medians, index marker | `GET /v1/live/epochs/{epoch}/distribution` | load, then every 60 s |

## `GET /v1/live/summary`

```json
{
  "schemaVersion": 1,
  "kind": "real",
  "asOf": "2026-10-03T19:19:02+05:30",
  "source": "indexer_app via Postgres (fee_index_live, epoch_index)",
  "live": true,
  "dataSource": "RPC polling (api.mainnet-beta.solana.com)",
  "stream": {
    "source": "rpc",
    "endpoint": "api.mainnet-beta.solana.com",
    "status": "polling",
    "lastSlotAt": "2026-10-03T19:18:58+05:30",
    "secondsSinceLastSlot": 4,
    "indexerSeenAt": "2026-10-03T19:19:02+05:30",
    "gapSlots": 0,
    "catchingUp": false
  },
  "tipSlot": 452951614,
  "processedSlot": 452951600,
  "lagSlots": 14,
  "lagSeconds": 5.6,
  "epoch": {
    "number": 1048,
    "firstSlot": 452736000,
    "slotIndex": 215609,
    "slotsInEpoch": 432000,
    "progressPct": 49.91
  },
  "estimate": {
    "epoch": 1048,
    "value": 12092,
    "leaders": 79,
    "slotsWithFees": 112,
    "pricedTxs": 29646,
    "coverageFromSlot": 452950900,
    "coveragePct": 0.3,
    "stakeEpoch": 1048,
    "sampled": true
  },
  "lastFinal": null,
  "unit": "µL/CU"
}
```

Recorded from the smoke run on 3 Oct 2026 (RPC sampling on public RPC, since the build machine has no Solami key).
With a Solami key the same fields read `"dataSource": "Solami gRPC (Yellowstone)"`,
`"stream": { "source": "grpc", "endpoint": "solami", "status": "streaming", … }`, `"sampled": false`, a lag of a few
slots (blocks stream at `confirmed`, a second or two after they are produced), `coveragePct` near 100 with `INDEXER_BACKFILL_EPOCH=true`, and `lastFinal` once an epoch has completed:
`{ "epoch": 1047, "value": …, "postedSignature": null | "<sig>", "computedAt": "…" }`.


| Field | Meaning |
| --- | --- |
| `live` | **The only "is it live" signal.** True when the indexer processed a slot within `LIVE_STALE_AFTER_SECONDS` (20 s). |
| `dataSource` | Label to show next to the badge: `Solami gRPC (Yellowstone)`, `Solami gRPC (block meta) + Solami RPC (blocks)` (hybrid), `RPC Fast gRPC (failover)`, or `RPC polling (<host>)`. |
| `stream.status` | `streaming`, `connecting`, `reconnecting`, `polling` (RPC source), `stopped`, or `offline` (the indexer wrote nothing for 20 s). |
| `stream.catchingUp`, `gapSlots` | Gap fill or an epoch backfill is running (`gapSlots` processed live but not yet contiguous). |
| `tipSlot`, `processedSlot`, `lagSlots`, `lagSeconds` | Mainnet tip, the newest slot indexed, and the difference (a few slots when healthy; it keeps growing while the indexer is down). |
| `epoch` | Mainnet epoch progress for the progress bar. |
| `estimate.value` | The running Fee Index: stake-weighted median of per-leader medians so far. Null before the first priced slot. |
| `estimate.coveragePct` | Share of the epoch so far that the estimate covers (below 100 when indexing started mid-epoch). |
| `estimate.sampled` | True in the RPC sampling demo mode (one slot in N): show "sampled", never present it as the index. |
| `lastFinal` | The newest finished epoch's value (`epoch_index`): the number to compare against ("+1.9% vs epoch 1047"). `postedSignature` is set once `publisher_app` posted it on-chain. Null until one epoch completed. |
| `note` | Present only when the indexer never ran: show it in the empty state. |

## `GET /v1/live/slots?limit=60`

`limit`: 1–500, default 60. Newest first.

```json
{
  "schemaVersion": 1,
  "kind": "real",
  "asOf": "2026-10-03T19:19:02+05:30",
  "source": "indexer_app via Postgres (live_slots)",
  "live": true,
  "slots": [
    {
      "slot": 452951600,
      "epoch": 1048,
      "leader": "HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU",
      "leaderName": "Helius",
      "medianCuPrice": 40091,
      "p25CuPrice": 1000,
      "p75CuPrice": 185089,
      "p90CuPrice": 690740,
      "pricedTxs": 482,
      "unpricedTxs": 118,
      "leaderPaidTxs": 1,
      "failedTxs": 270,
      "time": "2026-10-03T19:18:57+05:30",
      "source": "rpc"
    },
    {
      "slot": 452951590,
      "epoch": 1048,
      "leader": "C8Bey3LKVJHVqN6xPTeW8WJfUgFQAeGNBpT4Rp99JP1k",
      "leaderName": "Ledger by Figment",
      "medianCuPrice": 13697,
      "p25CuPrice": 1000,
      "p75CuPrice": 100001,
      "p90CuPrice": 500136,
      "pricedTxs": 319,
      "unpricedTxs": 113,
      "leaderPaidTxs": 0,
      "failedTxs": 185,
      "time": "2026-10-03T19:18:54+05:30",
      "source": "rpc"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `medianCuPrice` | The slot's Fee Index input (median over priced, non-leader-paid transactions). Null when none (draw an empty bar). |
| `p25CuPrice`, `p75CuPrice`, `p90CuPrice` | Spread of the same prices (nearest rank): a band around the median bar. |
| `pricedTxs` | Transactions in the median. |
| `unpricedTxs` | Non-vote transactions that set no priority fee (left out). |
| `leaderPaidTxs` | Paid by the slot leader itself (left out): worth a small marker, it is the anti-manipulation rule at work. |
| `failedTxs` | Failed on chain, among the priced ones (they paid, so they count). |
| `leaderName` | From the validator table; null → show the short key (`HEL1…e2TU`). |
| `source` | `grpc`, `hybrid`, `rpc`, or `gap-fill` (filled in later over RPC; fine to show like the others). |

Slot numbers may skip (a slot without a block has no row). Medians span four orders of magnitude: use a log scale.

## `GET /v1/live/leaders?epoch=1048&limit=50`

`epoch`: default the epoch in progress. `limit`: 1–5,000, default 200. Sorted by stake, largest first.

```json
{
  "schemaVersion": 1,
  "kind": "real",
  "asOf": "2026-10-03T19:19:02+05:30",
  "source": "indexer_app via Postgres (slot_fees, epoch_stakes)",
  "live": true,
  "epoch": 1048,
  "final": false,
  "value": 12092,
  "setter": "5pPRHniefFjkiaArbGX3Y8NUysJmQ9tMZg3FrFGwHzSm",
  "stakeEpoch": 1048,
  "totalStakeSol": 212850616,
  "leaders": [
    {
      "rank": 1,
      "identity": "Fd7btgySsrjuo25CJCj7oE7VPMyezDhnx7pZkj2v69Nk",
      "name": "Figment",
      "slots": 5,
      "medianCuPrice": 18750,
      "pricedTxs": 1060,
      "stakeSol": 17923954,
      "weightPct": 8.421,
      "setsIndex": false
    },
    {
      "rank": 2,
      "identity": "HEL1USMZKAL2odpNBj2oCjffnFGaYwmbGmyewGv1e2TU",
      "name": "Helius",
      "slots": 4,
      "medianCuPrice": 12454,
      "pricedTxs": 1245,
      "stakeSol": 15898894,
      "weightPct": 7.47,
      "setsIndex": false
    }
  ],
  "leaderCount": 79,
  "unit": "µL/CU"
}
```

| Field | Meaning |
| --- | --- |
| `value` | The epoch's index: the final value when `final`, else the stake-weighted median of what is indexed so far (equals `summary.estimate.value` for the epoch in progress). |
| `setter` / `setsIndex` | The leader whose median *is* the index. Highlight that row. |
| `weightPct` | Share of the listed leaders' stake. Sorting the rows by `medianCuPrice` and adding `weightPct` up shows the index where the running total crosses 50%: a good "how it is computed" chart. |
| `stakeSol` | Null when the leader is not in the stake snapshot (it weighs nothing). |
| `leaderCount` | Leaders with priced slots before `limit` was applied. |

## `GET /v1/live/epochs/{epoch}/distribution`

```json
{
  "schemaVersion": 1,
  "kind": "real",
  "asOf": "2026-10-03T19:19:02+05:30",
  "source": "indexer_app via Postgres (slot_fees)",
  "live": true,
  "epoch": 1048,
  "final": false,
  "slots": 113,
  "buckets": [
    { "fromCuPrice": 3162, "toCuPrice": 5623, "slots": 7 },
    { "fromCuPrice": 5623, "toCuPrice": 10000, "slots": 34 },
    { "fromCuPrice": 10000, "toCuPrice": 17783, "slots": 39 },
    { "fromCuPrice": 17783, "toCuPrice": 31623, "slots": 17 },
    "…",
    { "fromCuPrice": 562341, "toCuPrice": 1000000, "slots": 1 }
  ],
  "percentiles": { "p10": 6046, "p25": 8001, "p50": 10000, "p75": 18750, "p90": 40000 },
  "indexValue": 12092,
  "unit": "µL/CU"
}
```

Buckets are log-spaced, four per decade, `[fromCuPrice, toCuPrice)`, contiguous from the first to the last non-empty
one (empty ones inside the range are kept, so bars line up). `indexValue` is where to draw the index marker. An epoch
with no data answers `slots: 0`, `buckets: []`, `percentiles: null`.

## WebSocket `/v1/stream`

One socket per page, on the API port: `ws://localhost:4000/v1/stream?channels=slots,index:live` (or send
`{ "op": "subscribe", "channels": ["slots", "index:live"] }`). The protocol (hello, subscribed, ping, errors) is the
one in [`packages/api_app/README.md`](../../packages/api_app/README.md#ws-v1stream); data frames are
`{ "channel", "data", "at" }`.

| Channel | `data` | When |
| --- | --- | --- |
| `slots` | one `LiveSlot`, exactly as in `GET /v1/live/slots` | every block the indexer processes live (gap-filled slots are not pushed). Nothing is sent on subscribe: load the history over REST, then append. |
| `index:live` | the whole `LiveSummary`, exactly as `GET /v1/live/summary` | right after subscribing (the last value, or a fresh read), then whenever the indexer writes its estimate (≈ every 2 s, at most 1 per second), at once when an epoch's final value is written, and after the API's database listener reconnects |

```json
{ "channel": "slots", "data": { "slot": 452946890, "leaderName": "SolBlaze", "medianCuPrice": 21017, "…": "…" }, "at": "2026-10-03T18:58:04+05:30" }
{ "channel": "index:live", "data": { "live": true, "estimate": { "value": 14887, "…": "…" }, "…": "…" }, "at": "2026-10-03T18:58:04+05:30" }
```

Both channels are listed in `hello` only when the API has a database. They need no sign-in.

## Refresh behaviour

1. On load, in parallel: `summary`, `slots?limit=60`, `leaders?limit=50`, `epochs/{summary.epoch.number}/distribution`.
2. Open the socket with `slots,index:live`. Append each `slots` frame to the strip (drop the oldest beyond 60; ignore a
   slot you already have); replace the header and big number with each `index:live` frame.
3. Poll `leaders` every 30 s and `distribution` every 60 s (both are cached 10 s on the server).
4. On socket close: back off (1 s, 2 s, … 30 s), reconnect, and reload `slots` so the strip has no hole.
5. When `summary.epoch.number` changes, reload `leaders` and `distribution` for the new epoch; `lastFinal` updates when
   the previous epoch's value is written (it may take a few minutes after the boundary while gap fill finishes).

## States

| State | How to detect | Show |
| --- | --- | --- |
| Loading | requests in flight | skeletons; no numbers |
| Empty | `summary.estimate === null` and `stream.status === 'offline'` (`note` explains) | "The indexer has not run yet", no zeros |
| Live | `summary.live === true` | "LIVE" badge with `dataSource`, animate new slots |
| Stale | `summary.live === false` with data | grey the badge, show "last updated {secondsSinceLastSlot}s ago" (`stream.lastSlotAt`), stop animations; keep the last numbers but never call them live |
| Reconnecting | `stream.status` is `reconnecting` or `connecting` | a quiet "reconnecting to Solami…" next to the badge (data turns stale after 20 s) |
| Catching up | `stream.catchingUp` | "filling {gapSlots} slots" next to the coverage |
| Partial epoch | `estimate.coveragePct < 100` | "covers {coveragePct}% of the epoch so far" under the big number |
| Sampled | `estimate.sampled` | "sampled demo data", no "index" wording |
| Error | HTTP 503 `DATABASE_NOT_CONFIGURED`, any 5xx, or a socket `error` frame | an inline error card with retry; keep the last good data marked stale |

## Units and copy

- Prices: µL/CU. For people: 10,000 µL/CU = 0.01 lamports per CU = 2,000 lamports (0.000002 SOL) for 200,000 CU.
- "Solana Fee Index: the stake-weighted median priority fee across slot leaders, streamed live from mainnet through
  Solami." Methodology: [`packages/indexer_app/README.md`](../../packages/indexer_app/README.md#methodology-fee-index-v1).
