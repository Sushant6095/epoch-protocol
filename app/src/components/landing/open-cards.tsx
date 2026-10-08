'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import fee from '@/fixtures/fee-index.sample.json';
import vault from '@/fixtures/vault.sample.json';

/** A card that tilts in 3D toward the pointer, with a soft spotlight following it. */
function TiltCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el || e.pointerType !== 'mouse') return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty('--rx', `${(0.5 - y) * 10}deg`);
    el.style.setProperty('--ry', `${(x - 0.5) * 12}deg`);
    el.style.setProperty('--mx', `${x * 100}%`);
    el.style.setProperty('--my', `${y * 100}%`);
  };
  const reset = () => {
    ref.current?.style.setProperty('--rx', '0deg');
    ref.current?.style.setProperty('--ry', '0deg');
  };
  return (
    <div ref={ref} className={`lx-card lx-tilt ${className}`} onPointerMove={onMove} onPointerLeave={reset}>
      {children}
    </div>
  );
}

/** The program's instruction names, typed out like a terminal. */
const IX = [
  'initialize_pool',
  'deposit_senior',
  'deposit_junior',
  'register_validator',
  'post_bond',
  'draw_advance',
  'sweep_revenue',
  'repay_advance',
  'propose_fee_index',
  'finalize_fee_index',
  'mark_default',
  'request_withdrawal',
];
function CodeVisual() {
  const [lines, setLines] = useState<string[]>(IX.slice(0, 7));
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let i = 7,
      c = 0;
    const id = setInterval(() => {
      const word = IX[i % IX.length];
      c++;
      setTyped(word.slice(0, c));
      if (c >= word.length + 6) {
        setLines((l) => [...l.slice(-8), word]);
        setTyped('');
        c = 0;
        i++;
      }
    }, 70);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="oc-code" aria-hidden="true">
      <div className="oc-code-bar">
        <i />
        <i />
        <i />
        <span className="num">programs/epoch/src/lib.rs</span>
      </div>
      <pre className="num">
        {lines.map((l) => (
          <span key={l} className="oc-line">
            <b>pub fn</b> {l}(ctx)
          </span>
        ))}
        <span className="oc-line oc-cursor">
          <b>pub fn</b> {typed}
          <u />
        </span>
      </pre>
    </div>
  );
}

function FeeVisual() {
  const pts = [...fee.points].reverse().slice(-16);
  const max = Math.max(...pts.map((p) => p.value));
  return (
    <div className="oc-fee" aria-hidden="true">
      {pts.map((p, i) => (
        <i
          key={p.epoch}
          data-status={p.status}
          style={{ height: `${(p.value / max) * 100}%`, animationDelay: `${i * 0.12}s` }}
          title={`E${p.epoch}`}
        />
      ))}
      <span className="oc-fee-tag num">
        {pts[pts.length - 1].value.toLocaleString('en-US')} µL/CU
      </span>
    </div>
  );
}

const param = (field: string) => vault.params.find((p) => p.field === field)?.value as number | null;
function ParamVisual() {
  const dials = [
    { label: 'Advance fee', v: (param('fee_bps') ?? 0) / 100, max: 10, unit: '%' },
    { label: 'Swept / epoch', v: (param('remit_bps') ?? 0) / 100, max: 100, unit: '%' },
    { label: 'Max lent out', v: (param('max_utilization_bps') ?? 0) / 100, max: 100, unit: '%' },
  ];
  return (
    <div className="oc-dials" aria-hidden="true">
      {dials.map((d, i) => {
        const r = 26,
          c = Math.PI * r;
        return (
          <div key={d.label} className="oc-dial">
            <svg viewBox="0 0 64 38">
              <path d="M6 34 A26 26 0 0 1 58 34" className="oc-dial-track" />
              <path
                d="M6 34 A26 26 0 0 1 58 34"
                className="oc-dial-fill"
                style={{ strokeDasharray: c, ['--off' as string]: c * (1 - d.v / d.max), animationDelay: `${i * 0.2}s` }}
              />
            </svg>
            <strong className="num">
              {d.v}
              {d.unit}
            </strong>
            <small>{d.label}</small>
          </div>
        );
      })}
    </div>
  );
}

export function OpenCards() {
  return (
    <div className="lx-cards">
      <TiltCard className="lx-reveal">
        <CodeVisual />
        <strong>Open-source program</strong>
        <p>An MIT-licensed Anchor program: pool, credit, Fee Index and fee swaps in 29 instructions.</p>
        <a href="https://github.com/Sushant6095/epoch-protocol" target="_blank" rel="noreferrer">
          Read the code <ArrowUpRight size={14} />
        </a>
      </TiltCard>
      <TiltCard className="lx-reveal">
        <FeeVisual />
        <strong>Solana Fee Index</strong>
        <p>A stake-weighted median priority fee for every epoch, published by Epoch on-chain.</p>
        <Link href="/live">
          See the index <ArrowUpRight size={14} />
        </Link>
      </TiltCard>
      <TiltCard className="lx-reveal">
        <ParamVisual />
        <strong>Parameters, not promises</strong>
        <p>Fees, limits, the utilisation cap and the loss order are read from the program, not written into the UI.</p>
        <Link href="/vault?tab=params">
          View parameters <ArrowUpRight size={14} />
        </Link>
      </TiltCard>
    </div>
  );
}

/** Three tilted orbits around the Epoch mark, rotating in 3D: the epoch, the sweep and the index. */
export function EpochOrbit() {
  return (
    <div className="oc-orbit" aria-hidden="true">
      <div className="oc-orbit-stage">
        <i className="oc-ring r1">
          <b />
        </i>
        <i className="oc-ring r2">
          <b />
        </i>
        <i className="oc-ring r3">
          <b />
        </i>
        <span className="oc-core" />
      </div>
    </div>
  );
}
