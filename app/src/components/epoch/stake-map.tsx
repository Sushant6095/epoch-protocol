'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { ValidatorRow } from '@/lib/data/contracts/Api.types';
import { OperatorLogo, compact, fmt } from '@/components/epoch/shared';

/**
 * Stake map, simulated: every operator is a bubble sized by stake (area ∝ SOL). Bubbles drift, collide and
 * spring back to their place; the cursor pushes them aside; every ~1.2 s one operator pulses as if new
 * delegation arrived. Amber ring = earns below vote fees; dashed = one delegator holds over half.
 * Positions are written straight to transforms in a rAF loop (no React re-render per frame).
 */
type Body = { r: ValidatorRow; hx: number; hy: number; x: number; y: number; vx: number; vy: number; rad: number; seed: number };

const W = 1100;
const H = 380;

function layout(rows: ValidatorRow[]): Body[] {
  const max = Math.max(...rows.map((r) => r.stakeSol));
  const placed: Body[] = [];
  for (const r of [...rows].sort((a, b) => b.stakeSol - a.stakeSol)) {
    const rad = 16 + Math.sqrt(r.stakeSol / max) * 62;
    for (let t = 0; t < 4000; t++) {
      const a = t * 0.35,
        d = 3 * t;
      const x = W / 2 + Math.cos(a) * d * 1.6,
        y = H / 2 + Math.sin(a) * d * 0.8;
      if (
        x - rad > 0 &&
        x + rad < W &&
        y - rad > 0 &&
        y + rad < H &&
        placed.every((p) => Math.hypot(p.hx - x, p.hy - y) > p.rad + rad + 8)
      ) {
        placed.push({ r, hx: x, hy: y, x, y, vx: 0, vy: 0, rad, seed: Math.random() * 1000 });
        break;
      }
    }
  }
  return placed;
}

