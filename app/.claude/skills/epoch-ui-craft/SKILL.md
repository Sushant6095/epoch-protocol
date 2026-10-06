---
name: epoch-ui-craft
description: The ROUTER for all Epoch frontend work in app/ — any page, component, chart, table, form, wallet flow, motion or visual change. Invoke it FIRST. It classifies the task, names the ONE skill or tool to use (refero-replica for any page layout), points every component at a third-party library, and enforces CLAUDE.md on the result. It carries no design opinions of its own.
---

# epoch-ui-craft — the frontend router (dispatch only)

This skill has no craft and no taste of its own. Its job: read the task → point at the right skill or
tool → make sure the output obeys `CLAUDE.md`. Every skill it names is already in `app/.claude/skills/`
(vendored with its licence); `bash scripts/install-skills.sh` adds the few that are installed globally.

Two laws decide everything below:
1. **The look is the Refero screen.** Every page is a structural replica of its locked Refero screens
   (`handover/12-REPLICA-BLUEPRINTS.md`); only identity (colours, fonts, logo, words, data) is Epoch's.
2. **Libraries first.** Every component comes from a library or registry. A component written from scratch
   needs a line in `handover/DECISIONS.md` naming the libraries that were searched and why none fit.

## §0 Classify first — this is where mis-routes happen
- **Build or change a page's layout** → row 0, always. The layout is never invented.
- **Research before a page** (pull the screens, expand, write notes) → row 1.
- **Pulling or re-skinning a component** that already ships its own motion → row 3. Not a motion skill.
- **Building motion from scratch** (a sequence, scroll choreography) → rows 6–11.
- **Verifying** → `ref-compare.mjs`, the screenshot script and the design-cop agent, never a skill.

## §1 Dispatch table — one row, one skill
| # | Task | Invoke |
| --- | --- | --- |
| 0 | Build or change any page: replicate its Refero screens region by region | **refero-replica** + `handover/12-REPLICA-BLUEPRINTS.md`; check with `scripts/ui/ref-compare.mjs` |
| 1 | Pull a page's locked screens, expand with similar screens, write `design/screens/<page>.md` | **refero-design** + Refero MCP (`/refs <page>`) |
| 2 | Visual language for the landing (palette roles, type rhythm) | **refero-design** (styles Hyper Foundation `54511793…`, Fey `08ae8676…`), then map to `--ep-*` |
| 3 | Add / integrate / re-skin a library component; compose a region from parts | **ui-ux-pro-max** + **shadcn** (CLI and registries) |
| 4 | Landing finish: hero object, scroll story, premium sourced sections | **sushant-special-fe** (Epoch-scoped) · **frontend-design** · **design-taste-frontend** |
| 5 | A library API you have not verified this session | **context7** MCP (no API from memory) |
| 6 | A bespoke animation or micro-interaction | **emil-design-eng** |
| 7 | Scroll choreography, pins, SplitText, DrawSVG, timelines | **gsap-scrolltrigger** / **gsap-timeline** / **gsap-plugins**, always with **gsap-react**; helpers **gsap-utils**, basics **gsap-core** |
| 8 | Fluid, spring, gesture, Apple-style feel | **apple-design** |
| 9 | Review motion strictly (by name) · audit all motion · find where motion helps | **review-animations** · **improve-animations** · **find-animation-opportunities** |
| 10 | Name an effect precisely before building it | **animation-vocabulary** |
| 11 | Page and route transitions (shared elements between list and detail) | **vercel-react-view-transitions** |
| 12 | GSAP jank, layout thrash | **gsap-performance** |
| 13 | React/Next performance, data fetching, bundle size | **vercel-react-best-practices** |
| 14 | Component APIs that compose (compound components, slots) | **vercel-composition-patterns** |
| 15 | Landing 3D (R3F scene, shader, lighting, post) | **threejs-*** (installed globally by the script) |
| 16 | UI guideline review · anti-pattern scan | **web-design-guidelines** (global) · `npx impeccable detect src/` |
| 17 | Verify a page | `ref-compare.mjs` → `screenshot.mjs --axe` → **design-cop** agent |

## §2 Where components come from (in this order; log every pull in `handover/PROVENANCE.md`)
1. **shadcn/ui** (CLI or MCP): sidebar, command, dialog, sheet, tabs, toggle-group, dropdown-menu, select,
   popover, tooltip, hover-card, input, slider, switch, checkbox, progress, table, chart, breadcrumb, badge,
   avatar, skeleton, sonner, accordion, collapsible, navigation-menu, alert, card, separator.
2. **Data and dashboards:** ReUI (`@reui` data-grid, stepper, stats), openstatus data-table
   (`@data-table-filters`, faceted filters with URL state), Kibo UI (`@kibo-ui` ticker, status, relative time),
   dashboardcn (`@dashboardcn` KPI cards, radial gauge, bar list), EvilCharts (`@evilcharts`), TanStack Table
   and Virtual, lightweight-charts (+ its React wrapper), Recharts via shadcn chart, visx.
