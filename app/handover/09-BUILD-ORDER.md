# 09 · Build order

Dates are IST and follow the gates in `docs/PLAN.md`. The demo judges see is a screen recording under
3 minutes at 1,280 px: Landing → Terminal → Validators → a profile's Manage tab → Vault → My Stake.

## Phase 0 — foundation (29–30 Sep)

- [ ] Kit in place (`app/README.md`), `pnpm install && pnpm build` at the root, `bash scripts/setup-frontend.sh`,
      `bash scripts/install-skills.sh`,
      `/mcp` sign-ins (Refero, Figma, ReUI).
- [ ] `app/tsconfig.json`: add `"handover"` to `exclude` (the kit's template `.ts` files are not app code).
- [ ] No `shadcn init` (it overwrites CSS): copy `handover/design/components.json` to `app/`, `tokens.css` and
      `globals.css` to `src/styles/`, `motion.ts` to `src/design/`, `lib/{gsap,anime,utils}.ts` to `src/lib/`;
      fonts via `next/font/google`; `<html data-theme="emerald" className="dark">`.
- [ ] Data layer: QueryClient provider, `src/lib/data/types.ts` from `handover/contracts/epoch-data.ts`,
      fixtures in `src/fixtures/`, one hook per resource (all on fixtures), `src/lib/format.ts`,
      `src/lib/explorers.ts`, `src/lib/health.ts`.
- [ ] App shell: header (EpochRing, nav, search, EpochPill, price, Connect), footer (slot, TPS, sources,
      network badge), phone nav sheet. Wallet provider with Phantom, Solflare, Backpack.
- [ ] Verify the loop works end to end once: production build → `screenshot.mjs / landing --axe` → design-cop.

## Gate 1 — Terminal live on mainnet (1 Oct)

- [ ] `/refs terminal`, then `/screen terminal`: KPI strip, Stake on the move (lightweight-charts line +
      in/out histogram, 32/64 toggle), epoch panel, network health, tabbed tables (Top validators,
      Biggest delegators; Loan book on sample), Fee Index card with explainer, live activity (sample).
- [ ] Switch `useFeeIndex` to `GET /v1/index` as soon as `api_app` serves it; others stay on fixtures
      until their endpoints land.

## Gate 2 — first real advance (5 Oct)

- [ ] `/screen validators`: virtual table, chips and sort in the URL, compare tray, phone cards.
- [ ] `/screen validator`: header, gauges, tiles, five tabs, stake moves; Manage tab (operator only)
      with the borrow console on `epoch-sdk` (amount → preview → wallet → pending → done).
- [ ] `/screen sign-in`: Sign In With Solana end to end, account creation, read-only mode.
- [ ] `/screen vault` on devnet: tranche cards, performance chart, deposit flow with TxPreview, what
      protects you (waterfall + stress slider), tables. Terminal loan book and activity from the indexer.

## Gate 3 — feature freeze (9 Oct)

- [ ] `/screen my-stake`: tiles, alert banner, stake accounts, rewards per epoch, where your stake sits,
      healthier homes with the move plan, alerts.
- [ ] `/screen landing` with live numbers, the 3D/shader hero, how-it-works flow, verify tiles.
- [ ] `/screen predict` ONLY if decisions 2 and 3 in `10-OPEN-DECISIONS.md` are cleared; otherwise it
      ships behind a feature flag (points-only mode or hidden).
- [ ] Passes on every page: reduced motion, contrast, axe clean, phone width, impeccable clean,
      1,280 px screen recording.

## Dry run and submission (11–12 Oct; side tracks close 13 Oct 12:29 IST)

- [ ] Every page on the production URL, network badge correct, no Sample badge on anything that is live.
- [ ] Record the demo; re-record after any visual fix.
- [ ] README screenshots from `design/screens/impl/`.

## Daily rhythm

Morning: pull main, pick one page section, `/refs` if new. Build one component at a time inside the
loop. Evening: PR with screenshots and the design-cop verdict, list anything you need from Sushant in
`BACKEND-REQUESTS.md`.
