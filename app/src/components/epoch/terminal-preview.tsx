'use client';
import { useMemo } from 'react';
import Link from 'next/link';
import { Activity, ArrowUpRight, Server, Vault, Wallet } from 'lucide-react';
import { EpochMark } from './epoch-mark';
import { EpochChart } from './epoch-chart';
import { Source, compact, fmt } from './shared';
import { useNetwork } from '@/lib/data/useNetwork';
import { useValidators } from '@/lib/data/useValidators';
import { useStakeHistory } from '@/lib/data/resources';
export function TerminalPreview() {
  const network = useNetwork(),
    history = useStakeHistory(),
    validators = useValidators();
  const n = network.data;
  const points = useMemo(
    () => history.data?.rows.slice(-32).map((r) => ({ epoch: r.epoch, value: r.totalActiveSol })) ?? [],
    [history.data],
  );
  return (
    <div className="terminal-showcase">
      <div className="terminal-preview-bar">
        <span>
          <EpochMark />
          epoch <i>/ Terminal</i>
        </span>
        <>
          {network.isError ? (
            <span role="status">
              Network unavailable · <button onClick={() => network.refetch()}>Retry</button>
            </span>
          ) : (
            <Source data={n} />
          )}
        </>
        <Link href="/terminal">
          Open workspace <ArrowUpRight size={14} />
        </Link>
      </div>
      <div className="terminal-preview-layout">
        <aside aria-label="Preview navigation">
          <Link href="/terminal" className="selected">
            <Activity size={16} />
            Terminal
          </Link>
          <Link href="/validators">
            <Server size={16} />
            Validators
          </Link>
          <Link href="/me">
            <Wallet size={16} />
            My Stake
          </Link>
          <Link href="/vault">
            <Vault size={16} />
            Vault
          </Link>
          <small>
            PREVIEW
            <br />
            Historical network data
          </small>
        </aside>
        <div className="terminal-preview-main">
          <div className="terminal-preview-heading">
            <div>
              <span className="num">YOUR NETWORK, IN CONTEXT</span>
              <h2>Every epoch. In focus.</h2>
            </div>
            <span className="num">E{n?.epoch.number ?? '—'}</span>
          </div>
          <div className="terminal-preview-metrics">
            {[
              ['Active stake', compact(n?.stake.totalSol) + ' SOL'],
              ['Validators', fmt(n?.validators.total)],
              ['Median staking APY', fmt(n?.stake.medianApyPct, 2) + '%'],
            ].map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong className="num">{value}</strong>
              </div>
            ))}
          </div>
          <div className="terminal-preview-chart">
            <div>
              <span>Network stake</span>
              <Source data={history.data} />
            </div>
            {history.isError ? (
              <p>
                Stake history unavailable. <button onClick={() => history.refetch()}>Retry</button>
              </p>
            ) : points.length ? (
              <EpochChart points={points} height={230} />
            ) : (
              <p>Loading stake history…</p>
            )}
          </div>
          <div className="terminal-preview-operators">
            {validators.isError ? (
              <p>
                Operator data unavailable. <button onClick={() => validators.refetch()}>Retry</button>
              </p>
            ) : (
              validators.data?.rows.slice(0, 3).map((r) => (
                <Link href={`/validators/${r.vote}`} key={r.vote}>
                  <span>{r.name}</span>
                  <span>{fmt(r.apyPct, 2)}% APY</span>
                  <ArrowUpRight size={13} />
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