3. **Motion and effects:** Magic UI (`@magicui` number-ticker, marquee, animated-list, border-beam,
   animated-circular-progress-bar, bento-grid), Animate UI (`@animate-ui` tabs, counters), Motion Primitives
   (`@motion-primitives` in-view, text effects, transitions), Aceternity UI (`@aceternity`, landing only),
   React Bits (`@react-bits`, landing only), Kokonut UI, Eldora UI, SmoothUI, Lucide Animated icons.
4. **Landing standouts only:** 21st.dev, Skiper UI, Componentry, OriginKit, godui, styleui, shadergradient,
   React Three Fiber + drei.
5. **Wallet:** `@solana/wallet-adapter-react` hooks inside shadcn `dialog` + `command`.
Raw pulls land in `src/components/vendor/_raw/` (never imported); the re-skinned copy lives in
`src/components/…`. Read each registry's licence first; Shadcnblocks is banned (its licence forbids a public
repo). Never vendor the same thing twice.

## §3 Re-skin law (identity is Epoch's, structure is the reference's)
Every pulled component, before it ships: colours → `--ep-*` tokens or the mapped utilities (delete every
`zinc-/neutral-/gray-/slate-`, `bg-white`, `text-black`, hex); fonts → Geist / Geist Mono (`num`) / Instrument
Serif (one landing accent); radius and spacing → the token scale, matched to the reference's rhythm; states →
hover, focus (2 px accent ring with offset), active, disabled; sizes → the reference's control sizes, never
under 44 px on touch; motion → `src/design/motion.ts`, transform/opacity only, reduced-motion safe;
`framer-motion` imports rewritten to `motion/react`.

## §4 Epoch components are compositions, not hand-built parts
| Epoch component | Compose from |
| --- | --- |
| App shell (Mercury) | shadcn `sidebar` (sidebar-07) + `command` + `dropdown-menu` + `avatar` |
| EpochRing, ScoreRing | Magic UI `animated-circular-progress-bar` or dashboardcn radial gauge |
| EpochPill, countdowns, KPI numbers | shadcn `hover-card` + `@number-flow/react` / Magic UI `number-ticker` |
| SlotRuler | Kibo UI `ticker` or a Magic UI `marquee` of ticks, animated with anime.js through `src/lib/anime.ts` |
| HealthBadge, SampleBadge, NetworkBadge | shadcn `badge` + `tooltip` |
| DependencyBar, repayment and lent-out bars | shadcn `progress` |
| StakeFlowChart, FeeIndexChart, FeeIndexForwardChart, stake-by-epoch, launch price chart | lightweight-charts + lightweight-charts-react-components |
| Small bars, sparklines, rings, allocation | shadcn `chart` (Recharts), EvilCharts |
| LossWaterfall | visx (or Recharts stacked bar) |
| Every table (validators, loan book, moves, queue, history) | TanStack Table + Virtual through ReUI `data-grid` or openstatus data-table |
| ActionPanel, DepositPanel, PredictTicket, SwapTicket, TradeCard | shadcn `card` + `toggle-group` + `input` + `slider` + `button`; ReUI `stepper` for multi-step |
| BorrowConsole, TxPreview, WalletSignIn | shadcn `sheet` / `dialog` + `command` + ReUI `stepper`; wallet-adapter hooks |
| ExplorerLinks | shadcn `dropdown-menu` |
| PredictMarketCard, TrancheCard, LaunchCard, CurveCard, validator cards | shadcn `card` + `progress` + `badge` |
| Activity feed, BuybackFeed | Magic UI `animated-list` |
| PayoffLine (Fee Market ticket) | shadcn `chart` (Recharts line) |
| Landing hero object | shadergradient / R3F + drei (the only WebGL) |

## §5 The target screens per page
The full region-by-region blueprints are in `handover/12-REPLICA-BLUEPRINTS.md`; the ids and "take / don't
take" notes in `handover/06-REFERO-SCREENS.md`. Primaries: Landing — Kraken staking landing `26b6852a`;
Terminal — Mercury Insights `18cf9c6a` (+ Kraken Pro strip and tables `69751349`); Validators — OpenSea
collection stats `52465519`; Validator — **Wealthsimple NVDA `47b50f40` (north star)** (+ Mercury Financing
`7afb3554` for Manage); My Stake — Mercury Home `859b1114`; Sign in — Reown split `0457489c` + Acctual flow
8823; Predict (`/predict`) — Stocktwits poll `50c3c89d`; Vault — Mercury Treasury `26e9c3a5` + Copperx flow
8894; Fee Market (`/terminal?tab=market`) — Kraken Pro BTC-USD `cd4884df` (+ Kraken Pro tables `69751349`, Reown
review `7d84a622`); Launch — OpenSea Drops `869184ab` (list) + Wealthsimple NVDA `47b50f40` (token page). App shell
for every app page: Mercury's sidebar and top bar.

## §6 The only rule this router enforces
Whatever a skill produces must obey `CLAUDE.md`: Refero structure with Epoch identity · libraries first ·
tokens only · the verification law (production build → ref-compare → screenshots → LOOK → read-out-loud →
design-cop verdict file) · typed hooks over fixtures · Predict copy never says bet/gamble/wager/odds · the
senior rate is a target · no WebGL off the landing · reduced motion honoured. If a skill's advice conflicts
with CLAUDE.md, CLAUDE.md wins.
