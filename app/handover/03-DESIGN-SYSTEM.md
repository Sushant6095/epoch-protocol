# 03 · Design system

Source files: `handover/design/tokens.css` (the only place raw colours live), `handover/design/globals.css`
(Tailwind v4 + shadcn mapping + utilities), `handover/design/motion.ts` (timing), `handover/design/lib/gsap.ts`
and `handover/design/lib/anime.ts`.
Copy them to `src/styles/`, `src/design/` and `src/lib/` on day one; every screen uses them.

## Where the look comes from

- **Structure** of each page: its locked Refero screens (`06-REFERO-SCREENS.md`).
- **Visual language:** the Refero styles *Hyper Foundation* (hyperliquid.xyz: deep green-black, one mint
  accent, serif display over sans) for the landing and brand; *Fey* (near-black layers, one interaction
  colour, 16 px cards, 18/20 px padding) for app surfaces; *OpenSea* ("midnight data console": compact
  rows, mono numbers) for tables.
- **Why not near-black + acid green:** `docs/UI_SOURCES.md` §3 found that praised terminals use deep
  green-black with a mint accent (Hyperliquid) or graphite with one blue (Polymarket), and that
  near-black with a single acid green reads as generic AI output.

## Themes

Two dark themes, same variable names, same meanings. `<html data-theme="emerald" className="dark">`.

| Token | emerald (default) | graphite (canvas v1) | Use |
| --- | --- | --- | --- |
| `--ep-bg` | #050E0C | #0A0D10 | page |
| `--ep-bg-bar` | #040B09 | #0B0F13 | footer strip, ticker |
| `--ep-inset` | #07120F | #0E1318 | wells in cards, input fill |
| `--ep-surface` | #0A1714 | #10151A | cards, tiles, menus, table body |
| `--ep-hover` | #0E1F1B | #121A20 | row hover, pressed ghost button |
| `--ep-raised` | #10241F | #151C23 | popovers, dialogs, the sticky action panel |
| `--ep-line` | #15302A | #1E2730 | card borders, dividers, empty bar tracks |
| `--ep-line-strong` | #23524C | #2A3642 | pills, chips, ghost buttons |
| `--ep-field-border` | #3E8276 | #5B6E80 | inputs, selects, checkboxes (≥ 3:1) |
| `--ep-text` | #E8F1EE | #E8ECEA | primary text |
| `--ep-text-2` | #C2D3CE | #C9D2D6 | body copy on cards |
| `--ep-muted` | #8AA59E | #93A0A8 | labels, captions, axes (≥ 6.4:1) |
| `--ep-accent` | #97FCD7 mint | #A3E35F lime | primary action, positive, live, senior, focus |
| `--ep-accent-ink` | #03201A | #0A1205 | text on an accent fill |
| `--ep-accent-soft` / `-line` | #0F2A24 / #2B5E52 | #1B2A14 / #2E4A1E | selected chip, success panel |
| `--ep-info` | #7DB9FF | #6CB2FF | second series, info, junior |
| `--ep-warn` | #F5A55B | #F59E4B | watch, late, top-18, Sample badge, losses |
| `--ep-warn-soft` / `-line` | #1F170D / #5A3A1A | #1A130B / #5A3A1A | warning banner |

No red anywhere: losses and "watch" use warn (orange), which also reads for red-green colour blindness.
Colour never carries meaning alone — badges have words, changes have a sign (+/−) or an arrow.

Tailwind utilities (from `globals.css`): `bg-ep-surface`, `bg-ep-inset`, `border-ep-line`,
`text-ep-muted`, `text-ep-accent`, `bg-ep-warn-soft`, `shadow-ep-glow` (landing hero card only),
`ease-ep-out`, `animate-ep-pulse` (live dot). shadcn classes (`bg-card`, `text-muted-foreground`,
`bg-primary`, `border-input`, `ring-ring`) already point at the tokens. Custom utilities: `num` (mono,
tabular, slashed zero), `label-caps` (11 px mono uppercase label), `accent-serif`, `page-gutter`.

