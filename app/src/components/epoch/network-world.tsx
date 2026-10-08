'use client';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Environment, Lightformer, RoundedBox } from '@react-three/drei';
import { CanvasTexture, CatmullRomCurve3, Group, MathUtils, Mesh, Points, Vector3 } from 'three';

type Palette = { green: string; cyan: string; amber: string; ink: string; muted: string; bg: string };
// An illustrative product map: paths show roles, not mainnet telemetry.
function NetworkPath({
  points,
  color,
  active,
  offset = 0,
}: {
  points: [number, number, number][];
  color: string;
  active: boolean;
  offset?: number;
}) {
  const curve = useMemo(() => new CatmullRomCurve3(points.map((v) => new Vector3(...v))), [points]);
  const packet = useRef<Mesh>(null);
  const phase = useRef(offset);
  useFrame((_, delta) => {
    if (!active) return;
    phase.current = (phase.current + Math.min(delta, 0.04) * 0.08) % 1;
    if (packet.current) packet.current.position.copy(curve.getPointAt(phase.current));
  });
  return (
    <group>
      <mesh>
        <tubeGeometry args={[curve, 60, 0.012, 6, false]} />
        <meshBasicMaterial color={color} transparent opacity={0.65} />
      </mesh>
      <mesh ref={packet} position={curve.getPointAt(offset)}>
        <boxGeometry args={[0.12, 0.12, 0.12]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  );
}
function SceneLabel({ text, position, color }: { text: string; position: [number, number, number]; color: string }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.font = '500 34px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, 384, 60);
    return new CanvasTexture(canvas);
  }, [text, color]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={position} scale={[3.4, 0.425, 1]}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}
