'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowDownLeft, ArrowUpRight, Download, Info, ShieldCheck, Activity, ArrowRight } from 'lucide-react';
import { useQueryState, parseAsString } from 'nuqs';
import { useNetwork } from '@/lib/data/useNetwork';
import { useValidators } from '@/lib/data/useValidators';
import { useStakeHistory, useVault, useFeeIndex, useActivity, useBiggestDelegators } from '@/lib/data/resources';
import { EpochChart } from '@/components/epoch/epoch-chart';
import { NetworkHero } from '@/components/epoch/network-hero';
import {
  Panel,
  PageHeading,
  Metric,
  Source,
  QueryState,
  Jump,
  fmt,
  compact,
  signed,
  downloadCsv,
} from '@/components/epoch/shared';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

export default function Terminal() {
  const network = useNetwork(),
    history = useStakeHistory(),
    validators = useValidators(),
    vault = useVault(),
    fees = useFeeIndex(),
    activity = useActivity(),
    delegators = useBiggestDelegators();
  const [mode, setMode] = useQueryState('flow', parseAsString.withDefault('overview'));
  const [range, setRange] = useQueryState('range', parseAsString.withDefault('32'));
  const [table, setTable] = useQueryState('table', parseAsString.withDefault('validators'));
  const [audience, setAudience] = useState('stakers');
  const [explainer, setExplainer] = useState(false);
  const n = network.data,
    v = vault.data;
  const rows = useMemo(() => {
    if (!history.data) return [];
    const all = [...history.data.rows];
    if (n && !all.some((r) => r.epoch === n.epoch.number))
      all.push({
        epoch: n.epoch.number,
        totalActiveSol: n.stake.totalSol,
        activatingSol: n.stake.activatingThisEpochSol,
        deactivatingSol: n.stake.deactivatingThisEpochSol,
      });
    return all.slice(-Number(range));
  }, [history.data, n, range]);
  const points = useMemo(
    () =>
      rows.map((r) => ({
        epoch: r.epoch,
        value: mode === 'arriving' ? r.activatingSol : mode === 'leaving' ? r.deactivatingSol : r.totalActiveSol,
        inflow: r.activatingSol,
        outflow: r.deactivatingSol,
      })),
    [rows, mode],
  );
  const feePoints = useMemo(
    () =>
      fees.data?.points
        .filter((p) => p.status !== 'vetoed')
        .map((p) => ({ epoch: p.epoch, value: p.value, status: p.status })) ?? [],
    [fees.data],
  );
  if (!n) return <QueryState pending={network.isPending} error={network.error} retry={network.refetch} />;
  const net = n.stake.activatingThisEpochSol - n.stake.deactivatingThisEpochSol;
  const final = fees.data?.points.filter((p) => p.status === 'final').sort((a, b) => b.epoch - a.epoch)[0];
  const statTitle = `${n.source} · ${n.asOf}`;
  return (
    <>
      <NetworkHero n={n} />
      <div className="nh-strip">
        <Metric label="Fee Index" value={fmt(final?.value)} detail={<span>µL/CU · {fees.data?.kind === 'sample' ? 'Sample' : 'Final'} · E{final?.epoch ?? '—'}</span>} />
        <Metric label="Vault · SOL" value={compact(v?.pool.tvlSol)} detail={<Source data={v} />} />
        <Metric
          label="Open advances"
          value={v ? fmt(v.advances.filter((a) => ['active', 'late'].includes(a.status)).length) : '—'}
          detail={v ? `${fmt(v.pool.outstandingPrincipalSol, 2)} SOL lent · ${v.kind === 'sample' ? 'Sample' : 'API'}` : 'Loading'}
        />
        <Metric
          title={statTitle}
          label="Delegators"
          value={compact(n.delegators?.wallets)}
          detail={`${compact(n.delegators?.stakeAccounts)} stake accounts · median ${fmt(n.delegators?.medianWalletSol)} SOL`}
        />
        <div className="nh-actions">
          <Source data={n} />
          <Button
            variant="outline"
            onClick={() =>
              downloadCsv(
                'stake-history',
                ['Epoch', 'Active SOL', 'Arriving SOL', 'Leaving SOL'],
                rows.map((r) => [r.epoch, r.totalActiveSol, r.activatingSol, r.deactivatingSol]),
              )
            }
          >
            <Download />
            Export
          </Button>
        </div>
      </div>
      <section aria-labelledby="stake-flow-heading" className="workspace-panel min-w-0 rounded-2xl border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Tabs value={mode} onValueChange={(v) => setMode(String(v))}>
            <TabsList className="h-11 bg-card p-1">
              <TabsTrigger className="px-5" value="overview">
                Overview
              </TabsTrigger>
              <TabsTrigger className="px-5" value="arriving">
                Arriving
              </TabsTrigger>
              <TabsTrigger className="px-5" value="leaving">
                Leaving
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex gap-1" aria-label="Chart range">
            {['32', '64'].map((r) => (
              <Button
                key={r}
                variant={range === r ? 'secondary' : 'ghost'}
                aria-pressed={range === r}
                onClick={() => setRange(r)}
                className="num text-xs"
              >
                {r} epochs
              </Button>
            ))}
          </div>
        </div>
        <div className="my-8 grid gap-6 md:grid-cols-3">
          <div>
            <h2 id="stake-flow-heading" className="text-sm text-muted-foreground">
              {mode === 'overview' ? 'Net stake flow' : mode === 'arriving' ? 'Stake arriving' : 'Stake leaving'}{' '}
              <span className="num">· E{n.epoch.number}</span>
            </h2>
            <p
              className={`num mt-3 text-4xl tracking-tight lg:text-5xl ${mode === 'leaving' || (mode === 'overview' && net < 0) ? 'text-ep-warn' : 'text-primary'}`}
            >
              {mode === 'overview'
                ? signed(net)
                : compact(mode === 'arriving' ? n.stake.activatingThisEpochSol : n.stake.deactivatingThisEpochSol)}{' '}
              <span className="text-lg text-muted-foreground">SOL</span>
            </p>
          </div>
          <div className="flex items-center gap-4 md:justify-center">
            <span className="rounded-full bg-ep-accent-soft p-3 text-primary">
              <ArrowDownLeft className="size-5" />
            </span>
            <div>
              <p className="text-xs text-muted-foreground">Arriving this epoch</p>
              <p className="num mt-2 text-xl">
                +{compact(n.stake.activatingThisEpochSol)} <span className="text-xs text-muted-foreground">SOL</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4 md:justify-center">
            <span className="rounded-full bg-ep-warn-soft p-3 text-ep-warn">
              <ArrowUpRight className="size-5" />
            </span>
            <div>
              <p className="text-xs text-muted-foreground">Leaving this epoch</p>
              <p className="num mt-2 text-xl">
                −{compact(n.stake.deactivatingThisEpochSol)} <span className="text-xs text-muted-foreground">SOL</span>
              </p>
            </div>
          </div>
        </div>
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>{mode === 'overview' ? 'Total active stake · net flow bars' : 'Stake flow per epoch'}</span>
          <span className="num">SOL</span>
        </div>
        {history.isError ? (
          <QueryState pending={false} error={history.error} retry={history.refetch} />
        ) : (
          <EpochChart points={points} height={350} flow={mode === 'overview'} bars={mode !== 'overview'} />
        )}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-primary" />
            {mode === 'overview' ? 'Total active stake' : mode === 'arriving' ? 'Arriving SOL' : 'Leaving SOL'}{' '}
            {mode === 'overview' && (
              <>
                <span className="ml-4 size-2 rounded-full bg-ep-warn" />
                Negative net flow
              </>
            )}
          </span>
          <span className="num">
            Epochs {rows[0]?.epoch}–{rows.at(-1)?.epoch} · <Source data={history.data} />
          </span>
        </div>
      </section>
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Stake movement" aside={<ArrowUpRight className="size-4 text-muted-foreground" />}>
          <p className="text-lg leading-snug">
            {net < 0 ? 'More SOL is leaving than arriving.' : 'More SOL is arriving than leaving.'}
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            The difference is <span className="num">{compact(Math.abs(net))} SOL</span> in the captured epoch.
            Individual validators tell a more detailed story.
          </p>
          <Jump href="/validators">Explore validators</Jump>
        </Panel>
        <Panel title="Validator economics" aside={<Activity className="size-4 text-muted-foreground" />}>
          <p className="text-lg leading-snug">
            <span className="num">{n.validators.belowBreakEven}</span> validators are below break-even.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Estimated revenue doesn’t cover voting costs. Check health alongside APY before choosing where to stake.
          </p>
          <Jump href="/validators?chips=below">See the watchlist</Jump>
        </Panel>
        <Panel title="Network concentration" aside={<ShieldCheck className="size-4 text-muted-foreground" />}>
          <p className="text-lg leading-snug">
            <span className="num">{n.validators.superminorityCount}</span> validators hold a third of stake.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Explore smaller, healthy operators to understand how your delegation can support the network.
          </p>
          <Jump href="/validators?chips=hide-top18&tab=healthy">Find healthy operators</Jump>
        </Panel>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 pt-4">
        <h2 className="text-lg">Your next move</h2>
        <Tabs value={audience} onValueChange={(v) => setAudience(String(v))}>
          <TabsList className="h-11">
            <TabsTrigger className="px-4" value="stakers">
              For stakers
            </TabsTrigger>
            <TabsTrigger className="px-4" value="validators">
              For validators
            </TabsTrigger>
            <TabsTrigger className="px-4" value="lenders">
              For lenders
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <Panel
        title={
          audience === 'stakers'
            ? 'Is your SOL in good hands?'
            : audience === 'validators'
              ? 'Put your future revenue to work.'
              : 'Understand the source of your yield.'
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-2xl text-muted-foreground">
            {audience === 'stakers'
              ? 'Inspect your stake accounts, compare validator health, and see where your rewards come from.'
              : audience === 'validators'
                ? 'Review your revenue and potential credit limit. Advances are repaid from collected validator revenue.'
                : 'Lenders fund validator advances. Senior is paid first; Junior takes first loss after the borrower’s bond. Vault SOL is not staked.'}
          </p>
          <Jump href={audience === 'stakers' ? '/me' : audience === 'validators' ? '/validators' : '/vault'}>
            Take a closer look
          </Jump>
        </div>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="Solana Fee Index"
          aside={
            <div className="flex items-center gap-2">
              <Source data={fees.data} />
              <Button
                size="icon"
                variant="ghost"
                aria-label="What is the Fee Index?"
                onClick={() => setExplainer(true)}
              >
                <Info />
              </Button>
            </div>
          }
        >
          <p className="num text-3xl">
            {fmt(final?.value)} <span className="text-xs text-muted-foreground">µL/CU · latest final</span>
          </p>
          <EpochChart points={feePoints} bars height={180} unit="µL/CU" />
          <p className="mt-3 text-xs text-muted-foreground">
            Teal: final · Ink blue: proposed, still in its dispute window
          </p>
        </Panel>
        <Panel title="Protocol activity" aside={<Source data={activity.data} />}>
          {activity.data?.events.length ? (
            <div className="divide-y divide-border">
              {activity.data.events
                .filter((e) => e.kind !== 'predict')
                .slice(0, 5)
                .map((e) => (
                  <div key={e.id} className="flex items-center gap-3 py-4">
                    <div className="rounded-full bg-muted p-2 text-primary">
                      <ArrowRight className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm" title={e.text}>
                        {e.text}
                      </p>
                      <p className="mt-1 text-xs capitalize text-muted-foreground">{e.kind}</p>
                    </div>
                    <span className="num text-xs">
                      {fmt(e.amountSol ?? e.value, 2)} {e.unit}
                    </span>
                  </div>
                ))}
            </div>
          ) : (
            <p className="py-10 text-muted-foreground">
              {activity.isError ? 'Activity is unavailable.' : 'Waiting for the next event.'}
            </p>
          )}
        </Panel>
      </div>
      <section className="mt-4 min-w-0">
        <Tabs value={table} onValueChange={(v) => setTable(String(v))}>
          <TabsList variant="line" className="mb-4 h-12 max-w-full overflow-x-auto justify-start">
            <TabsTrigger className="px-4" value="validators">
              Top validators
            </TabsTrigger>
            <TabsTrigger className="px-4" value="epochs">
              Epoch history
            </TabsTrigger>
            <TabsTrigger className="px-4" value="loans">
              Loan book · Sample
            </TabsTrigger>
            <TabsTrigger className="px-4" value="delegators">
              Biggest delegators
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Table>
          <TableHeader>
            <TableRow>
              {(table === 'validators'
                ? ['Validator', 'Active stake', 'APY', 'Epoch Score']
                : table === 'epochs'
                  ? ['Epoch', 'Active stake', 'Arriving', 'Leaving']
                  : table === 'loans'
                    ? ['Validator', 'Borrowed', 'Repaid', 'Status']
                    : ['Delegator', 'Stake', 'Validators', 'Type']
              ).map((t) => (
                <TableHead key={t} className="label-caps py-4">
                  {t}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {table === 'validators' &&
              validators.data?.rows.slice(0, 8).map((r, i) => (
                <TableRow key={r.vote}>
                  <TableCell className="py-5">
                    <Link href={`/validators/${r.vote}`} className="flex items-center gap-4 hover:text-primary">
                      <span className="num text-xs text-muted-foreground">{String(i + 1).padStart(2, '0')}</span>
                      <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-card text-xs">
                        {r.name.slice(0, 2).toUpperCase()}
                      </span>
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell className="num">{compact(r.stakeSol)} SOL</TableCell>
                  <TableCell className="num">{fmt(r.apyPct, 2)}%</TableCell>
                  <TableCell className="num text-primary">{r.epochScore} / 100</TableCell>
                </TableRow>
              ))}
            {table === 'epochs' &&
              [...rows]
                .reverse()
                .slice(0, 8)
                .map((r) => (
                  <TableRow key={r.epoch}>
                    <TableCell className="num py-5">{r.epoch}</TableCell>
                    <TableCell className="num">{compact(r.totalActiveSol)} SOL</TableCell>
                    <TableCell className="num text-primary">+{compact(r.activatingSol)} SOL</TableCell>
                    <TableCell className="num text-ep-warn">−{compact(r.deactivatingSol)} SOL</TableCell>
                  </TableRow>
                ))}
            {table === 'loans' &&
              v?.advances.map((r) => (
                <TableRow key={r.validator}>
                  <TableCell className="py-5">{r.validator}</TableCell>
                  <TableCell className="num">{fmt(r.borrowedSol, 2)} SOL</TableCell>
                  <TableCell className="num">{fmt(r.repaidSol, 2)} SOL</TableCell>
                  <TableCell className={r.status === 'late' ? 'text-ep-warn' : 'text-primary'}>{r.status}</TableCell>
                </TableRow>
              ))}
            {table === 'delegators' &&
              delegators.data?.rows.map((r) => (
                <TableRow key={r.name}>
                  <TableCell className="py-5">{r.name}</TableCell>
                  <TableCell className="num">{compact(r.stakeSol)} SOL</TableCell>
                  <TableCell className="num">{r.validators}</TableCell>
                  <TableCell>{r.kind}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </section>
      <p className="mt-4 border-t border-border pt-5 text-xs text-muted-foreground">
        Network figures are sourced snapshots until the API is configured. Sample protocol figures are illustrations,
        not deposits or returns.
      </p>
      <Dialog open={explainer} onOpenChange={setExplainer}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>What is the Solana Fee Index?</DialogTitle>
            <DialogDescription>
              The stake-weighted median priority fee, measured in microlamports per compute unit. It helps validators
              and lenders understand the cost of blockspace.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            A proposed value is still in its dispute window. Only a final value is used for settled results. Vetoed
            proposals are excluded.
          </p>
          <Button onClick={() => setExplainer(false)}>Got it</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
