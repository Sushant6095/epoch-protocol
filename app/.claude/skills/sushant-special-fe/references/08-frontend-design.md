# 08 — Frontend design philosophy (Engine A: anti-AI-slop)

Create distinctive, production-grade interfaces with exceptional aesthetic detail. Implement
real working code; never settle for generic AI aesthetics.

## Design thinking (before coding)
Commit to a BOLD aesthetic direction:
- **Purpose** — what problem does this solve? who uses it?
- **Tone** — pick an extreme and own it: brutally minimal, maximalist chaos, retro-futuristic,
  organic/natural, luxury/refined, playful/toy-like, editorial/magazine, brutalist/raw,
  art-deco/geometric, soft/pastel, industrial/utilitarian. Use as inspiration; design one true
  to the direction.
- **Constraints** — framework, performance, accessibility.
- **Differentiation** — what makes this UNFORGETTABLE? the one thing someone remembers.

Choose a clear conceptual direction and execute with precision. Bold maximalism and refined
minimalism both work — the key is intentionality, not intensity. Then implement code that is
production-grade, visually striking, cohesive, and meticulously refined.

## Aesthetics guidelines
- **Typography** — beautiful, unique, characterful. Avoid generic fonts (Arial, Inter, Roboto,
  system). Pair a distinctive display font with a refined body font.
- **Color & theme** — commit to a cohesive aesthetic; CSS variables for consistency. Dominant
  colors with sharp accents beat timid, evenly-distributed palettes.
- **Motion** — high-impact moments over scattered micro-interactions. One orchestrated page
  load with staggered reveals (animation-delay) delights more than noise. CSS-only for HTML;
  Motion library for React. Surprising scroll + hover states.
- **Spatial composition** — unexpected layouts, asymmetry, overlap, diagonal flow,
  grid-breaking, generous negative space OR controlled density.
- **Backgrounds & detail** — atmosphere and depth, not solid fills: gradient meshes, noise,
  geometric patterns, layered transparency, dramatic shadows, decorative borders, custom
  cursors, grain overlays.

NEVER: overused fonts (Inter/Roboto/Arial/system), cliché schemes (purple gradients on white),
predictable layouts, cookie-cutter patterns. Vary light/dark, fonts, aesthetics across builds.
Never converge on the same common choices (e.g. Space Grotesk) every time.

Match implementation complexity to the vision: maximalist → elaborate code + extensive
animation; minimalist/refined → restraint, precision, careful spacing and typography.

## Scroll-driven website rules (when building an animated landing)
- **Typography as design** — hero headings 6rem+ (line-height 0.9–1.0, weight 700–800); section
  headings 3rem+; marquee text 10–15vw uppercase letterspaced; section labels 0.7rem uppercase
  tracked 0.15em+ muted ("001 / Features"). Size/weight/color ARE the structure.
- **No cards/boxes** — never glass/frosted containers around text on scroll sites. Text sits on
  the background; readability from weight (600+), text-shadow, and clean frames at text points.
- **Color zones** — background shifts between sections (light → dark → accent → light) via CSS
  vars `--bg-light/-dark/-accent`; text inverts (`--text-on-light/-on-dark`); transitions via
  GSAP, not CSS.
- **Layout variety** — ≥3 patterns (centered, left-aligned, right-aligned, full-width, split);
  never the same layout for consecutive sections.
- **Animation choreography** — each section a different entrance (fade-up, slide-l/r, scale-up,
  clip-path reveal); staggered child delays 0.08–0.12s; sequence label → heading → body → CTA;
  one section pins while contents animate; one oversized text element moves horizontally.
- **Stats & numbers** — 4rem+; count up via GSAP (never static); suffix unit element smaller;
  small-caps/uppercase muted labels below.
