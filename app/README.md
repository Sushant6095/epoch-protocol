# epoch-frontend — the frontend handover kit for Epoch

Everything Chahat (GitHub `chahat-code`) needs to build Epoch's web app in `app/`: how every page should
look (the exact Refero screens, locked per page), what each page shows and where its data comes from,
the UI libraries and their MCP servers and skills, the Claude Code setup with guard rails, fixtures to
build against today, and the git rules. Sushant owns the backend and the Solana program; Chahat owns the
frontend and the UI.

## Install (10 minutes, on your Mac)

```bash
# 1. Get the repo and a branch (you are a collaborator on Sushant6095/epoch-protocol)
git clone git@github.com:Sushant6095/epoch-protocol.git
cd epoch-protocol
corepack enable && corepack prepare pnpm@10.28.0 --activate
pnpm install
pnpm build                # builds packages/* so @epoch/epoch-sdk resolves in app/
git switch -c feat/app-foundation

# 2. Drop this kit into the frontend folder. Nothing existing in app/ is overwritten.
cp -R ~/Downloads/epoch-frontend/. app/

# 3. Libraries, then the few global skills (the rest already ship in app/.claude/skills)
bash app/scripts/setup-frontend.sh
bash app/scripts/install-skills.sh

# 4. Claude Code inside app/
cd app
claude
#   /mcp  → sign in to refero (your Refero Pro account), figma, reui
#   then paste the prompt from handover/KICKOFF-PROMPT.md
```

Claude Code started inside `app/` picks up `CLAUDE.md` (the law), `.claude/` (the router skill, the
design-cop agent, `/refs` `/screen` `/design-review`, and two guard hooks) and `.mcp.json` (Refero,
shadcn, Magic UI, Context7, Playwright, Chrome DevTools, Figma, ReUI, CSS Studio, Solana docs).

## The design

**The look is the Refero screens.** Each page is built as a structural replica of its locked Refero screens
(same shell, grid, regions, spacing, type steps, components, states, flows and motion) with Epoch's own
colours, fonts, logo, words and data: `handover/12-REPLICA-BLUEPRINTS.md`, the `refero-replica` skill and
`scripts/ui/ref-compare.mjs`. **Every component comes from a library** (`handover/04-UI-LIBRARIES.md`).
The design canvas "Epoch — UI designs (5 pages)" and its renders in `handover/design/boards/` only map which
content and controls exist (the Fee Market and Launch, added on 1 Oct, have no board: their specs are the map);
what every click does is in `handover/11-CLICK-MAP.md`. Where a board and a spec disagree, the spec wins.

## The Refero screen to follow first

**Wealthsimple — NVDA stock page (dark)**, Refero `47b50f40-2189-480a-8279-8d1796ddf5eb`
(https://refero.design/pages/47b50f40-2189-480a-8279-8d1796ddf5eb). One asset, one hero number, one chart,
one action panel on the right, calm details below: it is Epoch's validator page, and its grammar repeats on
the Vault and Predict. Every other page's lock is in `handover/06-REFERO-SCREENS.md`.

## What is inside

| Path | What it is |
| --- | --- |
| `CLAUDE.md` | The frontend law: scope, stack, design, Refero-first, verification loop, data, Web3, copy, git, done |
| `.mcp.json` | Project MCP servers (no tokens in the file; Refero signs in with OAuth) |
| `.claude/skills/epoch-ui-craft/` | The router: sends each task to the right published skill or tool, lists what to hand-build |
| `.claude/agents/design-cop.md` | The judge: 8-line rubric against the spec and the Refero lock; writes a verdict file |
| `.claude/commands/` | `/refs <page>`, `/screen <page>`, `/design-review <route> <page>` |
| `.claude/hooks/` | Guards: no edits or shell writes outside `app/`, no `.env`/keypairs, no pushes to `main`, no force pushes |
| `.claude/settings.json` | Hook wiring and a safe permission allow-list |
| `.impeccable/config.json` | Anti-slop detector settings (`npx impeccable detect src/`) |
| `handover/design/components.json` | shadcn 4 config (`base-nova`, CSS at `src/styles/globals.css`) — copy it instead of running `shadcn init` |
| `handover/00-START-HERE.md` | Reading order and the pages at a glance |
| `handover/01 … 10` | Product and users · sitemap and routes · design system · UI libraries · MCP servers and skills · Refero screens · data contracts · git workflow · build order · open decisions |
| `handover/11-CLICK-MAP.md` | What every click does on every page (322 rows, the Fee Market and Launch included): route, UI change, hook or call, loading · empty · error · success |
| `handover/12-REPLICA-BLUEPRINTS.md` | The look: every region of every Refero screen mapped to Epoch content and a library component |
| `handover/13-BACKEND-AND-PROGRAM-MAP.md` | The wiring: per screen, which API it reads and which program instruction the wallet signs; what the backend and program have today; the words for every program error |
| `.claude/skills/` | 24 skills: the router, `refero-replica`, Sushant's `sushant-special-fe`, and 21 published design, motion and React skills with their licences (list: `THIRD-PARTY-SKILLS.md`) |
| `AGENTS.md` | The same rules for any other coding agent (Codex, Cursor, Astra …) |
| `skills-lock.json` · `scripts/update-skills.sh` | Where each vendored skill came from; refresh them |
| `scripts/ui/ref-compare.mjs` | Structure check against a Refero screen: side-by-side, overlay, edges, row and column scores |
| `handover/pages/` | One spec per page: job, hero, sections with data fields, Refero lock, states, done-checklist |
| `handover/contracts/epoch-data.ts` | TypeScript types every hook returns |
| `handover/fixtures/` | Real mainnet data (29 Sep 2026) and rule-consistent sample protocol data, typed |
| `handover/design/` | `tokens.css` (two themes), `globals.css` (Tailwind v4 + shadcn mapping), `motion.ts`, `lib/gsap.ts`, `lib/anime.ts`, `boards/` (full-page renders of the approved canvas boards), `wireframes/` (old content maps, superseded) |
| `handover/KICKOFF-PROMPT.md` | The first prompt to paste: builds the foundation and stops for review |
| `handover/DECISIONS.md` · `PROVENANCE.md` · `BACKEND-REQUESTS.md` | The ledgers you keep updating |
| `scripts/setup-frontend.sh` · `scripts/install-skills.sh` | Installs every library (pinned ranges) and the few skills kept global (Three.js, web-design-guidelines, impeccable); the rest ship in `.claude/skills/` |
| `scripts/ui/screenshot.mjs` | The loop's eyes: 4 breakpoints + guards for console errors, blank charts, overflow, axe |
| `design/` | Our screenshots (`screens/impl/`), reference notes (`screens/<page>.md`), design-cop verdicts |

## The rules that matter most

1. **Only `app/` is yours.** Never edit `programs/`, `packages/`, `tests/`, `deployments/`, `docs/`, `.github/`
   or root configs. Backend needs go in `handover/BACKEND-REQUESTS.md`.
2. **Replicate the Refero screen, libraries first.** Structure 1:1 from the locked screens; tokens, fonts,
   content and data are Epoch's; every component comes from a library or registry.
3. **Never ship without looking.** Production build → screenshots at four sizes → look → design-cop.
4. **Never show fake data as real,** and never ask anyone for a seed phrase.
