# Provenance — every component that did not start from a blank file

A row per pulled or reused component. No row = not done (design-cop fails the TOKENS line without it). Licence must be MIT,
Apache-2.0, BSD, ISC or CC-BY; never AGPL, "all rights reserved", unlicensed, or Shadcnblocks.
Code reused from before the hackathon window (for example from omnipitch) is marked `pre-hackathon`
and disclosed in the PR description.

| Component (our path) | Source (registry / repo / URL) | Licence | Pulled via | Where used | What we changed | Pre-hackathon? |
| --- | --- | --- | --- | --- | --- | --- |
| `src/styles/tokens.css`, `globals.css`, `src/design/motion.ts`, `src/lib/gsap.ts`, `src/lib/anime.ts` | this handover kit (patterns follow omnipitch 2's motion/tokens files) | repo MIT | copy | everywhere | written for Epoch | pattern only |
| `src/components/ui/*`, `src/hooks/use-mobile.ts` | https://github.com/shadcn-ui/ui (base-nova registry) | MIT | shadcn add sidebar-07 command badge progress dialog dropdown-menu | Shared shell and command search | Epoch tokens; 240px sidebar; mobile touch targets; raw sources preserved in vendor/_raw | no |

| `src/components/ui/accordion.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/avatar.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/badge.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/breadcrumb.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/button.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/card.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/checkbox.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/collapsible.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/command.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/dialog.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/dropdown-menu.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/input.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/input-group.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/progress.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/select.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/separator.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/sheet.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/sidebar.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/skeleton.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/slider.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/table.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/tabs.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/textarea.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/ui/tooltip.tsx` | shadcn/ui base-nova | MIT | shadcn CLI | Epoch interface | Epoch semantic tokens, focus and motion | no |
| `src/components/epoch/epoch-chart.tsx` | lightweight-charts 5 public API | Apache-2.0 | npm | Timeseries | Epoch scale labels, colours and formatter; attribution retained | no |
| `src/components/epoch/hero-object.tsx` | React Three Fiber + drei Torus | MIT | npm | Landing only | Original epoch-ring composition of library geometry, demand rendering and error fallback | no |
| Validators table | TanStack Table v9 + Virtual | MIT | npm | Validator explorer | Typed row model and responsive layout | no |
| Vault allocation | Recharts PieChart | MIT | npm | Vault | Epoch colour roles | no |

## 5 October visual overhaul

- ThreeUI Community CRT shader: `https://github.com/MengTo/threeui/blob/main/src/shaders/crt/crtShaders.ts`, MIT, © 2026 Meng To. Vendored with LICENSE at `src/components/vendor/threeui/`. Original fragment preserved; mesh UV adaptation at import in `revenue-console.tsx`. Original Epoch canvas content replaces the unrelated Zion boot log. No Pro source used.
- R3F/drei RoundedBox, Environment/Lightformer, ContactShadows compose the original silver console. Existing installed dependencies; local type declarations checked before use.
- 21st.dev Awanish Verma 3D tilt card: `https://21st.dev/@avanishverma4/components/3d-tilt-card`. Reference for pointer depth only; no source copied.
- GSAP React/ScrollTrigger, installed version, official React guidance read. Scoped timelines, cleanup, reduced-motion and visibility guards.
- Refero Lusion style `15c1f822-2f9b-4252-b76c-d32729f0abcf`: visual inspiration; no brand art copied. Codeway and Bending Spoons official pages researched for type hierarchy and product presentation.

## ThreeUI field studies · 5 October 2026
- Structure Flow: https://threeui.com/three-js/structure-flow — public MIT `structureFlowRenderer.ts` dome distribution adapted to existing R3F with deterministic particles and visibility/reduced-motion handling. Original upstream package imports Three128; no second Three runtime installed.
- Laser / Matrix Field: https://threeui.com/backgrounds/matrix-field — public MIT `laserShaders.ts` vendored at `src/components/vendor/threeui/laser-shaders.ts`, with existing ThreeUI MIT license alongside. Vanishing Array used in closing chapter with R3F lifecycle wrapper.
- 3D Paper: https://threeui.com/three-js/3d-paper — inspected public bending-paper preview. Original Epoch mesh deformation/texture implementation; no certificate copy, names, claims, or source assets taken. 21st.dev tilt-card interaction is a pattern reference; existing R3F pointer smoothing implements depth. No third-party card code copied.
- GSAP provides scoped entrance, audience transition and scroll choreography. TasteSkill guides section hierarchy and keeps financial content clear of animated shader layers.
- Warp Field: https://threeui.com/three-js/warp-field — adapted public MIT line-segment corridor technique into existing R3F runtime, reduced count/speed and palette tokens.
- Matrix Junction: public MIT `src/shaders/neuform-isolated/sources/matrix-field.html` fragment extracted to `matrix-shader.ts`; reverse-edge smoothsteps normalized. Mouse lightning disabled to avoid rapid flicker; slow original beam pulse retained. Replaces closing Vanishing Array to match user's screenshot exactly at the effect-family level.

## Architectural landing revision
- Kage https://threeui.com/landing-pages/kage-landing-page is the composition reference; Sublevel https://threeui.com/landing-pages/sublevel-studio-landing-page informs tactile navigation. Public previews inspected. `network-world.tsx` is original procedural R3F geometry, lighting and animation; no Pro code or assets copied. Replaces the rejected desktop object.
- User-approved ink blue, icy silver and warm amber palette; Refero Analogue and Exo Ape inform atmosphere and editorial scale.
- Network environment revision: original procedural Solana-inspired three-layer architecture and animated illustrative paths using Three.js CatmullRomCurve3/TubeGeometry, with canvas-generated labels. No new third-party assets or dependencies.
- Supplied motion video: `/Users/chahatbiswas/Desktop/WhatsApp Video 2026-10-06 at 00.25.12.mp4` used as visual reference only. Original Canvas2D ribbon renderer and Epoch product-model panel; no footage or third-party source copied. Final local automated hero sample: median/p95 frame interval ~16.7ms, with idle-motion and pause pixel assertions passing. This is not a cross-device performance guarantee.
- Mercury public homepage inspected 6 October 2026: https://mercury.com/ — hero-to-software transition and consistent product-demonstration frames informed narrative structure only; no Mercury assets, copy or product claims used. Epoch now uses one continuous background and source-labeled product illustrations instead of disconnected WebGL chapters.

## 7 October Mercury-inspired reveal
- Mercury https://mercury.com/ public homepage and Products dropdown visually inspected; original Epoch Terminal hero and explanatory dropdowns use reference structure only. No Mercury assets or copy reused.
- EpochMark: original inline SVG; three open epoch cycles connect to a forward arrow. Reused in landing, Terminal preview and app shell.
- TerminalPreview reuses installed lightweight-charts via EpochChart and existing query hooks. No fabricated chart data.
- LandingNavigation composes existing shadcn/Base UI DropdownMenu primitives.
- Validator logos: downloaded official site icon references recorded per asset in `src/components/epoch/validator-logos.json`. Used to identify directory entries, not to imply endorsement. Unverified marks fall back to initials.

- 2026-10-07 editorial opening: original Epoch-mark sculpture composed with installed Three.js TorusGeometry, React Three Fiber Canvas/useFrame and drei Environment/Lightformer (MIT). Official API references: https://r3f.docs.pmnd.rs/api/hooks and https://drei.docs.pmnd.rs/staging/environment. No reference-site code or visual assets copied. GSAP reveal uses existing central setup. Existing shadcn primitives and typed data preview retained.

- 2026-10-07 pavilion treatment: Kage public preview (https://threeui.com/landing-pages/kage-landing-page) informs architectural framing, Mercury informs scroll zoom. No template source or proprietary assets copied. `public/scenes/epoch-pavilion.png` is an original generated photographic background made with the image-generation skill. Rendered through Next Image; interface remains real HTML and chart canvas. No new runtime/library. Sublevel inspected and rejected for this direction.
