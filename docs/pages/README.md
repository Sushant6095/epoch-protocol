# Page contracts: the special pages

Each side track has one page in the Terminal built for it. The contracts below are written for the frontend: every
endpoint, example responses, WS frames, states and copy rules.

Conventions shared by all the pages:

- **Server and envelope.** Everything is served by `packages/api_app`. Responses are `{ ok: true, data }` or
  `{ ok: false, error: { code, message, details }, traceId }`.
- **Times** are IST (`+05:30`).
- **Live updates** come over one socket, `WS /v1/stream`: `?channels=a,b`, or `{ "op": "subscribe", "channels": […] }`.
  Data frames are `{ channel, data, at }`. The protocol is in
  [packages/api_app/README.md](../../packages/api_app/README.md#ws-v1stream).
- **Nothing cached is shown as live.** Every page marks stale data with its age.

The track details (prizes, eligibility, deadlines) are in [docs/SIDE_TRACKS.md](../SIDE_TRACKS.md).

| Page | Track | Contract | Routes | WS channels |
| --- | --- | --- | --- | --- |
| Live | Solami | [live.md](live.md) | `GET /v1/live/summary`, `/slots`, `/leaders`, `/epochs/:epoch/distribution`, `/solami` | `slots`, `index:live` |
| Predict | Panta | [predict.md](predict.md) | `/v1/predict/panta/*` (markets, market detail, categories, positions, stats, forecast, market image, quote, build, submit, status, claims); resolution from `GET /v1/index/epochs/:epoch` and `GET /v1/index/latest-final`; chart from `GET /v1/index`; sign-in `POST /v1/auth/siws/nonce`, `/verify`; points tab `GET /v1/predict/markets`, `POST /calls`, `GET /leaderboard` | `predict:panta`, `feeIndex` (with `ballot`) |
| Launch | Meteora | [launch.md](launch.md) | `GET /v1/launches`, `/:mint`, `/:mint/page`, `/market`, `/trades`, `/candles`, `/holders`, `/fees`, `/indexed`, `/buybacks`; `POST /quote`, `/build` | `launch:<mint>`, `activity` (kind `buyback`, with `mint`) |
| Score (Manage tab) | none | [score.md](score.md) | `GET /v1/validators/:vote/position` (`scoreBreakdown`, `mev`), `GET /v1/validators/:vote/history`; `GET /v1/validators/:vote` (`mevHistory`) | `activity` (kind `score`) |
| India (no page) | Superteam India, not entered | [india.md](india.md) | `GET /v1/india/summary`, `/price`, `/validators`, `/wallets/:address/rewards`, `/wallets/:address/rewards.csv` | none |

The validator score's on-chain inputs (round 4) have their own contract, used by the Manage tab rather than a track
page: [score.md](score.md) (`GET /v1/validators/:vote/history`, `scoreBreakdown` and `mev` on
`GET /v1/validators/:vote/position`, `activity` rows of kind `score`).

## Live (Solami)

The Solana Fee Index computed live from mainnet: each new block's median priority fee, the epoch's running index, the
leaders whose medians form it, and the distribution of slot medians. The data comes from `indexer_app` (Solami
Yellowstone gRPC → Postgres) through `api_app`.

| Routes | WS | Contract |
| --- | --- | --- |
| `GET /v1/live/summary` (with the epoch's fee mix: `fees`, `lastEpochFees`) · `GET /v1/live/slots?limit=60` (each block's `fees`) · `GET /v1/live/leaders?epoch=&limit=50` · `GET /v1/live/epochs/:epoch/distribution` · `GET /v1/live/solami` ("Powered by Solami" panel) | `slots` (one frame per block) · `index:live` (the whole summary, about every 2 s) | [live.md](live.md) |

What makes it special for the Solami judges:

- It is mainnet, block by block, from Solami's Yellowstone gRPC firehose (or Solami RPC on a plan stream), and the page
  shows it streaming: one bar per slot as it lands, and the index moving every 2 seconds.
- Solami RPC fills gaps and snapshots the leader schedule and stakes. Solami Beam can land the index's `post_index`
  transaction on mainnet.
- The page says where its data comes from (`dataSource`, the stream's status and lag), and never shows stale data as
  live.

## Predict (Panta)

Real-money YES/NO markets in USDC on Solana mainnet, through Panta, next to the free points tier. First come Epoch's own
markets on the Fee Index ("Will the Solana Fee Index for epoch N close above X µL/CU?"), then Panta's catalog.

| Routes | WS | Contract |
| --- | --- | --- |
| `GET /v1/predict/panta/markets` · `/markets/:marketId` · `/categories` · `/positions?wallet=` · `/stats` · `/forecast?epoch=` · `/market-image.png` · `/status/:tradeId` · `POST /v1/predict/panta/quote` · `/build` · `/submit` · `/claim/build` · resolution: `GET /v1/index/epochs/:epoch` (with `ballot`) · `GET /v1/index/latest-final` · chart: `GET /v1/index` · sign-in: `POST /v1/auth/siws/nonce`, `/verify` · points tab: `GET /v1/predict/markets`, `POST /v1/predict/calls`, `GET /v1/predict/leaderboard` | `predict:panta` (prices of our markets, about every 15 s) · `feeIndex` (the live index next to the price, and the open ballot's progress on every vote) | [predict.md](predict.md) |

What makes it special for the Panta judges:

- Epoch's bot creates a market on Panta every epoch, on Epoch's own number: the Fee Index. Each market resolves from
  Epoch's endpoint (`GET /v1/index/epochs/{N}`), whose value counts once it is final: posted on chain (with operator
  consensus on, only once operators holding two thirds of the weight agree; `status: "voting"` until then) and past its
  dispute window.
- Every trade goes through Panta's API and is attributed to Epoch; the app never sees Panta's key.
- The "Powered by Panta" badge appears wherever Panta data is shown, as Panta's terms require.

## Launch (Meteora)

One page per validator revenue token. A validator sells a fixed share of its gross revenue for a fixed term as a token
on a Meteora DBC curve, with Epoch as the partner. The token graduates to DAMM v2. Every epoch, the Epoch program buys
the token back out of the validator's revenue and burns it.

| Routes | WS | Contract |
| --- | --- | --- |
| `GET /v1/launches/:mint/page` (first paint) · `/market` · `/trades` · `/candles` · `/holders` · `/fees` · `/indexed` · `/buybacks` · `POST /v1/launches/:mint/quote` · `/build` · `GET /v1/launches`, `/v1/launches/:mint` | `launch:<mint>` (`snapshot`, then `trade`, `market` and `fee` frames); buyback events also appear on `activity` (kind `buyback`, with the token's `mint`) | [launch.md](launch.md) |

The track is judged on depth of Meteora integration, technical execution, originality and taste, impact potential (a
new class of assets), and traction and volume on mainnet. What the page shows for each:

- **Depth.** The whole DBC lifecycle on one page: the curve, the raise and its graduation to DAMM v2. It has a
  buy/sell ticket on whichever venue is live (DBC `swap2`, then DAMM v2), a trade feed and chart decoded from Meteora's
  own events, and the partner's fees, LP fees and leftover.
- **Technical execution.** The terms are enforced on chain, not promised:
  - `revenueToken` is the program's own `RevenueToken` account;
  - the buyback feed shows the escrow filling from the validator's sweep and the slices that buy and burn;
  - the treasury PDA is the DBC fee claimer, so Epoch's fees reach lenders through permissionless program claims.
- **Originality and impact.** A token whose backing is a validator's real revenue, bought back at source: a new asset
  class for Solana validators.
- **Traction.** Every number is live from the chain (`freshness` on each block), so mainnet volume shows as it happens.

## India (not entered)

Superteam India is not entered (6 Oct 2026). The API (`/v1/india`) and its contract ([india.md](india.md)) stay
in the code; there is no page.
