"use client";
// Central GSAP setup for Epoch. Copy to app/src/lib/gsap.ts and import gsap, useGSAP and the
// plugins ONLY from here, so plugins register once and every tween inherits the motion tokens.
//
// GSAP 3.13+ ships every plugin free under the standard no-charge licence (SplitText, DrawSVG,
// ScrollTrigger, MorphSVG …). Register the heavy ones only where they are used:
//   landing:       ScrollTrigger, SplitText (hero words), DrawSVGPlugin (how-it-works flow lines)
//   data pages:    DrawSVGPlugin for the score ring / epoch ring first draw. No ScrollTrigger.
// Reduced motion: wrap every choreography in `withMotion` (gsap.matchMedia) so it is skipped for
// prefers-reduced-motion users; the end state must still render.
import { gsap } from "gsap";
import { useGSAP } from "@gsap/react";
import { CustomEase } from "gsap/CustomEase";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import motion from "@/design/motion";

gsap.registerPlugin(useGSAP, CustomEase, DrawSVGPlugin, ScrollTrigger, SplitText);

// Same curve as CSS and Motion: one motion law across all three libraries.
const [x1, y1, x2, y2] = motion.easeOut;
CustomEase.create("epoch", `M0,0 C${x1},${y1} ${x2},${y2} 1,1`);

gsap.defaults({ duration: motion.transition / 1000, ease: "epoch" });

/**
 * Run choreography only when the user allows motion. Returns the matchMedia context so callers
 * can revert it (useGSAP reverts automatically when used inside its callback).
 *
 *   useGSAP(() => withMotion(() => { gsap.from(".hero-word", { yPercent: 100, stagger: 0.045 }); }), { scope: ref });
 */
export function withMotion(run: () => void | (() => void)) {
  const mm = gsap.matchMedia();
  mm.add("(prefers-reduced-motion: no-preference)", run);
  return mm;
}

export { gsap, useGSAP, DrawSVGPlugin, ScrollTrigger, SplitText };
