---
name: refero-replica
description: Rebuild an Epoch page as a structural replica of its locked Refero screens, matching grid, region order and sizes, spacing, type steps, components, states and motion 1:1, using library components with Epoch's tokens and data. Use for every page build and any "make it look exactly like the Refero screen" request. Pairs with /screen, handover/12-REPLICA-BLUEPRINTS.md and scripts/ui/ref-compare.mjs.
---

# refero-replica: build the page the Refero screen shows

The target for every Epoch page is its locked Refero screen, not the design canvas. When a page is done,
a designer holding the reference next to it should say "same layout, same rhythm, same components".
The only differences allowed are identity: Epoch's colours, fonts, logo, words and data.

## What must match the reference exactly

| Match | How to check |
| --- | --- |
| App shell and page grid: sidebar or top bar, content width, columns, gutters, side margins | ref-compare column score ≥ 0.85; overlay |
| Region order, position and size: header, hero, cards, charts, tables, panels | ref-compare row score ≥ 0.85; overlay within 8 px at the reference width |
| Spacing rhythm between and inside regions | measure, then snap to the 4/8 px scale |
| Type steps: relative size and weight of display, titles, body, labels, numbers | map each step to the nearest Epoch type token; keep the same number of steps |
| Component anatomy and density: segmented vs underline tabs, pill vs square buttons, row height, card padding, chip size, icon size | pick the library component with the same anatomy (see the blueprint's "Library" column) |
| States: hover, focus, selected, disabled, empty, loading, error, dialogs | from the Refero flow when there is one, else the click map row |
| Flows: step order, what each step shows, transitions | the Refero flow (8823 sign-in, 8894 deposit, 8510 order) |
| Motion: what moves, when, duration, easing | the flow and the reference's live site when public; else `src/design/motion.ts` |

## What stays Epoch's (never copied)

Logo and brand name · colours (map the reference's colour roles to `--ep-*` tokens: their page background →
`--ep-bg`, card → `--ep-surface`, raised → `--ep-raised`, divider → `--ep-line`, primary action → `--ep-accent`,
negative → `--ep-warn`; never copy a hex) · fonts (Geist, Geist Mono for every number, Instrument Serif only
for the landing accent) · illustrations, photos and 3D art (use nothing, or Epoch's ring) · icons (lucide) ·
copy and data (from `handover/pages/<page>.md`, the fixtures and the click map).
Nothing captured from a reference enters `src/`: no image, no copied CSS, no text. Measurements and
structure only. What repeats across references is a pattern you may use; what is unique to a brand is
their identity and stays theirs. This keeps Epoch out of trade-dress trouble and stops the app from looking
like five different companies stitched together.

## Procedure for one page

1. **Pull the screens.** For every screen of the page in `handover/12-REPLICA-BLUEPRINTS.md`:
   `refero_get_screen` (metadata: original URL and viewport) and `refero_get_screen_image` with
   `image_size: "full"`. Save as `design/screens/<page>/ref-<role>-<first 8 of id>.png` (git-ignored).
   Flows: `refero_get_flow`. Refero images are about 800 px wide: multiply every measurement by
   (original viewport width / image width), usually 1440 / 800 = 1.8.
2. **Measure.** Copy the page's blueprint into `design/screens/<page>.replica.md` and complete it: canvas
   width, content width, columns, gutters; for each region x, y, w, h at the original width; type steps;
   spacing; radii; states; motion. When the original page is public (the metadata URL), open it with the
   Playwright MCP at the same viewport and read computed sizes, line heights, paddings and gaps from the
   DOM. Never read or reuse its colours or assets.
3. **Pick library parts.** Every region gets a library component with the same anatomy, in this order:
   shadcn/ui → the registries in `handover/04-UI-LIBRARIES.md` (Magic UI, ReUI, Kibo UI, openstatus
   data-table, dashboardcn, Aceternity, Animate UI, Motion Primitives, React Bits, Kokonut UI, Eldora UI) →
   lightweight-charts / Recharts / visx for charts. Write the install command next to each region. Only a
   thin wrapper that composes library parts may be written by hand; a component built from scratch needs a
   line in `handover/DECISIONS.md` saying which libraries were searched.
4. **Build top to bottom,** one region at a time: shell, page header, then each region. Tokens only,
   data from the typed hooks, behaviour from the page's rows in `handover/11-CLICK-MAP.md`.
5. **Compare after every region.** Production build, then
   `node scripts/ui/ref-compare.mjs <route> <page> --ref design/screens/<page>/ref-primary-<id8>.png`.
   It writes a side-by-side, a 50% overlay and an edge overlay (reference orange, ours mint, overlap white)
   to `design/screens/compare/` and prints row and column scores. LOOK at the edges image: fix every
   region whose outline is off by more than 8 px, then run it again. Done at ≥ 0.85 on both scores.
6. **Then the normal loop:** four-breakpoint screenshots, read-out-loud test, design-cop (its line 4 is
   judged on these compare images).

## When Epoch's content does not fit the reference

Keep the region's size and anatomy; shorten or split the content, or move it to the page that has a slot
for it (the blueprint lists these moves). If a feature has no slot anywhere (for example the compare tray),
build it from library parts in the reference's style and list it under "Additions" in the replica file.

## Pitfalls

- Copying a hex, a gradient or an illustration from the screenshot.
- Measuring the 800 px image as if it were the real size.
- Matching the reference at one width only: check 1440 and 1280, then make phones follow the reference's
  own mobile screens if Refero has them (`refero_get_similar_screens`), else stack in reading order.
- Hand-building a table, tabs, a date range picker or a stepper that a registry already ships.
- Letting the design canvas decide the look. The canvas boards and `handover/design/boards/*.jpg` only say
  which content and controls exist; the Refero screens decide how they look.
