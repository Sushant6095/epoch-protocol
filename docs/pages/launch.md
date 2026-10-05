# Launch page: the API contract

For the frontend: one page per revenue token, `/launch/[mint]` (plan F13, ADR 0006).

- **What a revenue token is.** A validator sells a fixed share of its gross revenue for a fixed term as a token on a
  Meteora Dynamic Bonding Curve (DBC). The share and the term are immutable once registered with the Epoch program.
- **Who does what.** Epoch is the DBC partner: the program's treasury PDA `["treasury", pool]` is every launch's fee
  claimer and leftover receiver. When the raise is complete, the token graduates to a DAMM v2 pool.
- **The backing.** Every epoch of the term, the program takes the share off the top of the validator's sweep into a
  buyback escrow. It then buys the token back on its pool (the curve before graduation, DAMM v2 after) and burns it.

The page has six blocks:

1. [Curve and market](#1-curve-and-market)
2. [Trade](#2-trade)
3. [Holders](#3-holders)
4. [Fees and treasury](#4-fees-and-treasury)
5. [Buybacks and burns](#5-buybacks-and-burns)
6. [Revenue-token terms](#6-revenue-token-terms)

Live updates come over [WS `launch:<mint>`](#ws-launchmint).

Everything is served by `packages/api_app`:

| Part | Routes | Service | Types |
| --- | --- | --- | --- |
| The page | `Routes/LaunchPageRouters.ts` | `Services/Launch/LaunchPageService.ts` | `src/types/LaunchPage.types.ts` |
| Revenue-token terms | (in `/page`) | `Services/Launch/RevenueTokenSource.ts` | `RevenueTokenInfo` |
| Buybacks | `Routes/BuybackRouters.ts` | `Services/Launch/BuybackFeed.ts` | `src/types/Buyback.types.ts` |

**About the examples.** They are real responses, trimmed where marked `…`, from two launches:

- **`rREH`**, the devnet rehearsal of 3 Oct 2026
  ([docs/runbooks/meteora-devnet-rehearsal.md](../runbooks/meteora-devnet-rehearsal.md)). It graduated, so it supplies
  the market, trades, holders, LP fees and the ticket. Its `graduatedEpoch` is illustrative: the validator was stopped
  overnight, so its slot clock could not date the graduation.
- **`rLOC`**, launched on 4 Oct 2026 on a local stand-in that runs Meteora's mainnet programs and the merged Epoch
  program. It was registered with the program in the same run, so it supplies the revenue-token terms, the fees under
  the treasury PDA and the buyback feed. It is still on the curve.
  - Its API ran with `LAUNCH_CLUSTER=devnet` against the local RPC, so the responses say `devnet` and the explorer
    links carry a custom RPC URL.
  - The stand-in's block times lag the wall clock (its ledger was paused overnight).
- **`rOPR`**, a second token on the stand-in, registered by its operator in a separate step. Its escrow is empty, and
  it shows the buyback schedule before the term.

The same API also answered for `rREH` with the program: its "not registered" revenue-token block and buyback feed are
from that run.

**Checked end to end.** On 5 Oct 2026 a full run on the stand-in (`rR2E`: launch, trades through `/quote` and
`/build`, graduation, a sweep, four buyback slices and the treasury's claims through the program) compared every
endpoint below, the activity feed and the WS frames with the chain to the lamport and the token unit: 46 of 46 checks
passed ([the runbook's round-2 section](../runbooks/meteora-devnet-rehearsal.md#10-round-2-the-whole-loop-through-the-program-5-oct-2026)).
The `ingest` feed fields in the examples are from that run (`LAUNCH_TRADES_BACKSTOP_SECONDS=30`).

## Rules the page follows

- **Words.**
  - Use: revenue token, share, term, curve, raise, graduate, buyback, burn, backing.
  - Never use: investment, dividend, APY, return or profit.
  - Implied yield is **per epoch** and is never annualised: the cashflow stops when the term ends.
- **Times are IST** (`2026-10-03T19:08:39+05:30`). Charting libraries get unix seconds in `time`.
- **Nothing cached is shown as live.**
  - Every live block carries `freshness: { asOf, ageSeconds, stale }`; the trade feed carries
    `ingest: { running, lastPollAt, stale, mode, lagSeconds, pollSeconds }` (see [2. Trade](#2-trade)).
  - When `stale` is true, show the block with its age ("as of 19:08 IST") in a muted style, never as live.
  - `asOf: null` means the block has never been read: show it as unavailable, not as zero.
- **Unavailable is not empty.** The first-paint bundle lists the blocks it could not read in `unavailable`. Those are
  `null` (holders, fees) or carry `freshness.asOf: null` (market). Show "not available right now", not "0".
- **Amounts are UI numbers** in SOL or tokens (`solAmount: 0.2`, `tokenAmount: 89402.418317`).
  - Prices are SOL per token, with 6 significant digits.
  - USD appears only where `priceUsd`/`marketCapUsd` are non-null (SOL/USD from Jupiter).
- **`network`** is `devnet` or `mainnet`. On mainnet, trades move real SOL: the ticket shows the API's `warnings`
  verbatim and asks for consent before it builds anything.
- Every response is wrapped as `{ ok: true, data }` or `{ ok: false, error: { code, message, details }, traceId }`.

## Loading the page

1. `GET /v1/launches/:mint/page` returns everything for the first paint in one call. `:mint` is the mint or the symbol,
   case-insensitive (`/v1/launches/rREH/page`).
2. `GET` the bundle's `links.buybacks` (the mint, not the symbol) for the buyback block.
3. Open `WS /v1/stream?channels=launch:<mint>`, or send `{ "op": "subscribe", "channels": ["launch:<mint>"] }` on the
   page's existing socket. The first frame is a `snapshot`; then `trade`, `market` and `fee` frames as they happen.
4. Fetch more as needed:
   - `/trades?before=…` for older trades;
   - `/candles?interval=…` for other chart ranges;
   - `/holders` and `/fees` again when a `fee` frame arrives, or every 30–60 s while the page is visible;
   - `/buybacks` again every 60 s while visible, and after a `trade` frame whose `trader` is the buyback escrow.
5. On a WS reconnect, subscribe again: the new `snapshot` replaces the market and the newest trades.

## Endpoints

| Endpoint | Returns | Cache-Control | Notes |
| --- | --- | --- | --- |
| `GET /v1/launches/:mint/page` | `LaunchPage` | `no-store` | First paint: every block below except buybacks |
| `GET /v1/launches/:mint/market` | `LaunchMarket` | `no-store` | Pool read cached 10 s, dropped on every new trade |
| `GET /v1/launches/:mint/trades` | `LaunchTradeList` | `no-store` | `?limit=1–200` (50), `?before=<nextCursor>` |
| `GET /v1/launches/:mint/candles` | `LaunchCandles` | `public, max-age=5` | `?interval=1m…1d` (15m), `?from=&to=` unix s |
| `GET /v1/launches/:mint/holders` | `LaunchHolders` | `public, max-age=30` | Largest 20 accounts, cached 2 min; read again after a trade or claim (at most every 5 s) |
| `GET /v1/launches/:mint/fees` | `LaunchFees` | `public, max-age=15` | Pools' state cached 60 s, plus claim events |
| `GET /v1/launches/:mint/buybacks` | `LaunchBuybackFeed` | `public, max-age=30` | Base58 mint only; from the program's cluster |
| `POST /v1/launches/:mint/quote` | `LaunchQuoteResponse` | `no-store` | Rate-limited per IP (30/min) |
| `POST /v1/launches/:mint/build` | `LaunchBuildResponse` | `no-store` | Needs `consent: true`; rate-limited per IP |
| `WS /v1/stream`, channel `launch:<mint>` | frames, below | — | Snapshot on subscribe, then live |

`GET /v1/launches` (the list) and `GET /v1/launches/:mint` (the detail: token, curve, escrow, risks, price series) are
unchanged; the first-paint bundle includes the detail.

## First paint: `GET /v1/launches/:mint/page`

`rLOC` on the curve, registered with the program:

```json
{
  "schemaVersion": 1,
  "kind": "real",
  "asOf": "2026-10-04T11:49:37+05:30",
  "source": "Meteora DBC and DAMM v2 pools on devnet, the launch registry (LAUNCHES_PATH), the mainnet validator table; the Launch page's live reads (pools, launch_trades, holders, fees)",
  "note": "Launches come from the launch registry; a registered token's terms are the program's (revenueToken on GET /v1/launches/:mint/page). Buybacks: GET /v1/launches/:mint/buybacks (the program's escrow, schedule and burns). rLOC: share revenue is 0 until it is known (its vote account is not a mainnet validator with stake).",
  "network": "devnet",
  "launch": {
    "mint": "G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq", "symbol": "rLOC", "name": "Epoch local revenue token",
    "validator": { "name": "Local test validator", "vote": "F8bkJtsc9HhPj9spAQXzGaVYUCtdUMwZVevSvR68d3jB" },
    "shareBps": 500, "termEpochs": 10, "startEpoch": 1, "endEpoch": 10, "status": "curve", "opensAtEpoch": null,
    "raise": { "targetSol": 0.5, "raisedSol": 0.0198, "progressPct": 3.96, "buyers": 1 },
    "priceSol": 5.80362e-7, "bandLowSol": 5.68669e-7, "bandHighSol": 9.00393e-7, "marketCapSol": 0.5804,
    "shareRevenuePerEpochSol": 0, "impliedYieldPctPerEpoch": null, "backingRatio": null
  },
  "detail": {
    "token": { "supply": 1000000, "burned": 0, "holders": 2, "decimals": 6, "mintAuthority": null, "metadataImmutable": true },
    "curve": { "dbcPool": "AYr4ALrNGSqnxCFuv52NKBfhtXFeQi197bktKEH9NsVp", "config": "7gs7DvMjnzPxGEFGLbHrtCqSGbvV4R6Resb68C2npsWf",
               "bandLowSol": 5.68669e-7, "bandHighSol": 9.00393e-7, "valuePerTokenSol": 9.47782e-7,
               "migrationThresholdSol": 0.5, "creatorMigrationFeePct": 70, "lockedLiquidityPct": 100,
               "dammPool": null, "graduatedEpoch": null },
    "escrow": { "address": "9wjpf4Uw2w1BQ3SC3mygBz7tUDNi7Fwpu4WRSAL9PHva", "balanceSol": 0.1, "slicesPerEpoch": 12, "mode": "buyback" },
    "partnerFeesToSeniorSol": 0.00016, "upfrontToValidatorSol": null, "buybacks": [], "risks": ["…4 lines…"],
    "priceSeries": [{ "t": "2026-10-04T11:49:37+05:30", "epoch": 0, "priceSol": 5.80362e-7 }]
  },
  "market": { "…": "as GET /market" },
  "revenueToken": { "source": "program", "registeredOnChain": true, "…": "see 6. Revenue-token terms" },
  "trades": ["…the newest 50, as GET /trades…"],
  "candles": { "interval": "15m", "basis": "trades", "candles": ["…24 hours of 15-minute candles…"] },
  "holders": { "count": { "all": 2, "buyers": 1 }, "top": ["…"], "freshness": { "…": "…" } },
  "fees": { "partner": { "…": "…" }, "creator": { "…": "…" }, "lp": { "…": "…" }, "leftover": { "…": "…" },
            "toLenders": { "…": "…" }, "history": [], "freshness": { "…": "…" } },
  "ingest": { "running": true, "lastPollAt": "2026-10-04T11:49:53+05:30", "stale": false,
              "pools": [{ "address": "AYr4ALrNGSqnxCFuv52NKBfhtXFeQi197bktKEH9NsVp", "venue": "dbc" }],
              "mode": "websocket", "lagSeconds": 0.7, "pollSeconds": 30 },
  "stream": { "channel": "launch:G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq" },
  "links": {
    "buybacks": "/v1/launches/G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq/buybacks",
    "trades": "/v1/launches/G1MV…pYEq/trades", "candles": "/v1/launches/G1MV…pYEq/candles",
    "holders": "/v1/launches/G1MV…pYEq/holders", "fees": "/v1/launches/G1MV…pYEq/fees"
  },
  "unavailable": []
}
```

- `launch` is the `GET /v1/launches` row (the board, cached 60 s). `market` is the fresher read: prefer `market` for the
  price, market cap, raise and status.
- `revenueToken` holds the terms: the program's own `RevenueToken` account once the validator's operator registered the
  token; otherwise the launch record's terms. See [6. Revenue-token terms](#6-revenue-token-terms).
- `holders` and `fees` are `null` when they could not be read (they are listed in `unavailable`). `fees` is also `null`
  before the curve exists. When the market cannot be read, it falls back to an upcoming-looking block with
  `freshness.asOf: null`.
- Every escrow figure (`detail.escrow.balanceSol`, `revenueToken.escrow.balanceSol` and the buyback feed's
  `escrow.balanceSol`) is the SOL the escrow can spend: its balance above the rent-exempt minimum (0.1 here).
- `note` says what is still estimated (share revenue) and which blocks failed.

## 1. Curve and market

### `GET /v1/launches/:mint/market`

`rREH` after graduation:

```json
{
  "status": "graduated",
  "venue": "damm-v2",
  "priceSol": 0.00000278106,
  "priceUsd": 0.00033538,
  "solUsd": 120.59,
  "marketCapSol": 2.7811,
  "marketCapUsd": 335.38,
  "raise": { "targetSol": 0.75, "raisedSol": 0.75, "progressPct": 100, "complete": true },
  "liquiditySol": 0.208761,
  "shareRevenuePerEpochSol": 0.099794,
  "pricedAtShareRevenuePerEpochSol": 0.341036,
  "impliedYieldPctPerEpoch": 3.588,
  "graduation": {
    "state": "migrated",
    "dammPool": "849LsiGbYgC9vRSMiMi3SKrT7C3D3dYPCYX1HD1cGokj",
    "dammPoolUrl": "https://explorer.solana.com/address/849LsiGbYgC9vRSMiMi3SKrT7C3D3dYPCYX1HD1cGokj?cluster=devnet",
    "meteoraUrl": null,
    "graduatedEpoch": 2,
    "curveCompletedAt": "2026-10-03T19:08:39+05:30"
  },
  "day": { "volumeSol": 1.222593, "trades": 8, "buys": 6, "sells": 2, "priceChangePct": 2.94 },
  "freshness": { "asOf": "2026-10-04T09:40:24+05:30", "ageSeconds": 5, "stale": false }
}
```

On the curve (`rLOC`), the same block reads:

```json
{ "status": "curve", "venue": "dbc", "priceSol": 5.80362e-7, "marketCapSol": 0.5804, "liquiditySol": 0.0198,
  "raise": { "targetSol": 0.5, "raisedSol": 0.0198, "progressPct": 3.96, "complete": false },
  "graduation": { "state": "curve", "dammPool": null, "dammPoolUrl": null, "meteoraUrl": null, "graduatedEpoch": null, "curveCompletedAt": null } }
```

| Field | Meaning |
| --- | --- |
| `status` | `upcoming` · `curve` · `graduated` · `ended`, as in the list. |
| `venue` | Where a trade goes now: `dbc` (the curve) or `damm-v2` (after graduation). `null` when there is no pool yet, or when the raise is complete and the token is waiting to graduate: disable the ticket. |
| `raise` | The curve's quote reserve against DBC `migrationQuoteThreshold`. `complete` once the threshold is reached. |
| `marketCapSol` | Fully diluted: price × (supply − burned). |
| `liquiditySol` | SOL in the pool now: the curve's reserve, or the DAMM v2 pool's SOL. |
| `shareRevenuePerEpochSol` | The live estimate of what the buyback gets each epoch: the mainnet validator table's inflation and MEV commission × share. Use it for the implied yield. `0` while unknown (a vote account that is not a mainnet validator with stake). |
| `pricedAtShareRevenuePerEpochSol` | What the curve was priced from at launch: the 10-epoch average, including sampled block revenue, × share. Show it as "priced at", next to the live figure. The two differ when block revenue is not part of what the program sweeps. |
| `impliedYieldPctPerEpoch` | `shareRevenuePerEpochSol ÷ marketCapSol × 100`, in **% per epoch**. `null` without a market cap or share revenue. |
| `graduation.state` | `upcoming` (no pool) · `curve` (trading on the curve) · `complete` (raise in, migration pending, usually minutes) · `migrated` (DAMM v2 live). |
| `graduation.meteoraUrl` | Meteora's pool page, on mainnet only. |
| `day` | The last 24 hours from the trade feed. `priceChangePct` is null without two trades. |

The curve itself (band, value per token, threshold, the 70% upfront, locked liquidity) is in `detail.curve`. The band is
60% → 95% of the share's value per token: the curve starts at `bandLowSol` and graduates at `bandHighSol`.

### The chart: `GET /v1/launches/:mint/candles?interval=1m&from=<unix s>&to=<unix s>`

```json
{
  "schemaVersion": 1, "kind": "real", "asOf": "2026-10-04T09:40:29+05:30", "network": "devnet",
  "source": "launch_trades", "note": "", "mint": "2gg2Sun6S8EoJq2E9QjrjPf9bENzrveDGCvP9CHM7Tby",
  "interval": "1m",
  "candles": [
    { "t": "2026-10-03T19:07:00+05:30", "time": 1791034620, "open": 0.00000221471, "high": 0.00000221471, "low": 0.00000221471, "close": 0.00000221471, "volumeSol": 0.2, "trades": 1 },
    { "t": "2026-10-03T19:08:00+05:30", "time": 1791034680, "open": 0.00000247721, "high": 0.00000283216, "low": 0.00000247721, "close": 0.00000283216, "volumeSol": 0.689667, "trades": 3 },
    { "t": "2026-10-03T19:09:00+05:30", "time": 1791034740, "open": 0.00000283216, "high": 0.00000283216, "low": 0.00000283216, "close": 0.00000283216, "volumeSol": 0, "trades": 0 }
  ],
  "basis": "trades"
}
```

- **Intervals:** `1m 5m 15m 1h 4h 1d`. The default is `15m` over the last 24 h; `1h`/`4h` cover 7 days and `1d` 90 days.
  At most 1,000 candles, oldest first, on the interval's UTC grid.
- **Empty buckets** after the first trade are flat at the previous close, with `volumeSol: 0`. Draw them as gaps or flat
  bars, never as zero prices. Buckets before the first trade are left out.
- **`basis`:**
  - `trades`: built from decoded swaps;
  - `samples`: no trades yet, so the sampled pool price (`launch_price_samples`), without volume;
  - `none`: nothing yet; show the empty chart state.
- Update the last candle from WS `trade` frames (`postPriceSol`, `solAmount`), or re-fetch every few seconds.

## 2. Trade

### The feed: `GET /v1/launches/:mint/trades?limit=50&before=<cursor>`

```json
{
  "schemaVersion": 1, "kind": "real", "asOf": "2026-10-04T09:40:29+05:30", "network": "devnet",
  "source": "launch_trades: DBC and DAMM v2 swap events of the launch pools", "note": "",
  "mint": "2gg2Sun6S8EoJq2E9QjrjPf9bENzrveDGCvP9CHM7Tby",
  "trades": [
    {
      "id": "5XoMzRAivewoMTAJRebgspoH8CRhnYGKNx95qkQDeukxe9P2GStqxz3VdyxvSt9DvjCtwMFQT7JT2fcy5rXDyifc:0",
      "signature": "5XoMzRAivewoMTAJRebgspoH8CRhnYGKNx95qkQDeukxe9P2GStqxz3VdyxvSt9DvjCtwMFQT7JT2fcy5rXDyifc",
      "t": "2026-10-03T19:10:58+05:30",
      "slot": 3818,
      "venue": "damm-v2",
      "side": "buy",
      "trader": "6MTBgCMiLQLbXrMXmWa172Hv2hE2q1wANkfPZD2QMTA5",
      "solAmount": 0.05,
      "tokenAmount": 23294.177937,
      "priceSol": 0.0000021207,
      "postPriceSol": 0.00000278106,
      "feeSol": 0.000599946,
      "explorerUrl": "https://explorer.solana.com/tx/5XoM…yifc?cluster=devnet"
    }
  ],
  "nextCursor": "3775:2BbeEkGz5TGgU8J2vczBaqW31v1HmEsM3GCfRGsjfUxzbj3JzMyhfpjHEqy6wKteQS4Z4GsWr4j74harqdThYExX:0",
  "ingest": { "running": true, "lastPollAt": "2026-10-04T09:41:55+05:30", "stale": false, "pools": ["…"],
              "mode": "websocket", "lagSeconds": 0.7, "pollSeconds": 30 }
}
```

- Newest first. `id` (`<signature>:<event index>`) is unique: dedupe WS `trade` frames against it.
- `solAmount` is the SOL paid for a buy (fees included) or received for a sell (after fees). `priceSol` is the execution
  price before fees; `postPriceSol` is the pool's price after the trade (use it for the "price now" tick).
- `trader` is the account that paid for the swap. **Buybacks** are swaps the program makes from the buyback escrow: their
  `trader` is `revenueToken.buybackEscrow`. Label those rows "Buyback (burned)".
- `nextCursor` is null at the end. A cursor the API did not make answers `400 BAD_REQUEST`.
- `ingest` is the feed's state:
  - `mode` is how new trades reach the API. With `grpc` (a Yellowstone stream of the pools' transactions, for mainnet
    launches) or `websocket` (the launch RPC's `logsSubscribe` on each pool), every transaction is pushed as it
    confirms. Polling stays as the backstop, slowed to `LAUNCH_TRADES_BACKSTOP_SECONDS` (60 s) while the push is
    healthy. `polling` means no push source, or it is down: the pools are read every `LAUNCH_TRADES_POLL_SECONDS`
    (10 s).
  - `pollSeconds` is the polling interval now.
  - `lagSeconds` runs from the newest stored row's block time to when the API stored it: about a second on a push, up
    to a poll interval on `polling`. It is null until a new row arrives (a first start's backfill does not count). On
    `grpc` the block time is when the node confirmed the transaction.
  - `stale` means no successful read of the pools within `LAUNCH_STALE_SECONDS` (120 s; at least two `pollSeconds`), or
    no ingester in this API. Show "feed delayed" and keep showing what is there.
  - A "live" badge fits `grpc` or `websocket` with `stale: false`; on `polling`, say "updates every `pollSeconds` s".

### The buy/sell ticket

```
quote ──► review (amounts, price impact, fee, min out, warnings, consent) ──► build ──► wallet signs & sends ──► WS trade
```

1. **Quote** while the user types (debounced to at most 1 request a second; the API allows 30 quotes and builds a minute
   per IP).

   `POST /v1/launches/:mint/quote` `{ "side": "buy", "amount": 0.05, "slippageBps": 100 }`
   - `amount` is the SOL to spend for a buy, or the tokens to sell for a sell.
   - `slippageBps` is 0–5,000; the default is 100 (1%).

   On the curve (`rLOC`):

   ```json
   {
     "schemaVersion": 1, "kind": "real", "asOf": "2026-10-04T11:49:53+05:30", "network": "devnet",
     "source": "Meteora DBC swapQuote2 on devnet", "note": "", "mint": "G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq",
     "quote": { "side": "buy", "amountIn": 0.05, "amountOut": 83185.821373, "minimumOut": 82353.963159,
                "priceImpactPct": 2.5313, "tradingFeeSol": 0.0005, "venue": "dbc" },
     "validForSeconds": 15,
     "warnings": ["devnet demo: no real value. Nothing here is an offer."]
   }
   ```

   After graduation (`rREH`), the source is `Meteora DAMM v2 getQuote2 on devnet`, `venue` is `damm-v2`, and a small
   pool adds a warning: `"High price impact: 23.74% (a small pool)."`.

   The API chooses the venue: the curve (`dbc`) before graduation, DAMM v2 after. On the curve, the buy that completes
   the raise uses only what the threshold needs, so `amountIn` can be less than asked: show it.

2. **Review.** Show `amountIn`, `amountOut`, `minimumOut`, `priceImpactPct`, `tradingFeeSol` and every `warnings` line
   verbatim (on mainnet the first line is the real-money and legal line). The user ticks a consent box.

3. **Build.** `POST /v1/launches/:mint/build`
   `{ "side": "buy", "amount": 0.05, "slippageBps": 100, "owner": "<wallet>", "minimumOut": 14210.985214, "consent": true }`
   - Pass the reviewed quote's `minimumOut`, so the transaction enforces what the review showed.
   - Without `consent: true` the API answers `400 CONSENT_REQUIRED` and builds nothing.

   ```json
   {
     "…": "the quote response's fields",
     "validForSeconds": 60,
     "transaction": "AQAAAAAAAAAAAAAA…(base64, legacy wire format, unsigned)",
     "feePayer": "6MTBgCMiLQLbXrMXmWa172Hv2hE2q1wANkfPZD2QMTA5",
     "blockhash": "8AqcAaMBqJrCn7HNjs2zXBFivAAZdvG9jnVsk7ztPTgh",
     "lastValidBlockHeight": 4734,
     "explorerCluster": "devnet"
   }
   ```

4. **Sign and send** with the wallet. The API never signs or sends:

   ```ts
   import { Transaction } from '@solana/web3.js';

   const tx = Transaction.from(Buffer.from(built.transaction, 'base64'));
   const signature = await wallet.sendTransaction(tx, connection); // or signTransaction + sendRawTransaction
   await connection.confirmTransaction(
     { signature, blockhash: built.blockhash, lastValidBlockHeight: built.lastValidBlockHeight },
     'confirmed',
   );
   ```

   - `connection` is the launch cluster's RPC (`network`).
   - Link the signature with `explorerCluster` (`?cluster=devnet`; `null` means mainnet).
   - The trade appears on WS `launch:<mint>` about a second after it confirms while `ingest.mode` is `grpc` or
     `websocket`, and within one poll (`ingest.pollSeconds`) on `polling`. Show the signed trade as pending until its
     `trade` frame (same `signature`) arrives.

5. If the blockhash expires (`lastValidBlockHeight` passed), or the user waited longer than `validForSeconds`, quote and
   build again.

**Errors** (`error.code`):

| Code | HTTP | When | Ticket |
| --- | --- | --- | --- |
| `CONSENT_REQUIRED` | 400 | A build without `consent: true` | Ask for the consent tick |
| `AMOUNT_TOO_LARGE` | 400 | A buy above `LAUNCH_TRADE_MAX_SOL` (`details.maxSol`) | Show the cap |
| `AMOUNT_TOO_SMALL` | 400 | The amount rounds to nothing | Ask for more |
| `BAD_REQUEST` | 400 | An invalid body or `owner` | — |
| `NOT_LAUNCHED` | 409 | No pool yet | Disable the ticket |
| `NOT_OPEN` | 409 | The pool's activation time has not come | Show "opens at …" |
| `CURVE_COMPLETE` | 409 | The raise is complete; graduation is pending | "Graduating to DAMM v2 — back in minutes" |
| `NOT_TRADING` | 409 | The DAMM v2 pool is disabled | Disable the ticket |
| `WRONG_TOKEN` | 409 | The pool does not trade this mint | — |
| `INSUFFICIENT_LIQUIDITY` | 422 | The pool cannot fill it | Ask for less |
| `TOO_MANY_REQUESTS` | 429 | More than 30 quotes and builds a minute (`retryAfterSeconds`) | Slow down |
| `NOT_FOUND` | 404 | Unknown mint or symbol | The page's 404 |

For example: `{ "ok": false, "error": { "code": "AMOUNT_TOO_LARGE", "message": "Buys are capped at 10 SOL while the
demo runs", "details": { "maxSol": 10 } }, "traceId": "ac1f0506-…" }`.

A sent transaction can still fail on chain (slippage: the price moved past `minimumOut`). Show the wallet's error and
offer to quote again.

## 3. Holders

### `GET /v1/launches/:mint/holders`

`rREH` after graduation (its treasury was a plain wallet, before the program's treasury PDA):

```json
{
  "schemaVersion": 1, "kind": "real", "asOf": "2026-10-04T09:40:29+05:30", "network": "devnet",
  "source": "getTokenLargestAccounts and token-account owners (every holder)", "note": "",
  "mint": "2gg2Sun6S8EoJq2E9QjrjPf9bENzrveDGCvP9CHM7Tby",
  "count": { "all": 7, "buyers": 4 },
  "top": [
    { "owner": "AQ3gcCLTPwTHsBhNBTFz94L2kxKevZuywYWobx9H9Mf8", "tokenAccount": "AdrJmJmmjTS2qW1sQveNA1Rfqpzn83v9DxnNsdknxuYe", "amount": 639263.000567, "sharePct": 63.9263, "label": "Epoch's treasury" },
    { "owner": "CuioAkwCMnBr7gb4wCSqFi9baBEkpv6uj4VuyHwhqaWu", "tokenAccount": "EGA2T4D71udPCGe8cHB65Jp3WmxrYhAgFjnozfHTvD1g", "amount": 112329.360287, "sharePct": 11.2329, "label": null },
    { "owner": "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC", "tokenAccount": "BADjSsMk5dARWTSu5vMa2ACYrW4VJdsDM6KPaWjVbFGQ", "amount": 74807.645655, "sharePct": 7.4808, "label": "Meteora DAMM v2 pool" },
    { "owner": "FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM", "tokenAccount": "6bRDSFxaXs3BVy9j9jL3r4QcJ1gcboLK5WeFf48aXHU1", "amount": 138.895778, "sharePct": 0.0139, "label": "Meteora curve vault" }
  ],
  "freshness": { "asOf": "2026-10-04T09:40:29+05:30", "ageSeconds": 0, "stale": false }
}
```

- `top` lists the 20 largest token accounts, largest first. `sharePct` is the share of the supply now (supply − burned).
- **`label`** is one of the following, or null:
  - `Meteora curve vault`, `Meteora DAMM v2 pool`;
  - `Buyback escrow`, `Epoch's treasury` (the treasury PDA, and the launch record's fee claimer), `Leftover receiver`;
  - `<validator> (pool creator)`.

  Show labelled rows muted: they are not buyers.
- **`count`:**
  - `all` counts the accounts with a balance;
  - `buyers` leaves out the pools, the escrow, the treasury and the leftover receiver.

  With fewer than 20 accounts, both come from this read. Otherwise they come from the holder scan, which can be up to 10
  minutes old (`freshness` says so). `null` means not known yet.
- After graduation, the treasury PDA can withdraw the unsold supply (DBC "leftover") and the program burns it: see
  [4. Fees and treasury](#4-fees-and-treasury). Until it is burned, a leftover in the treasury's token account dominates
  the list.

## 4. Fees and treasury

Where the money goes, with Epoch's preset:

| Flow | Who gets it | Show |
| --- | --- | --- |
| Curve trading fee: 1% of each trade | DBC keeps its protocol share (20%); the rest accrues to the partner, Epoch's treasury PDA (the creator's share is 0) | "Fees to Epoch's lenders" |
| Migration fee: 70% of the raise, at graduation | The pool creator, the validator (`creator.migrationFeeSol`) | "Upfront to the validator" |
| The other 30% of the raise | Seeds the DAMM v2 pool. 100% of its LP is permanently locked with the partner, so its trading fees go to the treasury PDA forever | "Locked liquidity" |
| Unsold supply (DBC "leftover") | Withdrawable by the leftover receiver, the treasury PDA; the program burns it | "Unsold supply: burned" |
| Partner fees, surplus, LP fees held under the treasury PDA | The Epoch program's permissionless treasury claims move the SOL into the lending pool as income and burn any tokens among them | `toLenders` |

Suggested copy: "Epoch's fees go to lenders. Its share of trading fees, the migration fee and its LP fees are claimed
into the lending pool (senior coupon first), and any tokens among them are burned, as is the supply the curve never
sold."

### `GET /v1/launches/:mint/fees`

`rLOC` on the curve, with the treasury PDA as partner and leftover receiver:

```json
{
  "schemaVersion": 1, "kind": "real", "asOf": "2026-10-04T11:49:53+05:30", "network": "devnet",
  "source": "DBC pool and config, DAMM v2 positions (on-chain state); claim events from launch_fee_events; the treasury claims from the Epoch program (TreasuryClaimed)", "note": "",
  "mint": "G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq",
  "partner": {
    "address": "CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP",
    "tradingFeesSol": { "accrued": 0.00016, "claimed": 0, "unclaimed": 0.00016 },
    "surplusSol": 0, "surplusWithdrawn": false, "migrationFeeSol": 0, "migrationFeeWithdrawn": false
  },
  "creator": {
    "address": "3Wg6vJYo9jz881tVExLZdBh9x72ZPSUZTwmf5wWANCVJ",
    "migrationFeeSol": 0.350000144, "migrationFeeWithdrawn": false, "surplusSol": 0, "surplusWithdrawn": false,
    "tradingFeesSol": { "accrued": 0, "claimed": 0, "unclaimed": 0 }
  },
  "lp": { "positions": [], "claimedSol": 0, "unclaimedSol": 0 },
  "leftover": { "receiver": "CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP", "tokens": 0, "withdrawn": false, "burned": false, "burnedTokens": 0 },
  "toLenders": {
    "claimedSol": 0, "pendingSol": 0.00016, "holder": "<the lending pool's vault, [\"vault\", pool]>",
    "note": "Epoch's partner fees (trading fees, surplus, migration fee, LP fees) are claimed into the Epoch lending pool as income; tokens burned, as is the supply the curve never sold."
  },
  "history": [],
  "freshness": { "asOf": "2026-10-04T11:49:45+05:30", "ageSeconds": 8, "stale": false }
}
```

After graduation, the LP position and the claim history fill in (`rREH`, trimmed):

```json
{
  "lp": {
    "positions": [
      { "position": "Aw6zrpyw47WSTHZ5xBKqdKP2Qy8faJEX2bH4uQSUjNzY", "owner": "AQ3gcCLTPwTHsBhNBTFz94L2kxKevZuywYWobx9H9Mf8", "role": "partner",
        "lockedPct": 100, "claimedSol": 0.003613643, "unclaimedSol": 0, "claimedTokens": 0, "unclaimedTokens": 0 }
    ],
    "claimedSol": 0.003613643, "unclaimedSol": 0
  },
  "history": [
    { "id": "5VHN…noHB7:0", "signature": "5VHNHcgvx5rrXLNYtK5AWHxYsNGTqFvbMUURG3A2ruWr8wkVcGxfQYCPhVZxGeXotj8U4pzuiZw15ZKkXPynoHB7", "t": "2026-10-03T19:46:49+05:30", "kind": "lpFee", "owner": "AQ3g…9Mf8", "solAmount": 0.000750739, "tokenAmount": 0, "explorerUrl": "…" },
    { "id": "3f35…NPuK:0", "signature": "3f35E7FznPXTAyickGWua4xJpicDkcnuXBJdCsonET1yuooMMAWztC9Yiks5ravjKf8m169og2gYTdrtYhYpNPuK", "t": "2026-10-03T19:11:43+05:30", "kind": "creatorMigrationFee", "owner": "GjMZ…F1c1", "solAmount": 0.52500027, "tokenAmount": 0, "explorerUrl": "…" },
    { "id": "3Qnw…FGyav:2", "signature": "3QnwyUkzdN8fq6z4ttDSsJXPyveMCrCSdH3iPH6V9Z66ke4CkmbLjKVjaRTdBacSjZnCY4RuhvUPSJiUQx1FGyav", "t": "2026-10-03T19:08:39+05:30", "kind": "curveComplete", "owner": null, "solAmount": 0.750000387, "tokenAmount": 708710.925708, "explorerUrl": "…" }
  ]
}
```

- **`partner`** is Epoch's treasury PDA, the DBC fee claimer. It earns the curve's trading fees, its share of any
  surplus over the raise, and its share of the migration fee (0 in Epoch's preset). `tradingFeesSol` is exact, from the
  pool's state: `accrued = claimed + unclaimed`.
- **`creator`** is the validator. The **70% migration fee** is its upfront SOL at graduation; `migrationFeeWithdrawn`
  turns true once it claimed it.
- **`lp`** is the DAMM v2 position created at graduation: 100% permanently locked with the partner. Its trading fees are
  claimable forever. `role` is `partner`, `creator` or `other`.
- **`leftover`:** after graduation, `tokens` is the unsold supply and `withdrawn` turns true once the treasury withdrew
  it. With the treasury PDA as receiver, the program burns it in the same instruction (`burn_leftover`): `burned` turns
  true and `burnedTokens` is what it burned, equal to the buyback feed's `treasury.byKind.leftover.tokensBurned`. The
  mint's supply then drops, so `detail.token.burned` grows too.
- **`toLenders`:**
  - `pendingSol` is the partner's fees still on Meteora: unclaimed trading fees, surplus, migration fee, and the locked
    LP's unclaimed fees.
  - `claimedSol` is what the treasury already claimed into the lending pool: exactly the buyback feed's
    `treasury.totals.toLendersSol`.
  - `holder` is where that SOL now sits: the lending pool's vault (`["vault", pool]`). For a launch whose fee claimer is
    a plain wallet instead of Epoch's treasury PDA, `holder` is that wallet and `note` says so.

  Say "accruing for Epoch's lenders" for `pendingSol` and "claimed for lenders" for `claimedSol`. Show `note` as the
  block's footnote.
- **`history` kinds:**
  - claims: `partnerTradingFee`, `creatorTradingFee`, `partnerMigrationFee`, `creatorMigrationFee`, `partnerSurplus`,
    `creatorSurplus`, `leftover`, `lpFee`;
  - lifecycle events: `curveComplete` (SOL is the curve's reserve; tokens are what was left in it) and
    `dammPoolCreated` (the DAMM v2 seed).
- `409 NOT_LAUNCHED` before the curve exists.

### Treasury claims

The Epoch program claims for its treasury PDA with five permissionless instructions:

- `claim_partner_trading_fee`: SOL to the lending pool, base tokens burned;
- `claim_partner_surplus`;
- `claim_partner_migration_fee`;
- `burn_leftover`: withdraws the unsold supply and burns all of it;
- `claim_treasury_lp_fee`: the locked DAMM v2 position's fees.

The cranks send them; no treasury key exists (ADR 0006, amendment of 4 Oct 2026). Each claim emits `TreasuryClaimed`.
The buyback feed lists those claims under `treasury` (in `GET /v1/launches/:mint/buybacks`, with the treasury-claim
instructions):

| Field | Meaning |
| --- | --- |
| `treasury.address` | The treasury PDA; null while the API has no program id. |
| `treasury.totals` | `toLendersSol` (SOL put in the lending pool as income), `tokensBurned` (UI units), `claims` (count). |
| `treasury.byKind` | The same totals for `tradingFee`, `surplus`, `migrationFee`, `leftover`, `lpFee`. |
| `treasury.claims[]` | Newest first: `kind`, `epoch` (null if unknown), `source` (the DBC pool, or the DAMM v2 pool for LP fees), `position` (LP fees), `toLendersSol`, `tokensBurned`, `signature`. |
| `treasury.claimable` | `"/v1/launches/<mint>/fees"`: what is still unclaimed is on this page's fee block. |

Claimed SOL is pool income: the next `accrue` pays the protocol fee, then the senior coupon, and junior takes the rest.
Say "to Epoch's lenders", not "to Senior".

## 5. Buybacks and burns

This block shows that the token is backed by the validator's revenue. Every epoch of the term, the share goes into the
escrow, and the program spends it on the token and burns what it buys.

### `GET /v1/launches/:mint/buybacks`

It reads the program's cluster (`network`): the mint's `RevenueToken` account, the escrow's balance, the epoch clock,
and every ingested `BuybackExecuted` event for the mint, newest first (at most 200).

- `:mint` must be the base58 mint: use `links.buybacks`. A symbol answers `400 BAD_REQUEST` ("a base58 mint").
- A mint no validator registered answers `200` with `revenueToken: null`, `term: null`, `schedule: null`, zero totals
  and `note: "No validator has registered this mint as a revenue token."`.
- Without `EPOCH_PROGRAM_ID` the API answers `503 PROGRAM_NOT_CONFIGURED`: show the block as unavailable.

`rLOC`, registered, before its first sweep. Its escrow holds 0.1 SOL that was sent by hand to stand in for a share:

```json
{
  "schemaVersion": 1, "kind": "real", "asOf": "2026-10-04T11:49:53+05:30",
  "source": "Epoch program (localnet)", "network": "localnet",
  "mint": "G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq",
  "revenueToken": "3mbboR1eVR4EdUtt64sMMpT4NGe9a466cRdgRZDyLeTd",
  "vote": "F8bkJtsc9HhPj9spAQXzGaVYUCtdUMwZVevSvR68d3jB",
  "venue": "dbc",
  "term": { "shareBps": 500, "termEpochs": 10, "startEpoch": 1, "endEpoch": 10 },
  "escrow": { "address": "9wjpf4Uw2w1BQ3SC3mygBz7tUDNi7Fwpu4WRSAL9PHva", "balanceSol": 0.1, "mode": "buyback" },
  "schedule": { "slicesPerEpoch": 12, "windowSlots": 9000, "slicesDoneThisEpoch": 0, "paused": false,
                "nextSlice": { "epoch": 0, "slice": 0, "inSlots": 0, "etaSeconds": 0, "waitsForSweep": false } },
  "totals": { "escrowedSol": 0, "spentSol": 0, "burned": 0, "redeemed": 0, "redeemedSol": 0, "buybacks": 0 },
  "buybacks": [],
  "treasury": {
    "address": "CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP",
    "totals": { "toLendersSol": 0, "tokensBurned": 0, "claims": 0 },
    "byKind": { "tradingFee": { "toLendersSol": 0, "tokensBurned": 0, "claims": 0 }, "…": "…" },
    "claims": [],
    "claimable": "/v1/launches/G1MVHrAaAyPPnRNe6YQadsdmHTvdduxyXBtxj9kGpYEq/fees"
  }
}
```

| Field | Use |
| --- | --- |
| `revenueToken`, `vote` | `null` when no validator registered the mint. Every other field is then empty, and `note` says "No validator has registered this mint as a revenue token." |
| `venue` | `dbc` on the curve, `damm-v2` once the program synced the graduation |
| `term` | `shareBps`, `termEpochs`, `startEpoch`, `endEpoch` (the last epoch whose share is bought back). Immutable. |
| `escrow.balanceSol` | SOL waiting to be spent, above rent |
| `escrow.mode` | `redeem` once holders can burn tokens for SOL: after the term, or during it if the pool admin enabled the fallback |
| `schedule` | `slicesPerEpoch` (12), `windowSlots` (9,000, about an hour), `slicesDoneThisEpoch`, `paused`, and `nextSlice`: `epoch`, `slice`, `inSlots`, `etaSeconds` at 0.4 s a slot, and `waitsForSweep` (true in the term until that epoch's sweep pays the share). `nextSlice` is null once the term ended and the escrow is spent. |
| `totals` | `escrowedSol`, `spentSol`, `burned` and `redeemed` (token UI units), `redeemedSol`, `buybacks` (count) |
| `buybacks[]` | `LaunchBuyback` rows: `epoch`, `slice` of `slices`, `solIn`, `tokensBurned`, `priceSol` (SOL per token paid, fees included), `venue`, `signature`. Build the explorer link on the program's cluster (`network`). |
| `treasury` | Epoch's treasury claims for the mint, present for every mint (see [Treasury claims](#treasury-claims)) |

How the program runs it:

- **The share.** Each sweep from `startEpoch` to `endEpoch` pays `gross revenue × shareBps / 10,000` into the escrow
  (`RevenueShareSwept`), off the top, before any advance repayment.
- **The slices.** The epoch's budget is the escrow when its first slice runs. It is spread over 12 slices in the first
  `windowSlots` slots of the epoch; each slice spends what is left ÷ the slices left. A slice can move the price by at
  most `maxImpactBps` (1%), and must get at least the fee-free output minus `maxSlippageBps` (3%). Anyone can run a due
  slice (the cranks do).
- **The burn.** What a slice buys is burned in the same instruction (`BuybackExecuted`), so the supply only goes down.

**`nextSlice` before and during the term.** The schedule follows the program's rules:

- Before the term, with an empty escrow, `nextSlice` is slice 0 of `term.startEpoch` (`inSlots` counts to that epoch's
  first slot) with `waitsForSweep: true`: show "buybacks start in epoch `startEpoch`" rather than a countdown.
- In the term, a slice can run only after that epoch's sweep paid the share. While `waitsForSweep` is true, treat
  `etaSeconds` as "from", not "at".
- Once this epoch's share is spent (escrow empty), `nextSlice` moves to slice 0 of the next epoch in the term; after the
  term with an empty escrow it is null.

**Rendering.**

- **Headline:** "Bought back and burned: `totals.burned` tokens for `totals.spentSol` SOL", plus the escrow balance and
  the countdown to `nextSlice`.
- **Table:** the `buybacks` rows grouped by epoch (slice `i` of `slices`), with the venue badge and the explorer link.
- **Redeem:** when `escrow.mode` is `redeem`, show the redeem action. It calls `redeem({ amount })` from
  `@epoch/epoch-sdk` and pays `escrow × amount ÷ circulating`. Circulating is the supply minus the escrow's token
  account and the treasury's (`circulatingSupply`; tokens in the pools count). `redeemPayout` gives the exact figure.
- Keep to what the data says. Show no annualised yields, and promise nothing beyond the immutable share and term
  (decision 22).

The activity feed (`/v1/activity` and the WS `activity` channel, kind `buyback`) also shows each registration, share
swept, buyback, graduation sync, redemption and close, across all tokens.

## 6. Revenue-token terms

`revenueToken` in the first-paint bundle. It comes from the program's own `RevenueToken` account at
`["revenue_token", vote]`, decoded with `@epoch/epoch-sdk`. The escrow's balance comes from `["buyback", vote]` on the
program's cluster. Both are read once per 10 s.

Registered (`rLOC`):

```json
{
  "source": "program",
  "address": "3mbboR1eVR4EdUtt64sMMpT4NGe9a466cRdgRZDyLeTd",
  "buybackEscrow": "9wjpf4Uw2w1BQ3SC3mygBz7tUDNi7Fwpu4WRSAL9PHva",
  "treasury": "CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP",
  "registeredOnChain": true,
  "shareBps": 500, "termEpochs": 10, "startEpoch": 1, "endEpoch": 10, "registeredEpoch": 0,
  "status": "curve", "dammPool": null,
  "operator": "3Wg6vJYo9jz881tVExLZdBh9x72ZPSUZTwmf5wWANCVJ",
  "commissionFloorBps": { "inflation": 500, "blockRevenue": 1000 },
  "escrow": { "balanceSol": 0.1, "asOf": "2026-10-04T11:49:45+05:30" },
  "buybacks": { "slicesPerEpoch": 12, "windowSlots": 9000, "maxSlippageBps": 300, "maxImpactBps": 100, "paused": false, "redeemOpen": false },
  "totals": { "escrowedSol": 0, "spentSol": 0, "boughtTokens": 0, "burnedTokens": 0, "redeemedTokens": 0, "redeemedSol": 0, "buybacks": 0 },
  "note": null
}
```

Not registered yet: `rREH` on the same API (12:14 IST). No `RevenueToken` exists for its vote account, and none can:
its fee claimer is a plain wallet, not the treasury PDA.

```json
{
  "source": "registry",
  "address": "7aetwDmDhhbJVndMXuvRW2rYfdibF32HkcA4nqYFztjh",
  "buybackEscrow": "JgrRFypWwn9XtDjfCiXBmuTK4hMB6MaHFJhP5a4MFiF",
  "treasury": "CgSSZYu6o2qys6kGBYBuJfuJAHmMyDqaeXBNa82B1ECP",
  "registeredOnChain": false,
  "shareBps": 500, "termEpochs": 10, "startEpoch": 1, "endEpoch": 10, "registeredEpoch": null,
  "status": null, "dammPool": null, "operator": null, "commissionFloorBps": null,
  "escrow": null, "buybacks": null, "totals": null,
  "note": "Not registered with the program yet: the terms are the launch record's."
}
```

| Field | Meaning |
| --- | --- |
| `source` | `program`: the program's account, the authority. `registry`: the launch record's terms, for a token that is not registered. |
| `registeredOnChain` | `true`: registered with this mint. `false`: not registered yet, or the vote account registered another mint (`note` says which). `null`: unknown; the API has no program id or the read failed (`note` says so). |
| `address`, `buybackEscrow`, `treasury` | The program's PDAs: `["revenue_token", vote]`, `["buyback", vote]`, `["treasury", pool]` |
| `shareBps`, `termEpochs` | The share of the validator's gross revenue (1–5,000 bps) and the term (10–1,000 epochs). Immutable. |
| `startEpoch`, `endEpoch` | The first and last epoch whose sweep pays the share. The term starts the epoch after registration (`registeredEpoch + 1`). |
| `status`, `dammPool` | `curve` until the program synced the graduation, then `graduated` with the DAMM v2 pool the buybacks use |
| `operator` | The validator's operator, who registered the token and paid its rent |
| `commissionFloorBps` | The validator's inflation and block-revenue commissions at registration. Until the term ends, neither can go below these. |
| `escrow` | SOL in the escrow above rent, and when it was read |
| `buybacks` | The slice settings, `paused` (the pool admin's brake) and `redeemOpen` |
| `totals` | Lifetime totals from the account: SOL escrowed and spent, tokens bought, burned and redeemed (UI units), SOL redeemed, number of slices |
| `note` | Why the program's record is not shown, when it is not |

What registration means for holders (show it as the terms block):

- **Who registers.** The validator's operator signs `register_revenue_token(share_bps, term_epochs)` for a pool whose
  fee claimer is Epoch's treasury PDA. The launch CLI sends it as its last step, or prints exactly what the operator
  signs.
- **Locked commission.** The validator onboarded to Epoch, which holds its vote account's withdraw authority. Until the
  term ends it cannot leave Epoch (`release` is blocked), and it cannot cut its commission below `commissionFloorBps`.
- **After the term.** The sweep stops paying the share after `endEpoch`. What is left in the escrow is still bought
  back, and holders can also redeem tokens for their share of it. Once the escrow is empty, `close_revenue_token` burns
  any tokens left in the escrow's account and returns the rent to the operator.

Suggested copy: "5% of `<validator>`'s gross revenue for 10 epochs (1–10), bought back and burned every epoch.
Registered on chain [link to `address`]." Before registration: "Terms as announced; not registered with the program
yet."

## WS `launch:<mint>`

```json
{ "op": "subscribe", "channels": ["launch:rREH"] }
```

- `hello` lists `launch:<key>` among the channels. A symbol subscribes to the mint's channel: `subscribed` answers with
  `launch:<mint>`.
- At most 8 keyed channels per socket. An unknown key answers
  `{ "type": "error", "message": "Unknown channel or too many keyed channels (at most 8): launch:…" }`.

Data frames (`at` is when the server sent it, IST):

```json
{ "channel": "launch:2gg2…7Tby", "at": "2026-10-04T09:43:24+05:30",
  "data": { "type": "snapshot", "market": { "…": "LaunchMarket" }, "trades": ["…the newest 20 LaunchTrade…"] } }
{ "channel": "launch:2gg2…7Tby", "at": "2026-10-04T09:43:31+05:30",
  "data": { "type": "trade", "trade": { "id": "3TJY…ePu9:0", "side": "buy", "venue": "damm-v2", "solAmount": 0.02, "…": "LaunchTrade" } } }
{ "channel": "launch:2gg2…7Tby", "at": "2026-10-04T09:43:31+05:30",
  "data": { "type": "market", "market": { "priceSol": 0.00000328164, "…": "LaunchMarket after the trade" } } }
{ "channel": "launch:2gg2…7Tby", "at": "2026-10-03T19:08:44+05:30",
  "data": { "type": "fee", "event": { "kind": "curveComplete", "solAmount": 0.750000387, "…": "LaunchFeeEventRow" } } }
```

- **`trade`** frames come in chain order. A batch of them is followed by one `market` frame with the fresh pool read.
  A buyback slice arrives as a `trade` whose `trader` is the escrow: re-fetch `/buybacks`.
- **`fee`** frames carry claims and the lifecycle events:
  - on `curveComplete`, switch the ticket to "graduating";
  - on `dammPoolCreated`, re-fetch `/page` (the venue is DAMM v2 from now on);
  - on any `fee` frame, re-fetch `/fees`.
- Frames follow the feed's `ingest.mode`: about a second after a transaction confirms when it is pushed (`grpc`,
  `websocket`), up to one poll behind on `polling`. Each row is sent once: the push and the backstop poll dedupe on
  (signature, event index).
- There is no buyback channel. Buyback events are on the protocol-wide `activity` channel (kind `buyback`), without
  the mint.

## States

| State | How to tell | Show |
| --- | --- | --- |
| Loading | Before `/page` answers | Skeletons, never zeros |
| Upcoming | `market.graduation.state = upcoming` (`status: upcoming`) | Terms, band, "opens at epoch N" (`launch.opensAtEpoch`); no ticket, no chart |
| On the curve | `state = curve`, `venue = dbc` | Raise progress (`raise.progressPct`, `raisedSol` of `targetSol`), band, the ticket on the curve |
| Raise complete | `state = complete`, `venue = null` | "Raise complete — graduating to DAMM v2"; ticket disabled (`CURVE_COMPLETE`) |
| Graduated | `state = migrated`, `venue = damm-v2` | The DAMM v2 pool link (`dammPoolUrl`, `meteoraUrl` on mainnet), liquidity, the ticket on DAMM v2 |
| Not registered | `revenueToken.registeredOnChain` is not `true` | Terms "as announced", with `revenueToken.note`; the buyback block shows its `note` |
| Term not started | Registered; `nextSlice.epoch < term.startEpoch` | "Buybacks start in epoch `startEpoch`" |
| In term | Registered; between `startEpoch` and `endEpoch` | Escrow, the next slice, buybacks and burns |
| Ended | `status = ended`, or past `endEpoch` | The term is over: no new share. The escrow's rest is still bought back, or redeemed when `escrow.mode = redeem`; trading on DAMM v2 continues |
| Empty feed | `trades: []`, `candles.basis: none` | "No trades yet" and an empty chart |
| Stale | Any `freshness.stale` or `ingest.stale` | The value with "as of HH:MM IST", muted; never a live badge |
| Unavailable | Listed in `unavailable`, or `freshness.asOf: null`, or `/buybacks` answers 503 | "Not available right now" in that block; the rest of the page works |
| Error | An HTTP error on `/page` | `404 NOT_FOUND`: the page's not-found. 5xx: retry with backoff |
