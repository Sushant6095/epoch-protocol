# 04 · UI libraries

Every version below was read from the npm registry on 29 Sep 2026 and checked against React 19.3 /
Next 16 peer ranges, then installed and built in a dry run of this kit on a clone of the repo (production
build green; the only pnpm peer warning is `utf-8-validate` under `@solana/web3.js` → `ws`, which is harmless). `scripts/setup-frontend.sh` installs them in one go with `pnpm --filter app add`.
**Library-first law (30 Sep).** Every component on every page comes from these libraries and registries; a
component written from scratch needs a line in `DECISIONS.md` naming what was searched. The router skill
(`.claude/skills/epoch-ui-craft`, §2 and §4) maps each Epoch component to its library parts, and
`12-REPLICA-BLUEPRINTS.md` names the part for every region of every page.

"From" says where the choice came from: **omnipitch 2** (`~/Downloads/omnipitch 2/apps/web/package.json`),
**ninety-brain** (the Ninety/omnipitch design notes: tokens-only law, GSAP primary, design-cop, impeccable),
or **Epoch** (added for this product).

## Core

| Library | Version | What it does here | Allowed on | From |
| --- | --- | --- | --- | --- |
| next | 16.3.6 (repo pins ^16.3.0) | App Router, RSC, production build | all | Epoch |
| react / react-dom | 19.3.0 | UI runtime | all | Epoch |
| typescript | 5.9 (repo) | strict types | all | Epoch |
| tailwindcss + @tailwindcss/postcss | 4.3.3 | styling through tokens only (omnipitch was on v3; Epoch is v4) | all | omnipitch 2 |
| tw-animate-css | 1.4.0 | the keyframes shadcn components expect | all | Epoch |
| shadcn (CLI) | 4.21.0 | pulls primitives and registry items into `src/components/ui` | all | omnipitch 2 |
| radix-ui | 1.6.7 | primitives under shadcn (or use Base UI) | all | omnipitch 2 |
| @base-ui/react | 1.8.0 | shadcn's default primitives since July 2026 | all | omnipitch 2 |
| class-variance-authority · clsx · tailwind-merge | 0.7.1 · 2.1.1 · 3.7.0 | variant classes and `cn()` | all | omnipitch 2 |
| lucide-react | 1.48.0 | icons (outline, 1.5 stroke) | all | omnipitch 2 |
| next-themes | 0.4.6 | theme attribute switch (emerald ↔ graphite) without flash | all | omnipitch 2 |
| sonner | 2.0.8 | toasts: pending → confirmed with explorer link | all | omnipitch 2 |
| cmdk | 1.1.1 | ⌘K search: validator, vote account, wallet, signature | all | omnipitch 2 |
| vaul | 1.1.2 | bottom sheets on phones (action panels, nav) | all | Epoch |
| usehooks-ts | 3.1.1 | small hooks (media query, interval, copy) | all | omnipitch 2 |

## Data

| Library | Version | What it does here | From |
| --- | --- | --- | --- |
| @tanstack/react-query | 5.104.0 | server state behind every hook; websocket updates via `setQueryData` | Epoch |
| @tanstack/react-table | 9.2.4 | Validators, loan book, stake moves, withdrawal queue | Epoch |
| @tanstack/react-virtual | 3.14.13 | virtual rows (683+ validators) | Epoch |
| nuqs | 2.10.1 | filters, sort, tabs and ranges in the URL | Epoch |
| zustand | 5.0.15 | tiny client state (compare tray, units SOL/USD/INR) | Epoch |
| msw (dev) | 3.0.0 | mock the API with the fixtures when you want network-shaped tests | Epoch |

## Charts and numbers

| Library | Version | What it does here | From |
| --- | --- | --- | --- |
| lightweight-charts | 5.2.1 | every time series: stake flows, Fee Index, share price, stake by epoch. Apache-2.0 — keep the TradingView attribution link | omnipitch 2 (was v4 there) |
| lightweight-charts-react-components | 2.6.0 | React wrapper for v5 panes and series | Epoch |
| recharts (via shadcn Charts) | 3.10.1 | small bars and sparklines (rewards per epoch, credits) | Epoch |
| @visx/visx | 4.0.0 | the custom loss waterfall (bond → junior → senior) | Epoch |
| @number-flow/react | 0.6.2 | animated KPI numbers and countdowns, reduced-motion aware | Epoch |

