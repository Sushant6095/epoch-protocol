# 09 — Premium component sourcing (replace generic components)

Generic components are the #1 "AI slop" tell. The fix isn't to hand-roll everything — it's to
source from premium libraries and **re-skin to the project's tokens**. Sourcing is the speed;
re-theming is the quality.

## Where to pull from
- **21st.dev** — heroes, bento grids, marquees, feature sections, pricing, testimonials, CTAs.
- **vibecodecomponents.com** — animated sections, scroll effects, decorative blocks.
- **Aceternity-style libraries** — spotlight cards, aurora/beam backgrounds, 3D card hovers,
  animated grids (great for landing atmosphere).
- **shadcn/ui (+ Radix)** — accessible primitives: dialog, dropdown, popover, tooltip, tabs,
  command palette, combobox. `npx shadcn@latest add …`.

## The re-theme workflow (non-negotiable)
1. **Copy** the component source in.
2. **Strip** its colors, fonts, radii, and shadows — every hardcoded value.
3. **Re-skin** to the surface's design tokens (CSS variables) and its font stack.
4. **Port** shared landing components into `src/components/landing/` (Epoch: only `app/` is yours) and log each in `handover/PROVENANCE.md`; don't scatter one-off styles.
5. **Verify** it passes the project's token-compliance check (no raw hex / off-token values).
6. **License-check** before shipping a public repo — gallery components carry their own terms.

A page that pastes 5 components from 5 sources verbatim looks like a patchwork — *more* generic,
not less. After re-theming they should read as one cohesive, bespoke system.

## Matching components to sections
| Section | Good source pattern |
|---------|---------------------|
| Hero | 21st.dev animated hero, or Engine-B frame-sequence canvas |
| Feature grid | bento grid (21st.dev / Aceternity) |
| Social proof | testimonial marquee, logo cloud |
| Atmosphere | aurora/beam/spotlight background (Aceternity-style), re-tinted |
| Primitives (modal, menu, tabs) | shadcn/ui + Radix |
| Pricing / CTA | 21st.dev pricing block, re-themed |

## Caution
- Don't import heavy decorative components into **dense data tables / the trading app** — they
  wreck density and performance. Premium components are for landing/marketing surfaces.
- Prefer copy-in (own the source, re-theme it) over a runtime dependency you can't restyle.
- Keep the bundle honest: lazy-load heavy visual sections; tree-shake.
