---
description: Build or refine one Epoch page inside the verification loop
---
Page: $ARGUMENTS   (one of: landing, sign-in, terminal, validators, validator, my-stake, predict, vault)

Invoke the epoch-ui-craft router first, then:
1. Read `handover/pages/$ARGUMENTS.md`, this page's section of `handover/12-REPLICA-BLUEPRINTS.md` (the look),
   its rows in `handover/11-CLICK-MAP.md` (plus SH1–SH13 for the shell; the behaviour) and glance at the board
   render linked at the top of the spec (which content exists, not the look).
2. Follow the `refero-replica` skill: pull every screen of the page with the Refero MCP into
   `design/screens/$ARGUMENTS/ref-*.png`, then write `design/screens/$ARGUMENTS.replica.md` (measurements,
   region → library component → Epoch content).
3. Plan (plan mode): the library components to pull for each region (router §2 and §4; nothing hand-built that a
   registry has) and the exact hooks, types and fixtures (`handover/07-DATA-CONTRACTS.md`). Pull and re-skin the
   components first.
4. Build ONE component or state at a time, tokens only, wired to the typed hooks.
5. After each: `pnpm --filter app build && pnpm --filter app start` (production), then
   `node scripts/ui/ref-compare.mjs <route> $ARGUMENTS --ref design/screens/$ARGUMENTS/ref-primary-<id8>.png`
   → LOOK at the edges image and fix every region off by more than 8 px → `node scripts/ui/screenshot.mjs <route>
   $ARGUMENTS --axe` → LOOK at sm/md/lg/xl → read-out-loud test → run the design-cop agent → fix the numbered
   gaps, naming each gap you target.
6. Loop until all eight lines PASS at four breakpoints, or 6 rounds; then stop and show the human the last diff.
DONE = ref-compare ≥ 0.85 rows and columns at 1440 and 1280, design-cop verdict file all-PASS on fixture data,
every click-map row for this page checked (a
Playwright test per row where it can be automated), typecheck and build green, screenshot guards and
`npx impeccable detect src/` clean. Then add a line to `handover/DECISIONS.md` for any design decision,
rows to `handover/PROVENANCE.md` for pulled components, and commit on your feature branch.
