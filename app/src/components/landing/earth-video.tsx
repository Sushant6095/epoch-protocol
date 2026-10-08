'use client';
import { useEffect, useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';

/**
 * Hero backdrop from real footage: NASA ISS footage of Earth at night (public domain; "Earth from Space in 4K,
 * Expedition 65 Edition", jsc2022m000172, from the 4K original: a night pass over Iberia, rotated 180 degrees,
 * graded to cool white-gold lights on navy, slowed 2x and crossfade-looped). Kept quiet on purpose: no overlays, a slow settle-in when the intro hands over,
 * and an edge vignette so the type stays the subject. `onFail` falls back to the live 3D Earth.
 */
export function EarthVideo({ onFail, paused }: { onFail: () => void; paused?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  // fall back to the 3D Earth when the clip is not deployed (the video error event is unreliable for 404s)
  useEffect(() => {
    let live = true;
    fetch('/earth/hero.mp4', { method: 'HEAD' })
      .then((r) => live && !r.ok && onFail())
      .catch(() => live && onFail());
    return () => {
      live = false;
    };
  }, [onFail]);

  // settle-in: the footage eases up from a slight zoom as the intro opens onto the hero
  useGSAP(
    (_ctx, contextSafe) => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const tl = gsap.timeline({ paused: true });
        tl.fromTo(video.current, { autoAlpha: 0, scale: 1.06 }, { autoAlpha: 1, scale: 1, duration: 2.8, ease: 'power2.out' });
        const play = contextSafe!(() => tl.play());
        if (document.documentElement.dataset.intro !== 'on') {
          tl.play();
          return;
        }
        window.addEventListener('epoch:intro-reveal', play, { once: true });
        window.addEventListener('epoch:intro-done', play, { once: true });
        return () => {
          window.removeEventListener('epoch:intro-reveal', play);
          window.removeEventListener('epoch:intro-done', play);
        };
      });
      mm.add('(prefers-reduced-motion: reduce)', () => {
        video.current?.pause();
      });
    },
    { scope: root },
  );

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (paused) v.pause();
    else if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) void v.play().catch(() => {});
  }, [paused]);

  return (
    <div ref={root} className="ev">
      <video
        ref={video}
        className="ev-video"
        poster="/earth/hero-poster.jpg"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
      >
        <source src="/earth/hero.mp4" type="video/mp4" />
      </video>
      <span className="ev-scrim" />
    </div>
  );
}
