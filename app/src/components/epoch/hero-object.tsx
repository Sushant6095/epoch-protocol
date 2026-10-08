'use client';
import { Component, useEffect, useState, type ReactNode } from 'react';
import { Canvas } from '@react-three/fiber';
import { Torus } from '@react-three/drei';
class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
function Fallback() {
  return (
    <div className="absolute inset-12 flex items-center justify-center rounded-full border-8 border-ep-accent-line">
      <div className="h-4/5 w-4/5 rounded-full border border-primary" />
    </div>
  );
}
export default function HeroObject() {
  const [colors, setColors] = useState<{ mint: string; dark: string; light: string } | null>(null);
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    setColors({
      mint: style.getPropertyValue('--ep-accent').trim(),
      dark: style.getPropertyValue('--ep-accent-line').trim(),
      light: style.getPropertyValue('--ep-text').trim(),
    });
  }, []);
  return (
    <div className="absolute inset-0" aria-hidden="true">
      <SceneBoundary fallback={<Fallback />}>
        {colors && (
          <Canvas frameloop="demand" dpr={[1, 1.5]} camera={{ position: [0, 0, 7.5], fov: 38 }} fallback={<Fallback />}>
            <ambientLight intensity={1.8} />
            <directionalLight position={[3, 5, 5]} intensity={5} color={colors.mint} />
            <directionalLight position={[-4, -2, 3]} intensity={2} color={colors.light} />
            <group rotation={[0.42, -0.46, -0.38]}>
              <Torus args={[1.75, 0.19, 32, 128]}>
                <meshStandardMaterial color={colors.mint} metalness={0.7} roughness={0.23} />
              </Torus>
              <Torus args={[1.38, 0.045, 20, 128]}>
                <meshStandardMaterial color={colors.dark} metalness={0.5} roughness={0.4} />
              </Torus>
              <Torus args={[2.08, 0.015, 12, 128]}>
                <meshStandardMaterial color={colors.dark} />
              </Torus>
              {Array.from({ length: 48 }, (_, i) => (
                <mesh
                  key={i}
                  position={[1.76 * Math.cos((i * Math.PI) / 24), 1.76 * Math.sin((i * Math.PI) / 24), 0.2]}
                  rotation={[0, 0, (i * Math.PI) / 24]}
                >
                  <boxGeometry args={[0.12, 0.022, 0.018]} />
                  <meshStandardMaterial color={colors.dark} />
                </mesh>
              ))}
            </group>
          </Canvas>
        )}
      </SceneBoundary>
    </div>
  );
}
