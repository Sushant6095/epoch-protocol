# Predict page: contract

The Predict page has two tabs:

- **Real (USDC via Panta)**: real-money YES/NO markets on Solana mainnet through [Panta](https://panta.market)
  (decision of 3 Oct 2026). First: Epoch's own markets on the Solana Fee Index, then Panta's wider catalog.
- **Points**: the free tier, unchanged (`/v1/predict/markets`, `/calls`, `/leaderboard`).

Everything below is served by `api_app`. Every response is `{ "ok": true, "data": … }` or
`{ "ok": false, "error": { "code", "message", "details" }, "traceId" }`; switch on `error.code`. Times are ISO 8601
in IST (`+05:30`). USDC amounts are decimal strings (`"20.00"`); prices and probabilities are numbers from 0 to 1.
Send cookies (`credentials: 'include'`): build, submit and claims use the sign-in session. The app never talks to
Panta directly and never sees Panta's API key.

## "Powered by Panta" (required)

Panta's Terms of Use (§6) require the exact words **Powered by Panta**, legible and near the Panta-powered
functionality, linked to `https://panta.market` (`poweredByUrl` in every payload). Do not reword, hide or shrink it.
Show it:

1. in the Real tab header, next to the tab title;
2. on every market card and on the market detail view;
3. on the trade ticket, on the confirm step, right under the summary;
4. on the positions panel and on the trade receipt / status toast;
5. on the claim dialog.

Every Real payload also carries `poweredBy: "Panta"`; a component that renders Panta data without the badge is a bug.

## Freshness: never show cached data as live

Every Real payload has `asOf`, `ageSeconds` and `stale`. When `stale` is true, Panta could not be read and this is the
last good answer: show a **Delayed · as of 18:42 IST** chip on the module and do not animate it as live; keep trading
buttons enabled (quotes are always fresh) unless the error says otherwise. Cards of our markets also carry
`pricesAsOf` / `pricesStale` per card.

## Endpoints (Real tab)

### `GET /v1/predict/panta/markets?category=&status=&q=&cursor=&limit=`

The tab's main payload. `category`: one of `/categories`; `status`: `primary` · `secondary` · `resolved` ·
`cancelled`; `q`: search (2–64 chars, titles and descriptions of the first catalog pages); `cursor`:
`discover.nextCursor`; `limit`: 1–50 (default 20). Refresh every 30 s, or use the WS channel for our markets.

```json
{
  "schemaVersion": 1,
  "kind": "real",
  "source": "Panta public API (live-api.panta.market) through Epoch",
  "poweredBy": "Panta",
  "poweredByUrl": "https://panta.market",
  "asOf": "2026-10-03T19:14:05+05:30",
  "ageSeconds": 3,
  "stale": false,
  "access": {
    "tradingEnabled": true,
    "geoBlocked": false,
    "country": "IN",
    "reason": null,
    "minTradeUsdc": "1",
    "maxTradeUsdc": "500",
    "signInRequired": true,
    "network": "solana-mainnet",
    "currency": "USDC"
  },
  "ours": [
    {
      "marketId": "8xQd…Fee1",
      "title": "Solana Fee Index above 1,300 µL/CU in epoch 1049",
      "description": "Epoch publishes the Solana Fee Index every epoch: …",
      "category": "crypto",
      "phase": "primary",
      "status": "open",
      "imageUrl": "https://cdn.epoch.example/fee-index-1024.png",
      "yesPrice": 0.62,
      "noPrice": 0.38,
      "volumeUsdc": "1240.00",
      "startsAt": "2026-10-03T20:23:22+05:30",
      "endsAt": "2026-10-04T11:59:55+05:30",
      "resolvesAt": "2026-10-06T08:26:40+05:30",
      "resolved": false,
      "ours": true,
      "tradable": true,
      "epoch": 1049,
      "thresholdMicroLamports": 1300,
      "question": "Will the Solana Fee Index for epoch 1049 close above 1,300 micro-lamports per CU?",
      "resolutionRule": "Resolves YES if the final Solana Fee Index for Solana mainnet epoch 1049 is strictly greater than 1,300 …",
      "sourcesOfTruth": [
        "https://api.epoch.example/v1/index/epochs/1049",
        "https://github.com/Sushant6095/epoch-protocol/blob/main/docs/FEE_INDEX_METHODOLOGY.md",
        "https://explorer.solana.com/address/FhT3…kQH4"
      ],
      "resolutionUrl": "https://api.epoch.example/v1/index/epochs/1049",
      "pricesAsOf": "2026-10-03T19:14:05+05:30",
      "pricesStale": false,
      "intelligence": {
        "label": "informational",
        "note": "Informational only, not advice. The model is the share of recent finished epochs whose Fee Index was strictly above the threshold; the implied probability is the market’s YES price. Past fees do not predict future fees.",
        "impliedProbability": 0.62,
        "modelProbability": 0.4,
        "model": { "method": "empirical share of recent finished epochs above the threshold", "lookbackEpochs": 30, "above": 12, "sample": 30 },
        "gapPct": 22,
        "index": {
          "unit": "µL/CU",
          "last": { "epoch": 1047, "value": 1284, "status": "final" },
          "running": { "epoch": 1048, "value": 1275, "slots": 214000 }
        }
      }
    }
  ],
  "discover": {
    "items": [
      {
        "marketId": "3pLk…ETH5",
        "title": "ETH above 5k?",
        "description": "Resolves from CoinGecko.",
        "category": "crypto",
        "phase": "primary",
        "status": "open",
        "imageUrl": "https://…/eth.webp",
        "yesPrice": null,
        "noPrice": null,
        "volumeUsdc": "1200.00",
        "startsAt": "2026-01-01T05:30:00+05:30",
        "endsAt": "2026-12-31T05:29:59+05:30",
        "resolvesAt": "2026-12-31T06:29:59+05:30",
        "resolved": false,
        "ours": false,
        "tradable": true
      }
    ],
    "nextCursor": "3pLk…ETH5",
    "category": null,
    "q": null,
    "searched": null
  }
}
```

Catalog rows carry no live prices (`yesPrice: null`): open the detail for prices.

### `GET /v1/predict/panta/markets/:marketId`

```json
{
  "poweredBy": "Panta", "asOf": "…", "ageSeconds": 2, "stale": false, "access": { "…": "as above" },
  "market": { "…": "a card as above; one of ours carries epoch, threshold, rule, sources, intelligence" },
  "trades": [
    { "walletShort": "9aB1…x7Qe", "side": "yes", "yesShares": "10.00", "noShares": "0", "feeUsdc": "0.05", "isPrimary": true, "at": "2026-10-03T18:50:02+05:30", "signature": "5VEJ…" }
  ]
}
```

`note` is set when the tape could not be read (show the market, hide the tape).

### `GET /v1/predict/panta/categories`

`{ "categories": ["sports", "crypto", "politics", "entertainment", "finance", "science", "world", "other"], "poweredBy": "Panta", … }`

### `GET /v1/predict/panta/positions?wallet=<address>`

Public (on-chain data). Show it for the connected wallet.

```json
{
  "wallet": "9aB1…x7Qe",
  "claimableCount": 1,
  "positions": [
    { "marketId": "3pLk…ETH5", "title": "ETH above 5k?", "ours": false, "side": "yes", "shares": "38.40", "phase": "primary", "claimable": false, "claimed": false, "outcome": null, "price": 0.52, "estValueUsdc": "19.97", "state": "open" },
    { "marketId": "8xQd…Fee1", "title": "Solana Fee Index above 1,300 µL/CU in epoch 1049", "ours": true, "side": "no", "shares": "10", "phase": "resolved", "claimable": true, "claimed": false, "outcome": "no", "price": null, "estValueUsdc": "10.00", "state": "claimable" }
  ],
  "poweredBy": "Panta", "asOf": "…", "stale": false
}
```

`state`: `open` (value ≈ shares × price, display only) · `claimable` (show **Claim**) · `won` (resolved for this
side, not claimable yet) · `lost` · `claimed` · `cancelled`. A wallet with YES and NO in one market has two rows.

### `GET /v1/predict/panta/stats`

For a small traction strip: `epoch.trades`, `epoch.uniqueWallets`, `epoch.volumeUsdc`, `epoch.attributedTrades`,
`epoch.marketsCreated`, `epoch.marketsLive`, and Panta's own count in `panta.attributedTrades` / `attributedVolumeUsdc`.

### `POST /v1/predict/panta/quote`

`{ "wallet": "<address>", "marketId": "<id>", "side": "yes", "amountUsdc": "20" }` → no sign-in needed.

```json
{
  "quoteId": "qt_…",
  "marketId": "8xQd…Fee1",
  "side": "yes",
  "amountUsdc": "20.00",
  "feeUsdc": "0.40",
  "shares": "38.42",
  "avgPrice": "0.520800",
  "payoutIfWinUsdc": "38.42",
  "expiresAt": "2026-10-03T19:15:35+05:30",
  "summary": "Buy YES for 20.00 USDC: about 38.42 shares at an average 0.520800 USDC, Panta fee 0.40 USDC. If YES wins the shares pay 38.42 USDC; if not, nothing. Powered by Panta.",
  "poweredBy": "Panta"
}
```

The quote lives ~90 s: re-quote after `expiresAt` (or on `PANTA_QUOTE_EXPIRED`). Debounce the amount input (≥ 500 ms):
Panta allows only 30 quotes a minute for the whole app.

### `POST /v1/predict/panta/build` (signed in)

`{ "quoteId": "qt_…", "wallet": "<signed-in address>", "consent": true, "maxSlippageBps": 100 }`

```json
{
  "tradeId": "ptr_Qm3…",
  "action": "buy",
  "transaction": "<base64 unsigned VersionedTransaction>",
  "recentBlockhash": "…",
  "lastValidBlockHeight": 312345678,
  "orderId": "ord_…",
  "expiresAt": "2026-10-03T19:16:05+05:30",
  "summary": "Buy YES on \"Solana Fee Index above 1,300 µL/CU in epoch 1049\" for 20.00 USDC (Panta fee 0.40 USDC, about 38.40 shares, price may move up to 1%). Wallet 9aB1…x7Qe pays in USDC on Solana mainnet. Shares pay 1 USDC each if YES wins, nothing if not. Powered by Panta.",
  "review": { "action": "buy", "marketId": "8xQd…Fee1", "market": "Solana Fee Index above 1,300 µL/CU in epoch 1049", "side": "yes", "amountUsdc": "20.00", "feeUsdc": "0.40", "expectedShares": "38.40", "maxSlippageBps": 100, "wallet": "9aB1…x7Qe", "network": "solana-mainnet" },
  "poweredBy": "Panta"
}
```

### `POST /v1/predict/panta/submit` (signed in)

Either `{ "tradeId": "ptr_…", "signedTransaction": "<base64 of the wallet-signed transaction>" }` (Epoch broadcasts it)
or `{ "tradeId": "ptr_…", "signature": "<base58>" }` (the wallet already sent it).

```json
{ "tradeId": "ptr_Qm3…", "signature": "5VEJ…", "status": "submitted", "broadcastBy": "epoch", "explorerUrl": "https://explorer.solana.com/tx/5VEJ…", "poweredBy": "Panta" }
```

Safe to repeat with the same transaction (after a timeout).

### `GET /v1/predict/panta/status/:tradeId`

```json
{ "tradeId": "ptr_Qm3…", "action": "buy", "status": "confirmed", "signature": "5VEJ…", "explorerUrl": "https://explorer.solana.com/tx/5VEJ…", "marketId": "8xQd…Fee1", "side": "yes", "amountUsdc": "20.00", "orderStatus": "confirmed", "attribution": "processed", "poweredBy": "Panta" }
```

`status`: `built` · `submitted` · `confirmed` · `failed` · `expired` (the transaction can no longer land: re-quote).
`attribution`: `pending` · `processed` (Panta credited the trade to Epoch) · `failed`. Nothing to show for attribution;
it is our traction record.

### `POST /v1/predict/panta/claim/build` (signed in)

`{ "wallet": "<signed-in address>", "marketId": "<id>", "consent": true }` → the same shape as build with
`"action": "claim"`, `"orderId": null` and a summary such as "Claim winnings on "…": 38 winning YES shares, about
38 USDC to wallet 9aB1…x7Qe on Solana mainnet. Powered by Panta." Then submit and status as for a buy.

### `GET /v1/index/epochs/:epoch` (resolution source)

Public. One mainnet epoch's Fee Index and how settled it is: `status` = `pending` · `computed` · `proposed` · `final`
· `vetoed`; `value` in µL/CU. Link it from our market's detail ("Resolution source"). Example in
[FEE_INDEX_METHODOLOGY.md](../FEE_INDEX_METHODOLOGY.md#reading-it).

## Live updates: WS `predict:panta`

`wss://<api>/v1/stream?channels=predict:panta` (or `{"op":"subscribe","channels":["predict:panta"]}` on the existing
socket). On subscribe you get the current value, then a frame every ~15 s while you stay subscribed (slower if Panta
throttles us):

```json
{
  "channel": "predict:panta",
  "at": "2026-10-03T19:14:20+05:30",
  "data": {
    "poweredBy": "Panta",
    "asOf": "2026-10-03T19:14:20+05:30",
    "stale": false,
    "markets": [
      { "marketId": "8xQd…Fee1", "epoch": 1049, "thresholdMicroLamports": 1300, "phase": "primary", "yesPrice": 0.63, "noPrice": 0.37, "impliedProbability": 0.63, "modelProbability": 0.4, "volumeUsdc": "1310.00" }
    ]
  }
}
```

Merge by `marketId` into the cards. If `hello` does not list `predict:panta` (no key on the server), poll
`GET /markets` every 30 s instead. Combine with the existing `feeIndex` channel for the live index next to the price.

## Buying: step by step

1. **Connect + sign in.** Wallet adapter connect, then the existing SIWS sign-in (`/v1/auth/siws/nonce` → sign →
   `/v1/auth/siws/verify`). Signed-out users can browse and quote; **Buy** asks them to sign in first.
2. **Ticket.** Side (YES / NO) and amount in USDC (`access.minTradeUsdc`–`maxTradeUsdc`; also check the wallet's USDC
   balance client-side). Debounced `POST /quote`; show shares, average price, fee, payout if it wins, and the expiry.
3. **Consent.** Show `quote.summary` (or the build's `summary`) verbatim with a checkbox **"I understand this is a real
   USDC trade on Solana mainnet"** and **Powered by Panta** under it. The Confirm button is disabled until checked.
   Only then call build with `consent: true`.
4. **Build.** `POST /build { quoteId, wallet, consent: true, maxSlippageBps }`. Keep `tradeId`. Show `review`.
5. **Sign.** Deserialize and sign **without changing it** (no extra instructions, no new blockhash; the server checks the
   message hash):

   ```ts
   const tx = VersionedTransaction.deserialize(Buffer.from(build.transaction, 'base64'));
   const signed = await wallet.signTransaction(tx);
   ```

   The blockhash lives ~60 s: sign promptly; if the wallet takes longer, re-quote.
6. **Submit.** `POST /submit { tradeId, signedTransaction: Buffer.from(signed.serialize()).toString('base64') }`.
   (Wallets that only offer sign-and-send: send it, then `POST /submit { tradeId, signature }`.)
7. **Status.** Poll `GET /status/:tradeId` every 2 s until `confirmed`, `failed` or `expired` (stop after 90 s and
   keep a "check later" link). Show the explorer link, then refresh positions. Attribution to Panta happens on the
   server; the app does not call `/trades/`.

## Claiming

Positions with `state: "claimable"` get a **Claim** button: claim dialog with the summary + consent checkbox +
**Powered by Panta** → `POST /claim/build { wallet, marketId, consent: true }` → sign → `POST /submit` → poll status →
refresh positions (the row becomes `claimed`).

## States

| State | When | Show |
| --- | --- | --- |
| Loading | first fetch | skeleton cards (ours: 2, catalog: 6), skeleton ticket |
| Empty (ours) | `ours` is empty | "The next Fee Index market opens soon" + the catalog |
| Empty (catalog / search) | `discover.items` empty | "No markets match" with a clear-filters action |
| Empty (positions) | no rows | "No positions yet" |
| Stale | `stale` or `pricesStale` | **Delayed · as of HH:MM IST** chip on that module; no live pulse |
| Signed out | Buy / Claim without a session (`401`) | sign-in prompt; browsing and quotes still work |
| Wrong wallet | `403 WALLET_MISMATCH` | "Sign in with the wallet you are trading from" |
| Geo-blocked | `access.geoBlocked` or `403 PANTA_GEO_BLOCKED` | banner "Real-money trading isn't available in your region"; cards visible, trade buttons disabled; link to the Points tab |
| Panta restriction | `403 PANTA_FORBIDDEN` | "Panta does not allow this for this wallet or region" (no workaround) |
| Trading off | `access.tradingEnabled: false` or `503 PANTA_TRADING_DISABLED` | banner with `access.reason`; browse only |
| Not configured | `503 PANTA_NOT_CONFIGURED` on the page | Real tab shows "Real-money markets are coming soon" and the Points tab opens by default |
| Market closed | `tradable: false`, `409 PANTA_MARKET_CLOSED` | "Trading closed" + `resolvesAt` |
| Quote expired / moved | `409 PANTA_QUOTE_EXPIRED` / `PANTA_QUOTE_STALE` | re-quote automatically and ask again |
| Amount | `400 PANTA_AMOUNT_OUT_OF_RANGE` (`details.minUsdc`, `maxUsdc`), `400 PANTA_AMOUNT_TOO_SMALL` | inline under the amount |
| Busy | `429 PANTA_BUSY` / `PANTA_RATE_LIMITED` / `TOO_MANY_REQUESTS` (`details.retryAfterSeconds`) | "Busy, retrying in N s" and retry once |
| Transaction | `400 TX_REJECTED` (`details.reason`), `TX_MODIFIED`, `TX_NOT_SIGNED`; status `failed` / `expired` | "The network rejected it" / "The wallet changed the transaction" / "Expired, try again" |
| Error | anything else (`502 PANTA_UNAVAILABLE`, `RPC_UNAVAILABLE`, `500`) | "Something went wrong" + retry; keep the `traceId` |

## Our market's detail

- Question, threshold and epoch; **Trading closes** countdown to `endsAt` (before the epoch starts: nobody trades while
  its fees are public); **Resolves after** `resolvesAt`.
- Prices: YES / NO from the card (or the WS channel).
- **Fee Index intelligence**, labelled "Informational": implied probability (`impliedProbability`) next to the model
  (`modelProbability`, "N of the last K epochs closed above X"), `gapPct`, and `index.last` / `index.running` from
  the same payload; the existing `feeIndex` WS channel and `GET /v1/index` give the chart. Render `intelligence.note`
  under it. Never call it a prediction or advice.
- Resolution: the rule (collapsible), the sources of truth as links, and `resolutionUrl` ("Resolution source").
- **Powered by Panta**.

## Points tab

Unchanged: `GET /v1/predict/markets` (`PredictSnapshot`), `POST /v1/predict/calls { marketId, side, points }` with the
session, `GET /v1/predict/leaderboard?epochs=30`; see `packages/api_app/README.md` → "Predict in points mode". Points
have no cash value; nothing there involves Panta or a wallet transaction.
