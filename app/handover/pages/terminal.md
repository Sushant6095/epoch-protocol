# Terminal · `/terminal`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § Terminal (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** [`2-terminal.jpg`](../design/boards/2-terminal.jpg) shows which numbers, controls and states exist (from the design canvas). It is not the look.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § Terminal, rows TE1–TE32. Each row is a test case.

The older wireframes ([`02-terminal.png`](../design/wireframes/02-terminal.png)) are superseded.

**Job:** Solana's validator economy on one screen, public, no login, and the richest page on the site:
every visitor (staker, validator, lender, judge) finds their common question answered here. It is the page
judges will record, so it must read at 1,280 px. Gate 1 (1 Oct): live on mainnet.

**Users:** judges, researchers, pros; anyone from the landing.

## Refero lock for this page

Style: **Fey** (`08ae8676-eeed-4eba-9835-856c0f25a1d4`, feyapp.com) — pull with `refero_get_style`.

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [Mercury — Insights (dark)](https://refero.design/pages/18cf9c6a-e713-4e47-a3e2-db729d647cc3) · `18cf9c6a-e713-4e47-a3e2-db729d647cc3` | One hero number with its two components beside it (net stake flow · arriving · leaving), Overview / In / Out tabs, a range brush above the chart, a single large chart with a hover card that lists the values for that epoch. | Money-management copy; the left sidebar (Epoch uses a top header). |
| secondary | [Kraken Pro — trading dashboard](https://refero.design/pages/69751349-05f1-4fee-abac-c5452f01bc17) · `69751349-05f1-4fee-abac-c5452f01bc17` | The one-line KPI strip across the top (epoch, slot progress, TPS, Fee Index, vault) and the tabbed tables docked at the bottom (Loan book · Top validators · Biggest delegators). | Order book, drawing tools, candle toolbar, the purple. |
| secondary | [Mercury — Insights with insight cards](https://refero.design/pages/f06ee439-d696-4a31-a32c-1e1b6bdfae35) · `f06ee439-d696-4a31-a32c-1e1b6bdfae35` | Three plain-language insight cards under the chart ('What changed this epoch'). | The decorative illustration in the middle. |
| secondary | [Stocktwits — Sentiment Index explainer](https://refero.design/pages/9ede2f3b-2a72-41c5-8e09-19d21483cfdb) · `9ede2f3b-2a72-41c5-8e09-19d21483cfdb` | A short 'What is this index?' modal: one paragraph, a tiny scale and one button. Use it for the Solana Fee Index explainer. | Fear/greed colours. |

Run `/refs terminal` first: it pulls these images through the Refero MCP and writes `design/screens/terminal.md`.

## Layout, top to bottom (map to the references)

| # | Block | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Title row | "Solana's validator economy, live" + "Updated every slot" + sources pill (hover lists sources and times) | `useNetwork` → `asOf`, `source` | Mercury Insights title row |
| 2 | KPI strip (one line on desktop, 2 × 3 on phones) | SOL staked 441.0M (+0.95M in, −0.97M out) · Validators 683 (7 offline, 136 below break-even) · Median APY 4.95% · Fee Index 1,284 µL/CU (epoch 1042, the latest final value) · Vault 1,633 SOL (senior 1,124, junior 509) · Open advances 8 (190 SOL out, 1 late). First three live; last three Sample | `useNetwork`, `useFeeIndex`, `useVault` | Kraken Pro KPI strip |
| 3 | **Hero: Stake on the move** | One hero number: net stake flow in the CURRENT epoch 1044 (−0.02M SOL) with its two parts beside it (+0.95M arriving, −0.97M leaving) — the same numbers as the KPI strip; Overview / Arriving / Leaving tabs; a range brush above the chart (32/64 epochs); lightweight-charts line of total active stake over the completed epochs 980–1043 plus the current epoch as the last, live bar; SOL starting (accent) and stopping (warn) as histogram bars; hover card lists epoch, total, in, out | hero: `useNetwork` → `epoch.number`, `stake.activatingThisEpochSol`, `stake.deactivatingThisEpochSol`; chart: `useStakeHistory(64)` → `rows[]` + the current epoch from `useNetwork` | Mercury Insights: hero number + brush + one big chart + hover card |
| 4 | Epoch panel | Progress bar, elapsed and left, start and current slot, 432,000 slots, 271.5 epochs a year | `useNetwork` → `epoch.*` + WS `slot` | — |
| 5 | Epoch's cycle now | Where the protocol is in its loop: Collecting → rewards finish → sweeps → accrue → withdrawals paid → Fee Index posted (current step highlighted) | Sample until cranks run | — |
| 6 | Solana Fee Index | Histogram of the index per epoch up to 1043: final bars info, the newest (1043, proposed, in its dispute window) accent; the current epoch has no bar yet; dashed 8-epoch average; "What is this?" opens the explainer dialog | `useFeeIndex` → `points[]` (`status`) | Stocktwits Sentiment Index explainer for the dialog |
| 7 | What changed this epoch | Three plain-language insight cards ("Stake leaving outpaced arriving for the 3rd epoch", …) generated from the data | derived from `useStakeHistory`, `useNetwork` | Mercury Insights cards |
| 8 | Live activity | New rows slide in: sweeps, deposits, advances, withdrawals, Fee Index, Predict calls — amount and explorer link; "Waiting for the next event" when empty | `useActivity` (WS) | — |
| 9 | Network health | Client mix donut (Agave 84.3%, Firedancer 15.7% by stake) · halt risk (18 validators hold a third) · TPS split (47% users, 53% votes) · finality ≈ 8.5 s · 0.02% skipped | `useNetwork` → `clients`, `validators.superminorityCount`, `tps`, `blocks` | — |
| 10 | Tabbed tables (docked at the bottom) | Loan book (all 8 open advances → profile, Sample) · Epochs (last 7: active, arriving, leaving, net, Fee Index; a row moves the chart crosshair) · Top validators by stake (8 rows → profile) · Biggest delegators (5 rows) · Withdrawal queue (Sample) | `useVault` → `advances`, `withdrawQueue`; `useStakeHistory` + `useFeeIndex`; `useTopValidators`, `useBiggestDelegators` | Kraken Pro bottom tabs; OpenSea table density |
| 11 | Quick answers (under the insight cards) | Tabs For stakers · For validators · For lenders, four answers each: a question, one big answer, one line of context, one action (link or in-page switch). Every answer is computed from data already on the page | see TE12 in `11-CLICK-MAP.md` | Mercury insight cards, with a segmented control |
| 12 | Who stakes (three panels) | Who holds the stake (By SOL · By wallets split, same as the landing) · Where retail stakes (six validators with the most wallets) · Validator health (offline, below break-even, one delegator over half, Foundation-dependent, top 18) | `useNetwork` → `delegators.*`, `validators.*`; `useRetailMagnets` | Kraken Pro tiles; OpenSea list density |
| 13 | What it pays (three panels) | What SOL earns (staking median and best vs Senior target and Junior since launch) · Vault pulse (TVL, lenders, lent out vs the 60% cap, share prices, defaults) · Validators over time (2,560 → 795 → 683, dashed because only three counts exist) | `useNetwork` → `stake.*`, `validatorCountHistory`; `useVault` → `pool`, `tranches`, `series` | Mercury Insights cards |

Order and layout come from the Mercury Insights replica (`12-REPLICA-BLUEPRINTS.md` § Terminal): page title and
range controls, KPI strip, Overview / Arriving / Leaving, brush, metric row, one big chart, insight cards, Quick
answers, card rows for the panels, docked tables. Phones stack in that order.

## Interactions

32/64 toggle and the brush on the stake chart; table tabs in the URL (`?table=loans`); every validator
name opens its profile; every activity row and slot opens in the explorer (new tab); hover on any bar
shows epoch, value and unit; the sources pill lists each source with its time.

## States

Charts draw with the last known value while the socket reconnects (live dot greys, "updated N min ago");
the activity feed says "Waiting for the next event" when empty; Sample blocks keep their badge until the
program's accounts exist on the connected network, then switch to live automatically. Skeletons in the
exact chart and tile shapes. Error: a quiet inline card "Couldn't load stake history — retry".

## Motion

Only the live dot, the epoch countdown and the activity ticker move while idle. KPI values roll on change
(number-flow) with the 180 ms up/down tint. New activity rows slide in (200 ms, transform/opacity). No WebGL.

## Done when

- [ ] One hero (the stake chart) that is readable in a 1,280 px screen recording; nothing else competes.
- [ ] Six KPIs in one line at ≥ 1,280 px, 2 × 3 on phones, units and signs on every value.
- [ ] Fee Index switched to `GET /v1/index` when available (others on fixtures until their endpoints land).
- [ ] No chart canvas at 300 × 150 (screenshot guard), design-cop all PASS, axe and impeccable clean.

## Live sites to look at (not on Refero)

- [Hyperliquid trade](https://app.hyperliquid.xyz/trade) — a dense top strip, one big chart, tabbed tables underneath
- [Orb](https://orbmarkets.io) — the epoch page and the live transaction feed
- [DefiLlama Solana](https://defillama.com/chain/solana) — one clear chart over a ranking table
- [Jito StakeNet](https://www.jito.network/stakenet/) — the "current state of the cycle" card
