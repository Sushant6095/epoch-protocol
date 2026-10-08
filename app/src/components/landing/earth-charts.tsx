'use client';
import { useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { gsap, useGSAP } from '@/lib/gsap';
import history from '@/fixtures/stake-history-64.real.json';
import fee from '@/fixtures/fee-index.sample.json';
import validators from '@/fixtures/validators.real.json';

/**
 * Market lines rising out of the cities where Solana stake actually sits. Each hub is a real data-centre
 * city; its line height follows that country's share of stake in the validator snapshot, and its shape is a
 * real series (64 epochs of active, activating or deactivating stake, or the Fee Index). Lines draw up out
 * of the ground once the intro hands over (GSAP timeline via useGSAP), then their tips breathe.
 */

type Hub = { lat: number; lon: number; country: string; series: number[]; color: string };

const rows = history.rows;
const SERIES = {
  active: rows.map((r) => r.totalActiveSol),
  activating: rows.map((r) => r.activatingSol),
  deactivating: rows.map((r) => r.deactivatingSol),
  net: rows.reduce<number[]>((acc, r) => [...acc, (acc.at(-1) ?? 0) + r.activatingSol - r.deactivatingSol], []),
  fee: [...fee.points].reverse().map((p) => p.value),
};

const HUBS: Hub[] = [
  { lat: 50.11, lon: 8.68, country: 'Germany', series: SERIES.active, color: '#8b9cff' }, // Frankfurt
  { lat: 52.37, lon: 4.9, country: 'Netherlands', series: SERIES.net, color: '#f0a347' }, // Amsterdam
  { lat: 51.51, lon: -0.13, country: 'United Kingdom', series: SERIES.fee, color: '#c48bff' }, // London
  { lat: 48.86, lon: 2.35, country: 'France', series: SERIES.activating, color: '#6fd3c6' }, // Paris
  { lat: 50.08, lon: 14.44, country: 'Czechia', series: SERIES.deactivating, color: '#8b9cff' }, // Prague
  { lat: 39.04, lon: -77.49, country: 'United States', series: SERIES.active, color: '#c48bff' }, // Ashburn
  { lat: 35.68, lon: 139.69, country: 'Japan', series: SERIES.fee, color: '#6fd3c6' }, // Tokyo
];

const stakeBy = (validators as { rows: { country: string; stakeSol: number }[] }).rows.reduce<Record<string, number>>(
  (m, r) => ((m[r.country] = (m[r.country] ?? 0) + r.stakeSol), m),
  {},
);
const maxStake = Math.max(...Object.values(stakeBy));

/** Same mapping as three's SphereGeometry UVs, so a lat/lon lands on that spot of the texture. */
function surface(lat: number, lon: number, r: number) {
  const phi = ((lon + 180) / 360) * Math.PI * 2;
  const th = ((90 - lat) * Math.PI) / 180;
  return new THREE.Vector3(-Math.cos(phi) * Math.sin(th), Math.cos(th), Math.sin(phi) * Math.sin(th)).multiplyScalar(r);
}

function build(h: Hub, r: number, i: number) {
  const base = surface(h.lat, h.lon, r * 1.001);
  const up = base.clone().normalize();
  const east = new THREE.Vector3(0, 1, 0).cross(up).normalize();
  const share = Math.sqrt((stakeBy[h.country] ?? 0) / maxStake);
  const H = 0.16 + 0.6 * share;
  const W = 0.14 + 0.2 * share;
  const lo = Math.min(...h.series);
  const hi = Math.max(...h.series);
  const span = hi - lo || 1;
  const pts: THREE.Vector3[] = [base.clone()];
  h.series.forEach((v, k) => {
    const x = (k / (h.series.length - 1)) * W * (i % 2 ? -1 : 1);
    const y = 0.05 + ((v - lo) / span) * 0.75 * H + (k / (h.series.length - 1)) * 0.25 * H;
    pts.push(base.clone().addScaledVector(east, x).addScaledVector(up, y));
  });
  const col = new THREE.Color(h.color);
  const positions: number[] = [];
  const colors: number[] = [];
  pts.forEach((p, k) => {
    positions.push(p.x, p.y, p.z);
    const t = Math.pow(k / (pts.length - 1), 0.7);
    colors.push(col.r * t, col.g * t, col.b * t);
  });
  const make = (width: number, gain: number) => {
    const g = new LineGeometry();
    g.setPositions(positions);
    g.setColors(colors.map((c) => c * gain));
    const m = new LineMaterial({
      vertexColors: true,
      linewidth: width,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const line = new Line2(g, m);
    line.computeLineDistances();
    g.instanceCount = 0;
    return { g, m, line };
  };
  const core = make(1.15, 1.1);
  const halo = make(4.5, 0.12);
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.011, 10, 10),
    new THREE.MeshBasicMaterial({ color: col.clone().lerp(new THREE.Color('#ffffff'), 0.55), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  tip.visible = false;
  return { pts, core, halo, tip, segs: pts.length - 1, draw: { p: 0 } };
}

export function MarketCharts({ radius }: { radius: number }) {
  const { size, viewport } = useThree();
  const charts = useMemo(() => HUBS.map((h, i) => build(h, radius, i)), [radius]);

  // GSAP draw-on: each line rises out of its city, staggered, once the intro hands over to the hero.
  // matchMedia keeps reduced-motion users on the drawn end state; useGSAP reverts it all on unmount.
  useGSAP(
    (_ctx, contextSafe) => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: reduce)', () => {
        charts.forEach((c) => (c.draw.p = 1));
      });
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const tl = gsap.timeline({ paused: true, delay: 0.5 });
        charts.forEach((c, i) => tl.fromTo(c.draw, { p: 0 }, { p: 1, duration: 2.6, ease: 'power2.inOut' }, i * 0.28));
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
    { dependencies: [charts], revertOnUpdate: true },
  );

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const dpr = viewport.dpr;
    charts.forEach((c, i) => {
      c.core.m.resolution.set(size.width * dpr, size.height * dpr);
      c.halo.m.resolution.set(size.width * dpr, size.height * dpr);
      const f = c.draw.p * c.segs;
      const n = Math.floor(f);
      c.core.g.instanceCount = n;
      c.halo.g.instanceCount = n;
      const a = c.pts[Math.min(n, c.segs)];
      const b = c.pts[Math.min(n + 1, c.segs)];
      c.tip.position.lerpVectors(a, b, f - n);
      c.tip.visible = c.draw.p > 0.01;
      c.tip.scale.setScalar(1 + 0.35 * Math.sin(t * 2.2 + i));
    });
  });

  return (
    <>
      {charts.map((c, i) => (
        <group key={i}>
          <primitive object={c.halo.line} />
          <primitive object={c.core.line} />
          <primitive object={c.tip} />
        </group>
      ))}
    </>
  );
}
