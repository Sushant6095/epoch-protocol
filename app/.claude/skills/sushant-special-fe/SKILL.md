---
name: sushant-special-fe
description: Build distinctive, premium, production-grade frontends and 3D scroll-animated websites that avoid generic AI aesthetics. Use whenever building a landing page, marketing site, hero section, scroll-driven animation, frame-sequence canvas (Apple-AirPods style), neumorphic/glassmorphic UI, or any surface that needs a memorable, non-generic, agency-quality look — even if the user only says "make it premium / less generic / replace these basic components / scroll animation / hero animation". Covers the full pipeline: anti-AI-slop design philosophy (distinctive type, bold aesthetic direction, atmosphere, motion choreography), the 3D-scroll engine (sticky canvas + frame sequence, Lenis smooth scroll, Framer Motion, perf hardening), and premium component sourcing (21st.dev / vibecodecomponents / shadcn / Aceternity, re-themed to project tokens). SCOPED for Epoch — full force on the landing (/) only, inside its Refero replica (Kraken staking landing); the app pages follow their Refero replicas and stay dense and calm.
license: Combines 3d-scroll-website + frontend-design skills.
---

# Sushant's Special Frontend Skill

Two engines in one skill, for building frontends that read as *bespoke and premium*, never
generic AI slop:

- **Engine A — Taste (frontend-design):** a bold, intentional aesthetic direction with
  distinctive typography, committed color, atmosphere, and choreographed motion. The cure for
  "it looks like every other AI site."
- **Engine B — 3D scroll pipeline (3d-scroll-website):** the agency-grade scroll experience —
  a sticky `<canvas>` scrubbing a pre-rendered frame sequence, Lenis smooth scroll, Framer
  Motion reveals, neumorphic/glass surfaces, and ruthless performance hardening.

You are the builder. The user brings the idea; you ship the whole surface.

## Epoch scoping (read FIRST)

Copied from Sushant's keel setup and scoped for Epoch. The page LAYOUT always comes from the page's Refero
screen (`refero-replica` skill, `handover/12-REPLICA-BLUEPRINTS.md`); this skill adds finish and motion inside
that layout, never a different layout.

| Surface | Apply this skill? | What "premium" means here |
|---------|-------------------|---------------------------|
| Landing `/` | **YES**, inside the Kraken-staking replica | the hero object (Engine B or R3F, the only WebGL on the site), headline choreography, section reveals, premium sourced components re-themed to `--ep-*` |
| Terminal, Validators, Validator, My Stake, Predict, Vault | **NO** decoration | density, tabular numbers, calm dark tokens, library components, micro-motion only (see `motion.ts`) |
| Sign in | light touch | the left panel may use a soft gradient from Epoch tokens; nothing else |

Epoch differences from the original keel pins: use the versions in `handover/04-UI-LIBRARIES.md`; `framer-motion`
is `motion` imported from `motion/react`; icons are lucide, not Phosphor; fonts are Geist, Geist Mono and one
Instrument Serif accent (Engine A's "never Inter" advice is satisfied: Epoch uses Geist); no neumorphic or glass
surfaces anywhere in the app.

## Replace generic components — premium component sourcing

The fastest way off "generic AI components" is to source from premium libraries and **re-skin
them to the project tokens**, not ship them raw. See `references/09-premium-component-sources.md`.

- Pull heroes, bento grids, marquees, feature sections, pricing, testimonial blocks from
  **21st.dev, vibecodecomponents.com, Aceternity-style libraries, and shadcn/ui**.
- **Non-negotiable:** strip their colors + fonts → re-theme to `--ep-*` tokens → put it in `src/components/…` and
  add a row to `handover/PROVENANCE.md` before shipping. A page that pastes galleries verbatim is a patchwork
  and reads *more* generic, not less. Re-theming is the whole game.
- Check each component's license before shipping a public repo.

## Engine A — the taste philosophy (anti-AI-slop)

Full guide: `references/08-frontend-design.md`. The essentials:

- **Commit to a bold aesthetic direction.** Pick one and execute with precision: brutalist,
  editorial, retro-futuristic, luxury/refined, organic, art-deco… Intentionality over intensity.
- **Distinctive typography.** Pair a characterful display face with a refined body face. On
  landing surfaces avoid Inter/Roboto/Arial defaults; pick fonts that elevate. Hero headings
  6rem+, tight line-height (0.9–1.0), heavy weight.
- **Committed color.** Dominant color + sharp accents beats a timid evenly-spread palette. CSS
  variables for consistency. Avoid the purple-gradient-on-white cliché.
- **Atmosphere & depth.** Gradient meshes, noise/grain, geometric patterns, layered
  transparency, dramatic shadows, custom cursors — not flat solid fills.
- **Motion choreography.** One well-orchestrated page load with staggered reveals beats
  scattered micro-interactions. Scroll-triggering + surprising hover states.
- **Spatial composition.** Asymmetry, overlap, diagonal flow, grid-breaking, generous negative
  space OR controlled density. Layout variety — never the same layout twice in a row.

## Engine B — the 3D scroll pipeline

The "3D feel" is almost never runtime WebGL. It's a **pre-rendered image sequence** (100–120
frames from Blender/C4D/AE) that a `<canvas>` scrubs based on scroll position, while the
viewport is pinned sticky and a tall parent drives the scroll. Everything else is polish.

