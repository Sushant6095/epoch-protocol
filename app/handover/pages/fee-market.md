# Fee Market · `/terminal?tab=market`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § Fee Market (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** there is no board for the Fee Market: it was added on 1 Oct, after the design canvas. This spec, the
fixture [`fee-market.sample.json`](../fixtures/fee-market.sample.json) and the click-map rows are the content map.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § Fee Market, rows FM1–FM30. Each row is a test case.

**Job:** let a validator lock in its fee revenue for the coming epochs, and let anyone take the other side of that
view, against Epoch's market maker at a posted fixed Fee Index level for each epoch. v1 has no order book: Epoch
seeds the maker and says so (ADR 0004, decision 21). A Terminal tab, because it trades the Terminal's own number,
the Solana Fee Index. The program runs on devnet for now (decision 6): Devnet badge, devnet wallet.

**Users:** validator operators hedging (a hedged validator borrows at 40% instead of 25%); anyone with a view on
Solana fees; judges. Everyone can read it without signing in.

## How a fee swap works (the program's rules, `programs/epoch/src/instructions/market/`)

- Epoch's market maker posts one **quote per epoch** for the next five epochs: a **fixed rate** (a Fee Index level
  in µL/CU), the most notional it takes (**room**), and the **max move** (2,000 bps = 20%). `post_quote` is open to
  any key; the page lists only Epoch's maker (request #19).
- You pick a quote and a side. **Receive fixed** gains if fees fall: the validator's hedge. **Pay fixed** gains if
  fees rise. Program enum `Side::ReceiveFixed` / `Side::PayFixed`.
- Both sides lock **collateral = notional × max move** (10 SOL at 20% locks 2 SOL). It is the most either side can
  lose or win, so settlement can never fail for lack of funds.
