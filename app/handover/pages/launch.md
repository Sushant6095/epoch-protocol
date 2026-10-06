# Launch · `/launch` and `/launch/[mint]`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § Launch (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** there is no board for Launch: it was added on 1 Oct, after the design canvas. This spec, the
fixtures [`launches.sample.json`](../fixtures/launches.sample.json) and
[`launch-rkest.sample.json`](../fixtures/launch-rkest.sample.json) and the click-map rows are the content map.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § Launch, rows LP1–LP28. Each row is a test case.

**Job:** a validator sells a fixed share of its commission for a fixed term as a token on a Meteora Dynamic Bonding
Curve, and Epoch buys the token back at source every epoch and burns it (ADR 0006, plan F13, Meteora side track).
The list shows every launch; each token has a page that answers "what backs this, and is the buyback happening?"
before it offers a trade. The program runs on devnet for now (decision 6). Nothing here is an offer (decision 22).

**Users:** Meteora side-track judges; people who want to buy or sell a validator's revenue (devnet); validators
thinking about a launch (they launch with Epoch through the launch script, not in the app: decision 22).

## How a revenue token works (ADR 0006, plan F13)

- The validator registers a **share** of its commission (`share_bps`) for a **term** (`term_epochs`) with
  `register_revenue_token(share_bps, term_epochs, mint, dbc_pool)` on its `ValidatorPosition`. Both are immutable,
  and the validator can't leave Epoch or lower its commission before the term ends: both need the withdraw
  authority the program holds.
- Epoch is the DBC **partner** and builds one curve per launch (`buildCurveWithCustomSqrtPrices` in
  `@epoch/meteora`): prices run from **60% to 95% of the share's value** (10-epoch average revenue × share × term ÷
  supply). The **raise target** is the DBC `migrationQuoteThreshold` (2–5 SOL for the demo).
- At the target the token **graduates**: the validator gets **70% of the raise** as SOL, the other 30% seeds a
  **DAMM v2** pool whose liquidity is **locked forever**, so holders always have an exit.
- Every sweep takes the share **off the top** (share → advance repayment → validator) into a **buyback escrow**.
  The permissionless `execute_buyback(slice)` buys the token on DAMM v2 (on the curve with DBC `swap2` before
  graduation) in **12 slices across the first hour of each epoch**, each with a min-out, and **burns** it.
- Fallback if the DAMM v2 buyback isn't ready: `redeem` lets holders burn tokens for their share of the escrow; the
  pools keep trading.
- Partner trading fees go to Epoch's treasury PDA for the **Senior tranche**. The token has a fixed supply, no mint
  authority and immutable metadata. The validator's credit limit is computed on its revenue after the share.

Fixture numbers: rKEST sells 5% of Kestrel Nodes' commission for 100 epochs (1043–1142). Kestrel's 10-epoch average
revenue is 20.8 SOL an epoch (the same validator borrows in `vault.sample.json`), so the share is 1.04 SOL an epoch
and was worth 104 SOL at registration: 0.00104 SOL per token over 100,000 tokens, a curve from 0.000624 to
0.000988 SOL. Now: 62% of a 5 SOL raise, price 0.000846 SOL, market cap 83.4 SOL fully diluted (price × the 98,570
tokens not burned; most of them still sit in the curve), 1.25% of that bought back per epoch, backing 1.23×
(99 epochs × 1.04 SOL ÷ 83.4 SOL). Always label the market cap "fully diluted".

