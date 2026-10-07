'use client';
import { useEffect, useRef } from 'react';
import { gsap, withMotion } from '@/lib/gsap';

/**
 * The epoch clock: one turn = one Solana epoch (432,000 slots). The amber arc is the share of slots
 * already produced; tick marks every 10% help read it at a glance. Draws in once (900 ms ring draw).
 */
export function EpochRing({
  progress,
  size = 160,
  stroke = 10,
  ticks = true,
  className = '',
  children,
  tone = 'light',
}: {
  progress: number;
  size?: number;
  stroke?: number;
  ticks?: boolean;
  className?: string;
  children?: React.ReactNode;
  tone?: 'light' | 'ink';
}) {
  const arc = useRef<SVGCircleElement>(null);
  const r = (size - stroke) / 2 - 4;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  const drawn = useRef(false);
  useEffect(() => {
    if (!arc.current) return;
    if (!drawn.current) {
      drawn.current = true;
      withMotion(() => {
        gsap.fromTo(arc.current, { strokeDashoffset: c }, { strokeDashoffset: c * (1 - p), duration: 0.9, ease: 'epoch' });
      });
      return;
    }
    // later progress changes (the epoch replay) glide instead of redrawing from zero
    gsap.to(arc.current, { strokeDashoffset: c * (1 - p), duration: 0.35, ease: 'none', overwrite: true });
  }, [c, p]);
  return (
    <div className={`epoch-ring ${className}`} data-tone={tone} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="epoch-ring-track" strokeWidth={stroke} fill="none" />
        {ticks &&
          Array.from({ length: 40 }, (_, i) => {
            const a = (i / 40) * Math.PI * 2 - Math.PI / 2;
            const major = i % 4 === 0;
            const r1 = r + stroke / 2 + 3;
            const r2 = r1 + (major ? 5 : 2.5);
            return (
              <line
                key={i}
                x1={size / 2 + Math.cos(a) * r1}
                y1={size / 2 + Math.sin(a) * r1}
                x2={size / 2 + Math.cos(a) * r2}
                y2={size / 2 + Math.sin(a) * r2}
                className={major ? 'epoch-ring-tick major' : 'epoch-ring-tick'}
              />
            );
          })}
        <circle
          ref={arc}
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="epoch-ring-arc"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <circle
          cx={size / 2 + Math.cos(p * Math.PI * 2 - Math.PI / 2) * r}
          cy={size / 2 + Math.sin(p * Math.PI * 2 - Math.PI / 2) * r}
          r={stroke / 2 + 2}
          className="epoch-ring-head"
        />
      </svg>
      {children && <div className="epoch-ring-center">{children}</div>}
    </div>
  );
}
