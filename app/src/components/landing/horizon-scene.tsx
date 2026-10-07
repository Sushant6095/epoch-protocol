'use client';
import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Three.js hero: the Solana validator set as a planet at dawn.
 * - 683 nodes on the surface (one per active validator in the snapshot); amber = earns below vote fees.
 * - Great-circle arcs carry stake between operators.
 * - An atmosphere rim lit from behind, like first light of a new epoch.
 * Scroll drives a camera dolly through `scroll.current` (0..1), set by the page's ScrollTrigger.
 */
export type SceneProps = {
  scroll: { current: number };
  paused?: boolean;
  total?: number;
  belowBreakEven?: number;
};

const R = 10;
const CENTER = new THREE.Vector3(0, -11.75, 0);

const planetVert = `
varying vec3 vN; varying vec3 vP; varying vec3 vView;
void main(){
  vN=normalize(normalMatrix*normal);
  vec4 wp=modelMatrix*vec4(position,1.);
  vP=position;
  vView=normalize(cameraPosition-wp.xyz);
  gl_Position=projectionMatrix*viewMatrix*wp;
}`;
const planetFrag = `
uniform float uTime;
varying vec3 vN; varying vec3 vP; varying vec3 vView;
void main(){
  vec3 n=normalize(vP);
  float lat=asin(clamp(n.y,-1.,1.));
  float lon=atan(n.z,n.x);
  float gl=abs(fract(lat*22.)-.5); float go=abs(fract(lon*14.)-.5);
  float grid=smoothstep(.03,0.,gl)*.8+smoothstep(.02,0.,go)*.55;
  float fres=pow(1.-max(dot(normalize(vN),vec3(0.,0.,1.)),0.),3.);
  vec3 base=vec3(.028,.028,.045);
  vec3 blue=vec3(.36,.42,.93);
  vec3 col=base+blue*grid*.05+blue*fres*.22;
  gl_FragColor=vec4(col,1.);
}`;
const atmoFrag = `
uniform vec3 uAmber; uniform vec3 uBlue; uniform float uPulse; uniform float uRise;
varying vec3 vN; varying vec3 vP; varying vec3 vView;
void main(){
  float f=1.-abs(dot(normalize(vN),vec3(0.,0.,1.)));
  float rim=pow(f,5.);
  float sun=exp(-pow(vP.x/5.5,2.));
  vec3 c=mix(uBlue,uAmber,sun*.85);
  float a=rim*(.55+(.35+.9*uRise)*sun)*uPulse;
  gl_FragColor=vec4(c*a*1.15,a*.9);
}`;
const pointVert = `
attribute float aWarn; attribute float aSeed;
uniform float uTime; uniform float uPx;
varying float vWarn; varying float vFade;
void main(){
  vWarn=aWarn;
  vec4 mv=modelViewMatrix*vec4(position,1.);
  vec3 wn=normalize((modelMatrix*vec4(position,0.)).xyz);
  vFade=smoothstep(-.05,.35,wn.z)*smoothstep(-.2,.6,wn.y+.4);
  float tw=.75+.25*sin(uTime*1.3+aSeed*40.);
  gl_PointSize=uPx*(aWarn>.5?3.8:2.8)*tw*(14./-mv.z);
  gl_Position=projectionMatrix*mv;
}`;
const pointFrag = `
uniform vec3 uAmber; uniform vec3 uSilver;
varying float vWarn; varying float vFade;
void main(){
  vec2 d=gl_PointCoord-.5; float r=length(d);
  float a=smoothstep(.5,.1,r)*vFade;
  vec3 c=mix(uSilver,uAmber,vWarn);
  gl_FragColor=vec4(c*a,a);
}`;
const arcVert = `
attribute float aT;
varying float vT;
void main(){ vT=aT; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
const arcFrag = `
uniform float uHead; uniform vec3 uColor;
varying float vT;
void main(){
  float d=uHead-vT;
  float tail=smoothstep(.45,0.,d)*step(0.,d);
  float base=.07;
  float a=max(tail,base);
  gl_FragColor=vec4(uColor*a,a);
}`;


/* Full-screen dawn sky behind the planet: ink night, aurora curtains, stars, and a sun cresting the limb
   (the planet occludes the sun's core, so only the corona, rays and lens streak spill over the horizon). */
const skyVert = `
varying vec2 vUv;
void main(){ vUv=uv; gl_Position=vec4(position.xy,.9999,1.); }`;
const skyFrag = `
uniform float uTime; uniform float uRise; uniform float uAspect; uniform vec2 uSun;
uniform vec3 uAmber; uniform vec3 uBlue; uniform vec3 uTeal; uniform vec3 uViolet;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<5;i++){ v+=a*noise(p); p*=2.03; a*=.5; } return v; }
void main(){
  vec2 uv=vUv;
  vec2 p=uv-uSun; p.x*=uAspect;
  float d=length(p);
  float above=uv.y-uSun.y;
  // night to first light
  vec3 col=mix(vec3(.022,.022,.04), vec3(.075,.07,.17), pow(clamp(1.-above*1.5,0.,1.),2.2));
  col+=uBlue*exp(-d*1.25)*.2*uRise;
  col+=uViolet*exp(-d*2.2)*.22*uRise;
  col+=uAmber*exp(-d*3.4)*.6*uRise;
  // stars, fading out where the light is
  vec2 g=vec2(uv.x*uAspect,uv.y)*110.;
  vec2 id=floor(g); float r=hash(id);
  if(r>.986){
    vec2 c=fract(g)-.5-(vec2(hash(id+3.),hash(id+7.))-.5)*.6;
    float tw=.55+.45*sin(uTime*(1.+r*3.)+r*90.);
    col+=vec3(.85,.88,1.)*smoothstep(.09,0.,length(c))*tw*smoothstep(.0,.25,above)*(1.-.8*exp(-d*2.));
  }
  // aurora: three drifting curtains above the horizon
  float ax=uv.x*uAspect;
  for(int i=0;i<3;i++){
    float fi=float(i);
    float y0=uSun.y+.24+fi*.085+.05*sin(ax*1.6+uTime*.09+fi*2.1)+.06*(fbm(vec2(ax*.9+uTime*.025,fi*5.))-.5);
    float w=.018+.022*fbm(vec2(ax*2.+fi,uTime*.05));
    float band=exp(-pow((uv.y-y0)/w,2.));
    float rays=step(0.,uv.y-y0)*exp(-max(uv.y-y0,0.)*9.);
    float curtain=pow(fbm(vec2(ax*16.+uTime*.1+fi*9.,uv.y*1.2+fi)),2.2)*2.6*smoothstep(.0,.35,fbm(vec2(ax*1.3-uTime*.04,fi*4.)));
    vec3 ac=i==0?uTeal:(i==1?uBlue:uViolet);
    col+=ac*(band*.7+rays*.55)*curtain*(.45+.55*uRise)*.38;
  }
  // god rays fanning up from the sun
  float ang=atan(p.y,p.x);
  float rays=pow(.5+.5*sin(ang*22.+fbm(vec2(ang*4.,uTime*.08))*7.),5.);
  col+=mix(uAmber,vec3(1.),.3)*rays*exp(-d*2.6)*.15*uRise*smoothstep(-.02,.05,above);
  // corona + anamorphic lens streak along the horizon
  col+=vec3(1.,.86,.7)*exp(-d*22.)*1.4*uRise;
  col+=mix(uAmber,vec3(1.),.5)*exp(-abs(p.y)*70.)*exp(-abs(p.x)*1.6)*.75*uRise;
  col+=uBlue*exp(-abs(p.y)*26.)*exp(-abs(p.x)*.9)*.18*uRise;
  // film grain
  col+=(hash(uv*vec2(1733.,977.)+fract(uTime))-.5)*.018;
  gl_FragColor=vec4(col,1.);
}`;

function fibonacci(count: number) {
  const pts: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    pts.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r));
  }
  return pts;
}

function Planet({ scroll, paused, total = 683, belowBreakEven = 136 }: SceneProps) {
  const group = useRef<THREE.Group>(null);
  const { camera, size } = useThree();
  const amber = useMemo(() => new THREE.Color('#f3b16a'), []);
  const blue = useMemo(() => new THREE.Color('#6d7ff0'), []);
  const silver = useMemo(() => new THREE.Color('#ededf3'), []);

  const planetMat = useMemo(
    () => new THREE.ShaderMaterial({ vertexShader: planetVert, fragmentShader: planetFrag, uniforms: { uTime: { value: 0 } } }),
    [],
  );
  const atmoMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: planetVert,
        fragmentShader: atmoFrag,
        uniforms: { uAmber: { value: amber }, uBlue: { value: blue }, uPulse: { value: 1 }, uRise: { value: 0 } },
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
      }),
    [amber, blue],
  );

  const skyMat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: skyVert,
        fragmentShader: skyFrag,
        uniforms: {
          uTime: { value: 0 },
          uRise: { value: 0 },
          uAspect: { value: 1 },
          uSun: { value: new THREE.Vector2(0.5, 0.3) },
          uAmber: { value: amber },
          uBlue: { value: blue },
          uTeal: { value: new THREE.Color('#2fb5a3') },
          uViolet: { value: new THREE.Color('#8a5cf0') },
        },
        depthTest: false,
        depthWrite: false,
      }),
    [amber, blue],
  );
  const sunWorld = useMemo(() => new THREE.Vector3(), []);
  const tmp = useMemo(() => ({ c: new THREE.Vector3(), up: new THREE.Vector3() }), []);

  const points = useMemo(() => {
    const dirs = fibonacci(total);
    const pos = new Float32Array(total * 3);
    const warn = new Float32Array(total);
    const seed = new Float32Array(total);
    // deterministic shuffle so amber nodes are spread out
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    dirs.forEach((d, i) => {
      pos.set([d.x * R * 1.003, d.y * R * 1.003, d.z * R * 1.003], i * 3);
      seed[i] = rnd();
    });
    const order = [...Array(total).keys()].sort(() => rnd() - 0.5);
    order.slice(0, belowBreakEven).forEach((i) => (warn[i] = 1));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aWarn', new THREE.BufferAttribute(warn, 1));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: pointVert,
      fragmentShader: pointFrag,
      uniforms: { uTime: { value: 0 }, uPx: { value: 1 }, uAmber: { value: amber }, uSilver: { value: silver } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    return { geo, mat, dirs };
  }, [total, belowBreakEven, amber, silver]);

  const arcs = useMemo(() => {
    const { dirs } = points;
    // pick node pairs on the visible (front-top) cap
    const front = dirs
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.z > 0.55 && d.y > 0.55);
    let s = 3;
    const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    return Array.from({ length: 14 }, (_, k) => {
      const a = front[Math.floor(rnd() * front.length)].d;
      const b = front[Math.floor(rnd() * front.length)].d;
      const n = 64;
      const pos = new Float32Array(n * 3);
      const t = new Float32Array(n);
      const ang = a.angleTo(b);
      for (let j = 0; j < n; j++) {
        const u = j / (n - 1);
        const p = new THREE.Vector3().copy(a).lerp(b, u).normalize();
        const lift = 1 + Math.sin(u * Math.PI) * (0.04 + ang * 0.12);
        pos.set([p.x * R * lift, p.y * R * lift, p.z * R * lift], j * 3);
        t[j] = u;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aT', new THREE.BufferAttribute(t, 1));
      const mat = new THREE.ShaderMaterial({
        vertexShader: arcVert,
        fragmentShader: arcFrag,
        uniforms: { uHead: { value: 0 }, uColor: { value: k % 3 === 0 ? amber : blue.clone().lerp(silver, 0.4) } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      return { geo, mat, line: new THREE.Line(geo, mat), speed: 0.12 + rnd() * 0.12, offset: rnd() * 2 };
    });
  }, [points, amber, blue, silver]);

  const t = useRef(6);
  const smooth = useRef(0);
  // dawn: 0 = night; tweens to 1 when the opening sequence hands over (or at once without it)
  const dawn = useRef(0);
  const dawnTarget = useRef(0);
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      dawn.current = dawnTarget.current = 1;
      return;
    }
    const go = () => (dawnTarget.current = 1);
    if (document.documentElement.dataset.intro === 'on') {
      // first light breaks as the intro's iris opens onto the hero
      window.addEventListener('epoch:intro-reveal', go, { once: true });
      window.addEventListener('epoch:intro-done', go, { once: true });
      return () => {
        window.removeEventListener('epoch:intro-reveal', go);
        window.removeEventListener('epoch:intro-done', go);
      };
    }
    const id = setTimeout(go, 150);
    return () => clearTimeout(id);
  }, []);
  useFrame((state, dt) => {
    if (!paused) t.current += Math.min(dt, 0.05);
    const time = t.current;
    smooth.current += (scroll.current - smooth.current) * 0.12;
    const p = smooth.current;
    // camera dolly: from a wide establishing shot down towards the limb
    const aspect = size.width / size.height;
    const baseZ = aspect < 1 ? 9.5 : 6.4;
    camera.position.set(state.pointer.x * 0.25, 0.25 - p * 1.1 + state.pointer.y * 0.12, baseZ - p * 3.4);
    camera.lookAt(0, -0.6 - p * 0.9, 0);
    if (group.current) group.current.rotation.y = time * 0.018;
    dawn.current += (dawnTarget.current - dawn.current) * Math.min(dt * 0.9, 1);
    const rise = dawn.current * (0.85 + p * 0.5);
    // the sun sits on the silhouette's top point, a touch below the limb, and crests as you scroll
    camera.updateMatrixWorld();
    tmp.c.copy(camera.position).sub(CENTER);
    const dist = tmp.c.length();
    tmp.c.normalize();
    tmp.up.set(0, 1, 0).addScaledVector(tmp.c, -tmp.c.y).normalize();
    const cosT = R / dist;
    const sinT = Math.sqrt(1 - cosT * cosT);
    sunWorld
      .copy(CENTER)
      .addScaledVector(tmp.c, R * cosT)
      .addScaledVector(tmp.up, R * sinT * (0.985 + p * 0.03));
    sunWorld.project(camera);
    skyMat.uniforms.uSun.value.set(sunWorld.x * 0.5 + 0.5, sunWorld.y * 0.5 + 0.5);
    skyMat.uniforms.uAspect.value = aspect;
    skyMat.uniforms.uTime.value = time;
    skyMat.uniforms.uRise.value = rise;
    atmoMat.uniforms.uRise.value = rise;
    planetMat.uniforms.uTime.value = time;
    points.mat.uniforms.uTime.value = time;
    points.mat.uniforms.uPx.value = Math.min(state.viewport.dpr, 1.5);
    atmoMat.uniforms.uPulse.value = 0.94 + 0.06 * Math.sin(time * 0.6) + p * 0.35;
    arcs.forEach((a) => {
      a.mat.uniforms.uHead.value = ((time * a.speed + a.offset) % 1.6) - 0.1;
    });
  });

  return (
    <>
    <mesh material={skyMat} frustumCulled={false} renderOrder={-1}>
      <planeGeometry args={[2, 2]} />
    </mesh>
    <group position={CENTER}>
      <mesh material={atmoMat} scale={1.035}>
        <sphereGeometry args={[R, 96, 96]} />
      </mesh>
      <group ref={group}>
        <mesh material={planetMat}>
          <sphereGeometry args={[R, 128, 128]} />
        </mesh>
        <points geometry={points.geo} material={points.mat} />
        {arcs.map((a, i) => (
          <primitive key={i} object={a.line} />
        ))}
      </group>
    </group>
    </>
  );
}

export default function HorizonScene(props: SceneProps) {
  return (
    <Canvas
      className="lx-horizon"
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      camera={{ fov: 38, near: 0.1, far: 100, position: [0, 0.25, 6.4] }}
      frameloop={props.paused ? 'demand' : 'always'}
      aria-hidden="true"
    >
      <Planet {...props} />
    </Canvas>
  );
}