## Type

Load with `next/font/google` in `src/app/layout.tsx` (no extra packages):

```tsx
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
const sans = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["italic"], variable: "--font-instrument-serif" });
// <html lang="en" data-theme="emerald" className={`dark ${sans.variable} ${mono.variable} ${serif.variable}`}>
```

| Role | Face | Size / line | Notes |
| --- | --- | --- | --- |
| Hero line (landing) | Geist 600 + one Instrument Serif italic phrase | 56/60 (40/44 on phones) | "The revenue desk for *Solana validators.*" |
| Page title (H1) | Geist 600 | 32/40 | One per page |
| Section title (H2) | Geist 600 | 20/28 in app, 34–44 on landing | |
| Card title | Geist 500 | 16/24 | |
| Body | Geist 400 | 14/22 (15/24 on landing) | text-2 colour on cards |
| KPI value | Geist Mono 500, tabular | 28/32 (hero number 44/48) | number-flow roll on change |
| Table numbers | Geist Mono 400, tabular, right-aligned | 13/20 | |
| Labels | Geist Mono 500, uppercase, 0.08em | 11/16 | `label-caps` |

## Space, shape, size

- 4 px base: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 56 · 72. Card padding 16–24 (20 is the default).
  Gaps: 12 between cards, 40–72 between page sections. Design width 1440; gutter 32 (16 on phones).
- Radii: cards 12 · buttons and inputs 10 · chips 8 · pills and badges full.
- Heights: header 64 · footer 44 · buttons 44 (primary in heroes and action panels 52) · chips 34 ·
  table rows 48 (dense 40) · nothing clickable under 44 on touch. shadcn 4 `base-nova` ships 32 px buttons
  and 8 px tab triggers: change the size variants in `src/components/ui/button.tsx` and `tabs.tsx` once,
  right after adding them (seen in the dry run).
- Elevation by surface step (bg → surface → raised), hairline borders, no drop-shadow spam; the only glow
  is the landing hero card.

## Components to build once (and where they appear)

| Component | Where | Notes |
| --- | --- | --- |
| App header, EpochRing, EpochPill | All pages | Ring fills with epoch progress; pill has live dot + countdown |
| KPI tile | All pages | label-caps, big mono number, one sub-line, Sample badge slot, timestamp tooltip |
| Card | All pages | surface + line border + radius 12; title row with optional pill on the right; never nested |
| Pill, badges | All pages | Neutral pill; Sample (warn) and Live (accent) badges; status (Active, Late, Repaid, Won, Lost) |
| Segmented control | Units, chart ranges, sorts | Mono 12, selected state filled |
| Tabs | Terminal tables, profile, Vault tables | Underline tab, accent rule under the selected one, state in URL |
| Data table | Terminal, Validators, profile, My Stake, Vault | Mono numbers right-aligned, two-line name cells, row hover, sticky header, virtual rows > 50 |
| Progress bar | Loans, epoch, room left | 6 px track, colour = status |
| ScoreRing, gauges | Validators, profile | Small ring for Epoch Score; semicircle gauges for the four health gauges |
| Charts | Terminal, profile, My Stake, Vault | lightweight-charts for time series; Recharts for small bars; visx for the waterfall |
| ActionPanel | Profile (Stake/Borrow), Vault (Deposit), Predict (Call) | Docked right on desktop, bottom sheet on phones; form → preview → wallet → done, all inline |
| TxPreview | Every transaction | Program, accounts that matter, amounts, network fee, refund/unlock rules |
| Alert banner | My Stake | Warn; one sentence, one sub-line, one button |
| WalletSignIn | Sign in | Wallet rows 56 px; SIWS message in mono before signing |
| Switch | Alerts | Real checkbox semantics with switch styling |
| Skeleton | Everywhere | Shimmer in the exact shape of the content; never a spinner on a number |

