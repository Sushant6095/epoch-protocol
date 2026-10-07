'use client';
import type { NetworkSnapshot } from '@/lib/data/contracts/Api.types';
import { EpochRing } from '@/components/epoch/epoch-ring';
import { compact, fmt, OperatorLogo } from '@/components/epoch/shared';
import NumberFlow from '@number-flow/react';
import { useEpochReplay } from '@/components/epoch/use-epoch-replay';

function BlockStream({ blocks, tps }: { blocks: ReturnType<typeof useEpochReplay>['blocks']; tps: number }) {
  const latest = blocks.slice(-4).reverse();
  const max = 2600;
  return (
    <div className="nh-stream">
      <div className="nh-stream-feed" aria-live="off">
        <p className="nh-sub">
          Block stream <span className="num">· {fmt(tps)} TPS</span>
        </p>
        <ul>
          {latest.length === 0 && <li className="nh-stream-empty">Waiting for the next slot…</li>}
          {latest.map((b) => (
            <li key={b.slot} data-skipped={b.skipped || undefined}>
              <OperatorLogo name={b.leader} vote={b.vote} size={22} />
              <span className="nh-stream-leader">{b.leader}</span>
              <span className="num nh-stream-slot">#{fmt(b.slot)}</span>
              <span className="num nh-stream-txs">{b.skipped ? 'skipped' : `${fmt(b.txs)} txs`}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="nh-stream-chart" aria-hidden="true">
        {Array.from({ length: 64 }, (_, i) => {
          const b = blocks[blocks.length - 64 + i];
          return (
            <i
              key={b ? b.slot : `e${i}`}
              data-skipped={b?.skipped || undefined}
              style={{ height: b ? `${b.skipped ? 6 : Math.max(10, (b.txs / max) * 100)}%` : '4%' }}
            />
          );
        })}
      </div>
    </div>
  );
}

function Bar({ parts }: { parts: { label: string; pct: number; tone: string }[] }) {
  return (
    <div className="nh-bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.pct}%`).join(', ')}>
      {parts.map((p) => (
        <i key={p.label} data-tone={p.tone} style={{ flexGrow: p.pct }} />
      ))}
    </div>
  );
}

/** Terminal hero: the epoch clock plus the anatomy of Solana's validator set, from the network snapshot. */
export function NetworkHero({
  n,
  title = 'Terminal',
  headingLevel = 'h1',
  replay = true,
}: {
  n: NetworkSnapshot;
  title?: string;
  headingLevel?: 'h1' | 'h2' | 'h3';
  replay?: boolean;
}) {
  const H = headingLevel;
  const live = useEpochReplay(n, { enabled: replay });
  const progress = live.slotIndex / n.epoch.slotsInEpoch;
  const left = n.epoch.slotsInEpoch - live.slotIndex;
  const secs = left * n.epoch.secondsPerSlot;
  const eta = `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m`;
  const slot = n.epoch.startSlot + live.slotIndex;
  const asOf = n.asOf
    ? new Date(n.asOf).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
    : '—';
  const d = n.delegators;
  return (
    <section className="nh" aria-labelledby="nh-title" title={`${n.source} · ${n.asOf}`}>
      <div className="nh-clock">
        <EpochRing progress={progress} size={232} stroke={12} tone="ink">
          <span className="nh-clock-label">Epoch</span>
          <strong className="num">{n.epoch.number}</strong>
          <span className="num nh-clock-pct">
            <NumberFlow value={progress * 100} format={{ minimumFractionDigits: 2, maximumFractionDigits: 2 }} suffix="%" />
          </span>
        </EpochRing>
        <dl className="nh-clock-meta">
          <div>
            <dt>Slot</dt>
            <dd className="num">
              <NumberFlow value={slot} />
            </dd>
          </div>
          <div>
            <dt>Slots left</dt>
            <dd className="num">
              <NumberFlow value={left} /> <small>≈ {eta}</small>
            </dd>
          </div>
          <div>
            <dt>Epoch length</dt>
            <dd className="num">
              {fmt(n.epoch.slotsInEpoch)} <small>· {fmt(n.epoch.hoursPerEpoch, 1)} h</small>
            </dd>
          </div>
        </dl>
      </div>

      <div className="nh-main">
        <div className="nh-head">
          <p className="nh-eyebrow">
            <i data-live={live.running || undefined} />
            {live.running ? `Replaying epoch ${n.epoch.number} from the ${asOf} IST snapshot` : `Solana mainnet · snapshot ${asOf} IST`}
          </p>
          <H id="nh-title" className="nh-title">{title}</H>
          <p>The network, one epoch at a time: stake, operators, fees and the capital behind them.</p>
        </div>
        <div className="nh-stats">
          <div>
            <span>SOL staked</span>
            <strong className="num">{compact(n.stake.totalSol)}</strong>
            <small className="num">
              +{compact(n.stake.activatingThisEpochSol)} / −{compact(n.stake.deactivatingThisEpochSol)} this epoch
            </small>
          </div>
          <div>
            <span>Validators</span>
            <strong className="num">{fmt(n.validators.total)}</strong>
            <small className="num">{n.validators.delinquent} delinquent</small>
          </div>
          <div>
            <span>Median APY</span>
            <strong className="num">{fmt(n.stake.medianApyPct, 2)}%</strong>
            <small className="num">Top {fmt(n.stake.topApyPct, 2)}% · staking + MEV</small>
          </div>
          <div>
            <span>Throughput</span>
            <strong className="num">
              <NumberFlow value={live.tps} />
            </strong>
            <small className="num">
              TPS · {fmt(n.tps.user)} user / {fmt(n.tps.vote)} vote
            </small>
          </div>
        </div>
      </div>

      <div className="nh-anatomy">
        <p className="nh-sub">Validator set anatomy</p>
        <div className="nh-row">
          <div className="nh-row-head">
            <span>Client diversity · by stake</span>
            <span className="num">
              {fmt(n.clients.agavePct, 1)} / {fmt(n.clients.firedancerPct, 1)}%
            </span>
          </div>
          <Bar
            parts={[
              { label: 'Agave', pct: n.clients.agavePct, tone: 'a' },
              { label: 'Firedancer', pct: n.clients.firedancerPct, tone: 'b' },
            ]}
          />
          <div className="nh-legend">
            <span data-tone="a">Agave</span>
            <span data-tone="b">Firedancer</span>
          </div>
        </div>
        {d && (<div className="nh-row">
          <div className="nh-row-head">
            <span>Who holds the stake</span>
            <span className="num">{fmt(d.wallets)} wallets</span>
          </div>
          <Bar
            parts={[
              { label: 'Allocators', pct: d.allocators.sharePct, tone: 'a' },
              { label: 'Mid-size', pct: d.midSize.sharePct, tone: 'b' },
              { label: 'Retail', pct: d.retail.sharePct, tone: 'c' },
            ]}
          />
          <div className="nh-legend">
            <span data-tone="a">
              {fmt(d.allocators.holders)} allocators · {d.allocators.sharePct}%
            </span>
            <span data-tone="b">Mid · {d.midSize.sharePct}%</span>
            <span data-tone="c">Retail · {d.retail.sharePct}%</span>
          </div>
        </div>)}
        <dl className="nh-facts">
          <div>
            <dt>Superminority</dt>
            <dd className="num">{n.validators.superminorityCount}</dd>
            <small>validators hold ⅓</small>
          </div>
          <div>
            <dt>Under break-even</dt>
            <dd className="num">{n.validators.belowBreakEven}</dd>
            <small>below ~{compact(n.breakEvenStakeSol)} SOL stake</small>
          </div>
          <div>
            <dt>Finality</dt>
            <dd className="num">{fmt(n.finalitySeconds, 1)}s</dd>
            <small>{fmt(n.blocks.skipRatePct, 2)}% slots skipped</small>
          </div>
        </dl>
      </div>
      {replay && <BlockStream blocks={live.blocks} tps={live.tps} />}
    </section>
  );
}
