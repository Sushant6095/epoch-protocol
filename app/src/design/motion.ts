// Epoch motion tokens — the single source of truth for timing and easing.
// Copy to app/src/design/motion.ts. Every animated component imports from here; design-cop checks
// observed timings against these values. Never hard-code a duration or an easing in a component.
//
// Law: UI transitions are 150–250 ms, ease-out, no bounce, on transform and opacity only (never
// width/height/top/left). Named exceptions, and only these: the KPI number roll (≤ 500 ms, number-flow),
// the value-changed tint (180 ms, an opacity overlay), the ring first draw (900 ms, SVG stroke via DrawSVG)
// and the landing hero choreography. Honour prefers-reduced-motion everywhere (use `reduced`, and
// withMotion in lib/gsap.ts). Idle motion on data pages: the live dot, the epoch countdown, the ticker.

export const motion = {
  /** Value-changed tint on a number (accent up, warn down). Must re-fire on every change. */
  flash: 180,
  /** Focus ring, small state change, chip press. */
  fast: 150,
  /** Standard hover, reveal, tab switch, panel slide. */
  transition: 200,
  /** Deliberate reveal: dialog/sheet enter, toast, health-badge reason. */
  slow: 250,
  /** Number roll on a KPI (number-flow). The 500 ms ceiling, spent only on proof numbers. */
  count: 500,
  /** Live dot pulse period. */
  livePulse: 1600,
  /** Landing hero: per-word reveal and stagger (the only long choreography in the app). */
  heroWord: 400,
  heroStagger: 45,
  /** Score ring / epoch ring first draw (GSAP DrawSVG). */
  ringDraw: 900,
  /** Expo-out: calm and premium. Same curve for CSS, Motion and GSAP. */
  easeOut: [0.16, 1, 0.3, 1] as [number, number, number, number],
  /** Motion (motion.dev) spring for selection pills, tabs underline, number rolls. No wobble. */
  spring: { type: 'spring', duration: 0.3, bounce: 0 } as const,
  /** Reduced-motion budget: near-instant, no travel. */
  reduced: { duration: 0.01, ease: 'linear' } as const,
} as const;

/** CSS easing string for inline styles and Tailwind arbitrary-free usage via the token. */
export const ease = `cubic-bezier(${motion.easeOut.join(', ')})`;

/** CSS transition shorthand using the standard duration and ease. */
export const transition = (prop: string, ms: number = motion.transition): string => `${prop} ${ms}ms ${ease}`;

/** Motion (motion/react) transition presets. */
export const presets = {
  fade: { duration: motion.transition / 1000, ease: motion.easeOut },
  slide: { duration: motion.slow / 1000, ease: motion.easeOut },
  spring: motion.spring,
} as const;

export type Motion = typeof motion;
export default motion;
