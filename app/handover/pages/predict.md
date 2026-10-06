# Predict · `/predict`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § Predict (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** [`4-my-stake.jpg`](../design/boards/4-my-stake.jpg) shows which numbers, controls and states exist (from the design canvas). It is not the look. The board was drawn before 1 Oct: where it shows SOL, a fee or Panta, this spec wins.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § My Stake, rows MS42–MS55. Each row is a test case.

The older wireframes ([`05-my-stake-signed-in.png`](../design/wireframes/05-my-stake-signed-in.png)) are superseded.

**Job:** let a signed-in wallet make a *call* in points on an epoch's Fee Index, with no second login and no
wallet transaction. Points only for v1 (decisions 2 and 3, settled 1 Oct): no real SOL, no fee, Fee Index
markets only. The Panta / real-SOL path stays in the code behind the flag `PREDICT_REAL_SOL` (off) until there
is legal advice. Predict has its own route since 30 Sep: `/predict` (`/me#predict` redirects here).

**Users:** signed-in wallets, 18+ and where allowed; everyone else can browse read-only.

## Points rules (decision 2, settled 1 Oct)

- Every signed-in wallet gets **100 points each epoch** to call with. Unused points do not carry over.
- A call puts **10, 25, 50 or 100 points** on YES or NO.
- When the market resolves from the **final** Fee Index value (after its dispute window), the losing side's
  points are shared among the winners in proportion to their calls. No fee.
- The leaderboard ranks **net points won over the last 30 epochs**.
- Points have **no cash value** and cannot be bought, sold or transferred.
- Points won count for the **leaderboard only**: every wallet still gets 100 fresh points each epoch (decision 23).
- If nobody called the winning side, **every call in that market is refunded**. A vetoed Fee Index keeps the market
  in Settling until the next proposal turns final (decision 23).
- A call needs the sign-in session (SIWS) but **no wallet transaction**. Data: `usePredict()` reads
  `GET /v1/predict/markets` and `GET /v1/predict/leaderboard`; a call is `POST /v1/predict/calls
  { marketId, side, points }` (all served by `api_app` in points mode, request #11).

## Refero lock for this page

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Stocktwits — poll card on an asset page (dark)](https://refero.design/pages/50c3c89d-5cb1-4aa3-8082-9b4ef3ce30d0) · `50c3c89d-5cb1-4aa3-8082-9b4ef3ce30d0` | Question, one bar per outcome with its share, total votes and time left, sitting inside a data page rather than a casino lobby. Our card: question, YES/NO bar with pool share, pool in points, players, closes with epoch N. | The social feed, bullish/bearish buttons, the green 'Trade' button. |
| secondary | [Kraken Pro — order form](https://refero.design/pages/cd4884df-7bf5-4c8e-9814-c604e1e9f6f0) · `cd4884df-7bf5-4c8e-9814-c604e1e9f6f0` | The ticket: a two-way toggle (YES / NO), preset chips (our four call sizes in points), an estimate line, one full-width button. | Limit/stop order types, a free amount field. |
| secondary | [Coinbase Advanced — gated ticket](https://refero.design/pages/c2dbc562-373b-4790-b6dd-fa8ac6cf2c59) · `c2dbc562-373b-4790-b6dd-fa8ac6cf2c59` | The ticket replaced by a calm blocking state with one button: our 18+ and region check, and 'Connect wallet to call'. | KYC wording. |
| secondary | [Reown — Preview swap (dark)](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6) · `7d84a622-9f0f-459a-82a6-5ec05e3dc1a6` | The review step: rows of what the call does (market, side, points, payout if right, points left this epoch), 'Review carefully', Cancel / Confirm. | Swap wording, the network fee row: nothing is signed in points mode. |

Run `/refs predict` first: it pulls these images through the Refero MCP and writes `design/screens/predict.md`.

## Layout (its own page, `/predict`)

| # | Block | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Section title | "Predict" + "Points only · no cash value" + "100 points an epoch" + "18+ · where allowed" + "Settles from the final Fee Index" | `usePredict` → `rules` | — |
| 2 | **Hero: market cards** (grid of 4, one featured) | Fee Index markets only. Question · YES/NO bar with the pool share (62% / 38%) · pool 31,800 points · 1,204 players · "Closes with epoch 1045" + live countdown · answer source (the final Fee Index value) · now-note. The other cards are earlier epochs' markets: closed and waiting for the final value ("Proposed 1,330 µL/CU, in its dispute window"), or settled with the answer | `markets[]` | **Stocktwits poll card** (question, one bar per outcome with share, votes, time left) |
| 3 | Ticket (ActionPanel on desktop, bottom sheet on phones) | Three states: **pick** (market, YES or NO toggle, 10 / 25 / 50 / 100 point chips, "50 of 100 points left this epoch", payout preview in points) → **review** (market, side, points, payout if right, points left after the call, settles when the market's Fee Index turns final; "Nothing is signed: a call uses points"; Cancel / Confirm call) → **done** ("Your call is in. It settles when epoch 1045's Fee Index turns final.") | `rules`, `parimutuelPayout()`; `POST /v1/predict/calls` | Kraken Pro order form; Reown Preview swap for review; Coinbase gated ticket for the 18+/region/connect gate |
| 4 | Your calls | Newest first: market, side, points, status (Open, Settling, Won, Lost), estimate or net points | `myCalls[]` | Mercury transactions rows |
| 5 | Leaderboard | Top 5 by net points won over the last 30 epochs, with hit rate and calls; your own row pinned if ranked | `leaderboard[]` (`GET /v1/predict/leaderboard`) | OpenSea ranked rows |

Payout preview for a parimutuel pool, in points and with no fee: `payout = a · (P + a) / (s · P + a)` where a is
the points called, P the pool and s the chosen side's share. 100 points on YES at 62% of 31,800 points → ≈ 161
points (net +61). The helper `parimutuelPayout(a, P, s)` is in `contracts/epoch-data.ts`.

## Guardrails (part of the design, not an afterthought)

- Points only: no SOL amount, no fee, no wallet prompt and no Panta anywhere on Predict while
  `PREDICT_REAL_SOL` is off. "Points have no cash value and can't be bought, sold or transferred" sits on
  every Predict surface.
- An 18+ and region check before the first call (the Coinbase-style gate replaces the ticket until passed);
  it stays in points mode.
- Call sizes 10, 25, 50 and 100; a size above the points left this epoch is disabled with the reason.
- Read-only mode can browse markets but never call.
- Copy: "call", "market", "pool", "payout", "points". Never "bet", "gamble", "wager" or "odds" — not in UI
  copy, code names or comments.

## Done when

- [ ] The market card is the hero; the ticket never opens a second modal on top of a modal.
- [ ] "Points only · no cash value", "18+ · where allowed" and the points left this epoch visible on every
      Predict surface; no SOL, fee or Panta anywhere.
- [ ] A call goes through `POST /v1/predict/calls` with the session and never opens the wallet; design-cop all
      PASS.

## Live sites to look at (not on Refero)

- [Hyperliquid leaderboard](https://app.hyperliquid.xyz/leaderboard) — a ranked table with your own row pinned
- Prediction-market yes/no cards in general (Polymarket is the familiar one) — build an original card; do not copy its layout or branding
