# Kickoff prompt

Paste everything inside the box into Claude Code, started inside `epoch-protocol/app` on the branch
`feat/app-foundation`, after `pnpm install && pnpm build` at the repo root, `bash scripts/setup-frontend.sh`,
`bash scripts/install-skills.sh` and the `/mcp` sign-ins. It sets up the foundation and stops for review;
after that, build page by page with `/screen <page>`.

```text
You are the frontend engineer for Epoch in this folder (app/ of the epoch-protocol monorepo). Before
anything else read CLAUDE.md, handover/00-START-HERE.md, handover/03-DESIGN-SYSTEM.md,
handover/06-REFERO-SCREENS.md, handover/07-DATA-CONTRACTS.md and the app-shell rows SH1–SH13 in
handover/11-CLICK-MAP.md. Invoke the epoch-ui-craft router skill
for every task. Work only inside app/; anything the backend must do goes in handover/BACKEND-REQUESTS.md.

Goal of this session: Phase 0 (foundation) from handover/09-BUILD-ORDER.md, then stop and show me.

1. Check the setup: `git branch --show-current` is not main; app/package.json has the libraries from
   handover/04-UI-LIBRARIES.md (if not, tell me to run scripts/setup-frontend.sh);
   ../packages/epoch-sdk/dist exists (if not, tell me to run `pnpm build` at the repo root); the Refero MCP
   answers (call refero_get_screen for 47b50f40-2189-480a-8279-8d1796ddf5eb) — if it does not, stop and
   tell me to run /mcp and sign in.
2. tsconfig.json: add "handover" to "exclude" (the kit's template .ts files are not app code).
3. Tailwind v4 + shadcn WITHOUT `shadcn init` (init overwrites the first CSS file it finds with its stock
   palette). Add postcss.config.mjs with { plugins: { "@tailwindcss/postcss": {} } }. Copy
   handover/design/components.json to ./components.json, handover/design/tokens.css and globals.css to
   src/styles/, handover/design/motion.ts to src/design/motion.ts, and handover/design/lib/{gsap,anime,utils}.ts
   to src/lib/. From now on add primitives with `pnpm dlx shadcn@latest add <name> -y`.
4. src/app/layout.tsx: load Geist, Geist_Mono and Instrument_Serif (italic) with next/font/google as in
   03-DESIGN-SYSTEM.md; <html lang="en" data-theme="emerald" className="dark …font variables">; import
   @/styles/globals.css; metadata title "Epoch" and the one-line description.
5. Data layer: copy handover/contracts/epoch-data.ts to src/lib/data/types.ts and
   handover/fixtures/*.json to src/fixtures/. Add a QueryClient provider, src/lib/data/api.ts (reads
   NEXT_PUBLIC_EPOCH_API_URL, a per-resource USE_API map, all false except feeIndex behind a check) and
   one hook per resource exactly as in 07-DATA-CONTRACTS.md, including the Fee Index adapter and the
   "while on fixtures" behaviour. Add src/lib/format.ts (SOL, %, compact, signs with a true minus, "—" for
   missing), src/lib/explorers.ts (the tested link formats) and src/lib/health.ts (the health rules from
   01-PRODUCT-AND-USERS.md). Add .env.example with NEXT_PUBLIC_EPOCH_API_URL= and
   NEXT_PUBLIC_SOLANA_RPC_URL= (names only, no values).
6. App shell with the shadcn primitives you need (pull, re-skin to tokens, log in handover/PROVENANCE.md):
   header (EpochRing, nav, ⌘K search with cmdk, EpochPill with live dot and countdown from useNetwork,
   SOL price, Connect), footer strip (slot, TPS, sources, NetworkBadge, lightweight-charts attribution),
   phone nav in a vaul sheet, SampleBadge, and src/app/icon.svg (the Epoch ring) so there is no favicon
   404. Wallet provider (@solana/wallet-adapter-react, Wallet Standard discovery; Phantom, Solflare,
   Backpack first). The shell replicates Mercury's app shell (sidebar + top bar) as described in
   handover/12-REPLICA-BLUEPRINTS.md § App shell (pull the Mercury Insights screen 18cf9c6a with the Refero MCP
   first; start from the shadcn sidebar-07 block) and behaves exactly as rows SH1–SH13 say. Placeholder routes for /terminal, /validators,
   /validators/[vote], /me, /vault that render the shell and the page title only.
7. package.json scripts: "shots": "node scripts/ui/screenshot.mjs", "lint:ui": "impeccable detect src/".
8. Verify: `pnpm --filter app typecheck` and `pnpm --filter app build` pass (the first build adds a few
   Next defaults to tsconfig.json — keep them); start the production build (`pnpm --filter app start`),
   run `node scripts/ui/screenshot.mjs / landing --axe` and `node scripts/ui/screenshot.mjs /terminal terminal`,
   LOOK at every image, do the read-out-loud test on the header (one epoch number everywhere, a live dot
   only when data is live), then run the design-cop agent on the shell. Fix what it finds (max 3 rounds).
9. Commit in small steps on this branch with Conventional Commits, scope app (for example
   "chore(app): tailwind v4, shadcn config and Epoch tokens", "feat(app): app shell with epoch pill and
   wallet connect"). Stage with `git add .` plus `git add ../pnpm-lock.yaml` when package.json changed.
   Do not push.
10. Stop and give me: what you did, the screenshot paths, the design-cop verdict file, anything you put in
    BACKEND-REQUESTS.md, and the next page you suggest (the Terminal, per the build order).
```

## After the foundation

- One page per session: `/refs <page>` (references, no code) → review → `/screen <page>`.
- Order: terminal → validators → validator → sign-in → vault → my-stake → landing → predict (flagged).
- Push and open a PR when a page reaches design-cop all-PASS: see `08-GIT-WORKFLOW.md`.
