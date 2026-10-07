'use client';

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Environment, Lightformer, RoundedBox } from '@react-three/drei';
import { CanvasTexture, Color, Group, MathUtils, ShaderMaterial, Vector2 } from 'three';
import { CRT_FRAGMENT_SHADER } from '@/components/vendor/threeui/crt-shaders';

export type ConsoleChannel = 'network' | 'stake' | 'apy';
export type ConsoleData = { epoch?: number; validators?: number; stake?: string; apy?: string; source: string };
type Palette = Record<
  'silver' | 'edge' | 'ink' | 'screen' | 'blue' | 'phosphor' | 'white' | 'muted' | 'floor' | 'font',
  string
>;

class SceneBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function Fallback({ data, channel }: { data: ConsoleData; channel: ConsoleChannel }) {
  return (
    <div className="console-fallback">
      <span className="num">
        {channel === 'network' ? 'EPOCH' : channel === 'stake' ? 'SOL STAKED' : 'MEDIAN STAKING APY'}
      </span>
      <strong className="num">
        {channel === 'network'
          ? (data.epoch ?? '—')
          : channel === 'stake'
            ? (data.stake ?? '—')
            : `${data.apy ?? '—'}%`}
      </strong>
      <span>{data.source}</span>
    </div>
  );
}

// ThreeUI's MIT phosphor composite, adapted from screen-space to mesh UVs.
// The screen artwork and cabinet geometry are original Epoch compositions.
const fragment = CRT_FRAGMENT_SHADER.replace('uniform sampler2D uTex;', 'varying vec2 vUv;\nuniform sampler2D uTex;')
  .replace('gl_FragCoord.xy / uRes', 'vUv')
  .replace('gl_FragCoord.x *', '(vUv.x * uRes.x) *');
const vertex = 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}';