const paths: [number, number, number][][] = [
  [
    [-3.9, 0.5, 4.2],
    [-3.5, 1.2, 2],
    [-2.5, 1.8, -0.1],
  ],
  [
    [-2.5, 3.4, -1],
    [-1.2, 4.2, -1.5],
    [0, 3.8, -1],
  ],
  [
    [0, 3.8, -1],
    [1.8, 4.2, -0.9],
    [2.6, 2.9, -0.2],
  ],
  [
    [2.6, 1, 0.8],
    [3, 0.8, 2.8],
    [2.7, 0.5, 4.2],
  ],
  [
    [2.7, 0.4, 4.2],
    [0, 0.6, 3],
    [-2.5, 0.8, -0.1],
  ],
];
export default function NetworkWorld({ active, palette: p }: { active: boolean; palette: Palette }) {
  const world = useRef<Group>(null),
    dust = useRef<Points>(null);
  const positions = useMemo(() => {
    const a = new Float32Array(450 * 3);
    for (let i = 0; i < 450; i++)
      a.set([Math.sin(i * 12.989) * 13, ((i * 1.618) % 7) - 1, Math.cos(i * 7.31) * 11], i * 3);
    return a;
  }, []);
  useFrame(({ camera, pointer }, delta) => {
    if (!active) return;
    const scroll = Math.min(window.scrollY / 1100, 1);
    camera.position.x = MathUtils.damp(camera.position.x, 6 + pointer.x * 0.2, 2, delta);
    camera.position.z = MathUtils.damp(camera.position.z, 17 - scroll * 0.6, 2, delta);
    camera.lookAt(0, 1.3, 0);
    if (dust.current) dust.current.rotation.y += delta * 0.012;
  });
  return (
    <>
      <fog attach="fog" args={[p.bg, 16, 38]} />
      <ambientLight intensity={0.7} />
      <directionalLight position={[-4, 9, 3]} intensity={3} color={p.green} />
      <pointLight position={[2, 3, 0]} intensity={16} color={p.amber} distance={12} />
      <Environment resolution={128} frames={1}>
        <Lightformer position={[-8, 6, 6]} scale={[10, 8, 1]} intensity={3} color={p.green} target={[0, 0, 0]} />
        <Lightformer position={[6, 3, -7]} scale={[8, 4, 1]} intensity={4} color={p.cyan} target={[0, 0, 0]} />
      </Environment>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.35, 0]}>
        <planeGeometry args={[90, 90]} />
        <meshStandardMaterial color={p.bg} metalness={0.8} roughness={0.28} />
      </mesh>
      <group ref={world} position={[1, -0.1, -1]} rotation={[0, -0.18, 0]}>
        <RoundedBox args={[10, 0.35, 8]} radius={0.06} position={[0, 0, 0]}>
          <meshStandardMaterial color={p.bg} metalness={0.7} roughness={0.3} />
        </RoundedBox>
        {/* Three offset layers evoke Solana's mark as an architectural gateway. */}
        <group position={[0, 2.6, -1]} rotation={[0, -0.18, -0.12]}>
          {[0, 1, 2].map((i) => (
            <group
              key={i}
              position={[i === 1 ? -0.25 : 0.25, (i - 1) * 1.1, 0]}
              rotation={[0, 0, i === 1 ? -0.08 : 0.08]}
            >
              <RoundedBox args={[5.1, 0.64, 1.25]} radius={0.1} smoothness={3}>
                <meshStandardMaterial color={p.green} metalness={0.86} roughness={0.26} />
              </RoundedBox>
              <mesh position={[0, -0.24, 0.635]}>
                <boxGeometry args={[4.8, 0.035, 0.02]} />
                <meshBasicMaterial color={i === 1 ? p.amber : p.cyan} />
              </mesh>
            </group>
          ))}
        </group>
        {/* A receding colonnade gives the network a place, scale and a horizon. */}
        {Array.from({ length: 18 }, (_, i) => {
          const a = (i / 18) * Math.PI * 2;
          const x = Math.cos(a) * 7,
            z = Math.sin(a) * 7 - 2;
          return (
            <group key={i} position={[x, 0.3, z]}>
              <RoundedBox args={[0.45, 0.65 + (i % 3) * 0.18, 0.45]} radius={0.025}>
                <meshStandardMaterial color={p.muted} metalness={0.7} roughness={0.3} />
              </RoundedBox>
              <mesh position={[0, 0.6, 0]}>
                <sphereGeometry args={[0.055, 8, 8]} />
                <meshBasicMaterial color={p.cyan} />
              </mesh>
            </group>
          );
        })}
        {[5.5, 7, 10].map((r) => (
          <mesh key={r} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.2, -2]}>
            <torusGeometry args={[r, 0.012, 4, 100]} />
            <meshBasicMaterial color={p.cyan} transparent opacity={0.35} />
          </mesh>
        ))}
        {paths.map((points, i) => (
          <NetworkPath key={i} points={points} color={i > 2 ? p.amber : p.cyan} active={active} offset={i * 0.17} />
        ))}
        <SceneLabel text="SOLANA / VALIDATOR NETWORK" position={[0, 4.9, -1]} color={p.green} />
        <SceneLabel text="DELEGATED STAKE" position={[-3.8, 1.2, 4.2]} color={p.cyan} />
        <SceneLabel text="EPOCH VAULT" position={[2.7, 1.2, 4.2]} color={p.amber} />
        {[-3.8, 2.7].map((x, index) => (
          <group key={x} position={[x, 0.3, 4.2]}>
            {[0, 1, 2].map((j) => (
              <RoundedBox key={j} args={[1.2, 0.15, 1.1]} radius={0.03} position={[0, j * 0.22, 0]}>
                <meshStandardMaterial
                  color={p.muted}
                  metalness={0.8}
                  roughness={0.2}
                  emissive={index ? p.amber : p.cyan}
                  emissiveIntensity={0.12}
                />
              </RoundedBox>
            ))}
          </group>
        ))}
      </group>
      <mesh position={[-5, 5, -15]}>
        <sphereGeometry args={[3, 48, 48]} />
        <meshBasicMaterial color={p.cyan} transparent opacity={0.1} />
      </mesh>
      <points ref={dust}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <pointsMaterial color={p.green} size={0.016} transparent opacity={0.55} depthWrite={false} />
      </points>
    </>
  );
}
