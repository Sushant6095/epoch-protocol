'use client';
import { useEffect, useMemo, useRef } from 'react';
import { gsap, useGSAP } from '@/lib/gsap';
import history from '@/fixtures/stake-history-64.real.json';
import fee from '@/fixtures/fee-index.sample.json';

/**
 * Hero backdrop from real footage: NASA ISS footage of Earth at night (public domain) looping behind the
 * hero, with market lines rising out of the night side. Each line is a real series (64 epochs of stake
 * history or the Fee Index), drawn up with DrawSVG once the intro hands over. `onFail` lets the page fall
 * back to the live 3D Earth when the clip is missing or cannot play.
 */

const rows = history.rows;
const SERIES = [
  rows.map((r) => r.totalActiveSol),
  rows.reduce<number[]>((acc, r) => [...acc, (acc.at(-1) ?? 0) + r.activatingSol - r.deactivatingSol], []),
  [...fee.points].reverse().map((p) => p.value),
  rows.map((r) => r.activatingSol),
];

// base (x, y) on the 1440x900 frame, rise height and run width; tuned to the clip's night side
const LINES = [
  { x: 330, y: 820, h: 150, w: 90, tone: 'violet' },
  { x: 560, y: 760, h: 230, w: 120, tone: 'blue' },
  { x: 930, y: 770, h: 190, w: 110, tone: 'amber' },
  { x: 1150, y: 830, h: 130, w: 80, tone: 'blue' },
];

function path(series: number[], x: number, y: number, h: number, w: number) {
  const lo = Math.min(...series);
  const span = Math.max(...series) - lo || 1;
  return series
    .map((v, i) => {
      const t = i / (series.length - 1);
      const px = x + t * w;
      const py = y - (0.15 + 0.6 * ((v - lo) / span) + 0.25 * t) * h;
      return `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
    })
    .join(' ');
}

export function EarthVideo({ onFail, paused }: { onFail: () => void; paused?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const d = useMemo(() => LINES.map((l, i) => path(SERIES[i % SERIES.length], l.x, l.y, l.h, l.w)), []);

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

  useGSAP(
    (_ctx, contextSafe) => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: reduce)', () => {
        video.current?.pause();
      });
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const q = gsap.utils.selector(root);
        const tl = gsap.timeline({ paused: true, delay: 0.4 });
        tl.fromTo(q('.ev-line'), { drawSVG: '0%' }, { drawSVG: '100%', duration: 2.4, ease: 'power2.inOut', stagger: 0.3 })
          .fromTo(q('.ev-tip'), { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.5, stagger: 0.3, transformOrigin: '50% 50%' }, 1.9);
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
    },
    { scope: root },
  );

  useGSAP(() => {
    const v = video.current;
    if (!v) return;
    if (paused) v.pause();
    else if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) void v.play().catch(() => {});
  }, { dependencies: [paused] });

  return (
    <div ref={root} className="ev">
      <video
        ref={video}
        className="ev-video"
        src="/earth/hero.mp4"
        poster="/earth/hero-poster.jpg"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        onError={onFail}
      />
      <svg className="ev-lines" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <defs>
          <linearGradient id="ev-fade" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="white" stopOpacity="0" />
            <stop offset="0.35" stopColor="white" stopOpacity="0.85" />
            <stop offset="1" stopColor="white" stopOpacity="1" />
          </linearGradient>
          <mask id="ev-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="1440" height="900">
            <rect width="1440" height="900" fill="url(#ev-fade)" />
          </mask>
        </defs>
        <g mask="url(#ev-mask)">
          {LINES.map((l, i) => (
            <g key={i} data-tone={l.tone}>
              <path className="ev-line ev-glow" d={d[i]} />
              <path className="ev-line ev-core" d={d[i]} />
            </g>
          ))}
        </g>
        {LINES.map((l, i) => {
          const end = d[i].split(' ').slice(-2);
          return <circle key={i} className="ev-tip" data-tone={l.tone} cx={end[0].replace('L', '')} cy={end[1]} r="3" />;
        })}
      </svg>
      <span className="ev-scrim" />
    </div>
  );
}
