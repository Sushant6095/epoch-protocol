'use client';
import { compact, fmt } from '@/components/epoch/shared';

/**
 * Vault capital flow, simulated: lenders fund the Senior and Junior tranches, the Vault advances SOL to
 * validators, and every epoch the program sweeps a share of their revenue back. Particles travel the real
 * paths; widths follow the sample pool. Pure SVG (animateMotion), so it is crisp and cheap.
 */
type Props = {
  tvl: number;
  senior: number;
  junior: number;
  lent: number;
  lenders: number;
  remitPct: number;
  advances: { validator: string; borrowedSol: number; status: string }[];
};

const W = 1000;
const H = 360;

export function CapitalFlow({ tvl, senior, junior, lent, lenders, remitPct, advances }: Props) {
  const open = advances.filter((a) => a.status !== 'repaid').slice(0, 5);
  const vx = 470,
    vy = H / 2;
  const valY = (i: number) => 50 + i * ((H - 100) / Math.max(open.length - 1, 1));
  const lendPath = (y: number) => `M 70 ${y} C 220 ${y}, 260 ${vy}, ${vx - 70} ${vy}`;
  const outPath = (y: number) => `M ${vx + 70} ${vy - 18} C 640 ${vy - 18}, 680 ${y}, 840 ${y}`;
  const backPath = (y: number) => `M 840 ${y + 10} C 700 ${y + 10}, 700 ${H - 20}, ${vx} ${H - 20} L ${vx} ${vy + 60}`;
  return (
    <figure className="cf" aria-label={`Capital flow: ${fmt(lenders)} lenders fund ${fmt(tvl)} SOL, ${fmt(lent, 1)} SOL is advanced to validators and repaid from ${remitPct}% of their revenue each epoch.`}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-hidden="true">
        <defs>
          <linearGradient id="cf-in" x1="0" x2="1">
            <stop offset="0" stopColor="var(--ep-accent)" stopOpacity="0.1" />
            <stop offset="1" stopColor="var(--ep-accent)" stopOpacity="0.55" />
          </linearGradient>
          <linearGradient id="cf-out" x1="0" x2="1">
            <stop offset="0" stopColor="var(--ep-accent)" stopOpacity="0.55" />
            <stop offset="1" stopColor="var(--ep-info)" stopOpacity="0.4" />
          </linearGradient>
        </defs>
        {/* lenders → vault */}
        {[110, 180, 250].map((y, i) => (
          <g key={`l${i}`}>
            <path d={lendPath(y)} className="cf-pipe" stroke="url(#cf-in)" strokeWidth={i === 1 ? 10 : 6} />
            {[0, 1, 2].map((k) => (
              <circle key={k} r="3.5" className="cf-dot">
                <animateMotion dur={`${3.2 + i * 0.4}s`} begin={`${k * 1.1 + i * 0.3}s`} repeatCount="indefinite" path={lendPath(y)} />
              </circle>
            ))}
          </g>
        ))}
        {/* vault → validators */}
        {open.map((a, i) => (
          <g key={a.validator}>
            <path d={outPath(valY(i))} className="cf-pipe" stroke="url(#cf-out)" strokeWidth={2 + (a.borrowedSol / lent) * 14} />
            {[0, 1].map((k) => (
              <circle key={k} r="3" className="cf-dot">
                <animateMotion dur="2.8s" begin={`${k * 1.4 + i * 0.25}s`} repeatCount="indefinite" path={outPath(valY(i))} />
              </circle>
            ))}
            <path d={backPath(valY(i))} className="cf-pipe cf-back" />
            <circle r="3" className="cf-dot cf-dot-back">
              <animateMotion dur="4.4s" begin={`${i * 0.7}s`} repeatCount="indefinite" path={backPath(valY(i))} />
            </circle>
          </g>
        ))}
        {/* vault node */}
        <g className="cf-vault">
          <rect x={vx - 70} y={vy - 60} width="140" height="120" rx="22" />
          <rect x={vx - 58} y={vy - 46} width={(116 * senior) / tvl} height="10" rx="5" className="cf-sen" />
          <rect x={vx - 58 + (116 * senior) / tvl + 3} y={vy - 46} width={(116 * junior) / tvl - 3} height="10" rx="5" className="cf-jun" />
        </g>
      </svg>
      <div className="cf-label cf-label-left">
        <strong className="num">{fmt(lenders)}</strong>
        <span>lenders</span>
      </div>
      <div className="cf-label cf-label-vault">
        <span>Vault</span>
        <strong className="num">{compact(tvl)} SOL</strong>
        <small className="num">
          Senior {Math.round((senior / tvl) * 100)}% · Junior {Math.round((junior / tvl) * 100)}%
        </small>
      </div>
      {open.map((a, i) => (
        <div key={a.validator} className="cf-label cf-label-val" style={{ top: `${(valY(i) / H) * 100}%` }}>
          <span>{a.validator}</span>
          <small className="num" data-late={a.status === 'late' || undefined}>
            {fmt(a.borrowedSol)} SOL{a.status === 'late' ? ' · late' : ''}
          </small>
        </div>
      ))}
      <figcaption>
        <span>
          <i className="cf-key" /> SOL lent out
        </span>
        <span>
          <i className="cf-key cf-key-back" /> {remitPct}% of each epoch’s revenue swept back
        </span>
        <span className="num">Sample pool · simulation</span>
      </figcaption>
    </figure>
  );
}
