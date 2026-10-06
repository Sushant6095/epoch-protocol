# Validators · `/validators`

**Look:** replicate this page's Refero screens region by region: [`12-REPLICA-BLUEPRINTS.md`](../12-REPLICA-BLUEPRINTS.md) § Validators (method: the `refero-replica` skill; check with `scripts/ui/ref-compare.mjs`). Epoch keeps its own colours, fonts, logo, words and data.

**Content map:** [`3a-validators.jpg`](../design/boards/3a-validators.jpg) shows which numbers, controls and states exist (from the design canvas). It is not the look.

**Every click:** [`11-CLICK-MAP.md`](../11-CLICK-MAP.md) § Validators, rows VE1–VE41. Each row is a test case.

The older wireframes ([`03-validators.png`](../design/wireframes/03-validators.png)) are superseded.

**Job:** judge all 683 validators on health, not just APY, and send delegators to the right profile.

**Users:** delegators choosing where to stake; judges; operators checking their rank.

## Refero lock for this page

Style: **OpenSea** (`2465f692-3a79-4576-970c-ee56c1e72375`, opensea.io) — pull with `refero_get_style`.

| Role | Screen | Take | Don't take |
| --- | --- | --- | --- |
| primary | [OpenSea — Collection stats (dark)](https://refero.design/pages/52465519-ed54-42b3-95db-30226a52fe32) · `52465519-ed54-42b3-95db-30226a52fe32` | Title, Top / Trending / Watchlist tabs, a category dropdown + chip group + time-range segment on one row, sortable columns with the sort arrow on the active one, a star to watch a row, numbers right-aligned in mono. | Big square thumbnails (use a 24 px initials avatar), red for negatives (we use a sign + orange). |
| secondary | [Stocktwits — trending table (dark)](https://refero.design/pages/7e48ec24-1285-410c-8b9d-865dafa2862b) · `7e48ec24-1285-410c-8b9d-865dafa2862b` | A sparkline column inside the table (stake over 8 epochs) and the sub-tabs pattern (Healthy · Below break-even · One delegator over 50%). | The social sidebar. |
| secondary | [Kraken — market filters](https://refero.design/pages/0bfeff29-e274-4df6-9006-775da4955138) · `0bfeff29-e274-4df6-9006-775da4955138` | Column filter popovers for the advanced filters (client, country, commission range). | The light theme. |
| secondary | [Kraken Pro — market finder with chips](https://refero.design/pages/c7c156f4-429d-41d2-ba4f-8ad2478cf703) · `c7c156f4-429d-41d2-ba4f-8ad2478cf703` | Chip row with a toggle for 'show as cards' — our phone layout switches rows to cards. | Pair tickers. |

Run `/refs validators` first: it pulls these images through the Refero MCP and writes `design/screens/validators.md`.

## Layout, top to bottom (map to the references)

| # | Block | What it shows | Data (hook → field) | Reference region |
| --- | --- | --- | --- | --- |
| 1 | Title row | "Validators" + "judged on health, not just APY" + Export CSV + Set an alert | — | OpenSea title |
| 2 | Five tiles that filter | 683 (7 offline) · Top-18 control 1/3 (tap hides them) · Median APY 4.95% (tap sorts by APY) · Below break-even 136 · Hang on one delegator 338 | `useNetwork` → `validators.*`, `stake.medianApyPct` | — |
| 3 | Tabs + filter row | Tabs: All · Healthy · Watch · Watchlist (starred). One row: search (name or vote account) · chip group (Below break-even, One delegator over 50%, Hide top-18, Firedancer, 0% commission) · range segment for the sparkline (8 · 32 · 64 epochs) · sort dropdown (Stake, APY, Delegators, Epoch Score, Health) | nuqs URL state | OpenSea Top/Trending/Watchlist + dropdown + chip group + time segment on one row |
| 4 | **Hero: the table** | Compare checkbox · # · name (24 px initials avatar, short vote key, client badge, country code, TOP-18 badge) · Epoch Score ring · APY with staking + tips split in a tooltip · fee · stake · stake sparkline (from `stakeHistorySol`; hidden until the API sends it — fixtures do not have it) · delegators with DependencyBar (warn over 50%) · blocks/day · health per epoch in SOL (warn and a minus sign when negative) · uptime · star (watch) · View | `useValidators` → `rows[]` | OpenSea rows (rank, sort arrows, star); Stocktwits sparkline column; Kraken column filter popovers |
| 5 | Footer + legend | "Showing N of 683" + Load 50 more (or infinite scroll); one-line definitions of Epoch Score, Health, Biggest share, APY split | — | — |
| 6 | Compare tray | Floats at the bottom once one row is ticked; up to 3 (decision 14); "Compare side by side" opens a sheet with the chosen validators in columns | zustand | — |

Epoch Score here is the program's formula: vote credits up to 60, commission up to 25, tenure up to 15; 0
when delinquent; capped at 50 for the top 18. Commission counts as the higher of the inflation commission and
the MEV commission, so the list needs `mevCommissionPct` (request #5b) to match the profile (open decision 11).
Explain it in a tooltip on the column header.

## Table behaviour

- TanStack Table v9 + TanStack Virtual (683 rows, 1,000+ with zero-stake validators); sticky header; sort
  arrow rotates on the active column; numbers right-aligned in mono; row hover lifts the background; the
  whole row is a link to `/validators/[vote]` (with the checkbox and star as separate controls).
- Filters, tabs, sort and range live in the URL: `/validators?tab=healthy&chips=zero-fee,hide-top18&sort=apy`.
- Phones (< 768 px): rows become cards (name + score ring + APY + health badge + stake), filters move into
  a vaul sheet, the compare tray becomes a bottom bar.

## States

Skeleton rows (10) on first load; empty state for a filter with no matches ("No validator matches these
filters — clear one"); error card with retry; a validator without a name shows its short vote key.

## Done when

- [ ] The table is the obvious hero; tiles and filters are quieter.
- [ ] Sorting, filters, tabs and range survive a reload (URL) and the back button.
- [ ] Scrolling 683 rows stays at 60 fps (virtualised); the star and compare do not trigger row navigation.
- [ ] design-cop all PASS (tables usable at sm), axe and impeccable clean.

## Live sites to look at (not on Refero)

- [Stakewiz](https://stakewiz.com) — filters that answer delegator worries, the score
- [validators.app](https://www.validators.app/validators?network=mainnet) — dense validator rows
- [Jito StakeNet](https://www.jito.network/stakenet/) — comparing up to five validators
- [Hyperliquid staking](https://app.hyperliquid.xyz/staking) — a validator table that stays calm at high density