Reach for real 3D (Three.js/R3F) only when the scene must respond to mouse/drag/gestures or
needs real-time lighting/physics. Otherwise the frame sequence wins — smoother on mobile,
art-directable in a real 3D tool.

### Stack (pinned — see `references/01-tech-stack.md`)
Next 16.2.2 · React 19 · Tailwind v4 · Framer Motion 12.38 · Lenis 1.3.21 · Geist · Phosphor.

### Build order (do not deviate)
Scaffold → design tokens → primitives (`AnimatedSection`, `AnimatedItem`, `Button`,
`EyebrowBadge`) → **Hero (frame-sequence canvas)** → second canvas (tunnel/showcase) →
supporting sections (bento, services, process, testimonials, FAQ) → final CTA → polish. Build
top to bottom, check each section in a real browser before moving on.

### Frame-sequence engine (the core technique — `references/03`)
```
<section style="height:400vh"><div class="sticky top-0 h-screen"><canvas/></div></section>
```
The scroll handler does four things: compute progress (`-rect.top / (offsetHeight - innerH)`,
clamp 0–1) → pick frame (`floor(progress * FRAME_COUNT)`) → draw cover-fit (×1.3 zoom on
mobile) → toggle annotation cards (diff the visible set, only setState when it changes).

**Non-negotiable perf rules:** RAF + ticking-ref (never sync DOM in the scroll handler) ·
direct-DOM for hot updates (canvas/opacity/transform via refs, never React state) · preload all
frames with a real loading bar · DPR-aware canvas sizing (no retina blur) · passive scroll
listeners. Full deep-dive: `references/06-performance-optimization.md`.

### Smooth scroll, Framer Motion, design system
- Wrap the app in a `SmoothScrollProvider` (Lenis); Safari wants higher `lerp`, no `syncTouch`.
- Framer vocabulary: `AnimatedSection`/`AnimatedItem` staggered `whileInView`, infinite
  rotations, `AnimatePresence`, CSS-3D cubes, SVG path animations (`references/02`).
- Neumorphic system: 6-layer outer shadow + 1 inset highlight; glass `backdrop-blur-xl`;
  committed palette; Geist; generous spacing (`references/04`).

## References index (pull on demand — don't read all up front)
- `references/01-tech-stack.md` — versions, installs, fonts
- `references/02-animation-techniques.md` — every non-canvas Framer pattern
- `references/03-scroll-animation-deep-dive.md` — full frame/scroll math + mobile
- `references/04-design-patterns.md` — neumorphic stack, palette, type, spacing
- `references/05-component-architecture.md` — file layout, SSR rules
- `references/06-performance-optimization.md` — RAF, direct-DOM, preload, hardening
- `references/07-claude-code-guide.md` — prompting + workflow
- `references/08-frontend-design.md` — the anti-AI-slop taste philosophy (Engine A)
- `references/09-premium-component-sources.md` — 21st.dev/shadcn/Aceternity sourcing + re-theme
- `references/10-epoch-scoping.md` — exactly which Epoch surface gets what

## Common pitfalls
Missing `"use client"` (#1 hydration bug) · Phosphor in server comps needs `/dist/ssr` · frames
not preloaded (blank canvas) · React state on scroll value (jank — use refs) · retina blur (DPR)
· Safari Lenis stutter · Next 16 API drift (read `node_modules/next/dist/docs/`) · skipping the
loading bar · **applying Engine A/B to the dense trading app** (see scoping table).

Ship in order. Check each section in a real browser. Build something that makes people stop scrolling.
