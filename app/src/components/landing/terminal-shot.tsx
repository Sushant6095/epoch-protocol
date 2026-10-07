'use client';
import { useMemo } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  LineChart,
  Rows3,
  Search,
  Vault,
  Wallet,
} from 'lucide-react';
import { EpochMark } from '@/components/epoch/epoch-mark';
import { compact, fmt } from '@/components/epoch/shared';
import network from '@/fixtures/network.real.json';
import history from '@/fixtures/stake-history-64.real.json';
import activity from '@/fixtures/activity.sample.json';
import vault from '@/fixtures/vault.sample.json';
import fee from '@/fixtures/fee-index.sample.json';

/**
 * A faithful, static rendering of the Epoch Terminal for the landing page.
 * Built from the same snapshot fixtures as /terminal, so every figure matches the app.
 */
function areaPath(values: number[], w: number, h: number, pad = 6) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, pad + (h - pad * 2) * (1 - (v - min) / span)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return { line, area: `${line} L${w},${h} L0,${h} Z`, min, max, last: pts[pts.length - 1] };
}

const nav = [
  { icon: Activity, label: 'Terminal', active: true },
  { icon: Rows3, label: 'Validators' },
  { icon: Wallet, label: 'My Stake' },
  { icon: Vault, label: 'Vault' },
  { icon: LineChart, label: 'Predict' },
];

export function TerminalShot() {
  const rows = history.rows.slice(-40);
  const chart = useMemo(() => areaPath(rows.map((r) => r.totalActiveSol), 720, 210), [rows]);
  const flows = rows.map((r) => r.activatingSol - r.deactivatingSol);
  const maxFlow = Math.max(...flows.map(Math.abs));
  const progress = network.epoch.slotIndex / network.epoch.slotsInEpoch;
  const net = network.stake.activatingThisEpochSol - network.stake.deactivatingThisEpochSol;
  const finalFee = fee.points.find((p) => p.status === 'final');
  const kpis = [
    ['SOL staked', compact(network.stake.totalSol), 'Across the network'],
    ['Validators', fmt(network.validators.total), `${network.validators.delinquent} offline`],
    ['Median APY', `${fmt(network.stake.medianApyPct, 2)}%`, 'Staking + MEV tips'],
    ['Fee index', fmt(finalFee?.value), 'µL/CU · Sample'],
    ['Vault', `${compact(vault.pool.tvlSol)} SOL`, 'Sample'],
    ['Open advances', fmt(vault.advances.filter((a) => a.status !== 'repaid').length), `${fmt(vault.pool.outstandingPrincipalSol, 2)} SOL lent · Sample`],
  ];

  return (
    <div className="lx-shot" role="img" aria-label="The Epoch Terminal: network stake, validators, fee index and vault activity in one view">
      <aside className="lx-shot-side">
        <div className="lx-shot-brand">
          <EpochMark width={22} height={22} />
          <strong>Epoch</strong>
          <span>Mainnet data</span>
        </div>
        <p className="lx-shot-group">Workspace</p>
        {nav.map(({ icon: Icon, label, active }) => (
          <div key={label} className="lx-shot-nav" data-active={active || undefined}>
            <Icon size={15} strokeWidth={1.75} />
            {label}
          </div>
        ))}
        <p className="lx-shot-group">Tools</p>
        <div className="lx-shot-nav">
          <BookOpen size={15} strokeWidth={1.75} />
          Documentation
        </div>
        <div className="lx-shot-epoch">
          <div>
            <span className="num">Epoch {network.epoch.number}</span>
            <span className="num">{(progress * 100).toFixed(1)}%</span>
          </div>
          <i>
            <b style={{ width: `${progress * 100}%` }} />
          </i>
          <small>Snapshot · 29 Sep 2026</small>
        </div>
      </aside>
      <div className="lx-shot-main">
        <div className="lx-shot-top">
          <div className="lx-shot-search">
            <Search size={14} />
            Search validators or paste an address
            <kbd>⌘K</kbd>
          </div>
          <span className="num">Epoch {network.epoch.number}</span>
          <span className="num">SOL ${network.price.solUsd.toFixed(2)}</span>
          <span className="lx-shot-connect">Connect wallet</span>
        </div>
        <div className="lx-shot-body">
          <div className="lx-shot-head">
            <div>
              <p className="num">EPOCH / WORKSPACE</p>
              <h3>Terminal</h3>
            </div>
            <span className="lx-chip num">29 Sep snapshot</span>
          </div>
          <div className="lx-shot-kpis">
            {kpis.map(([label, value, sub]) => (
              <div key={label}>
                <span>{label}</span>
                <strong className="num">{value}</strong>
                <small>{sub}</small>
              </div>
            ))}
          </div>
          <div className="lx-shot-grid">
            <div className="lx-shot-card lx-shot-chart">
              <div className="lx-shot-card-head">
                <div>
                  <span>Net stake flow · E{network.epoch.number}</span>
                  <strong className="num" data-tone={net < 0 ? 'down' : 'up'}>
                    {net < 0 ? '−' : '+'}
                    {compact(Math.abs(net))} <small>SOL</small>
                  </strong>
                </div>
                <div className="lx-shot-flow">
                  <span>
                    <ArrowDownLeft size={13} /> Arriving <b className="num">+{compact(network.stake.activatingThisEpochSol)}</b>
                  </span>
                  <span>
                    <ArrowUpRight size={13} /> Leaving <b className="num">−{compact(network.stake.deactivatingThisEpochSol)}</b>
                  </span>
                </div>
              </div>
              <svg viewBox="0 0 720 260" preserveAspectRatio="none" className="lx-shot-svg">
                <defs>
                  <linearGradient id="lxArea" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0" stopColor="var(--ep-lx-blue)" stopOpacity="0.28" />
                    <stop offset="1" stopColor="var(--ep-lx-blue)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {[0, 1, 2, 3].map((i) => (
                  <line key={i} x1="0" x2="720" y1={20 + i * 55} y2={20 + i * 55} className="lx-grid" />
                ))}
                <path d={chart.area} fill="url(#lxArea)" />
                <path d={chart.line} className="lx-line lx-draw" fill="none" />
                <circle cx={chart.last[0]} cy={chart.last[1]} r="4" className="lx-dot" />
                {flows.map((f, i) => {
                  const bh = (Math.abs(f) / maxFlow) * 36;
                  const x = (i / (flows.length - 1)) * 712;
                  return (
                    <rect
                      key={i}
                      x={x}
                      y={f >= 0 ? 240 - bh : 240}
                      width="7"
                      height={Math.max(bh, 1)}
                      rx="1.5"
                      className={f >= 0 ? 'lx-bar-up' : 'lx-bar-down'}
                    />
                  );
                })}
              </svg>
              <div className="lx-shot-axis num">
                {rows.filter((_, i) => i % 8 === 0).map((r) => (
                  <span key={r.epoch}>E{r.epoch}</span>
                ))}
              </div>
            </div>
            <div className="lx-shot-card lx-shot-feed">
              <div className="lx-shot-card-head">
                <span>Protocol activity</span>
                <span className="lx-chip num">Sample</span>
              </div>
              <ul>
                {activity.events.slice(0, 6).map((e) => (
                  <li key={e.id}>
                    <i data-kind={e.kind} />
                    <span>{e.text}</span>
                    <b className="num">
                      {e.amountSol != null ? `${fmt(e.amountSol, e.amountSol % 1 ? 1 : 0)} SOL` : `${fmt(e.value)} ${e.unit}`}
                    </b>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
