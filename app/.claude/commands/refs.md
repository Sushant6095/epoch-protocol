---
description: Pull and write up the locked Refero references for one Epoch page (no code)
---
Page: $ARGUMENTS   (one of: landing, sign-in, terminal, fee-market, validators, validator, my-stake, predict, vault, launch)

Use the refero-design skill's method with the Refero MCP, starting from the reference lock — do not
research from scratch:
1. Read this page's section in `handover/06-REFERO-SCREENS.md` and `handover/pages/$ARGUMENTS.md`.
2. `refero_get_screen_image` (`image_size: "full"`) for the primary and each secondary and flow screen.
   Look at every image. `refero_get_screen` for their metadata.
3. `refero_get_similar_screens` on the primary (limit 10). Keep at most two extra screens, and only if they
   fit Epoch's content better than a locked secondary; say why.
4. If the page has a style lock, `refero_get_style` for it and note the tokens that map onto ours.
5. Write `design/screens/$ARGUMENTS.md`: ids and links (`https://refero.design/pages/<id>`), and for each
   screen a take / don't-take list (layout, hierarchy, density, component patterns, interaction details),
   then the decision ledger: which reference wins each region of the page.
6. If you saved images, put them in `design/screens/$ARGUMENTS/ref-*.png` (git-ignored). Do not write code.
