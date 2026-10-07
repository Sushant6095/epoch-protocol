'use client';

import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import type { Group } from 'three';

type Palette = { silver: string; amber: string; blue: string };
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

// Three open cycles echo the existing Epoch mark. No borrowed models or HDR assets.
function Cycles({ colors, active }: { colors: Palette; active: boolean }) {
  const group = useRef<Group>(null);
  const phase = useRef(0);
  useFrame((_, delta) => {
    if (!active || !group.current) return;
    phase.current += Math.min(delta, 0.05);
    group.current.rotation.y = -0.46 + Math.sin(phase.current * 0.22) * 0.18;
    group.current.rotation.x = 0.48 + Math.cos(phase.current * 0.18) * 0.09;
    group.current.rotation.z = -0.38 + Math.sin(phase.current * 0.13) * 0.05;
  });
  return (
    <group ref={group} rotation={[0.57, -0.46, -0.38]}>
      {[2.65, 2.05, 1.45].map((radius, i) => (
        <group key={radius} position={[0, 0, i * 0.28]} rotation={[0, 0, 0.55]}>
          <mesh scale={[1, 1, 0.48]}>
            <torusGeometry args={[radius, 0.22, 24, 160, Math.PI * 1.68]} />
            <meshStandardMaterial color={colors.silver} metalness={0.95} roughness={0.24} />
          </mesh>
          <mesh position={[0, 0, 0.115]}>
            <torusGeometry args={[radius, 0.019, 8, 160, Math.PI * 1.68]} />
            <meshStandardMaterial color={colors.amber} metalness={0.7} roughness={0.3} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export default function EditorialSculpture({ paused }: { paused: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<Palette | null>(null);
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState(true);
  const [foreground, setForeground] = useState(true);
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setColors({ silver: style.getPropertyValue('--ep-launch-ink').trim(), amber: style.getPropertyValue('--ep-launch-amber').trim(), blue: style.getPropertyValue('--ep-launch-cyan').trim() });
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(media.matches);
    const visibility = () => setForeground(!document.hidden);
    sync(); visibility();
    media.addEventListener('change', sync);
    document.addEventListener('visibilitychange', visibility);
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    if (host.current) observer.observe(host.current);
    return () => { media.removeEventListener('change', sync); document.removeEventListener('visibilitychange', visibility); observer.disconnect(); };
  }, []);
  const active = !paused && !reduced && visible && foreground;
  return (
    <div ref={host} className="editorial-sculpture" aria-hidden="true">
      <div className="sculpture-fallback"><i /><i /><i /></div>
      <SceneBoundary>
        {colors && <Canvas dpr={[1, 1.5]} frameloop={active ? 'always' : 'demand'} camera={{ position: [0, 0, 9], fov: 46 }} gl={{ alpha: true, antialias: true }}>
          <ambientLight intensity={0.5} />
          <directionalLight position={[3, 4, 5]} intensity={2} color={colors.silver} />
          <Environment resolution={128}>
            <Lightformer position={[-3, 3, 4]} scale={[3, 8, 1]} intensity={4} color={colors.silver} />
            <Lightformer position={[5, 1, 2]} rotation={[0, -Math.PI / 3, 0]} scale={[2, 6, 1]} intensity={3} color={colors.blue} />
            <Lightformer position={[0, -4, 3]} rotation={[Math.PI / 3, 0, 0]} scale={[8, 1, 1]} intensity={2} color={colors.amber} />
          </Environment>
          <Cycles colors={colors} active={active} />
        </Canvas>}
      </SceneBoundary>
    </div>
  );
}
