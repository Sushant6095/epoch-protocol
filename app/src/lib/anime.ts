"use client";
// anime.js v4 wrapper for Epoch. Copy to app/src/lib/anime.ts. anime.js is sanctioned ONLY for
// staggered SVG and glyph work that GSAP and Motion do not cover well (the slot-ruler tick sweep,
// staggered dot-matrix reveals). Import anime from here, never from "animejs" directly.
// Under prefers-reduced-motion the element jumps to its end state (no travel). Timelines are skipped:
// build them so their end state is also the element's resting CSS.
import { animate, createTimeline, cubicBezier, stagger, svg, utils } from "animejs";
import motion from "@/design/motion";

const epochEase = cubicBezier(...motion.easeOut);

const reduced = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Targets = Parameters<typeof animate>[0];
type Params = NonNullable<Parameters<typeof animate>[1]>;

const TIMING_KEYS = new Set([
  "duration", "delay", "ease", "loop", "alternate", "reversed", "autoplay", "frameRate", "playbackRate",
  "playbackEase", "composition", "modifier", "onBegin", "onUpdate", "onRender", "onLoop", "onPause",
  "onComplete", "onBeforeUpdate",
]);

/** The values an animation ends on: the last keyframe of every animated property. */
function endState(params: Params): Record<string, unknown> {
  const end: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (TIMING_KEYS.has(key) || typeof value === "function") continue;
    end[key] = Array.isArray(value) ? value[value.length - 1] : value;
  }
  return end;
}

/**
 * animate() with Epoch defaults (200 ms, expo-out). Under reduced motion it jumps straight to the end
 * state (no travel) and returns null.
 */
export function epochAnimate(targets: Targets, params: Params) {
  if (reduced()) {
    utils.set(targets as Parameters<typeof utils.set>[0], endState(params) as Parameters<typeof utils.set>[1]);
    return null;
  }
  return animate(targets, { duration: motion.transition, ease: epochEase, ...params });
}

/** A timeline with the same defaults; returns null under reduced motion. */
export function epochTimeline() {
  if (reduced()) return null;
  return createTimeline({ defaults: { duration: motion.transition, ease: epochEase } });
}

export { stagger, svg, utils };