## Refero lock for this page

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary (`/launch`) | [OpenSea — Drops](https://refero.design/pages/869184ab-10dc-4787-927f-7a90f388f24f) · `869184ab-10dc-4787-927f-7a90f388f24f` | Bold page title with two tabs (Active & upcoming / Past → Live & upcoming / Graduated & ended); wide rounded cards, one per launch, with a status badge on the top left ("MINTING NOW" → "On the curve"), name and creator, a stats line, a countdown and one small button on the right; group headings between cards (dates → "Now" and "Opens in epoch 1046") | The light theme, banner artwork (our card uses the validator avatar and the Epoch ring motif), ETH prices, cart and profile icons |
| primary (`/launch/[mint]`) | [Wealthsimple — NVDA stock page (dark)](https://refero.design/pages/47b50f40-2189-480a-8279-8d1796ddf5eb) · `47b50f40-2189-480a-8279-8d1796ddf5eb` | The north star again: identity row with a watch star, one hero number with its change, one chart with a crosshair and a dashed reference line labelled at the right edge, range pills, the sticky Buy card on the right, then "Market details" (4-column pairs), "Dividends" (3-column pairs), "News" (stacked cards) and "About" | Options, the promo banner's illustration, account-creation copy |
| secondary | [Reown — Preview swap (dark)](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6) · `7d84a622-9f0f-459a-82a6-5ec05e3dc1a6` | The buy and sell review: You send · You get (at least) · Price impact · Trading fee · Venue · Network fee, "Review carefully", Cancel / Sign | Token logos |
| secondary | [Coinbase Advanced — gated ticket](https://refero.design/pages/c2dbc562-373b-4790-b6dd-fa8ac6cf2c59) · `c2dbc562-373b-4790-b6dd-fa8ac6cf2c59` | The Buy card replaced by a calm gate before the first trade: 18+ and region, the "not an offer" line, one button (Predict's gate, reused) | KYC wording |

Run `/refs launch` first: it pulls these images through the Refero MCP and writes `design/screens/launch.md`.

## Layout: `/launch` (OpenSea Drops)

| # | Block | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Title row | "Launch" + "Validator revenue tokens on Meteora" + orange "Devnet" badge + "How it works" + the line "Devnet demo. Revenue tokens can be securities in many countries; nothing here is an offer." | `useLaunches()` → `network` | OpenSea title |
| 2 | Tabs | Live & upcoming (default) · Graduated & ended. URL `?tab=live|past` | `launches[].status` | OpenSea tabs |
| 3 | Group headings | Live & upcoming: "On the curve now" · "Opens in epoch 1046"; Graduated & ended: "Graduated" (buybacks still running) · "Ended" | `status`, `opensAtEpoch` | OpenSea date headings |
| 4 | **Launch card** (wide, one per launch) | Badge (On the curve / Graduated / Opens in epoch N / Ended) · validator avatar + symbol rKEST + name · "5% of Kestrel Nodes' commission for 100 epochs (1043–1142)" · raise bar "3.1 of 5 SOL · 62%" (curve only) · Price 0.000846 SOL (upcoming: the band, 0.000432–0.000684 SOL for rTIDE) · Market cap 83.4 SOL, fully diluted · Buyback 1.04 SOL an epoch · Backing 1.23× · upcoming: "Opens in ≈ 1 d 11 h" countdown (to the first slot of epoch 1046) · button View token | `LaunchSummary` | OpenSea drop card |
| 5 | Footer note | "Validators: a launch is set up with Epoch through the launch script (it needs your share, term and a curve built from your revenue)." | — | — |

## Layout: `/launch/[mint]` (Wealthsimple NVDA)

| # | Block | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Identity row | Avatar · **rKEST** + watch star · "Kestrel Nodes revenue token" · status badge · Devnet badge; right: "View on ▾" (mint, curve pool, escrow on Solana Explorer `?cluster=devnet`) | `useLaunch(mint)` → `launch`, `curve`, `escrow` | Wealthsimple identity row |
| 2 | Hero | Price 0.000846 SOL · ≈ $0.10 · "+35.6% since the curve opened" | `launch.priceSol`, `priceSeries[0]`, `useNetwork().price.solUsd` | Wealthsimple price + change |
| 3 | Chart | Price over time; dashed lines with right-edge labels for the curve's top (0.000988) and the share's value (0.00104); buyback slices as small markers. Range pills: 1 epoch · 4 epochs · All | `priceSeries[]`, `curve.bandHighSol`, `curve.valuePerTokenSol`, `buybacks[]` | Wealthsimple chart + range pills |
| 4 | Curve card | "62% of the raise: 3.1 of 5 SOL." Bar. "At 5 SOL it graduates to a Meteora DAMM v2 pool: Kestrel Nodes gets 3.5 SOL, 1.5 SOL seeds the pool and its liquidity is locked forever." Graduated: the pool, the epoch it graduated and the 70% paid | `raise`, `curve` | Wealthsimple promo card |
| 5 | What backs it (4-column pairs) | Share 5% of commission · Term (99 epochs left) · Share revenue 1.04 SOL an epoch · Implied yield 1.25% of market cap **per epoch** · Backing 1.23× · Market cap (fully diluted) · Supply 100,000 · Burned 1,430 · Holders 43 · Mint authority None · Metadata Immutable · Partner fees to Senior 0.031 SOL | `launch`, `token`, `partnerFeesToSeniorSol` | Wealthsimple "Market details" |
| 6 | Buybacks (3-column pairs) | Last epoch: 1.04 SOL → 1,430 rKEST burned · Next: epoch 1045, 12 slices in its first hour · Escrow 0.00 SOL (mode: buyback or redeem) | `buybacks[]`, `escrow` | Wealthsimple "Dividends" |
| 7 | Buyback feed | One row per slice, newest first: "Epoch 1044 · slice 12 of 12 · 0.0867 SOL → 118.3 rKEST burned at 0.000733" + explorer link; "View all" | `buybacks[]` (+ WS `activity` kind `buyback`) | Wealthsimple "News" cards |
| 8 | About and risks | One paragraph on the validator with a link to its profile, then the four risk lines from the fixture, always visible (no "Show more" on risks) | `launch.validator`, `risks[]` | Wealthsimple "About" |
| 9 | **Trade card** (right, sticky; bottom sheet on phones) | Buy · Sell · amount (SOL to buy, rKEST to sell) with chips (0.1 · 0.5 · 1 SOL; 25% · 50% · Max) · You get (≈) · At least (1% slippage) · Price impact · Trading fee · Venue "Meteora curve" or "Meteora DAMM v2" · one button. Upcoming: "Opens in epoch 1046" and a Watch button instead. Redeem mode: a third tab, Redeem, beside Buy · Sell (the pools keep trading). First trade: the 18+ and region gate | `LaunchTradeQuote` from `@epoch/meteora` (request #23) | Wealthsimple Buy card; Coinbase gate |
| 10 | Review → wallet → pending → done | TxPreview rows (LP22) and the same progress list as the Vault; success shows what you got and "See it in your wallet" | DBC `swap2` / DAMM v2 swap transaction from `@epoch/meteora` | Reown Preview swap; Copperx flow |

## Data

`useLaunches()` → `GET /v1/launches` (`LaunchList`) and `useLaunch(mint)` → `GET /v1/launches/:mint`
(`LaunchDetail`), request #22; both on fixtures until then (the sample token lives at `/launch/rKEST`). Trades: the
browser helpers in `@epoch/meteora` (request #23) return a `LaunchTradeQuote` and the transaction (DBC `swapQuote2` +
`swap2` on the curve, the DAMM v2 quote and swap after graduation); the wallet signs on devnet
(`NEXT_PUBLIC_EPOCH_RPC_URL`). Refetch the token after every trade and on WS `activity` events of kind `buyback`.

## Guardrails (part of the design)

- "Devnet demo. Revenue tokens can be securities in many countries; nothing here is an offer." on the list, the
  token page and in every review. A public launch needs legal review and a region-restricted front end first
  (ADR 0006, decision 22).
- The 18+ and region gate (Predict's component) before the first trade on a wallet.
- Implied yield is shown **per epoch** and never annualised: the cashflow stops at the end of the term. Market cap is
  always "fully diluted". Backing is "≈ 103 SOL of buybacks left against an 83.4 SOL market cap", never a promise.
- Words: revenue token, share, term, curve, raise, graduate, buyback, burn, backing. Never investment, dividend,
  guaranteed, APY or profit.
- No in-app launch flow in v1 (decision 22): the launch script sets up a validator's token with Epoch (request #24).

## Done when

- [ ] The list reads like the OpenSea Drops screen at 1,280 px; the token page like the Wealthsimple page, with the
      Trade card sticky on the right.
- [ ] The fixture numbers above reproduce exactly (62%, 83.4 SOL, 1.25% per epoch, 1.23×, 1,430 burned).
- [ ] A devnet buy on the curve and a sell both go through the review and land; design-cop all PASS.

## Live sites to look at (not on Refero)

- [Meteora launch pools](https://app.meteora.ag) — how Meteora itself shows a bonding curve's progress and graduation
- MeteoraAg/meteora-invent `scaffolds/fun-launch` (ISC, see `docs/UI_SOURCES.md`) — the open-source DBC token page
  and explore grid; borrow the curve-progress and trade-card logic, not the meme styling