function paintScreen(
  ctx: CanvasRenderingContext2D,
  data: ConsoleData,
  channel: ConsoleChannel,
  colors: Palette,
  time: number,
) {
  const w = 1024,
    h = 680;
  ctx.fillStyle = colors.screen;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = colors.blue;
  ctx.globalAlpha = 0.14;
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 42) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y < h; y += 42) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.font = `500 24px ${colors.font}`;
  ctx.fillStyle = colors.phosphor;
  ctx.fillText('EPOCH / SOLANA', 58, 68);
  ctx.fillStyle = colors.muted;
  ctx.textAlign = 'right';
  ctx.fillText('REVENUE CONSOLE', w - 58, 68);
  ctx.textAlign = 'left';
  ctx.strokeStyle = colors.muted;
  ctx.globalAlpha = 0.4;
  ctx.beginPath();
  ctx.moveTo(58, 90);
  ctx.lineTo(w - 58, 90);
  ctx.stroke();
  ctx.globalAlpha = 1;
  const content =
    channel === 'network'
      ? ['NETWORK EPOCH', data.epoch?.toString() ?? '—', `${data.validators ?? '—'} validators`]
      : channel === 'stake'
        ? ['SOL STAKED', data.stake ?? '—', 'Across the network']
        : ['MEDIAN STAKING APY', `${data.apy ?? '—'}%`, 'Historical, not guaranteed'];
  ctx.fillStyle = colors.muted;
  ctx.font = `500 22px ${colors.font}`;
  ctx.fillText(content[0], 58, 185);
  ctx.fillStyle = colors.white;
  ctx.font = `500 ${channel === 'network' ? 112 : 94}px ${colors.font}`;
  ctx.fillText(content[1], 48, 305);
  ctx.fillStyle = colors.phosphor;
  ctx.font = `400 23px ${colors.font}`;
  ctx.fillText(content[2], 58, 358);
  // Abstract signal sphere: an illustration, not a map or a live activity feed.
  const radius = 176,
    cx = 753,
    cy = 318,
    angle = time * 0.12;
  for (let lat = -80; lat <= 80; lat += 10) {
    for (let lon = 0; lon < 360; lon += 10) {
      const a = (lat * Math.PI) / 180,
        b = (lon * Math.PI) / 180 + angle;
      const x = Math.cos(a) * Math.sin(b),
        y = Math.sin(a),
        z = Math.cos(a) * Math.cos(b);
      ctx.globalAlpha = 0.2 + ((z + 1) / 2) * 0.8;
      ctx.fillStyle = z > 0.3 ? colors.phosphor : colors.blue;
      ctx.beginPath();
      ctx.arc(cx + x * radius, cy + y * radius, z > 0.3 ? 2.6 : 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = colors.muted;
  ctx.font = `400 20px ${colors.font}`;
  ctx.fillText(data.source.toUpperCase(), 58, 552);
  ctx.fillStyle = colors.phosphor;
  ctx.fillRect(58, 590, 11, 11);
  ctx.font = `500 22px ${colors.font}`;
  ctx.fillText('READ. UNDERSTAND. DECIDE.', 90, 607);
}

function ConsoleModel({
  data,
  channel,
  colors,
  animate,
}: {
  data: ConsoleData;
  channel: ConsoleChannel;
  colors: Palette;
  animate: boolean;
}) {
  const group = useRef<Group>(null);
  const material = useRef<ShaderMaterial>(null);
  const invalidate = useThree((s) => s.invalidate);
  const screen = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 680;
    const texture = new CanvasTexture(canvas);
    return { canvas, texture, ctx: canvas.getContext('2d')! };
  }, []);
  useEffect(() => () => screen.texture.dispose(), [screen]);
  const uniforms = useMemo(
    () => ({
      uTex: { value: screen.texture },
      uRes: { value: new Vector2(1024, 680) },
      uTime: { value: 0 },
      uMotion: { value: 0.2 },
      uCurve: { value: new Vector2(0.08, 0.1) },
      uScan: { value: 580 },
      uScanDepth: { value: 0.12 },
      uTriad: { value: 3 },
      uGrille: { value: 0.035 },
      uChroma: { value: 0.4 },
      uBar: { value: 0.01 },
      uFlicker: { value: 0 },
      uGrain: { value: 0.006 },
      uNoise: { value: 0 },
      uVignette: { value: 0.18 },
      uMono: { value: 0 },
      uGain: { value: 1.22 },
      uHalo: { value: 0.12 },
      uSheen: { value: new Color(colors.blue) },
      uRoom: { value: new Color(colors.screen) },
    }),
    [screen, colors],
  );
  useEffect(() => {
    paintScreen(screen.ctx, data, channel, colors, 0);
    screen.texture.needsUpdate = true;
    invalidate();
  }, [data, channel, colors, screen, invalidate]);
  const lastPaint = useRef(0);
  useFrame(({ clock, pointer }, delta) => {
    if (!animate) return;
    const elapsed = clock.getElapsedTime();
    if (group.current) {
      group.current.rotation.y = MathUtils.damp(group.current.rotation.y, -0.28 + pointer.x * 0.14, 4, delta);
      group.current.rotation.x = MathUtils.damp(group.current.rotation.x, 0.035 - pointer.y * 0.05, 4, delta);
    }
    if (material.current) material.current.uniforms.uTime.value = elapsed;
    if (elapsed - lastPaint.current > 1 / 24) {
      paintScreen(screen.ctx, data, channel, colors, elapsed);
      screen.texture.needsUpdate = true;
      lastPaint.current = elapsed;
    }
  });
  return (
    <group ref={group} rotation={[0.035, -0.28, 0.025]} position={[0, 0.1, 0]}>
      <RoundedBox args={[4.65, 3.55, 1.45]} radius={0.23} smoothness={4} position={[0, 0.35, -0.18]}>
        <meshStandardMaterial color={colors.silver} metalness={0.72} roughness={0.27} />
      </RoundedBox>
      <RoundedBox args={[4.4, 3.3, 0.18]} radius={0.2} smoothness={4} position={[0, 0.35, 0.54]}>
        <meshStandardMaterial color={colors.edge} metalness={0.85} roughness={0.25} />
      </RoundedBox>
      <RoundedBox args={[3.97, 2.81, 0.15]} radius={0.23} smoothness={4} position={[0, 0.47, 0.67]}>
        <meshStandardMaterial color={colors.ink} metalness={0.3} roughness={0.3} />
      </RoundedBox>
      <mesh position={[0, 0.49, 0.759]}>
        <planeGeometry args={[3.75, 2.57]} />
        <shaderMaterial
          ref={material}
          vertexShader={vertex}
          fragmentShader={fragment}
          uniforms={uniforms}
          toneMapped={false}
        />
      </mesh>
      <RoundedBox args={[0.57, 0.055, 0.025]} radius={0.02} position={[-1.6, -1.16, 0.71]}>
        <meshStandardMaterial color={colors.ink} />
      </RoundedBox>
      <mesh position={[1.75, -1.12, 0.77]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.105, 0.105, 0.12, 32]} />
        <meshStandardMaterial color={colors.blue} metalness={0.5} roughness={0.25} />
      </mesh>
      <mesh position={[1.43, -1.12, 0.72]}>
        <sphereGeometry args={[0.032, 12, 12]} />
        <meshBasicMaterial color={colors.phosphor} />
      </mesh>
      {Array.from({ length: 9 }, (_, i) => (
        <RoundedBox key={i} args={[0.015, 0.055, 0.55]} radius={0.006} position={[2.32, 0.75 - i * 0.15, -0.28]}>
          <meshStandardMaterial color={colors.ink} />
        </RoundedBox>
      ))}
      <RoundedBox args={[0.9, 0.75, 0.72]} radius={0.13} position={[0, -1.68, -0.23]}>
        <meshStandardMaterial color={colors.silver} metalness={0.7} roughness={0.3} />
      </RoundedBox>
      <RoundedBox args={[2.42, 0.19, 1.35]} radius={0.08} position={[0, -2.04, -0.07]}>
        <meshStandardMaterial color={colors.edge} metalness={0.8} roughness={0.3} />
      </RoundedBox>
      <group position={[0, -2.06, 1.55]} rotation={[0.08, 0, 0]}>
        <RoundedBox args={[4.1, 0.18, 1.23]} radius={0.08}>
          <meshStandardMaterial color={colors.silver} metalness={0.68} roughness={0.3} />
        </RoundedBox>
        {Array.from({ length: 48 }, (_, i) => (
          <RoundedBox
            key={i}
            args={[0.26, 0.095, 0.2]}
            radius={0.025}
            smoothness={2}
            position={[-1.68 + (i % 12) * 0.304, 0.14, -0.41 + Math.floor(i / 12) * 0.27]}
          >
            <meshStandardMaterial
              color={i === 35 || i === 47 ? colors.blue : colors.edge}
              metalness={0.25}
              roughness={0.45}
            />
          </RoundedBox>
        ))}
      </group>
    </group>
  );
}

