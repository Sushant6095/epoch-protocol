'use client';
import { useId, useMemo, useState } from 'react';
import NumberFlow from '@number-flow/react';
import vault from '@/fixtures/vault.sample.json';

/** Program parameters come from the Pool account (vault data), never literals. */
const param = (field: string) => vault.params.find((p) => p.field === field)?.value ?? null;
const rates = vault.advances.map((a) => a.limitRatePct);
const RATE_UNHEDGED = Math.min(...rates);
const RATE_HEDGED = Math.max(...rates);
const FEE = (param('fee_bps') ?? 0) / 10000;
const REMIT = (param('remit_bps') ?? 0) / 10000;
const BOND_MULT = param('bond_multiplier') ?? 0;
const MAX_EPOCHS = param('max_advance_epochs') ?? 20;
const WINDOW = 10;

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="lx-slider">
      <label htmlFor={id}>
        <span>{label}</span>
        <b className="num">
          {value} {unit}
        </b>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ ['--fill' as string]: `${pct}%` }}
      />
    </div>
  );
}

export function AdvanceCalculator() {
  const [revenue, setRevenue] = useState(14);
  const [bond, setBond] = useState(12);
  const [hedged, setHedged] = useState(false);

  const r = useMemo(() => {
    const rate = (hedged ? RATE_HEDGED : RATE_UNHEDGED) / 100;
    const byRevenue = rate * WINDOW * revenue;
    const byBond = BOND_MULT * bond;
    const limit = Math.min(byRevenue, byBond);
    const owes = limit * (1 + FEE);
    const perEpoch = revenue * REMIT;
    const epochs = perEpoch > 0 ? Math.ceil(owes / perEpoch) : Infinity;
    const bars = Array.from({ length: Math.min(Math.max(epochs, 1), MAX_EPOCHS) }, (_, i) =>
      Math.min(perEpoch, Math.max(owes - perEpoch * i, 0)),
    );
    return { limit, owes, perEpoch, epochs, bars, bound: byRevenue <= byBond ? 'revenue' : 'bond' };
  }, [revenue, bond, hedged]);

  return (
    <div className="lx-calc">
      <div className="lx-calc-inputs">
        <Slider label="Revenue per epoch" value={revenue} min={1} max={40} step={1} unit="SOL" onChange={setRevenue} />
        <Slider label="Bond posted" value={bond} min={1} max={40} step={1} unit="SOL" onChange={setBond} />
        <div className="lx-toggle" role="group" aria-label="Revenue hedge">
          <button type="button" aria-pressed={!hedged} onClick={() => setHedged(false)}>
            Unhedged · {RATE_UNHEDGED}%
          </button>
          <button type="button" aria-pressed={hedged} onClick={() => setHedged(true)}>
            Hedged · {RATE_HEDGED}%
          </button>
        </div>
      </div>
      <div className="lx-calc-out">
        <div className="lx-calc-limit">
          <span>Credit limit</span>
          <strong className="num">
            <NumberFlow value={Number(r.limit.toFixed(1))} format={{ maximumFractionDigits: 1 }} />
            <small>SOL</small>
          </strong>
          <p>
            Set by {r.bound === 'revenue' ? `${hedged ? RATE_HEDGED : RATE_UNHEDGED}% of ${WINDOW} epochs of revenue` : `${BOND_MULT}× the bond`}
            , whichever is lower.
          </p>
        </div>
        <dl className="lx-calc-figs">
          <div>
            <dt>Repays, with {Math.round(FEE * 100)}% fee</dt>
            <dd className="num">{r.owes.toFixed(1)} SOL</dd>
          </div>
          <div>
            <dt>Swept each epoch</dt>
            <dd className="num">{r.perEpoch.toFixed(1)} SOL</dd>
          </div>
          <div>
            <dt>Paid off in</dt>
            <dd className="num">
              {Number.isFinite(r.epochs) ? r.epochs : '—'} epochs
              <small>≈ {Number.isFinite(r.epochs) ? Math.round((r.epochs * 32.2) / 24) : '—'} days</small>
            </dd>
          </div>
        </dl>
        <div className="lx-calc-chart-wrap" aria-hidden="true">
          <div className="lx-calc-chart">
          {Array.from({ length: MAX_EPOCHS }, (_, i) => (
            <i key={i} data-on={r.bars[i] ? 'true' : undefined} style={{ height: r.bars[i] ? `${(r.bars[i] / (r.perEpoch || 1)) * 100}%` : '100%' }} />
          ))}
          </div>
          <div className="lx-calc-axis num">
            <span>Epoch 1</span>
            <span>Default after {MAX_EPOCHS} open epochs</span>
          </div>
        </div>
        <p className="lx-note">
          Illustration from the program’s current parameters. Real limits also need an Epoch Score of 60+ and sit under the
          vault cap. The operator keeps {Math.round((1 - REMIT) * 100)}% of every epoch’s revenue.
        </p>
      </div>
    </div>
  );
}