## Motion (GSAP is primary — ninety-brain's rule, kept)

| Library | Version | What it does here | Allowed on | From |
| --- | --- | --- | --- | --- |
| gsap | 3.15.0 | choreography, ScrollTrigger, SplitText, DrawSVG (all plugins free since 3.13, standard no-charge licence). Import only from `src/lib/gsap.ts` | all (scroll only on landing) | omnipitch 2 |
| @gsap/react | 2.1.2 | `useGSAP` hook with automatic cleanup | all | omnipitch 2 |
| motion | 13.4.4 | micro-interactions: hover, press, layout, tab underline (`motion/react`) | all | omnipitch 2 |
| animejs | 4.5.0 | staggered SVG/glyph work only, through `src/lib/anime.ts` | landing, slot ruler | ninety-brain (sanctioned there) |
| lenis | 1.3.26 | smooth scroll | landing only | Epoch |
| rough-notation | 0.5.1 | hand-drawn highlight on one landing phrase | landing only | omnipitch 2 |
| canvas-confetti (+ @types) | 1.9.4 | success burst ONLY on a first vault deposit | vault success | omnipitch 2 |

`framer-motion` (omnipitch had both) is the old name of `motion`: install only `motion` and import from
`motion/react`; rewrite any pulled component that imports `framer-motion`.

## Landing-only visuals (never on a surface with live data)

| Library | Version | What it does here | From |
| --- | --- | --- | --- |
| three (+ @types/three 0.186.0) | 0.186.1 | 3D hero object | omnipitch 2 |
| @react-three/fiber | 9.8.1 | React renderer for three (React 19 only) | omnipitch 2 |
| @react-three/drei | 10.7.9 | helpers: environment, float, text | omnipitch 2 |
| three-stdlib | 2.36.1 | loaders and post-processing helpers | omnipitch 2 |
| camera-controls | 3.1.2 | smooth, bounded camera moves on scroll | omnipitch 2 |
| @shadergradient/react | 2.4.20 | the animated gradient behind the hero | omnipitch 2 |
| embla-carousel-react + autoplay | 8.6.0 · 8.6.0 | audience cards / proof carousel on phones | omnipitch 2 |
| @xyflow/react | 12.12.0 | the how-it-works flow (vote account → escrow → vault / validator) | omnipitch 2 |
| svg-dotted-map | 2.1.0 | dotted world map of validator locations (landing or Terminal network card) | omnipitch 2 |

## Solana

| Library | Version | What it does here |
| --- | --- | --- |
| @solana/wallet-adapter-react | 0.15.40 (already in app) | wallet context, Wallet Standard discovery, `signIn()` for SIWS |
| @solana/wallet-adapter-react-ui | 0.9.40 | only as a fallback; build our own WalletSignIn list on top of the hooks |
| @solana/wallet-adapter-base | 0.9.28 | types, errors |
| @solana/web3.js | 1.99.0 (v1) | transactions; matches `packages/epoch-sdk` |
| @epoch/epoch-sdk | workspace | PDAs (`findPoolPda`, `findValidatorPositionPda`, `findFeeIndexPda` …), later the IDL and instruction builders |

Not now: `@solana/kit` (8.4.0) and `@wallet-ui/react` (4.3.0) — both fine libraries, but the SDK is on
web3.js v1, so mixing them adds two transaction models. Revisit after the hackathon.

## Quality and tooling (dev dependencies)

| Tool | Version | Used for | From |
| --- | --- | --- | --- |
| playwright + @playwright/test | 1.63.0 | `scripts/ui/screenshot.mjs`, later e2e | omnipitch 2 |
| @axe-core/playwright + axe-core | 4.13.0 | accessibility check inside the screenshot script (`--axe`) | omnipitch 2 |
| impeccable | 4.1.0 | anti-slop detector: `npx impeccable detect src/` (61 rules; config in `.impeccable/`) | ninety-brain / omnipitch 2 |
| cssstudio | 1.2.0 | CSS Studio: tweak CSS visually in the browser, the MCP sends edits back to code | omnipitch 2 |

## Seen in omnipitch 2 but NOT installed for Epoch

