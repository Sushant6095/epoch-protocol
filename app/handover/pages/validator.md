# Validator profile (+ Manage tab) · `/validators/[vote]`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § Validator profile (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** [`3b-validator-profile.jpg`](../design/boards/3b-validator-profile.jpg) shows which numbers, controls and states exist (from the design canvas). It is not the look.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § Validator profile, rows VP1–VP48 (VP23–VP25 and VP37–VP48 are the Manage tab and the borrow flow). Each row is a test case.

The older wireframes ([`04-validator-profile-overview.png`](../design/wireframes/04-validator-profile-overview.png), [`04b-validator-profile-manage-tab.png`](../design/wireframes/04b-validator-profile-manage-tab.png)) are superseded.

**Job:** tell one validator's whole story, and — for its operator only — become the borrowing console.
This page follows the **north star** (Wealthsimple NVDA, dark): content on the left, one action panel
docked on the right, details in a calm grid below. Shown with real NTT DOCOMO GLOBAL data.

**Users:** delegators deciding to stake; the operator (Manage tab); judges following a row from the Terminal.

## Refero lock for this page

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Wealthsimple — NVDA stock page (dark)  ← NORTH STAR](https://refero.design/pages/47b50f40-2189-480a-8279-8d1796ddf5eb) · `47b50f40-2189-480a-8279-8d1796ddf5eb` | Identity row with a watch star; one hero number with its change; one chart with a hover crosshair and date label; a time-range segment under the chart; a sticky action card on the right (form rows, an estimate line, one full-width button); a four-column key-value grid ('Market details' → 'Validator details'); news cards → stake moves; an About block. | The options promo card, the warm brown background (we use our tokens). |
| flow | [Wealthsimple flow 8510 · step 3 — order preparation](https://refero.design/pages/363e96ab-a3d1-4eb0-bbfb-1d9e4b0052d8) · `363e96ab-a3d1-4eb0-bbfb-1d9e4b0052d8` | How the page tightens when the action panel is in use: compact chart, the panel stays in view. | — |
| secondary | [Stocktwits — sentiment gauge explainer (dark)](https://refero.design/pages/857d5d0b-390b-4e95-a4a7-dd298180b8e7) · `857d5d0b-390b-4e95-a4a7-dd298180b8e7` | A gauge-in-a-modal that explains a 0–100 score with its bands: our Epoch Score and health explainer. | Red-to-green gauge colours. |
| secondary | [Mercury — Financing (working capital)](https://refero.design/pages/7afb3554-b9d2-4634-bb44-01c9afd4146f) · `7afb3554-b9d2-4634-bb44-01c9afd4146f` | The Manage tab for operators: outstanding balance, a repayment progress bar (repaid vs outstanding), 'N payments left', an upcoming-payments table (epoch · remit · ending balance) and an activity table. | The light theme and banking copy. |

Run `/refs validator` first: it pulls these images through the Refero MCP and writes `design/screens/validator.md`.

## Layout (desktop: 8 + 4 columns; the right column is the sticky ActionPanel)

| # | Block | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Header | Breadcrumb (Validators / name) · initials avatar · name · vote and identity keys with Copy · tags (client version, city, host, Jito fee, Foundation-backed, epochs active) · star (watch) · "View on" menu (six explorers) | `useValidator(vote)` → `name`, `vote`, `identity`, `tags` | Wealthsimple identity row with the star |
| 2 | **Hero** | One hero number: Epoch Score (ring) beside active stake 193,097 SOL (+1,121 this epoch); under it the four gauges (Epoch Score 100 · vote credits 99.96% · skipped blocks 0% · uptime 30 d 100%) as a quiet row | `gauges`, `tiles` | Wealthsimple hero price + change; Stocktwits gauge explainer on click |
| 3 | Chart | Stake by epoch (lightweight-charts area), range segment under it (8 · 32 · All epochs), hover crosshair with epoch and value | `stakeByEpoch` | Wealthsimple chart + range segment |
| 4 | Tabs (URL `?tab=`) | Overview · Revenue · Delegators · Epoch credit · Manage (operator only) | — | — |
| 4a | Overview | Four tiles: active stake · APY 4.94% (4.80 + 0.14 tips) · 1,988 delegators (42% from one) · 135 blocks a day; voting credits over 7 epochs against the 6,912,000 maximum; commission history | `tiles`, `voteCreditsByEpoch`, `commission` | Wealthsimple "Market details" 4-column grid |
| 4b | Revenue | What it kept in epoch 1043: inflation commission 1.74, tips commission 0.15, block fees ≈ 2.4 (estimate), vote fees −2.16, net ≈ +2.1 SOL; break-even bar (≈ 87,000 SOL vs 193,097); tips per epoch bars | `revenueEpoch1043Sol`, `jitoTipsTotalByEpochSol`, `network.breakEvenStakeSol` | — |
| 4c | Delegators | Split: Foundation 42.1%, liquid-staking pools 28.3%, 1,986 other wallets 29.6%; "if the biggest delegator left" → ≈ 111,800 SOL, survives; this epoch +1,127 in, −5.8 out; median wallet 1.86 SOL | `delegatorSplit`, `ifBiggestDelegatorLeftSol`, `thisEpoch`, `medianWalletSol` | — |
| 4d | Epoch credit | For a validator not yet onboarded: sweepable ≈ 1.89 SOL per epoch, 18.9 over 10 epochs, limit ≈ 4.7 SOL (25%) or ≈ 7.6 hedged (40%); the four covenants | `creditEstimate` | — |
| 4e | Manage (operator only) | Outstanding advance, repayment progress bar (repaid vs outstanding), "N epochs left", upcoming remittances table (epoch · remit · ending balance), activity table; or, before onboarding, "Onboard in one transaction" (hand over the withdraw key, point collectors at the escrow, post a bond) | `useOperatorPosition(vote)` → `state`, `limit`, `onboardingSteps`, `advance.schedule`, `advance.activity`, `covenants` (fixture `operator-position.sample.json`: NTT DOCOMO before onboarding, Northwind with an open advance) | **Mercury Financing** `7afb3554` |
| 5 | Stake moves (under every tab) | Every stake account that started or stopped delegating in the last two epochs: epoch, in/out, SOL, from, wallet, Orb link | `stakeMoves[]` | Mercury transactions list density |
| 6 | About | Operator description, website, where it runs | validators.app / Stakewiz (API) | Wealthsimple About block |
| R | **ActionPanel (right, sticky)** | For everyone: **Stake with this validator** (amount, "you'd earn ≈ X SOL a year at 4.94%", button → My Stake flow). For the operator: **Borrow** (slider up to the limit; fee 2%, total due, share taken per epoch 50%, epochs to repay) → TxPreview → wallet → pending → done with explorer link | `creditEstimate`, `tiles.apyPct` | Wealthsimple Buy card (form rows, estimate line, one full-width button); Wealthsimple flow 8510 step 3 |

## Rules

- The Manage tab renders ONLY when the connected wallet is the operator (`ValidatorPosition.operator`,
  or the vote account's withdraw authority before onboarding). Everyone else never sees it.
- A validator with fewer than 3 epochs of swept revenue shows "Credit starts after 3 epochs" instead of
  the slider. Below `min_score` (60) the Borrow button is disabled with the reason.
- The borrow flow: amount → review (fee, due, remit, covenants) → sign in wallet → pending until confirmed
  → done with an explorer link. Rejection and timeout both return to review with a quiet message.

## States

Skeleton for header, hero and chart; unknown validator → 404 page with search; delinquent validator →
warn banner "Offline — not voting" at the top and the score shows 0 with the reason.

## Phones

Hero and chart first; the ActionPanel becomes a bottom sheet opened by a pinned "Stake" (or "Borrow")
button; tabs scroll horizontally; tables become stacked rows.

## Done when

- [ ] Reads like the north star: identity → one hero → one chart → action panel → calm details.
- [ ] Every number has units, sign and timestamp tooltip; explorer links resolve for NTT DOCOMO's keys.
- [ ] Manage tab invisible to non-operators (test with a different wallet).
- [ ] design-cop all PASS, axe and impeccable clean.

## Live sites to look at (not on Refero)

- [Orb](https://orbmarkets.io) — the vote-account header, "View on" explorers and account history
- [Stakewiz](https://stakewiz.com) — the gauges
- [Jito's scoring page](https://www.jito.network/docs/stakenet/jito-steward/validators/scoring-system/) — how to explain a score
