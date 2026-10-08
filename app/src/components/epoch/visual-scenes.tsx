'use client';
import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import {
  AdditiveBlending,
  CanvasTexture,
  DoubleSide,
  MathUtils,
  Mesh,
  Points,
  LineSegments,
  BufferAttribute,
  ShaderMaterial,
  Vector2,
} from 'three';
import NetworkWorld from './network-world';
import { MATRIX_FRAGMENT_SHADER } from '@/components/vendor/threeui/matrix-shader';
import { LASER_FRAGMENT_SHADER } from '@/components/vendor/threeui/laser-shaders';

type Props = { kind: 'flow' | 'laser' | 'paper' | 'warp' | 'junction' | 'world'; paused: boolean; audience?: number };
type Palette = {
  green: string;
  cyan: string;
  amber: string;
  ink: string;
  muted: string;
  bg: string;
  font: string;
  sans: string;
};
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <div className="scene-fallback">EPOCH / SOLANA</div> : this.props.children;
  }
}
function Flow({ active, color }: { active: boolean; color: string }) {
  const ref = useRef<Points>(null);
  // Dome distribution adapted from ThreeUI's MIT Structure Flow renderer.
  const positions = useMemo(() => {
    const result = new Float32Array(6500 * 3);
    let seed = 17;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 6500; i++) {
      const theta = random() * Math.PI * 2,
        phi = Math.acos(random() * 0.9 + 0.1);
      result[i * 3] = 4 * Math.sin(phi) * Math.cos(theta);
      result[i * 3 + 1] = 4 * Math.cos(phi) - 2;
      result[i * 3 + 2] = 4 * Math.sin(phi) * Math.sin(theta);
    }
    return result;
  }, []);
  useFrame((_, delta) => {
    if (active && ref.current) {
      ref.current.rotation.y += delta * 0.08;
      ref.current.rotation.z = Math.sin(ref.current.rotation.y) * 0.07;
    }
  });
  return (
    <points ref={ref} rotation={[0.18, 0, -0.12]}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={0.018}
        color={color}
        transparent
        opacity={0.7}
        blending={AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
}
function Laser({ active, junction = false }: { active: boolean; junction?: boolean }) {
  const ref = useRef<ShaderMaterial>(null);
  const uniforms = useMemo(
    () => ({
      u_resolution: { value: new Vector2(1000, 500) },
      u_pointer: { value: new Vector2() },
      u_mouse: { value: new Vector2(0.5, 0.5) },
      u_mouseActive: { value: 0 },
      u_time: { value: 8 },
      u_variant: { value: 1 },
      u_size: { value: 1 },
      u_length: { value: 1 },
      u_density: { value: 0.75 },
      u_hue: { value: 0 },
      u_saturation: { value: 0.9 },
      u_brightness: { value: 0.8 },
    }),
    [],
  );
  useFrame(({ size, gl, pointer }, delta) => {
    if (!ref.current) return;
    const u = ref.current.uniforms;
    u.u_resolution.value.set(size.width * gl.getPixelRatio(), size.height * gl.getPixelRatio());
    if (active) {
      u.u_time.value += Math.min(delta, 0.05) * 0.5;
      u.u_pointer.value.lerp(pointer, 0.03);
    }
  });
  return (
    <mesh frustumCulled={false}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={ref}
        uniforms={uniforms}
        vertexShader="void main(){gl_Position=vec4(position.xy,0.0,1.0);}"
        fragmentShader={junction ? MATRIX_FRAGMENT_SHADER : LASER_FRAGMENT_SHADER}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
// Streak corridor adapted from ThreeUI Warp Field's MIT line-segment technique.
function Warp({ active, color }: { active: boolean; color: string }) {
  const ref = useRef<LineSegments>(null);
  const positions = useMemo(() => {
    const p = new Float32Array(160 * 6);
    for (let i = 0; i < 160; i++) {
      const a = i * 2.399963,
        r = 1.3 + (i % 19) * 0.28,
        z = -((i * 1.37) % 36);
      p.set([Math.cos(a) * r, Math.sin(a) * r, z, Math.cos(a) * r, Math.sin(a) * r, z + 0.4 + (i % 7) * 0.14], i * 6);
    }
    return p;
  }, []);
  useFrame((_, delta) => {
    if (!active || !ref.current) return;
    for (let i = 0; i < 160; i++) {
      positions[i * 6 + 2] += Math.min(delta, 0.05) * 2.2;
      positions[i * 6 + 5] += Math.min(delta, 0.05) * 2.2;
      if (positions[i * 6 + 2] > 4) {
        const len = positions[i * 6 + 5] - positions[i * 6 + 2];
        positions[i * 6 + 2] = -32;
        positions[i * 6 + 5] = -32 + len;
      }
    }
    (ref.current.geometry.attributes.position as BufferAttribute).needsUpdate = true;
  });
  return (
    <lineSegments ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={0.48} blending={AdditiveBlending} depthWrite={false} />
    </lineSegments>
  );
}
const paperVertex = `varying vec2 vUv; varying float vBend; uniform float uTime; uniform vec2 uPointer;
void main(){vUv=uv;vec3 p=position;p.z+=sin(p.x*1.4+uTime*.65)*.12+pow(p.x,2.)*.10;p.z+=sin(p.y*1.3+uTime*.4)*.06;p.z+=uPointer.x*p.x*.13+uPointer.y*p.y*.08;vBend=p.z;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`;
const paperFragment = `varying vec2 vUv; varying float vBend; uniform sampler2D uTex; uniform vec2 uPointer;
void main(){vec4 c=texture2D(uTex,vUv);float shine=pow(max(0.,1.-abs(vUv.x-.5-uPointer.x*.2-vBend*.5)*2.),8.)*.16;float edge=(1.0-smoothstep(0.,.014,min(min(vUv.x,1.-vUv.x),min(vUv.y,1.-vUv.y))));gl_FragColor=vec4(c.rgb+shine+edge*.16,.94);}`;
function Paper({ active, audience, palette }: { active: boolean; audience: number; palette: Palette }) {
  const mesh = useRef<Mesh>(null),
    material = useRef<ShaderMaterial>(null);
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 760;
    canvas.height = 980;
    const c = canvas.getContext('2d')!;
    const accent = [palette.green, palette.cyan, palette.amber][audience];
    c.fillStyle = palette.bg;
    c.fillRect(0, 0, 760, 980);
    c.strokeStyle = accent;
    c.globalAlpha = 0.45;
    c.strokeRect(18, 18, 724, 944);
    c.globalAlpha = 1;
    c.fillStyle = accent;
    c.font = `500 25px ${palette.font}`;
    c.fillText('EPOCH / SOLANA', 54, 78);
    c.fillText(`0${audience + 1}`, 650, 78);
    c.fillStyle = palette.ink;
    c.font = `500 75px ${palette.sans}`;
    c.fillText(['Your stake.', 'Your work.', 'Your capital.'][audience], 54, 245);
    c.fillText(['Your keys.', 'In focus.', 'With context.'][audience], 54, 335);
    c.strokeStyle = accent;
    c.lineWidth = 2;
    c.beginPath();
    c.arc(380, 520, 105, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 24; i++) {
      const a = (i * Math.PI) / 12;
      c.beginPath();
      c.moveTo(380 + Math.cos(a) * 80, 520 + Math.sin(a) * 80);
      c.lineTo(380 + Math.cos(a) * 120, 520 + Math.sin(a) * 120);
      c.stroke();
    }
    c.fillStyle = accent;
    c.font = `500 22px ${palette.font}`;
    c.fillText(['STAKER PERSPECTIVE', 'OPERATOR PERSPECTIVE', 'LENDER PERSPECTIVE'][audience], 54, 740);
    c.fillStyle = palette.muted;
    c.font = `400 24px ${palette.sans}`;
    c.fillText(
      [
        'Read-only first. Your stake stays yours.',
        'Health. Economics. Room to grow.',
        'Understand the risk before the return.',
      ][audience],
      54,
      790,
    );
    c.strokeStyle = accent;
    c.globalAlpha = 0.4;
    c.beginPath();
    c.moveTo(54, 865);
    c.lineTo(706, 865);
    c.stroke();
    c.globalAlpha = 1;
    c.font = `400 18px ${palette.font}`;
    c.fillText('RESEARCH / UNDERSTAND / DECIDE', 54, 915);
    return new CanvasTexture(canvas);
  }, [audience, palette]);
  useEffect(() => () => texture.dispose(), [texture]);
  const uniforms = useMemo(
    () => ({ uTex: { value: texture }, uTime: { value: 0 }, uPointer: { value: new Vector2() } }),
    [texture],
  );
  useFrame(({ pointer }, delta) => {
    if (!active || !material.current || !mesh.current) return;
    material.current.uniforms.uTime.value += Math.min(delta, 0.05);
    material.current.uniforms.uPointer.value.lerp(pointer, 0.05);
    mesh.current.rotation.y = MathUtils.damp(mesh.current.rotation.y, -0.2 + pointer.x * 0.22, 3, delta);
    mesh.current.rotation.x = MathUtils.damp(mesh.current.rotation.x, 0.05 - pointer.y * 0.12, 3, delta);
  });
  return (
    <mesh ref={mesh} rotation={[0.05, -0.2, -0.08]}>
      <planeGeometry args={[3.1, 4, 48, 64]} />
      <shaderMaterial
        ref={material}
        uniforms={uniforms}
        vertexShader={paperVertex}
        fragmentShader={paperFragment}
        transparent
        side={DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}
export default function VisualScene({ kind, paused, audience = 0 }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false),
    [reduced, setReduced] = useState(true),
    [palette, setPalette] = useState<Palette | null>(null);
  useEffect(() => {
    const s = getComputedStyle(document.documentElement),
      get = (name: string) => s.getPropertyValue(name).trim();
    setPalette({
      green: get('--ep-launch-green'),
      cyan: get('--ep-launch-cyan'),
      amber: get('--ep-launch-amber'),
      ink: get('--ep-launch-ink'),
      muted: get('--ep-launch-muted'),
      bg: get('--ep-launch-soft'),
      font: get('--font-geist-mono') || 'monospace',
      sans: get('--font-geist-sans') || 'sans-serif',
    });
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    let inView = false;
    const visibility = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(
      ([e]) => {
        inView = e.isIntersecting;
        visibility();
      },
      { rootMargin: '100px' },
    );
    if (host.current) observer.observe(host.current);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  const active = visible && !paused && !reduced;
  return (
    <div ref={host} className={`visual-scene visual-${kind}`} aria-hidden="true">
      <Boundary>
        {palette && (
          <Canvas
            onCreated={({ camera }) => {
              if (kind === 'world') camera.lookAt(0, 1.3, 0);
            }}
            dpr={1}
            gl={{ powerPreference: 'high-performance', antialias: true }}
            frameloop={active ? 'always' : 'demand'}
            camera={{ position: kind === 'world' ? [6, 4, 17] : kind === 'flow' ? [0, 1, 8] : [0, 0, 6.5], fov: 44 }}
            fallback={<div className="scene-fallback">EPOCH / SOLANA</div>}
          >
            {kind === 'world' ? (
              <NetworkWorld active={active} palette={palette} />
            ) : kind === 'flow' ? (
              <Flow active={active} color={palette.green} />
            ) : kind === 'warp' ? (
              <Warp active={active} color={palette.cyan} />
            ) : kind === 'laser' || kind === 'junction' ? (
              <Laser active={active} junction={kind === 'junction'} />
            ) : (
              <Paper active={active} audience={audience} palette={palette} />
            )}
          </Canvas>
        )}
      </Boundary>
    </div>
  );
}