## Numbers

- SOL: up to 2 decimals for amounts ≥ 1 (`1,124.00 SOL` → `1,124 SOL` when whole), 3–4 decimals under 1
  (`0.422 SOL`); compact above a million in tiles (`441.0M SOL`), full in tooltips.
- Percentages: 2 decimals for APY (`4.95%`), 1 for shares (`42.1%`). Signs on every change (`+0.95M`,
  `−0.97M` with a true minus sign).
- Missing value: "—". Never 0 for unknown. Every number has a tooltip with its source and time.
- Value-changed tint: 180 ms accent (up) or warn (down) flash that re-fires on every change — use the
  `flash-host` utility (an overlay whose opacity animates, so it stays inside the transform/opacity law)
  and set `data-flash="up" | "down"` for one frame.

## Charts (lightweight-charts 5)

Read colours from CSS variables at mount (`getComputedStyle(document.documentElement)`), never hex:
background transparent, grid `--ep-chart-grid`, text `--ep-muted`, crosshair `--ep-chart-crosshair`,
series 1 `--ep-chart-1`, series 2 `--ep-chart-2`, negatives/outflow `--ep-chart-3`. Update live data
with `series.update()` only. Keep the TradingView attribution link (Apache-2.0 requirement). Guard:
a chart canvas must never stay at 300×150 (the screenshot script fails if it does).

Lessons from the kit's dry run (29 Sep 2026, Next 16.3 + lightweight-charts 5.2):
- Epochs are not dates. Map epoch N to a synthetic time (`N * 86400`) and set BOTH
  `localization.timeFormatter` (crosshair) and `timeScale.tickMarkFormatter` (axis) to print `E1043`;
  otherwise the axis shows calendar months.
- Use `createChart(el, { autoSize: true, … })` and `chart.addSeries(LineSeries | HistogramSeries | AreaSeries, …)`
  (the v5 API); give in/out bars their own `priceScaleId` with `scaleMargins` so they sit under the line.
- Wrap a chart in `<figure>` with a `<figcaption>` (or a visually hidden summary). Do NOT put `role="img"`
  on the chart container: lightweight-charts renders its attribution link inside it and axe reports
  `nested-interactive` (serious).

## Motion

| What | Duration | How |
| --- | --- | --- |
| Hover, reveal, tab switch | 200 ms | CSS `ease-ep-out` or Motion `presets.fade` |
| Focus ring, chip press | 150 ms | CSS |
| Dialog, sheet, toast, badge reason | 250 ms | Motion `presets.slide` |
| KPI number roll | ≤ 500 ms | `@number-flow/react` |
| Value-changed flash | 180 ms | CSS keyframe, re-fires |
| Live dot | 1.6 s loop | `animate-ep-pulse` |
| Score ring / epoch ring first draw | 900 ms | GSAP DrawSVG via `withMotion` |
| Landing hero words | 400 ms, 45 ms stagger | GSAP SplitText via `withMotion` |
| Landing scroll story | scrubbed | GSAP ScrollTrigger + Lenis, landing only |

Transform and opacity only. Everything honours `prefers-reduced-motion` (tokens drop to 0 ms; GSAP runs
inside `gsap.matchMedia`; anime.js wrapper no-ops). On data pages only the live dot, the countdown and the
ticker move while idle. WebGL (shader gradient, R3F) only in the landing hero.

## Accessibility

Contrast checked: text ≥ 11:1, muted ≥ 6.4:1, accents ≥ 7.9:1 on every surface, field borders ≥ 3:1.
Real `<button>`, `<a>` and labelled `<input>`; icon-only buttons get `aria-label`; tabs, menus and dialogs
are keyboard reachable (shadcn primitives handle focus); focus ring 2 px accent with 2 px offset; tables
have `<th scope>`; live regions announce transaction status. The screenshot script's `--axe` flag must
report no serious or critical issues.