export default function RevenueConsole({
  data,
  channel,
  paused,
}: {
  data: ConsoleData;
  channel: ConsoleChannel;
  paused: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<Palette | null>(null);
  const [active, setActive] = useState(false);
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const names = ['silver', 'edge', 'ink', 'screen', 'blue', 'phosphor', 'white', 'muted', 'floor'] as const;
    setColors({
      ...Object.fromEntries(names.map((n) => [n, style.getPropertyValue(`--ep-console-${n}`).trim()])),
      font: style.getPropertyValue('--font-geist-mono').trim() || 'monospace',
    } as Palette);
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    let visible = false;
    const updateVisibility = () => setActive(visible && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      updateVisibility();
    });
    if (host.current) observer.observe(host.current);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  }, []);
  const animate = active && !reduced && !paused;
  return (
    <div ref={host} className="revenue-console" aria-hidden="true">
      <SceneBoundary fallback={<Fallback data={data} channel={channel} />}>
        {colors && (
          <Canvas
            frameloop={animate ? 'always' : 'demand'}
            dpr={[1, 1.5]}
            camera={{ position: [0, 0.65, 9.4], fov: 43 }}
            fallback={<Fallback data={data} channel={channel} />}
          >
            <ambientLight intensity={1.2} />
            <directionalLight position={[3, 6, 5]} intensity={3} color={colors.white} />
            <directionalLight position={[-5, 3, -2]} intensity={2} color={colors.blue} />
            <Environment resolution={128} frames={1}>
              <Lightformer
                form="rect"
                intensity={4}
                position={[-4, 5, 4]}
                scale={[6, 6, 1]}
                target={[0, 0, 0]}
                color={colors.white}
              />
              <Lightformer
                form="rect"
                intensity={3}
                position={[4, 2, -3]}
                scale={[3, 8, 1]}
                target={[0, 0, 0]}
                color={colors.blue}
              />
            </Environment>
            <ConsoleModel data={data} channel={channel} colors={colors} animate={animate} />
            <ContactShadows
              position={[0, -2.2, 0]}
              opacity={0.35}
              scale={12}
              blur={2.5}
              far={5}
              resolution={128}
              frames={1}
              color={colors.ink}
            />
          </Canvas>
        )}
      </SceneBoundary>
    </div>
  );
}
