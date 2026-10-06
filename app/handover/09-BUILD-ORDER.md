# 09 · Build order

Dates are IST and follow the gates in `docs/PLAN.md`. The demo judges see is a screen recording under
3 minutes at 1,280 px: Landing → Terminal (and its Fee Market tab) → Validators → a profile's Manage tab → Vault →
My Stake. Launch gets its own short clip for the Meteora side track.

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
- [ ] `/v1/network`, `/v1/network/stake-history`, `/v1/validators` and both delegator endpoints were built on 1 Oct
      for the branch `feat/api-network-validators-delegators`: once it is pushed, run it locally
      (`07-DATA-CONTRACTS.md`), and flip `USE_API` for each hook once Sushant deploys it (request #25).

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
- [ ] `/screen predict` in points mode (decisions 2 and 3, settled 1 Oct): Fee Index markets, calls with
      the sign-in session and no wallet transaction; the real-SOL path stays behind `PREDICT_REAL_SOL` (off).
- [ ] `/refs fee-market`, then `/screen fee-market` (7–8 Oct; plan F7 puts the Market UI on 8 Oct): the Terminal's
      Economy · Fee Market tabs, ticket, quotes by epoch, Fee Index chart with the forward quotes, docked tables, the
      review flow on epoch-sdk `openSwap` (request #20); fixtures until `GET /v1/market` (request #19).
- [ ] `/refs launch`, then `/screen launch` (8–9 Oct; plan F13 puts the Launch UI on 8 Oct): the list, the token page,
      the Trade card on `@epoch/meteora` (request #23); fixtures until `GET /v1/launches` (request #22).
- [ ] Passes on every page: reduced motion, contrast, axe clean, phone width, impeccable clean,
      1,280 px screen recording.

## Dry run and submission (11–12 Oct; side tracks close 13 Oct 12:29 IST)

- [ ] Every page on the production URL, network badge correct, no Sample badge on anything that is live.
- [ ] Record the demo; re-record after any visual fix.
- [ ] Record the Launch clip for the Meteora side track (closes 13 Oct 12:29 IST): list → rKEST-style token page →
      a devnet buy → the buyback feed.
- [ ] README screenshots from `design/screens/impl/`.

## Daily rhythm

Morning: pull main, pick one page section, `/refs` if new. Build one component at a time inside the
loop. Evening: PR with screenshots and the design-cop verdict, list anything you need from Sushant in
`BACKEND-REQUESTS.md`.
