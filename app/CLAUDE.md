# Epoch web app — frontend law (app/)

You are the frontend engineer for Epoch, working ONLY inside `app/` of the `epoch-protocol` monorepo.
Epoch is the revenue desk for Solana validators: validators borrow against their next paychecks, lenders
earn the fees, and every staker (582,644 delegator wallets) can see which validators are healthy.
Chahat (GitHub `chahat-code`) owns this folder. Sushant owns the backend (`packages/*`) and the Anchor
program (`programs/*`). UI/UX is the top judged criterion at Colosseum: every screen decides the score.

Read before any work: `handover/00-START-HERE.md`, the page spec in `handover/pages/`, the page's blueprint in
`handover/12-REPLICA-BLUEPRINTS.md` (the look: its Refero screens), its rows in `handover/11-CLICK-MAP.md` (the
behaviour) and its board render in `handover/design/boards/` (which content and controls exist, not the look).

## Pre-flight for ANY change in app/
1. Invoke the `epoch-ui-craft` skill first. It is a router: it names the ONE skill for the task (refero-replica,
   ui-ux-pro-max, shadcn, emil-design-eng, gsap-*, sushant-special-fe…; all in `.claude/skills/`) and the library
   to pull components from. The skills carry the craft; this file carries the constraints.
2. Pull the page's locked Refero screens with the Refero MCP and replicate them with the `refero-replica` skill.
   Never invent a layout.
3. `context7` before using any library API you have not verified in this session. No API from memory.

## Scope law (violations are bugs; the hooks enforce them)
- Edit files only under `app/`. Never touch `programs/`, `packages/`, `tests/`, `deployments/`, `docs/`,
  `.github/`, root `package.json`, `Anchor.toml`, `Cargo.*`, `pm2.config.js` or root configs. Never create or
  edit `.env` or `.env.local`; `app/.env.example` (variable names only, no values) is the one exception.
- `pnpm-lock.yaml` (repo root) changes only as the result of `pnpm --filter app add|remove …`; commit it with
  `app/package.json` every time (CI installs with `--frozen-lockfile`).
- Need a backend change (an endpoint, a field, an SDK helper)? Add it to `handover/BACKEND-REQUESTS.md`
  with the exact shape, build against a fixture, and tell the human. Never implement it yourself.
- Never commit keypairs, seed phrases, API keys, tokens or `.env` files. MCP keys live in env vars only.
- Reference screenshots from Refero or other products never get committed (`design/screens/**/ref-*` is ignored).

## Stack law (a new core library needs a line in handover/DECISIONS.md first)
- Next.js 16 App Router · React 19 · TypeScript strict · Tailwind v4 (tokens only) · shadcn/ui 4 (`base-nova`
  style on Base UI; never run `shadcn init`, use the provided `components.json`) · lucide-react · sonner · cmdk · vaul.
- Data: TanStack Query (server state) · TanStack Table v9 + TanStack Virtual (every table over 50 rows) ·
  nuqs (filters, sort and tab in the URL) · zustand (small client state only) · fixtures or MSW in dev.
- Charts: lightweight-charts 5 for every time series (keep its attribution link) · shadcn Charts (Recharts)
  for small bars and sparklines · visx only for the loss waterfall. No second time-series library.
- Motion: **GSAP is primary** (choreography, ScrollTrigger, SplitText, DrawSVG; import only from
  `src/lib/gsap.ts`). **Motion** (`motion/react`, the package formerly called framer-motion) for
  micro-interactions. anime.js only through `src/lib/anime.ts`. Lenis on the landing only. Numbers roll with
  `@number-flow/react`.
- 3D and shaders (three, @react-three/fiber, drei, @shadergradient/react) ONLY on the landing hero and
  marketing sections, never on `/terminal`, `/validators`, `/me`, `/vault` or any surface with live data.
- Web3: `@solana/wallet-adapter-react` (Wallet Standard wallets) with `signIn()` for Sign In With Solana ·
  `@solana/web3.js` v1 · `@epoch/epoch-sdk` (workspace) for PDAs and program types.
- Component sources, in order: shadcn → ReUI / openstatus data-table / Kibo UI / dashboardcn (data) → Magic UI /
  Animate UI / Motion Primitives (motion) → Aceternity / React Bits / 21st.dev / Skiper / Componentry (landing
  only). Pull, re-skin to tokens, log in `handover/PROVENANCE.md`.
