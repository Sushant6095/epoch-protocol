---
description: Score an Epoch route with design-cop without changing code
---
Route and page: $ARGUMENTS   (for example: `/validators validators`)

1. Make sure a production server is running (`pnpm --filter app build && pnpm --filter app start`).
2. `node scripts/ui/screenshot.mjs $ARGUMENTS --axe` and report any guard problems it prints.
3. LOOK at the four breakpoint shots and do the read-out-loud test.
4. Run the design-cop agent against the matching page spec in `handover/pages/`, the reference notes in
   `design/screens/` and the lock in `handover/06-REFERO-SCREENS.md`. It writes its verdict file.
5. Report the PASS/FAIL rubric and the numbered gap list only. Do not fix anything yet.
