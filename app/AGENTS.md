# Agent instructions for app/ (any coding agent: Claude Code, Codex, Cursor, Astra and others)

Claude Code reads `CLAUDE.md` and `.claude/`. Other agents: this file is your entry point and says the same
thing in short. Where anything here disagrees with `CLAUDE.md`, `CLAUDE.md` wins.

## The job
Build Epoch's web app in `app/` only. Epoch: validators borrow against their next paychecks, lenders earn the
fees, every staker sees which validators are healthy. Read `handover/00-START-HERE.md` first.

## The three laws
1. **The look is the Refero screen.** Each page is a structural replica of its locked Refero screens: same
   shell, grid, region order and size, spacing, type steps, components, states, flows and motion. Blueprints:
   `handover/12-REPLICA-BLUEPRINTS.md`; method: `.claude/skills/refero-replica/SKILL.md`; check:
   `node scripts/ui/ref-compare.mjs <route> <page> --ref <image>`. Identity stays Epoch's: `--ep-*` colours,
   Geist fonts, lucide icons, Epoch words and data. Never copy a logo, colour, illustration or text from a
   reference.
2. **Libraries first.** Every component comes from a library or registry (`handover/04-UI-LIBRARIES.md`,
   router §2 and §4 in `.claude/skills/epoch-ui-craft/SKILL.md`). Writing one from scratch needs a line in
   `handover/DECISIONS.md` that names the libraries you searched.
3. **Every click is specified.** Behaviour, data calls and states come from `handover/11-CLICK-MAP.md`; each
   row is a test case. Missing behaviour → add a row first. Which API and program instruction each screen
   uses, and what exists today: `handover/13-BACKEND-AND-PROGRAM-MAP.md`.

## Skills (playbooks you should read before the matching task)
All in `.claude/skills/<name>/SKILL.md`. Start with `epoch-ui-craft` (it tells you which one to open next).
Page layout → `refero-replica`. Components → `ui-ux-pro-max`, `shadcn`. Landing finish → `sushant-special-fe`,
`frontend-design`, `design-taste-frontend`. Motion → `emil-design-eng`, `gsap-*`, `apple-design`,
`vercel-react-view-transitions`. React quality → `vercel-react-best-practices`, `vercel-composition-patterns`.
Your agent can also install them natively: `npx skills add <source> --skill <name> -a <your-agent>` with the
sources in `skills-lock.json`.

## Scope and safety
Edit only `app/`. Never touch `programs/`, `packages/`, `tests/`, `deployments/`, `docs/`, `.github/` or root
configs; backend needs go in `handover/BACKEND-REQUESTS.md`. Never create or commit `.env` files, keypairs,
seed phrases, API keys or tokens. Never push to `main`; one feature branch per page, Conventional Commits.

## Done means
Production build green; `ref-compare.mjs` ≥ 0.85 rows and columns at 1440 and 1280; screenshots at four
breakpoints looked at; design-cop verdict all PASS; every click-map row for the page checked; `npx impeccable
detect src/` clean.