export function StakeMap({ rows }: { rows: ValidatorRow[] }) {
  const bodies = useMemo(() => layout(rows.filter((r) => r.name)), [rows]);
  const wrap = useRef<HTMLDivElement>(null);
  const els = useRef<(HTMLAnchorElement | null)[]>([]);
  const pointer = useRef<{ x: number; y: number; on: boolean }>({ x: 0, y: 0, on: false });
  const [hover, setHover] = useState<ValidatorRow | null>(null);
  const [pulse, setPulse] = useState<{ i: number; k: number } | null>(null);
  const total = rows.reduce((s, r) => s + r.stakeSol, 0);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let scale = el.clientWidth / W;
    const ro = new ResizeObserver(() => (scale = el.clientWidth / W));
    ro.observe(el);
    const place = () => {
      bodies.forEach((b, i) => {
        const node = els.current[i];
        if (node) node.style.transform = `translate3d(${(b.x - b.rad) * scale}px, ${(b.y - b.rad) * scale}px, 0)`;
      });
    };
    place();
    if (reduce) return () => ro.disconnect();

    let raf = 0,
      t = 0,
      visible = true,
      last = performance.now();
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting));
    io.observe(el);
    const step = (now: number) => {
      const dt = Math.min((now - last) / 16.67, 2);
      last = now;
      if (visible && !document.hidden) {
        t += 0.008 * dt;
        const p = pointer.current;
        for (const b of bodies) {
          // wander target around home (smooth noise)
          const tx = b.hx + Math.sin(t * 1.3 + b.seed) * 14 + Math.sin(t * 0.7 + b.seed * 2) * 8;
          const ty = b.hy + Math.cos(t * 1.1 + b.seed) * 10 + Math.sin(t * 0.5 + b.seed * 3) * 6;
          b.vx += (tx - b.x) * 0.004 * dt;
          b.vy += (ty - b.y) * 0.004 * dt;
          if (p.on) {
            const dx = b.x - p.x,
              dy = b.y - p.y,
              d = Math.hypot(dx, dy) || 1,
              reach = b.rad + 90;
            if (d < reach) {
              const f = ((reach - d) / reach) * 1.6 * dt;
              b.vx += (dx / d) * f;
              b.vy += (dy / d) * f;
            }
          }
        }
        // collisions
        for (let i = 0; i < bodies.length; i++)
          for (let j = i + 1; j < bodies.length; j++) {
            const a = bodies[i],
              c = bodies[j];
            const dx = c.x - a.x,
              dy = c.y - a.y,
              d = Math.hypot(dx, dy) || 1,
              min = a.rad + c.rad + 4;
            if (d < min) {
              const push = (min - d) / 2,
                nx = dx / d,
                ny = dy / d;
              const wa = c.rad / (a.rad + c.rad),
                wc = a.rad / (a.rad + c.rad);
              a.x -= nx * push * wa * 2;
              a.y -= ny * push * wa * 2;
              c.x += nx * push * wc * 2;
              c.y += ny * push * wc * 2;
              const rv = (c.vx - a.vx) * nx + (c.vy - a.vy) * ny;
              if (rv < 0) {
                a.vx += nx * rv * 0.5;
                a.vy += ny * rv * 0.5;
                c.vx -= nx * rv * 0.5;
                c.vy -= ny * rv * 0.5;
              }
            }
          }
        for (const b of bodies) {
          b.vx *= 0.9;
          b.vy *= 0.9;
          b.x = Math.min(W - b.rad, Math.max(b.rad, b.x + b.vx * dt));
          b.y = Math.min(H - b.rad, Math.max(b.rad, b.y + b.vy * dt));
        }
        place();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    let k = 0;
    const pulseId = setInterval(() => {
      if (!visible || document.hidden) return;
      // stake-weighted pick: bigger operators attract delegation more often
      const sum = bodies.reduce((s, b) => s + b.rad * b.rad, 0);
      let r = Math.random() * sum,
        i = 0;
      for (; i < bodies.length; i++) {
        r -= bodies[i].rad * bodies[i].rad;
        if (r <= 0) break;
      }
      setPulse({ i: Math.min(i, bodies.length - 1), k: ++k });
    }, 1200);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(pulseId);
      ro.disconnect();
      io.disconnect();
    };
  }, [bodies]);

  const onMove = (e: React.PointerEvent) => {
    const el = wrap.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = r.width / W;
    pointer.current = { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s, on: true };
  };

  return (
    <section className="sm" aria-label="Stake map of validators in this snapshot">
      <div className="sm-head">
        <div>
          <p className="sm-title">Stake map</p>
          <p className="sm-sub">Bubble area is active stake. Move your cursor through the network; hover to inspect.</p>
        </div>
        <div className="sm-readout" aria-live="polite">
          {hover ? (
            <>
              <OperatorLogo name={hover.name} vote={hover.vote} size={28} />
              <span>
                <strong>{hover.name}</strong>
                <small className="num">
                  {compact(hover.stakeSol)} SOL · {fmt((hover.stakeSol / total) * 100, 1)}% of shown · score {hover.epochScore}
                </small>
              </span>
            </>
          ) : (
            <span className="num">{compact(total)} SOL across {rows.length} operators shown</span>
          )}
        </div>
      </div>
      <div
        ref={wrap}
        className="sm-canvas"
        style={{ aspectRatio: `${W} / ${H}` }}
        onPointerMove={onMove}
        onPointerLeave={() => (pointer.current.on = false)}
      >
        {bodies.map((b, i) => (
          <Link
            key={b.r.vote}
            ref={(n) => {
              els.current[i] = n;
            }}
            href={`/validators/${b.r.vote}`}
            className="sm-bubble"
            data-warn={b.r.healthPerEpochSol < 0 || undefined}
            data-dep={(b.r.biggestDelegatorSharePct ?? 0) > 50 || undefined}
            style={{ width: `${((b.rad * 2) / W) * 100}%` }}
            onPointerEnter={() => setHover(b.r)}
            onPointerLeave={() => setHover(null)}
            onFocus={() => setHover(b.r)}
            onBlur={() => setHover(null)}
            aria-label={`${b.r.name}, ${compact(b.r.stakeSol)} SOL`}
          >
            {pulse?.i === i && <span key={pulse.k} className="sm-pulse" aria-hidden="true" />}
            <OperatorLogo name={b.r.name} vote={b.r.vote} size={Math.round(b.rad * 0.9)} />
            {b.rad > 44 && <span className="num sm-amt">{compact(b.r.stakeSol)}</span>}
          </Link>
        ))}
      </div>
      <div className="sm-legend">
        <span>
          <i data-k="warn" /> Earns below vote fees
        </span>
        <span>
          <i data-k="dep" /> One delegator over 50%
        </span>
        <span>
          <i data-k="pulse" /> New delegation (simulated)
        </span>
      </div>
    </section>
  );
}
