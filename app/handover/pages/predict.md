# Predict · `/me#predict`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § Predict (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** [`4-my-stake.jpg`](../design/boards/4-my-stake.jpg) shows which numbers, controls and states exist (from the design canvas). It is not the look.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § My Stake, rows MS42–MS55. Each row is a test case.

The older wireframes ([`05-my-stake-signed-in.png`](../design/wireframes/05-my-stake-signed-in.png)) are superseded.

**Job:** let a signed-in delegator make a small SOL *call* on an epoch outcome without a second login.
Legally gated (open decisions 2 and 3): build it behind a feature flag with a points-only mode; launch
with the Fee Index market only unless cleared.

**Users:** signed-in delegators aged 18+ in allowed regions; everyone else can browse read-only.

## Refero lock for this page

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Stocktwits — poll card on an asset page (dark)](https://refero.design/pages/50c3c89d-5cb1-4aa3-8082-9b4ef3ce30d0) · `50c3c89d-5cb1-4aa3-8082-9b4ef3ce30d0` | Question, one bar per outcome with its share, total votes and time left, sitting inside a data page rather than a casino lobby. Our card: question, YES/NO bar with pool share, pool in SOL, players, closes with epoch N. | The social feed, bullish/bearish buttons, the green 'Trade' button. |
| secondary | [Kraken Pro — order form](https://refero.design/pages/cd4884df-7bf5-4c8e-9814-c604e1e9f6f0) · `cd4884df-7bf5-4c8e-9814-c604e1e9f6f0` | The ticket: a two-way toggle (YES / NO), amount input with preset chips, an estimate line, one full-width button. | Limit/stop order types. |
| secondary | [Coinbase Advanced — gated ticket](https://refero.design/pages/c2dbc562-373b-4790-b6dd-fa8ac6cf2c59) · `c2dbc562-373b-4790-b6dd-fa8ac6cf2c59` | The ticket replaced by a calm blocking state with one button: our 18+ and region check, and 'Connect wallet to call'. | KYC wording. |
| secondary | [Reown — Preview swap (dark)](https://refero.design/pages/7d84a622-9f0f-459a-82a6-5ec05e3dc1a6) · `7d84a622-9f0f-459a-82a6-5ec05e3dc1a6` | The approve step: rows of what will be signed (market, side, amount, network fee, refund if cancelled), 'Review carefully', Cancel / Confirm. | Swap wording. |

Run `/refs predict` first: it pulls these images through the Refero MCP and writes `design/screens/predict.md`.

## Layout (inside My Stake, below the healthier-homes section)

| # | Block | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Section title | "Predict" + "18+ · where allowed" + "Cap 5 SOL per call" + "Settles by Panta" | `usePredict` → `rules` | — |
| 2 | **Hero: market cards** (grid of 4, one featured) | Question · YES/NO bar with the pool share (62% / 38%) · pool 318 SOL · 1,204 players · "Closes with epoch 1045" + live countdown · answer source · now-note ("7 validators delinquent now") | `markets[]` | **Stocktwits poll card** (question, one bar per outcome with share, votes, time left) |
| 3 | Ticket (ActionPanel on desktop, bottom sheet on phones) | Three states: **pick** (market, YES or NO toggle, 0.1 / 0.5 / 1 / 2 / 5 SOL chips, payout preview, "Fee TBD") → **approve** (TxPreview: escrow, amount, network fee, refund if cancelled; Cancel / Confirm) → **done** ("Settles when epoch 1045 ends; winnings arrive automatically") | `rules`, `parimutuelPayout()` | Kraken Pro order form; Reown Preview swap for approve; Coinbase gated ticket for the 18+/region/connect gate |
| 4 | Your calls | Newest first: market, side, amount, status (Open, Settling, Won, Lost), estimate or result | `myCalls[]` | Mercury transactions rows |
| 5 | Leaderboard | Top 5 by profit with hit rate and calls; your own row pinned if ranked | `leaderboard[]` | OpenSea ranked rows |

Payout preview for a parimutuel pool, before fees: `payout = a · (P + a) / (s · P + a)` where a is the
amount, P the pool and s the chosen side's share. 1 SOL on YES at 62% of 318 SOL → ≈ 1.61 SOL. The helper
`parimutuelPayout(a, P, s)` is in `contracts/epoch-data.ts`.

## Guardrails (part of the design, not an afterthought)

- An 18+ and region check before the first call (the Coinbase-style gate replaces the ticket until passed).
- Per-call cap (5 SOL) and a per-epoch cap the user can lower in Alerts/settings.
- Read-only mode can browse markets but never call. Points-only mode shows the same UI with points.
- Copy: "call", "market", "pool", "payout". Never "bet", "gamble", "wager" or "odds" — not in UI copy,
  code names or comments.

## Done when

- [ ] The market card is the hero; the ticket never opens a second modal on top of a modal.
- [ ] Gate, caps, "18+ · where allowed" and "Fee TBD" visible on every Predict surface.
- [ ] Feature flag off → the section is hidden or shows points-only; design-cop all PASS.

## Live sites to look at (not on Refero)

- [Hyperliquid leaderboard](https://app.hyperliquid.xyz/leaderboard) — a ranked table with your own row pinned
- Prediction-market yes/no cards in general (Polymarket is the familiar one) — build an original card; do not copy its layout or branding
