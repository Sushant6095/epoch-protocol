'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { fmt, OperatorLogo } from '@/components/epoch/shared';
import validators from '@/fixtures/validators.real.json';
import vault from '@/fixtures/vault.sample.json';


function ValidatorsPanel() {
  const rows = validators.rows
    .filter((r) => r.name && r.name !== 'Unnamed')
    .sort((a, b) => b.epochScore - a.epochScore || b.apyPct - a.apyPct)
    .slice(0, 7);
  return (
    <div className="lx-panel">
      <div className="lx-panel-head">
        <span>Validators · sorted by Epoch Score</span>
        <span className="lx-chip num">29 Sep snapshot</span>
      </div>
      <div className="lx-table" role="table" aria-label="Validator comparison">
        <div className="lx-tr lx-th" role="row">
          <span role="columnheader">Operator</span>
          <span role="columnheader">Epoch Score</span>
          <span role="columnheader">APY</span>
          <span role="columnheader">Fee</span>
          <span role="columnheader">Kept / epoch</span>
        </div>
        {rows.map((r) => (
          <div className="lx-tr" role="row" key={r.vote}>
            <span role="cell" className="lx-op">
              <OperatorLogo name={r.name} vote={r.vote} size={26} />
              <span>
                <strong>{r.name}</strong>
                <small>
                  {r.client} · {r.country}
                </small>
              </span>
            </span>
            <span role="cell" className="lx-score">
              <b className="num">{r.epochScore}</b>
              <i>
                <u style={{ width: `${r.epochScore}%` }} />
              </i>
            </span>
            <span role="cell" className="num">{fmt(r.apyPct, 2)}%</span>
            <span role="cell" className="num">{r.commissionPct}%</span>
            <span role="cell" className="num" data-tone={r.healthPerEpochSol < 0 ? 'warn' : undefined}>
              {r.healthPerEpochSol < 0 ? '−' : ''}
              {fmt(Math.abs(r.healthPerEpochSol), 1)} SOL
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdvancePanel() {
  const a = vault.advances[0];
  const fee = (vault.params.find((p) => p.field === 'fee_bps')?.value ?? 0) / 100;
  const remit = (vault.params.find((p) => p.field === 'remit_bps')?.value ?? 0) / 100;
  const pct = (a.repaidSol / a.owesSol) * 100;
  const open = vault.advances.filter((x) => x.status !== 'repaid').slice(0, 4);
  return (
    <div className="lx-panel">
      <div className="lx-panel-head">
        <span>Advance · {a.validator}</span>
        <span className="lx-chip lx-chip-amber num">Sample</span>
      </div>
      <div className="lx-adv">
        <div className="lx-adv-figs">
          <div>
            <span>Borrowed</span>
            <strong className="num">{fmt(a.borrowedSol)} SOL</strong>
          </div>
          <div>
            <span>Owes, with {fmt(fee)}% fee</span>
            <strong className="num">{fmt(a.owesSol, 1)} SOL</strong>
          </div>
          <div>
            <span>Bond posted</span>
            <strong className="num">{fmt(a.bondSol)} SOL</strong>
          </div>
        </div>
        <div className="lx-adv-progress">
          <div>
            <span>Repaid at source</span>
            <b className="num">
              {fmt(a.repaidSol)} / {fmt(a.owesSol, 1)} SOL
            </b>
          </div>
          <i>
            <u style={{ width: `${pct}%` }} />
          </i>
          <small>
            {fmt(remit)}% of each epoch’s revenue is swept to the vault until the advance is repaid. The operator keeps the
            rest.
          </small>
        </div>
        <div className="lx-adv-list">
          {open.map((x) => (
            <div key={x.validator}>
              <span>{x.validator}</span>
              <i>
                <u style={{ width: `${(x.repaidSol / x.owesSol) * 100}%` }} />
              </i>
              <b className="num">{Math.round((x.repaidSol / x.owesSol) * 100)}%</b>
              <em data-status={x.status}>{x.status === 'late' ? `Late · ${x.lateEpochs} epoch` : 'On track'}</em>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function VaultPanel() {
  const { senior, junior } = vault.tranches;
  const total = senior.assetsSol + junior.assetsSol;
  return (
    <div className="lx-panel">
      <div className="lx-panel-head">
        <span>Vault · {fmt(vault.pool.tvlSol)} SOL from {fmt(vault.pool.lenders)} lenders</span>
        <span className="lx-chip lx-chip-amber num">Sample</span>
      </div>
      <div className="lx-vault">
        <div className="lx-split" aria-hidden="true">
          <i style={{ flexGrow: senior.assetsSol }} />
          <i style={{ flexGrow: junior.assetsSol }} />
        </div>
        <div className="lx-tranches">
          <div>
            <span>Senior</span>
            <strong className="num">{fmt(senior.apyPct, 1)}%</strong>
            <small>Target a year · paid first</small>
            <p className="num">
              {fmt(senior.assetsSol)} SOL · {Math.round((senior.assetsSol / total) * 100)}%
            </p>
          </div>
          <div>
            <span>Junior</span>
            <strong className="num">{fmt(junior.apySinceLaunchPct, 1)}%</strong>
            <small>Since launch · first loss after bond</small>
            <p className="num">
              {fmt(junior.assetsSol)} SOL · {junior.sharePctOfVault}% · {junior.lockEpochs}-epoch lock
            </p>
          </div>
        </div>
        <ol className="lx-loss">
          <li>
            <ShieldCheck size={15} />
            <span>Validator bond</span>
            <small>absorbs a shortfall first</small>
          </li>
          <li>
            <span className="num">2</span>
            <span>Junior capital</span>
            <small>then all of Junior</small>
          </li>
          <li>
            <span className="num">3</span>
            <span>Senior capital</span>
            <small>only after both are gone</small>
          </li>
        </ol>
        <p className="lx-note">
          Vault SOL is not staked. {fmt(vault.pool.utilizationPct, 1)}% lent out of a {vault.pool.utilizationCapPct}% cap. Targets are
          not guarantees.
        </p>
      </div>
    </div>
  );
}

const tabs = [
  {
    key: 'validators',
    title: 'Research every operator',
    copy: 'Stake, APY split, fees kept after vote costs and delegator concentration, rolled into one Epoch Score.',
    href: '/validators',
    cta: 'Compare validators',
    Panel: ValidatorsPanel,
  },
  {
    key: 'advance',
    title: 'Borrow against the next epochs',
    copy: 'Validators draw SOL against revenue they are certain to earn. Repayment is swept at the source, every epoch.',
    href: '/validators/FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk',
    cta: 'See validator economics',
    Panel: AdvancePanel,
  },
  {
    key: 'vault',
    title: 'Lend with a written risk order',
    copy: 'Choose Senior for a target rate paid first, or Junior for the residual. Every advance and loss rule is on the page.',
    href: '/vault',
    cta: 'Explore the Vault',
    Panel: VaultPanel,
  },
];

const DURATION = 7000;

export function ProductTour({ paused = false }: { paused?: boolean }) {
  const [active, setActive] = useState(0);
  const [hold, setHold] = useState(false);
  const [visible, setVisible] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [reduce, setReduce] = useState(false);

  useEffect(() => {
    setReduce(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.35 });
    if (root.current) io.observe(root.current);
    return () => io.disconnect();
  }, []);

  const running = visible && !hold && !paused && !reduce;
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => setActive((i) => (i + 1) % tabs.length), DURATION);
    return () => clearTimeout(t);
  }, [running, active]);

  const current = tabs[active];
  return (
    <div
      ref={root}
      className="lx-tour"
      onPointerEnter={() => setHold(true)}
      onPointerLeave={() => setHold(false)}
      onFocus={() => setHold(true)}
      onBlur={() => setHold(false)}
    >
      <div className="lx-tour-tabs" role="group" aria-label="What Epoch does">
        {tabs.map((t, i) => (
          <div key={t.key} className="lx-tour-item" data-active={i === active || undefined}>
            <button
              id={`tour-tab-${t.key}`}
              aria-pressed={i === active}
              aria-controls="tour-panel"
              className="lx-tour-tab"
              onClick={() => setActive(i)}
            >
              <span className="lx-tour-index num">0{i + 1}</span>
              <span className="lx-tour-text">
                <strong>{t.title}</strong>
                <small>{t.copy}</small>
              </span>
            </button>
            {i === active && (
              <Link href={t.href} className="lx-tour-link">
                {t.cta} <ArrowRight size={14} />
              </Link>
            )}
            <span className="lx-tour-bar" aria-hidden="true">
              <u
                key={`${active}-${running}`}
                data-run={i === active && running ? 'true' : undefined}
                data-done={i === active && !running ? 'true' : undefined}
                style={{ animationDuration: `${DURATION}ms` }}
              />
            </span>
          </div>
        ))}
      </div>
      <div
        className="lx-tour-stage"
        role="region"
        id="tour-panel"
        aria-labelledby={`tour-tab-${current.key}`}
      >
        <div className="lx-tour-panel" key={current.key}>
          <current.Panel />
        </div>
      </div>
    </div>
  );
}

