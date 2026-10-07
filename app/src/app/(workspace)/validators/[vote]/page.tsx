'use client';
import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { Copy, ArrowUpRight, ChevronLeft, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useValidator } from '@/lib/data/resources';
import { useValidators } from '@/lib/data/useValidators';
import { useNetwork } from '@/lib/data/useNetwork';
import { Panel, Metric, Source, QueryState, fmt, compact, signed } from '@/components/epoch/shared';
import { EpochChart } from '@/components/epoch/epoch-chart';
import { ConnectWallet } from '@/components/epoch/connect-wallet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { apiConfigured } from '@/lib/data/client';
export default function Validator({ params }: { params: Promise<{ vote: string }> }) {
  const { vote } = use(params);
  const query = useValidator(vote),
    all = useValidators(),
    network = useNetwork();
  const [range, setRange] = useState(32);
  const [scoreOpen, setScoreOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const p = query.data,
    r = all.data?.rows.find((v) => v.vote === vote);
  const points = useMemo(
    () => p?.stakeByEpoch.slice(-range).map(([epoch, value]) => ({ epoch, value })) ?? [],
    [p, range],
  );
  if (!p && !r)
    return (
      <QueryState
        pending={query.isPending || all.isPending}
        error={query.error || new Error('This validator is not in the available snapshot.')}
        retry={query.refetch}
      />
    );
  const name = p?.name ?? r!.name,
    stake = p?.tiles.activeStakeSol ?? r!.stakeSol,
    apy = p?.tiles.apyPct ?? r?.apyPct,
    score = p?.gauges.epochScore ?? r!.epochScore;
  const details = [
    ['Epoch Score', `${score}/100`],
    ['Staking APY', `${fmt(p?.tiles.stakingApyPct ?? r?.stakingApyPct, 2)}%`],
    ['MEV tips APY', `${fmt(p?.tiles.tipsApyPct ?? r?.tipsApyPct, 2)}%`],
    ['Commission', `${fmt(p?.commission.inflationPct ?? r?.commissionPct)}%`],
    ['MEV commission', `${fmt(p?.commission.jitoTipsPct ?? r?.mevCommissionPct)}%`],
    ['Delegator wallets', fmt(p?.tiles.delegators ?? r?.delegators)],
    ['Blocks / day', fmt(p?.tiles.blocksPerDay ?? r?.blocksPerDay)],
    ['Uptime', `${fmt(p?.gauges.uptime30dPct ?? r?.uptimePct, 2)}%`],
  ];
  return (
    <>
      <Link
        href="/validators"
        className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-primary"
      >
        <ChevronLeft className="size-4" />
        All validators
      </Link>
      <div className="grid items-start gap-8 xl:grid-cols-3">
        <div className="min-w-0 space-y-8 xl:col-span-2">
          <div>
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-xl border border-ep-accent-line bg-ep-accent-soft text-primary">
                {name.slice(0, 2)}
              </div>
              <div className="min-w-0">
                <h1 className="text-2xl font-medium tracking-tight">{name}</h1>
                <div className="mt-2 flex items-center gap-3">
                  <span className="num text-xs text-muted-foreground">
                    {vote.slice(0, 6)}…{vote.slice(-5)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Copy vote account"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(vote);
                        toast.success('Vote account copied');
                      } catch {
                        toast.error('Could not copy the address');
                      }
                    }}
                  >
                    <Copy className="size-3" />
                  </Button>
                  <a
                    className="text-xs text-primary"
                    href={`https://orbmarkets.io/address/${vote}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Orb ↗
                  </a>
                </div>
              </div>
            </div>
            <Source data={p ?? all.data} />
            <p className="mt-8 text-sm text-muted-foreground">Active stake</p>
            <p className="num mt-3 text-4xl tracking-tight lg:text-5xl">
              {fmt(stake)} <span className="text-lg text-muted-foreground">SOL</span>
            </p>
            {p && (
              <p
                className={`num mt-3 text-sm ${p.tiles.stakeChangeThisEpochSol >= 0 ? 'text-primary' : 'text-ep-warn'}`}
              >
                {signed(p.tiles.stakeChangeThisEpochSol)} SOL this epoch
              </p>
            )}
          </div>
          {p ? (
            <>
              <EpochChart points={points} height={290} />
              <p className="num text-xs text-muted-foreground">
                {p.stakeByEpoch.length} epochs available in this source.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {[8, 16, 32, 64].map((n) => (
                  <Button
                    key={n}
                    className="num"
                    variant={range === n ? 'secondary' : 'ghost'}
                    onClick={() => setRange(n)}
                    aria-pressed={range === n}
                  >
                    {n} epochs
                  </Button>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-xl border border-border p-8 text-sm leading-relaxed text-muted-foreground">
              {apiConfigured
                ? 'Detailed history could not be loaded. The list summary remains available.'
                : 'This snapshot contains summary data for this validator. Detailed history is available for NTT DOCOMO GLOBAL; other histories need the connected API.'}
              {query.isError && apiConfigured && (
                <Button className="mt-4" variant="outline" onClick={() => query.refetch()}>
                  Retry details
                </Button>
              )}
            </div>
          )}
          <Panel title="What the Epoch Score tells you" aside={<ShieldCheck className="size-5 text-primary" />}>
            <div className="flex items-center justify-between gap-4">
              <p className="max-w-md text-sm text-muted-foreground">
                Vote performance, commission and tenure, combined into one health signal. It’s a starting point for
                research.
              </p>
              <Button variant="outline" onClick={() => setScoreOpen(true)}>
                See score
              </Button>
            </div>
          </Panel>
          <section>
            <h2 className="mb-6 text-lg">Validator details</h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4">
              {details.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="num mt-3 text-sm">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          {p && (
            <>
              <section className="border-t border-border pt-8">
                <h2 className="mb-6 text-lg">
                  Revenue <span className="num text-sm text-muted-foreground">· E{p.revenueEpoch}</span>
                </h2>
                <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
                  <Metric
                    label="Inflation commission"
                    value={`${fmt(p.revenueLastEpochSol.inflationCommission, 2)}`}
                    detail="SOL / epoch"
                  />
                  <Metric
                    label="MEV commission"
                    value={fmt(p.revenueLastEpochSol.tipsCommission, 2)}
                    detail="SOL / epoch"
                  />
                  <Metric
                    label="Block fees estimate"
                    value={fmt(p.revenueLastEpochSol.blockFeesEstimate, 2)}
                    detail="SOL / epoch"
                  />
                  <Metric label="Vote fees" value={fmt(p.revenueLastEpochSol.voteFees, 2)} detail="SOL / epoch" />
                  <Metric
                    label="Net estimate"
                    value={fmt(p.revenueLastEpochSol.netEstimate, 2)}
                    detail="SOL after vote fees"
                    tone="text-primary"
                  />
                </div>
              </section>
              <section className="border-t border-border pt-8">
                <h2 className="mb-6 text-lg">Who delegates here</h2>
                <div className="space-y-5">
                  {p.delegatorSplit.map((s) => (
                    <div key={s.source}>
                      <div className="mb-2 flex justify-between text-sm">
                        <span>{s.source}</span>
                        <span className="num text-muted-foreground">
                          {fmt(s.pct, 1)}% · {compact(s.sol)} SOL
                        </span>
                      </div>
                      <Progress value={s.pct} aria-label={`${s.source} share`} />
                    </div>
                  ))}
                </div>
              </section>
              <section className="border-t border-border pt-8">
                <div className="mb-5 flex items-center justify-between">
                  <h2 className="text-lg">Recent stake moves</h2>
                  <a
                    className="text-xs text-primary"
                    href={`https://orbmarkets.io/address/${vote}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on Orb ↗
                  </a>
                </div>
                {p.stakeMoves.map((m, i) => (
                  <a
                    key={`${m.stakeAccount}-${i}`}
                    href={m.orb}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between gap-4 border-b border-border py-5 hover:bg-card"
                  >
                    <div>
                      <p className="text-sm">{m.from}</p>
                      <p className="num mt-2 text-xs text-muted-foreground">
                        Epoch {m.epoch} · {m.stakeAccountShort}
                      </p>
                    </div>
                    <span className={`num text-sm ${m.direction === 'in' ? 'text-primary' : 'text-ep-warn'}`}>
                      {m.direction === 'in' ? '+' : '−'}
                      {fmt(m.sol, 2)} SOL
                    </span>
                  </a>
                ))}
              </section>
            </>
          )}
        </div>
        <aside className="space-y-4 xl:sticky xl:top-24">
          <Panel title="Estimate staking rewards">
            <p className="text-sm text-muted-foreground">Historical APY</p>
            <p className="num mt-3 text-4xl text-primary">
              {fmt(apy, 2)}
              <span className="text-xl">%</span>
            </p>
            <label htmlFor="stake-amount" className="mb-3 mt-8 block text-sm">
              Amount · SOL
            </label>
            <Input
              id="stake-amount"
              className="num h-14 text-lg"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
            <div className="my-3 flex gap-2">
              {[1, 10, 25, 100].map((n) => (
                <Button key={n} className="num flex-1" variant="outline" onClick={() => setAmount(String(n))}>
                  {n}
                </Button>
              ))}
            </div>
            <div className="my-6 flex justify-between border-y border-border py-4 text-xs">
              <span className="text-muted-foreground">Estimated yearly rewards</span>
              <span className="num">
                {apy != null && Number(amount) > 0 ? fmt((Number(amount) * apy) / 100, 4) : '—'} SOL
              </span>
            </div>
            <ConnectWallet className="w-full" />
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              Rewards vary. Connecting a wallet does not move your SOL. Stake transaction controls are not available in
              this preview.
            </p>
          </Panel>
          {p && (
            <Panel title="Revenue-backed credit">
              <Metric label="Unhedged estimate" value={`${fmt(p.creditEstimate.limitUnhedgedSol, 2)} SOL`} />
              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">{p.creditEstimate.note}</p>
            </Panel>
          )}
        </aside>
      </div>
      <Dialog open={scoreOpen} onOpenChange={setScoreOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Epoch Score</DialogTitle>
            <DialogDescription>A health signal, not an investment recommendation.</DialogDescription>
          </DialogHeader>
          <p className="num text-5xl text-primary">
            {score}
            <span className="text-xl text-muted-foreground"> / 100</span>
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Vote credits contribute up to 60 points, commission up to 25, and tenure up to 15. Offline validators score
            zero. Top-18 validators are capped at 50 to reflect network concentration. Commission considers the higher
            of inflation and MEV fees.
          </p>
          <Button onClick={() => setScoreOpen(false)}>Got it</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