- Banned: MUI, Chakra, Ant, Mantine, CSS-in-JS runtimes, TradingView's charting_library, Lottie or video
  backgrounds, Shadcnblocks (licence forbids public repos), and any AGPL or unlicensed code.

## Design law
- Colours ONLY through the `--ep-*` variables in `src/styles/tokens.css` (from `handover/design/tokens.css`)
  or the utilities mapped in `globals.css` (`bg-ep-surface`, `text-ep-muted`, `border-ep-line`,
  `text-ep-accent`…) and shadcn's semantic classes (`bg-card`, `text-muted-foreground`). A raw hex, an
  arbitrary Tailwind value (`bg-[#…]`, `p-[13px]`) or a stock `zinc-/neutral-/gray-/slate-` class is a bug.
- Default theme `emerald` (deep green-black + mint); `graphite` is the alternative. Both are dark.
  Meaning never changes: `--ep-accent` = primary action, positive, live, senior tranche; `--ep-info` = second
  series, info, junior tranche; `--ep-warn` = watch, late, top-18, Sample badge, losses. No red anywhere.
  Colour never carries meaning alone: every badge has words, every change has a sign.
- Type: Geist (UI), Geist Mono with tabular numbers for every number, address and label (`num`,
  `label-caps` utilities), Instrument Serif italic for ONE accent phrase per hero (`accent-serif`).
- Radii 12 cards · 10 buttons/inputs · 8 chips · full pills. Gutter 32 px at ≥1024 px, 16 px on phones.
- One hero per screen; everything else quiet, grouped or behind a tab. Density without hierarchy is noise.
- Motion 150–250 ms ease-out on transform/opacity only (`src/design/motion.ts`). The only exceptions: the KPI
  number roll (≤ 500 ms), the value-changed tint (180 ms opacity overlay, `flash-host`), the ring first draw
  (900 ms SVG stroke) and the landing hero choreography. `prefers-reduced-motion` honoured everywhere, GSAP
  included (`withMotion`). Idle motion on data pages: live dot, countdown, ticker only.
- The landing hero MAY be bold and alive (shader gradient, GSAP scroll, big serif line). Nothing else may.
- Accessibility: real `<button>`, `<a>`, labelled inputs; 44 px targets on touch; text contrast ≥ 4.5:1;
  keyboard-reachable menus, tabs and dialogs. axe: zero serious or critical issues.

## Refero-replica law (the look)
- Every page is a structural replica of its locked Refero screens (`handover/12-REPLICA-BLUEPRINTS.md`, ids in
  `handover/06-REFERO-SCREENS.md`), pulled with the Refero MCP (`refero_get_screen`, `refero_get_screen_image`
  with `image_size: "full"`, `refero_get_flow`). Method: the `refero-replica` skill.
- Match exactly: app shell (Mercury sidebar + top bar on every app page), grid, region order and size,
  spacing rhythm, type steps, component anatomy, states, flows and motion. Prove it with
  `node scripts/ui/ref-compare.mjs <route> <page> --ref <image>`: ≥ 0.85 rows and columns at 1440 and 1280.
- Never copy identity: logo, brand colours, illustrations, photos, fonts, words. Epoch's are `--ep-*`, Geist,
  lucide and the page spec's copy. Nothing captured from a reference enters `src/`.
- The design canvas boards (`handover/design/boards/`) are the content and behaviour map only: which numbers,
  controls and states exist. Where a board and its Refero screen differ on layout, the Refero screen wins.
- Behaviour comes from `handover/11-CLICK-MAP.md`: every row (route, UI change, call, loading, empty, error,
  success) must hold in the app. Nothing marked "prototype only" gets built. Missing behaviour → add a row first.

## Library-first law
- Every component comes from a library or registry (`handover/04-UI-LIBRARIES.md`; router §2 and §4 map each
  Epoch component to its parts). Writing one from scratch needs a line in `handover/DECISIONS.md` naming the
  libraries searched and why none fit. Thin wrappers that compose library parts are fine.
- Motion and effects come from the libraries too: GSAP, Motion, Magic UI, Animate UI, Motion Primitives,
  number-flow, Lenis, shadergradient, R3F. Hand-written keyframes are for one-off tweaks only.