- Trading on a quote closes when its epoch starts (or at the quote's expiry slot, whichever is first).
- **One swap per quote per wallet:** the position account is `["swap", quote, wallet]`. A swap can't be changed,
  added to or closed early; for more size, use another epoch.
- After the epoch ends, the publisher proposes its Fee Index, the dispute window runs, anyone finalizes it, then
  anyone can settle. Epoch's crank finalizes and settles every swap (request #21); the page also offers "Settle
  now". The program keeps the last 16 final values, so a swap must settle within 16 epochs of its index.
- **Payoff** = notional × (final index − fixed) ÷ fixed, sign flipped for Receive fixed, clipped to ± the collateral
  (`swapPnlSol()` in `contracts/epoch-data.ts`, the same as `taker_pnl` in `swap.rs`). Collateral ± payoff and the
  position's rent come back to the wallet in the settle transaction.
- **Hedged flag:** the scorer marks a validator hedged while it holds Receive-fixed swaps on each of the next 5
  epochs, each at least half its average revenue per epoch (plan F7; request #21). Hedged validators borrow up to
  40% of 10 epochs' swept revenue instead of 25%.

Worked example (the fixture): 5 SOL Receive fixed on epoch 1047 at 1,305 µL/CU, 20% max move. Collateral 1.00 SOL.
Final index 1,174.5 (−10%): +0.50 SOL. 1,435.5 (+10%): −0.50 SOL. 1,044 or lower: +1.00 SOL (clipped). The demo
wallet is Fernhill Validator's operator: it already holds 9 SOL Receive-fixed swaps on 1045 and 1046, so the ticket's
example uses 1047.

## Refero lock for this page

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Kraken Pro — BTC-USD trade screen](https://refero.design/pages/cd4884df-7bf5-4c8e-9814-c604e1e9f6f0) · `cd4884df-7bf5-4c8e-9814-c604e1e9f6f0` | The three-column trading layout: order form on the left (side tabs, amount field, estimate rows, one full-width button), the order book in the middle (our quotes by epoch, with the spread line replaced by "now"), the chart on the right with a slim toolbar; the compact status line at the bottom | The purple, order types (limit, stop, TIF), the drawing tools and colour picker, candles, "Verify your account" |
| secondary | [Kraken Pro — trading dashboard](https://refero.design/pages/69751349-05f1-4fee-abac-c5452f01bc17) · `69751349-05f1-4fee-abac-c5452f01bc17` | The one-line KPI strip (already the Terminal's) and the tabbed tables docked at the bottom: Your swaps · Recent swaps · Settlements | Resizable panels, several charts at once |
| secondary | [Reown — Preview swap (dark)](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6) · `7d84a622-9f0f-459a-82a6-5ec05e3dc1a6` | The review step: rows of what will be signed, "Review carefully", Cancel / Sign (the same TxPreview component as the Vault) | Token icons, price impact and slippage rows: the rate is fixed |
| secondary | [Stocktwits — Sentiment Index explainer](https://refero.design/pages/9ede2f3b-2a72-41c5-8e09-19d21483cfdb) · `9ede2f3b-2a72-41c5-8e09-19d21483cfdb` | "How a fee swap works": one paragraph, a tiny payoff scale, one button (the Terminal's Fee Index explainer, reused) | Fear/greed colours |

Run `/refs fee-market` first: it pulls these images through the Refero MCP and writes `design/screens/fee-market.md`.

## Layout (the Terminal page with its Fee Market tab selected)

| # | Block | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Title row | "Terminal" + tabs **Economy · Fee Market** (FM1) + orange "Devnet" badge and the line "Epoch's program runs on devnet for now. Switch your wallet to devnet to sign." + "How it works" | `useFeeMarket()` → `network` | Mercury Insights title row (Terminal) |
| 2 | KPI strip | Fee Index 1,284 µL/CU (epoch 1042, final) · Proposed 1,330 (1043, +3.6%, dispute window ends in 1 h 12 m) · Next quote 1,295 (epoch 1045, closes in 2 h 41 m) · Open interest 226.5 SOL (23 swaps) · Hedged validators 2 · Last settled: epoch 1042, 33.5 SOL, takers −0.19 SOL | `index`, `quotes[]`, `stats` | Kraken Pro KPI strip |
| 3 | **Ticket** (left column, ≈ 300 px; bottom sheet on phones) | Side tabs Receive fixed / Pay fixed with "Gain if fees fall" / "Gain if fees rise" · epoch select (open quotes only) with its fixed rate and room · notional field + chips 1 · 5 · 10 · 25 SOL · estimate rows: Collateral locked · Most you can gain or lose · Payoff at −10% / flat / +10% · Settles after (epoch) · a small payoff line (gain or loss against the final index, flat beyond the clip) · one button. Operators also see **Hedge my next 5 epochs** (Fernhill in the fixture: 9 SOL on each of 1047–1049) | `quotes[]`, `swapCollateralSol()`, `swapPnlSol()`, `hedgeRule`, `myHedge` | Kraken Pro order form |
| 4 | **Quotes by epoch** (middle column, ≈ 320 px) | Open quotes 1045–1049: epoch · fixed rate · vs last final · room left · closes in. A "now" line (epoch 1044 live), then 1044 live, 1043 settling (proposed 1,330), 1042 settled (final 1,284) in a quieter style. Maker shown once on top: "Epoch market maker (seeded)" | `quotes[]` | Kraken Pro order book (rows, mid-line) |
| 5 | **Chart** (right column, the rest) | Fee Index per epoch as bars (final in the info colour, proposed hollow in accent, vetoed hollow grey), dashed 8-epoch average (1,248), then the five open quotes plotted after "now" as a dotted forward line with dots. Toolbar: 16 · 32 epochs. Hover: epoch, value, status; on a quote: fixed rate, room, closes in | `useFeeIndex({ limit: 32 })` → `points[]`; `quotes[]` | Kraken Pro chart panel (no candles, no drawing tools) |
| 6 | Docked tables (full width) | Tabs **Your swaps** (side, epoch, notional, fixed, collateral, status, payoff or estimate, Settle now) · **Recent swaps** (who, side, epoch, notional, fixed, status, payoff) · **Settlements** (epoch, fixed, final index, swaps, notional, net to takers) | `myPositions[]`, `recentSwaps[]`, `quotes[]` (`index`, `swaps`, `netToTakersSol`) | Kraken Pro bottom tabs |
| 7 | Review → wallet → pending → done (in the ticket column; a sheet on phones) | Review rows (TxPreview, FM14): Side · Epoch · Notional · Fixed rate · Collateral locked · Most you can gain or lose · Settles · Network fee · Account rent (back at settlement); the instruction in mono `open_swap(notional: 5 SOL, side: ReceiveFixed)` on quote 1047; "Review carefully. Nothing moves until you sign." Then the progress list and success, exactly like the Vault deposit | epoch-sdk `openSwap` (request #20) → `simulateTransaction` | Reown Preview swap; Copperx flow (Vault) |
| 8 | How a fee swap works (dialog) | The rules above in five lines, the worked example, the payoff scale | static + `quotes[0]` | Stocktwits explainer |

Phones stack: title and tabs → KPI strip (2 × 3) → chart → quotes → docked tables; the ticket is a bottom sheet
opened by "Trade" (pinned).

## Data

`useFeeMarket()` reads `GET /v1/market` (request #19) and returns `FeeMarketSnapshot`, with `myHedge` filled in for a
signed-in operator; it refetches on WS `feeIndex` and on `activity` events of kind `swap`, and after every
transaction. The tab's URL parameters carry their own names so they never collide with the economy view's `range` and
`table`: `?tab=market&side=receive|pay&epoch=<n>&notional=<sol>&mrange=16|32&mtable=mine|recent|settlements`. Until the endpoint ships it returns
`fee-market.sample.json` with the Sample badge. Transactions go straight to the devnet RPC
(`NEXT_PUBLIC_EPOCH_RPC_URL`) through epoch-sdk builders (request #20): `openSwap({ quote, side, notionalSol })`,
`openSwaps([...])` for the five-epoch hedge (one transaction, five `open_swap` instructions) and `settleSwap(swap)`.
Explorer links for anything in the Fee Market go to Solana Explorer with `?cluster=devnet` (decision 24).

## Guardrails

- Every surface says the maker is Epoch's own, seeded: "Quotes come from Epoch's market maker (seeded). There is no
  order book in v1."
- Devnet only until legal review (decision 21): a fee swap is a derivative. The Devnet badge sits by the title, and
  the button says "Switch your wallet to devnet" while the wallet is on another network.
- Disabled states always say why: no quote open, more than the room left, a swap already open on this epoch (it
  can't be changed or added to), not enough SOL for collateral + fee + rent, trading on this epoch closed.
- Words: swap, fixed rate, Fee Index, notional, collateral, hedge, settle, Pay fixed, Receive fixed. Never bet,
  gamble, wager, odds, long or short.
- A rate is always a Fee Index level with its unit (µL/CU), never a %; percentages are moves against a fixed rate.

## Done when

- [ ] Ticket, quotes and chart sit side by side at 1,280 px (Kraken layout); the ticket is a bottom sheet on phones.
- [ ] The worked example above reproduces exactly in the ticket's estimate rows (5 SOL on 1047 at 1,305, 20%: 1.00 SOL
      of collateral, +0.50 / 0 / −0.50 SOL at −10% / flat / +10%).
- [ ] An open → settle round trip on devnet shows the right payoff in Your swaps; design-cop all PASS.

## Live sites to look at (not on Refero)

- [Hyperliquid trade](https://app.hyperliquid.xyz/trade) — a dense ticket beside one chart, positions docked below
- [Pendle](https://app.pendle.finance/trade/markets) — fixed against variable yield, the closest product idea;
  borrow the "fixed vs underlying" pairing, not the look
