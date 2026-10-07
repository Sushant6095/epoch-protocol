# Design and frontend decisions (the ledger)

One line per decision, newest at the bottom: date (IST) · decision · why · who. A new core library, a
changed Refero primary, a token change or a new pattern each need a line here before the code lands.

| Date | Decision | Why | Who |
| --- | --- | --- | --- |
| 29 Sep 2026 | Visual design comes from Refero screens locked per page (`06-REFERO-SCREENS.md`); the first canvas is a content map only | Chahat's Refero Pro seat gives real, shipped references for every page | Sushant |
| 29 Sep 2026 | North star: Wealthsimple NVDA page (dark), Refero `47b50f40` | One asset, one hero number, one chart, one action panel — Epoch's validator page, reused by Vault and Predict | Sushant |
| 29 Sep 2026 | Default theme `emerald` (deep green-black + mint); `graphite` kept as the alternative | Refero style Hyper Foundation + `docs/UI_SOURCES.md` §3; one attribute to switch (open decision 1) | Sushant |
| 29 Sep 2026 | Tokens prefixed `--ep-*`; shadcn variables mapped onto them in `globals.css` | shadcn's `--muted`/`--accent` are backgrounds; our names must not collide | Sushant |
| 29 Sep 2026 | GSAP primary, Motion for micro-interactions, anime.js via wrapper, WebGL on the landing hero only | Carried over from omnipitch 2 / ninety-brain, where it held up | Sushant |
| 29 Sep 2026 | Wallet: `@solana/wallet-adapter-react` + `signIn()`, web3.js v1 | Matches `packages/epoch-sdk`; one transaction model | Sushant |
| 29 Sep 2026 | One router skill in the repo; craft comes from published skills installed globally | omnipitch's custom craft skills drifted; published skills + a strict CLAUDE.md held | Sushant |
| 30 Sep 2026 | The design canvas is the visual source of truth: all six boards rebuilt section by section from their locked Refero screens, in the emerald tokens, with the 29 Sep data; the wireframes are superseded | One clickable design to build from instead of a content map plus references | Sushant |
| 30 Sep 2026 | Every interactive element is specified in `11-CLICK-MAP.md` (252 rows then, 264 after the richer Terminal: route, UI change, hook or call, states); each row is a test case | What happens at every click was the gap in the handover | Sushant |
| 30 Sep 2026 | Validators: tabs All · Healthy · Watch · Watchlist pick the population; chips (Below break-even · One delegator over 50% · Hide top-18 · Firedancer · 0% commission) narrow it | The old "Healthy only" chip duplicated the Healthy tab | Sushant |
| 30 Sep 2026 | One advance at a time; the Borrow button says why while one is open | The program refuses a second (`AdvanceAlreadyOpen` in `request_advance`) | Sushant |
| 30 Sep 2026 | Settled open decisions 11–18 with the standard answers (score counts MEV commission; block fees out of limits until the testnet test; compare 3; console link for visitors; landing glows as specified; vault shares on My Stake; no names in the stress test) | Standard answers, chosen on 30 Sep so nothing blocks Gate 2 | Sushant |
| 30 Sep 2026 | The Terminal is the richest page: Quick answers for stakers, validators and lenders; who holds the stake, where retail stakes, validator health; what SOL earns, vault pulse, validators over time; five network tiles; Loan book · Epochs · Top validators · Biggest delegators · Withdrawal queue | Every visitor should find their common question answered on one public page | Sushant |
| 30 Sep 2026 | Finality shows as ≈8.5 s everywhere (32 slots × 267 ms) | The landing said ≈8 s and the Terminal ≈8.5 s | Sushant |
| 30 Sep 2026 | The look of every page is its Refero screen: a structural replica (shell, grid, regions, spacing, type steps, components, states, flows, motion) with Epoch's identity (tokens, Geist, logo, lucide, words, data). The design canvas becomes the content and behaviour map only | The built pages must look like the chosen Refero screens; brand identity stays Epoch's to avoid trade-dress problems and a patchwork of five brands | Sushant |
| 30 Sep 2026 | Mercury's app shell (left sidebar + top bar) on every app page; the landing keeps a marketing bar; sign-in has no shell | Three of the seven app screens are Mercury's and Stocktwits also uses a sidebar; one shell keeps the app coherent | Sushant |
| 30 Sep 2026 | Predict gets its own route `/predict` (behind its flag); `/me#predict` redirects | Its Stocktwits screen is a full page, not a section of My Stake | Sushant |
| 30 Sep 2026 | Libraries first: every component comes from a library or registry; hand-built components need a line here | Faster, and the libraries already carry the motion and states | Sushant |
| 30 Sep 2026 | 21 published skills vendored into `app/.claude/skills` with their licences, plus `refero-replica` and Sushant's `sushant-special-fe`; `AGENTS.md` for other agents | Chahat's agent (Claude Code or another) gets the same playbooks without installing anything | Sushant |

| 5 Oct 2026 | Use current backend contract snapshots in `src/lib/data/contracts`, with explicit fixture adapters | Backend nullability, points-mode Predict and SIWS differ from the September handover | Codex |
| 5 Oct 2026 | Refero layout lock retained; R3F Torus composes the original landing epoch object | shadcn has no 3D epoch object; router specifies R3F/drei for this role. No reference imagery enters source | Codex |
| 5 Oct 2026 | Context7 unavailable in this session; verify library APIs against installed first-party declarations and shipped TanStack v9 guides | Avoid v8 or obsolete API guesses | Codex |
| 5 Oct 2026 | API failures never fall back silently to historical fixtures | Snapshot mode is selected only when no API origin is configured | Codex |