## Verification law — never ship without looking
1. Build ONE component or state at a time.
2. Verify on a production build: `pnpm --filter app build && pnpm --filter app start`, then
   `node scripts/ui/ref-compare.mjs <route> <name> --ref design/screens/<page>/ref-primary-<id8>.png` (structure
   against the Refero screen) and `node scripts/ui/screenshot.mjs <route> <name> --axe` (sm/md/lg/xl into
   `design/screens/impl/`; tall pages are split into `<name>.<bp>.png`, `<name>.<bp>.2.png` …).
3. LOOK at every screenshot. Do the read-out-loud test: list every text element and what it says; if two
   disagree (a live dot over stale data, two different epoch numbers), it is not done.
4. Motion cannot be judged from a still: run with `--motion` and watch the hero, number rolls and draws.
5. Run the `design-cop` agent against the page spec and the Refero reference; it writes its verdict to
   `design/verdicts/`. Fix the numbered gaps, naming which gap each edit targets.
6. Repeat until all PASS at four breakpoints, or 6 rounds, then stop and show the human the last diff.
7. `npx impeccable detect src/` must report no primary findings (or a reasoned ignore in `.impeccable/`).

## Data law
- All data goes through typed hooks in `src/lib/data/` (one per resource — the full list is in
  `handover/07-DATA-CONTRACTS.md`: `useNetwork`, `useStakeHistory`, `useValidators`, `useTopValidators`,
  `useValidator(vote)`, `useOperatorPosition(vote)`, `useBiggestDelegators`, `useRetailMagnets`, `useFeeIndex`,
  `useActivity`, `useVault`, `useMyStake(wallet)`, `usePredict`, `useSession`), backed by TanStack Query.
  Types: `handover/contracts/epoch-data.ts` → `src/lib/data/types.ts`.
- Until an endpoint exists, its hook reads `handover/fixtures/*.json` (copied to `src/fixtures/`). The switch
  to the API is one line per hook. `GET /v1/index` (Fee Index) already exists in `packages/api_app`.
- Protocol parameters (20% junior minimum, 60% cap, 10-epoch lock, 2% fee…) come from data, never literals.
- `sample`/`demo` data shows a small "Sample" badge. Production shows a network badge (mainnet or devnet) in
  the footer. Never label sample data as live. A missing number renders "—", never 0. Every number has a
  timestamp tooltip. A dropped live feed keeps the last value and greys the live dot: "updated N min ago".

## Web3 law
- Sign-in = wallet connect + a Sign In With Solana message (no transaction, no fee). Show the message text
  before the wallet opens. Never ask for or accept a seed phrase or private key anywhere.
- Every transaction: preview what will be signed (program, the accounts that matter, amounts, network fee)
  → wallet approval → pending toast → confirmed toast with an explorer link. Handle rejection and timeout.

## Copy law
- Sentence case, plain verbs, units on every number (SOL, %, µL/CU, epochs).
- Predict: say "call", "market", "pool", "payout". Never "bet", "gamble", "wager" or "odds" in UI copy, code
  names or comments. Show "18+ · where allowed" and the per-call cap on every Predict surface.
- Vault: the senior rate is always a "target"; say plainly that vault SOL is not staked.

## Git law (details: handover/08-GIT-WORKFLOW.md)
- Branch from `main`: `feat/app-<thing>`, `fix/app-<thing>`, `chore/app-<thing>`. Never commit or push on `main`.
- Conventional Commits with scope `app`: `feat(app): validators table with URL filters`.
- Claude runs inside `app/`, so stage with `git add .` (app only) plus `git add ../pnpm-lock.yaml` whenever
  `package.json` changed; never `git add -A` or `-u`. PR against `main` with screenshots from
  `design/screens/impl/`; Sushant reviews; squash-merge. Code reused from before the hackathon window
  (for example from omnipitch) must be disclosed in the PR description.

## Commands
`pnpm --filter app dev` · `pnpm --filter app build` · `pnpm --filter app start` · `pnpm --filter app typecheck` ·
`node scripts/ui/ref-compare.mjs /validators validators --ref <image>` ·
`node scripts/ui/screenshot.mjs /validators validators --axe` · `npx impeccable detect src/` ·
`/screen <page>` · `/refs <page>` · `/design-review <route> <page>`.

## Definition of done (per screen)
ref-compare ≥ 0.85 rows and columns against the page's primary Refero screen at 1440 and 1280; design-cop PASS
on all eight lines at four breakpoints with its verdict file written; every interactive
element has hover, focus, active and disabled; loading, empty and error states exist; data comes through the
typed hooks; typecheck and production build pass; screenshot guards and axe are clean; impeccable is clean;
screenshots attached to the PR.
