# 05 · MCP servers and skills

Claude Code started inside `app/` loads `app/.mcp.json` (project servers), `app/.claude/` (the router
skill, the design-cop agent, three commands, two guard hooks) and your global skills in `~/.claude/skills`.

## One-time setup (5 minutes)

```bash
cd epoch-protocol/app
bash scripts/install-skills.sh        # the few global skills; the rest ship in app/.claude/skills
claude                                # start Claude Code in app/
/mcp                                  # approve the project servers; sign in to refero, figma, reui
```

## Servers in `app/.mcp.json`

| Server | Transport | Sign-in | What it gives you | Prompts that work |
| --- | --- | --- | --- | --- |
| **refero** | HTTP `https://api.refero.design/mcp` | OAuth with your Refero Pro account on first use (`/mcp` → refero → Authenticate) | 150k+ real screens, 6k+ flows, curated styles. Tools: `refero_search_screens`, `refero_get_screen`, `refero_get_screen_image` (`image_size: "full"`), `refero_get_similar_screens`, `refero_search_flows`, `refero_get_flow`, `refero_search_styles`, `refero_get_style` | "Pull the locked screens for the validator page from handover/06-REFERO-SCREENS.md and show me the full images" · "Similar screens to 52465519…, limit 10" |
| **shadcn** | stdio `npx shadcn@latest mcp` | — | browse, search and install from shadcn and every registry in its index (`@magicui`, `@reui`, `@kibo-ui`, `@dashboardcn`, `@data-table-filters` …) | "Add tabs, tooltip, sheet and command, then re-skin to our tokens" |
| **magicui** | stdio `npx -y @magicuidesign/mcp@latest` | — | Magic UI components with their source | "Get number-ticker and animated-list; rewrite framer-motion imports to motion/react" |
| **context7** | stdio `npx -y @upstash/context7-mcp@latest` | — | current docs for any library (lightweight-charts v5, TanStack Table v9, GSAP, nuqs …) | "use context7: lightweight-charts v5 histogram series with a price scale on the left" |
| **playwright** | stdio `npx -y @playwright/mcp@latest` | — | drive a browser: open the app, click through flows, capture | "Open localhost:3000/validators, tick three rows, open the compare tray, screenshot" |
| **chrome-devtools** | stdio `npx -y chrome-devtools-mcp@latest` | — | performance traces, console, network, layout shifts in real Chrome | "Record a performance trace of /terminal and list long tasks over 50 ms" |
| **figma** | HTTP `https://mcp.figma.com/mcp` | OAuth (Figma account) | read frames and variables if you design anything in Figma first | "Get the variables from this frame and map them to our tokens" |
| **reui** | HTTP `https://mcp.reui.io` | sign in (free tier ≈ 100 requests/day) | ReUI blocks: data grid, stepper, stats | "Find a stepper for a three-step deposit and install it" |
| **css-studio** | stdio `npx -y cssstudio` | — | edit CSS visually in the browser; edits flow back into code | "Wait for edits from CSS Studio and apply them to the Hero component" |
| **solana-dev** | HTTP `https://mcp.solana.com/mcp` | — | Solana developer docs and examples (wallet adapter, SIWS, web3.js) | "How does signIn() in wallet-adapter build the SIWS message?" |

### Refero with a token instead of OAuth (optional)

If the browser sign-in is not possible, use an access token from your Refero account and keep it out of
the repo — local scope lives in `~/.claude.json`, and a local server overrides the project one:

```bash
export REFERO_TOKEN="…"   # in ~/.zshrc, never in a file inside the repo
claude mcp add --transport http --scope local refero https://api.refero.design/mcp \
  --header "Authorization: Bearer $REFERO_TOKEN"
```

Pro allows about 8,000 Refero calls a month; a full page study (`/refs <page>`) uses 15–30.

### Not in `.mcp.json` (add yourself if you want them)

- **21st.dev Magic:** `npx @21st-dev/cli@latest init --client claude` — needs a 21st.dev API key; it
  writes the server into your own Claude config, not the repo.