| Library | Why not |
| --- | --- |
| media-chrome 4.19.3 | video player controls; Epoch has no video (no video backgrounds by rule) |
| @svar-ui/react-core 2.6.1 + @svar-ui/react-filter 2.6.1 | a query-builder filter UI; our filters are chips + column popovers in the URL. Add only if the Validators advanced filter needs AND/OR groups (DECISIONS.md line first) |
| embla-carousel-wheel-gestures 8.1.0 | wheel scrolling for carousels; not needed |
| framer-motion | same library as `motion` under its old name |
| tailwindcss v3 | Epoch is on Tailwind v4 |
| geist (npm) 1.7.2 | fonts come from `next/font/google` instead |

## Component registries (pull, re-skin, log in PROVENANCE.md)

| Registry | How to pull | Use for | Where allowed |
| --- | --- | --- | --- |
| shadcn/ui | `pnpm dlx shadcn@latest add dialog tabs …` · MCP `shadcn` | every primitive, `chart-*`, `sidebar-*`, `dashboard-01` blocks | all |
| Magic UI (MIT) | `pnpm dlx shadcn@latest add @magicui/number-ticker` · MCP `magicui` | number-ticker, marquee, animated-list, border-beam, dotted-map, animated-beam | all (effects on landing) |
| 21st.dev | `npx @21st-dev/cli@latest init --client claude` (needs a 21st API key; search free, installs limited per day on the free plan) | hero sections, stat blocks, tier pickers | all, re-skinned |
| ReUI (MIT, Pro optional) | `pnpm dlx shadcn@latest add @reui/<name>` · MCP `reui` (sign in) | data grid, stepper, stats, app shell | all |
| Kibo UI (MIT) | `npx kibo-ui add ticker` or `pnpm dlx shadcn@latest add @kibo-ui/ticker` (its MCP returned HTTP 500 on 29 Sep 2026, so it is not in `.mcp.json`) | ticker, status, relative time, pill | all |
| openstatus data-table | `pnpm dlx shadcn@latest search @data-table-filters` | faceted filters with URL state for Validators | all |
| dashboardcn, Tremor Blocks | `pnpm dlx shadcn@latest add @dashboardcn/kpi-card` | KPI cards, trend chart, radial gauge, bar list | all |
| Skiper UI, OriginKit, Componentry, godui, styleui | registry JSON URLs (omnipitch pulled `skiper19/39/52`, godui `animated-beam`, `flow-field`, componentry `dithered-logo`) | standout effects | landing only; read each licence first |
| Shadcnblocks | — | BANNED here: its licence forbids publishing its components in a public repo | never |

### Motion, effect and data registries added for the replica build (30 Sep 2026)

All install through the shadcn CLI (`pnpm dlx shadcn@latest add @<registry>/<item>`) and were healthy in the
shadcn registry index on 30 Sep 2026. Read each item's licence before pulling; re-skin to tokens; log in
`PROVENANCE.md`.

| Registry | Use for | Where allowed |
| --- | --- | --- |
| Animate UI `@animate-ui` | animated tabs, counters, toggles, sheets | all |
| Motion Primitives `@motion-primitives` | in-view reveals, text effects, transitions, sliding numbers | all (reveals on landing) |
| Aceternity UI `@aceternity` | spotlight, beams, 3D card hover, background effects | landing only |
| React Bits `@react-bits` | text animations, backgrounds, animated counters | landing only |
| Kokonut UI `@kokonutui` · Eldora UI `@eldoraui` · SmoothUI `@smoothui` | polished motion components and blocks | landing; app only for small details |
| Lucide Animated `@lucide-animated` | animated versions of the lucide icons already in use | all, sparingly |
| EvilCharts `@evilcharts` | Recharts-based chart blocks (area, bar, radial) | all |
| Coss UI `@coss` (built on Base UI, like shadcn's base-nova) | form controls, inputs with addons, steppers | all |

Never copy code from AGPL, "all rights reserved" or unlicensed repos (stakewiz-frontend, Drift UI
templates, mango, dYdX, Uniswap web). Permissive code worth lifting is listed in `docs/UI_SOURCES.md` §1
row 5 (Solana explorer MIT, mrgn-ts Apache-2.0, meteora-invent ISC).