## 5 October: user-directed visual overhaul

The user rejected Hyper/emerald and asked for ThreeUI, TasteSkill, 21st.dev and GSAP. The previous replica/palette requirements are superseded for this visual pass. See `design/redesign/DIRECTION.md`. Native controls, routes, data source labels and transaction behaviour are preserved.

Library search: ThreeUI Cathode is gated Pro; free ThreeUI CRT contains a reusable MIT shader but its demo text is unrelated. Use that shader in an original cabinet built from installed drei RoundedBox, Environment and ContactShadows. 21st.dev tilt card is a motion reference only. Do not install the 54MB full ThreeUI catalog just to use a 4KB shader. No added core dependency.

### 2026-10-05 — Studio verification
- Production compilation uses `next build --webpack` in this environment: Turbopack failed while its CSS worker tried to bind a local port, including on the elevated retry. Webpack compiled and type-checked all routes.
- Landing and Terminal screenshots passed overflow, browser-error and serious/critical axe checks. Existing product interaction checks passed.
- The console's third channel is labelled APY, matching the displayed historical median staking yield; it does not claim to show validator revenue.

### 2026-10-05 — Night signal revision
User rejected the white landing. Cathode's public workstation preview now anchors the dark visual direction. Obsidian surfaces, orange actions, phosphor screen lighting and green/cyan/amber audience states replace the silver/cobalt treatment. Added CSS signal orbits, scan beam, drifting card, GSAP scroll depth, operator-row stagger and audience transitions. Pause now labels and pauses ambient animations; reduced motion disables them. Production webpack build, four breakpoint screenshots, axe and landing control tests passed.

## Product-specific network environment
User rejected generic server architecture and asked for Kage's visual impact in Solana context. Recompose existing R3F/drei scene into three-layer Solana-inspired gateway, surrounding validator nodes, delegated-stake and vault paths. Existing ThreeUI/21st effects do not encode Epoch's product relationships, so this composition uses installed primitives with original paths. Remove fixed full-screen WebGL background to reduce concurrent render load; retain section scenes with visibility and motion guards. The hero explicitly labels this as illustrative, not live telemetry.

## Supplied video becomes motion reference
User supplied WhatsApp Video 2026-10-06 at 00.25.12.mp4; inspected sampled frames across the 20-second reference. New target is flowing luminous ribbons behind an actual product panel. Replace architectural hero renderer with original Canvas2D flow field; keep user-approved ink/silver/amber. Installed GSAP/R3F/ThreeUI reviewed: continuous filaments need no mesh lighting or reflection, so a lightweight original canvas avoids the previous hero's WebGL overhead. Respect pause, reduced motion, viewport and tab visibility; moving points are explicitly illustrative.
- Latest requested hero reveal uses the existing Terminal data hooks and EpochChart rather than an embedded app or screenshot, allowing responsive text and genuine source labels. Existing Base UI menus provide keyboard/focus handling. New original SVG mark extends Epoch's prior circular identity.

## 2026-10-07 · Editorial landing reset
User selected an editorial opening with a cinematic Terminal reveal and rejected the previous centered dashboard opening. This supersedes the landing's locked Kraken layout. Mercury and Codeway are composition/motion references, not assets to copy. Keep the existing Epoch mark and ink/silver/amber palette. Compose existing shadcn navigation and TerminalPreview with GSAP scroll transitions and an original mark-derived sculpture using installed R3F/drei/Three primitives. Reviewed existing ThreeUI Structure Flow/CRT and library hero components; those effects do not represent Epoch's mark or fit this quieter brief. No new dependencies, HDR downloads or models. Remove the repeated illustrative network chart; its real counterpart already appears in TerminalPreview. Offscreen, background, paused and reduced-motion sculpture rendering is demand-only.

Additional reference inspection: Ramp UK and TradingView homepages, 7 Oct 2026. Ramp separates a compact promise/action from a large product showcase. TradingView presents one full-width editorial visual before its analysis surface. Apply hierarchy and the staged transition, without importing their palettes, testimonial claims, stock-market widgets or visual assets. Epoch's preview remains a sourced Solana stake chart, not a trading terminal simulation.

## Mercury scroll zoom · 7 October 2026
User explicitly requested Mercury's zoom-on-scroll interaction. Replace chrome sculpture and separate product reveal with one sticky scene containing the actual Terminal preview. GSAP scrubs product translation/scale from a framed scene into a full-width interface; no decorative WebGL. Reduced motion and Pause show normal document flow, with no long empty scroll track. Existing product actions remain links.


## 2026-10-07 · Colour hierarchy refinement
User requested a more considered fintech palette. Keep the current landing structure and motion. Mercury is the dominant restraint reference, with Ramp and TradingView reviewed as secondary product references. Use shared graphite surfaces, silver typography, cobalt primary landing actions, pale blue selection/progress, and muted amber for warning/sample states. Raise faint label contrast. This supersedes the old emerald default for the active studio theme. No new libraries or components.