- **Kibo UI:** `npx -y mcp-remote https://www.kibo-ui.com/api/mcp/mcp` — returned HTTP 500 on 29 Sep 2026;
  its components install fine through the shadcn CLI without it.
- **Mobbin / Nicelydone:** only if someone buys a seat (see `docs/UI_SOURCES.md` §6).

## Skills

### In the kit: `app/.claude/skills/` (24 skills, loaded automatically)

Most skills now ship inside the kit, each with its licence, so Claude Code (and any agent that reads
`AGENTS.md`) has them without installing anything. The full list with sources and licences is in
`THIRD-PARTY-SKILLS.md`; `skills-lock.json` pins where each came from and `bash scripts/update-skills.sh`
refreshes them.

| Skill | Kind | Use it for |
| --- | --- | --- |
| epoch-ui-craft | Epoch router | invoke first for any frontend task; picks the one skill or library |
| refero-replica | Epoch | building any page as a structural replica of its Refero screens (with `ref-compare.mjs`) |
| sushant-special-fe | Sushant's own, scoped for Epoch | the landing's premium finish: hero object, scroll story, sourced sections |
| refero-design | Refero (MIT) | research method: styles → screens → flows |
| ui-ux-pro-max · shadcn | published (MIT) | pulling, integrating and re-skinning library components |
| frontend-design · design-taste-frontend | Anthropic (Apache-2.0) · Leonxlnx (MIT) | a landing that does not look templated |
| emil-design-eng · animation-vocabulary · review-animations · improve-animations · find-animation-opportunities · apple-design | Emil Kowalski (MIT) | animation and interaction craft |
| gsap-core · gsap-react · gsap-scrolltrigger · gsap-timeline · gsap-plugins · gsap-performance · gsap-utils | GreenSock, official (MIT) | everything GSAP |
| vercel-react-best-practices · vercel-composition-patterns · vercel-react-view-transitions | Vercel (MIT) | React and Next performance, component APIs, page transitions |

### Installed globally by `scripts/install-skills.sh`

Three.js skills (landing 3D; the source repo has no licence file, so they are not vendored),
`web-design-guidelines` (Vercel; no licence declared) and `impeccable` (Apache-2.0; installs a platform binary).

### Other coding agents

`AGENTS.md` repeats the rules for Codex, Cursor, Astra and other agents and points them at the same skill
files. To install the skills natively for another agent: `npx skills add <source> --skill <name> -a <agent>`
with the sources in `skills-lock.json`.

Alternative for Refero: the official Claude Code plugin bundles the same skill and the MCP —
`/plugin marketplace add referodesign/refero_skill` then `/plugin install refero@refero`. If you use the
plugin, delete the `refero` entry from `app/.mcp.json` on your machine so the tools are not listed twice.

## Agent and commands in `app/.claude/`

| Name | Kind | What it does |
| --- | --- | --- |
| design-cop | agent | Scores screenshots against the page spec and its Refero lock on 8 lines; writes `design/verdicts/<page>-<date>-r<n>.md`; returns numbered fixes |
| `/refs <page>` | command | Pulls the locked Refero screens, expands with similar screens, writes `design/screens/<page>.md` (no code) |
| `/screen <page>` | command | Builds one page inside the verification loop |
| `/design-review <route> <page>` | command | Screenshots + design-cop verdict, no code changes |

## Hooks (guard rails)

Best-effort guard rails that catch the common mistakes (an edit in `packages/`, a push to `main`); they are
not a sandbox, so keep reviewing diffs before you push.

| Hook | Runs before | Blocks |
| --- | --- | --- |
| `scope-guard.mjs` | Edit / Write / MultiEdit / NotebookEdit | any file outside `app/` (symlinks resolved, so `node_modules/@epoch/*` → `packages/` is blocked too); `.env`/`.env.local` and other env files except `.env.example`; keypair files |
| `git-guard.mjs` | every Bash command | shell writes (rm, mv, cp, sed -i, tee, redirects …) that resolve outside `app/` — relative, absolute or via `cd ..`; `git -C` outside app; `git rm/checkout/restore/clean/reset` outside app; pushes to main; force pushes; commits on main; `git add -A` / `-u` |
