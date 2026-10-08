'use client';
import { useEffect, useRef } from 'react';

/** Original Epoch flow field, inspired by the user's supplied motion reference. */
export default function StreamField({ paused }: { paused: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phase = useRef(0);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext('2d', { alpha: true });
    if (!ctx) return;
    const style = getComputedStyle(document.documentElement);
    const blue = style.getPropertyValue('--ep-launch-cyan').trim();
    const silver = style.getPropertyValue('--ep-launch-green').trim();
    const amber = style.getPropertyValue('--ep-launch-amber').trim();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let width = 1,
      height = 1,
      raf = 0,
      last = 0,
      inView = true;
    let targetX = 0,
      targetY = 0,
      x = 0,
      y = 0;
    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const t = phase.current;
      const cx = width * (0.52 + x * 0.02),
        cy = height * (0.56 + y * 0.025);
      // Broad light volume, then sharp filaments: no full-screen blur pass.
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, width * 0.52);
      glow.addColorStop(0, blue + '48');
      glow.addColorStop(0.26, blue + '16');
      glow.addColorStop(1, blue + '00');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 52; i++) {
        const lane = (i - 26) / 26;
        const bend = Math.sin(t * 0.45 + i * 0.085) * 0.1;
        const point = (u: number) => {
          const v = u * 2 - 1;
          return {
            x:
              cx -
              width * 0.08 +
              v * v * width * 0.7 +
              lane * width * 0.035 +
              Math.sin(v * 3 + t * 0.55 + lane) * width * 0.025,
            y:
              cy +
              v * height * (0.75 + lane * 0.12) +
              Math.sin(v * 4 - t * 0.6 + lane) * height * 0.04 +
              bend * height * 0.15,
          };
        };
        ctx.beginPath();
        for (let j = 0; j <= 62; j++) {
          const a = point(j / 62);
          if (j === 0) ctx.moveTo(a.x, a.y);
          else ctx.lineTo(a.x, a.y);
        }
        ctx.strokeStyle = i % 9 === 0 ? amber : i % 3 === 0 ? silver : blue;
        ctx.globalAlpha = 0.18 + (Math.sin(i * 2.1 + t) + 1) * 0.13;
        ctx.lineWidth = i % 7 === 0 ? 1.7 : 0.65;
        ctx.stroke();
        const u = (t * 0.11 + i * 0.137) % 1;
        const packet = point(u);
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = i % 9 === 0 ? amber : silver;
        ctx.beginPath();
        ctx.arc(packet.x, packet.y, i % 4 === 0 ? 1.9 : 1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    };
    const frame = (now: number) => {
      const delta = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      phase.current += delta;
      x += (targetX - x) * 0.035;
      y += (targetY - y) * 0.035;
      draw();
      raf = requestAnimationFrame(frame);
    };
    const sync = () => {
      cancelAnimationFrame(raf);
      last = 0;
      draw();
      if (!paused && !reduce.matches && !document.hidden && inView) raf = requestAnimationFrame(frame);
    };
    const resize = () => {
      const box = el.getBoundingClientRect();
      width = box.width;
      height = box.height;
      el.width = Math.round(width);
      el.height = Math.round(height);
      sync();
    };
    const pointer = (e: PointerEvent) => {
      targetX = e.clientX / innerWidth - 0.5;
      targetY = e.clientY / innerHeight - 0.5;
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      sync();
    });
    observer.observe(el);
    const sizes = new ResizeObserver(resize);
    sizes.observe(el);
    reduce.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pointermove', pointer, { passive: true });
    resize();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      sizes.disconnect();
      reduce.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('pointermove', pointer);
    };
  }, [paused]);
  return <canvas ref={canvas} className="stream-field" aria-hidden="true" />;
}
