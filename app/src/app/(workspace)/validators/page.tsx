'use client';
import { useMemo, useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { Star, Search, Download, ArrowDown, X, SlidersHorizontal } from 'lucide-react';
import { useQueryState, parseAsString } from 'nuqs';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useValidators } from '@/lib/data/useValidators';
import { useNetwork } from '@/lib/data/useNetwork';
import type { ValidatorRow } from '@/lib/data/contracts/Api.types';
import { StakeMap } from '@/components/epoch/stake-map';
import { PageHeading, OperatorLogo, Source, QueryState, compact, fmt, downloadCsv } from '@/components/epoch/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

const features = tableFeatures({});
const COUNTRY: Record<string, string> = {
  Germany: 'DE', 'United States': 'US', 'United Kingdom': 'GB', Netherlands: 'NL', France: 'FR', Romania: 'RO',
  Czechia: 'CZ', Japan: 'JP', Singapore: 'SG', Switzerland: 'CH', Canada: 'CA', Ireland: 'IE', Finland: 'FI',
  Lithuania: 'LT', Poland: 'PL', 'South Korea': 'KR', Ukraine: 'UA', Austria: 'AT', Sweden: 'SE',
};
const cc = (c: string) => COUNTRY[c] ?? c.slice(0, 2).toUpperCase();
function ScoreRing({ value }: { value: number }) {
  const r = 8,
    c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" className="vt-ring" data-full={value >= 90 || undefined}>
      <circle cx="10" cy="10" r={r} />
      <circle cx="10" cy="10" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - value / 100)} transform="rotate(-90 10 10)" />
    </svg>
  );
}
const helper = createColumnHelper<typeof features, ValidatorRow>();
const chipOptions = [
  ['below', 'Below break-even'],
  ['dep', 'One delegator > 50%'],
  ['hide-top18', 'Hide top-18'],
  ['firedancer', 'Firedancer'],
  ['zero-fee', '0% commission'],
];
export default function Validators() {
  const query = useValidators(),
    network = useNetwork();
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('all'));
  const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
  const [chips, setChips] = useQueryState('chips', parseAsString.withDefault(''));
  const [sort, setSort] = useQueryState('sort', parseAsString.withDefault('stake'));
  const [direction, setDirection] = useQueryState('dir', parseAsString.withDefault('desc'));
  const [country, setCountry] = useQueryState('country', parseAsString.withDefault(''));
  const [client, setClient] = useQueryState('client', parseAsString.withDefault(''));
  const [watch, setWatch] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [compare, setCompare] = useState(false);
  const [filters, setFilters] = useState(false);
  useEffect(() => {
    try {
      const data = JSON.parse(localStorage.getItem('epoch.watchlist') || '[]');
      if (Array.isArray(data)) setWatch(data.filter((v) => typeof v === 'string'));
    } catch {}
  }, []);
  function star(vote: string) {
    setWatch((old) => {
      const next = old.includes(vote) ? old.filter((v) => v !== vote) : [...old, vote].slice(0, 200);
      try {
        localStorage.setItem('epoch.watchlist', JSON.stringify(next));
      } catch {}
      return next;
    });
  }
  function check(vote: string) {
    setSelected((old) => (old.includes(vote) ? old.filter((v) => v !== vote) : old.length < 3 ? [...old, vote] : old));
  }
  function chooseSort(key: string) {
    if (sort === key) setDirection(direction === 'desc' ? 'asc' : 'desc');
    else {
      setSort(key);
      setDirection('desc');
    }
  }
  const filtered = useMemo(() => {
    const active = chips.split(',');
    const key: keyof ValidatorRow =
      (
        {
          stake: 'stakeSol',
          apy: 'apyPct',
          score: 'epochScore',
          dels: 'delegators',
          fee: 'commissionPct',
          kept: 'healthPerEpochSol',
        } as Record<string, keyof ValidatorRow>
      )[sort] || 'stakeSol';
    return (query.data?.rows || [])
      .filter(
        (r) =>
          (tab === 'all' || (tab === 'watchlist' && watch.includes(r.vote)) || tab === r.health) &&
          `${r.name} ${r.vote}`.toLowerCase().includes(search.toLowerCase()) &&
          (!country || r.country === country) &&
          (!client || r.client === client) &&
          (!active.includes('below') || r.healthPerEpochSol < 0) &&
          (!active.includes('dep') || (r.biggestDelegatorSharePct ?? 0) > 50) &&
          (!active.includes('hide-top18') || !r.top18) &&
          (!active.includes('firedancer') || r.client === 'Firedancer') &&
          (!active.includes('zero-fee') || r.commissionPct === 0),
      )
      .sort((a, b) => {
        const av = a[key],
          bv = b[key];
        if (av == null) return 1;
        if (bv == null) return -1;
        return (Number(av) - Number(bv)) * (direction === 'asc' ? 1 : -1);
      });
  }, [query.data, tab, search, chips, sort, direction, country, client, watch]);
  const SortHead = ({ label, k }: { label: string; k: string }) => (
    <Button variant="ghost" className="label-caps -mr-2 h-8 px-2" onClick={() => chooseSort(k)}>
      {label}
      {sort === k && <ArrowDown className={`size-3 ${direction === 'asc' ? 'rotate-180' : ''}`} />}
    </Button>
  );
  const columns = useMemo(
    () =>
      helper.columns([
        helper.display({
          id: 'compare',
          header: () => <span className="sr-only">Compare</span>,
          cell: ({ row }) => (
            <Checkbox
              aria-label={`Compare ${row.original.name}`}
              checked={selected.includes(row.original.vote)}
              disabled={selected.length >= 3 && !selected.includes(row.original.vote)}
              onCheckedChange={() => check(row.original.vote)}
            />
          ),
        }),
        helper.display({
          id: 'name',
          header: 'Validator',
          cell: ({ row }) => {
            const r = row.original;
            return (
              <Link href={`/validators/${r.vote}`} className="vt-op">
                <OperatorLogo name={r.name} vote={r.vote} size={36} />
                <span className="vt-op-text">
                  <strong title={r.name}>{r.name || 'Unnamed'}</strong>
                  <span className="vt-op-meta">
                    <span className="num">{r.voteShort}</span>
                    <span className="vt-pill" data-client={r.client}>
                      {r.client}
                    </span>
                    <span className="num">{cc(r.country)}</span>
                    {r.top18 && <span className="vt-pill" data-tone="warn">Top-18</span>}
                  </span>
                </span>
              </Link>
            );
          },
        }),
        helper.accessor('epochScore', {
          header: () => <SortHead label="Epoch score" k="score" />,
          cell: (i) => (
            <span className="vt-score">
              <ScoreRing value={i.getValue()} />
              <span className="num">{i.getValue()}</span>
            </span>
          ),
        }),
        helper.accessor('apyPct', {
          header: () => <SortHead label="APY" k="apy" />,
          cell: ({ row: { original: r } }) => (
            <span className="vt-stack">
              <span className="num">{fmt(r.apyPct, 2)}%</span>
              <small className="num">
                {fmt(r.stakingApyPct, 2)} + {fmt(r.tipsApyPct, 2)}
              </small>
            </span>
          ),
        }),
        helper.accessor('commissionPct', {
          header: () => <SortHead label="Fee" k="fee" />,
          cell: (i) => (
            <span className="num" data-tone={i.getValue() === 0 ? 'accent' : i.getValue() >= 10 ? 'warn' : undefined}>
              {fmt(i.getValue())}%
            </span>
          ),
        }),
        helper.accessor('stakeSol', {
          header: () => <SortHead label="Stake (SOL)" k="stake" />,
          cell: (i) => <span className="num">{fmt(i.getValue())}</span>,
        }),
        helper.accessor('delegators', {
          header: () => <SortHead label="Delegators" k="dels" />,
          cell: (i) => <span className="num">{fmt(i.getValue())}</span>,
        }),
        helper.accessor('biggestDelegatorSharePct', {
          header: () => <span className="label-caps">Biggest share</span>,
          cell: (i) => {
            const v = i.getValue() ?? 0;
            return (
              <span className="vt-share" data-tone={v > 50 ? 'warn' : undefined}>
                <i>
                  <u style={{ width: `${Math.min(v, 100)}%` }} />
                </i>
                <span className="num">{fmt(v)}%</span>
              </span>
            );
          },
        }),
        helper.accessor('blocksPerDay', {
          header: () => <span className="label-caps">Blocks / day</span>,
          cell: (i) => <span className="num">{fmt(i.getValue())}</span>,
        }),
        helper.accessor('healthPerEpochSol', {
          header: () => <SortHead label="Health / epoch" k="kept" />,
          cell: (i) => {
            const v = i.getValue() ?? 0;
            return (
              <span className="num" data-tone={v < 0 ? 'warn' : 'accent'}>
                {v < 0 ? '−' : '+'}
                {fmt(Math.abs(v), 2)} SOL
              </span>
            );
          },
        }),
        helper.accessor('uptimePct', {
          header: () => <span className="label-caps">Uptime</span>,
          cell: (i) => (
            <span className="num" data-tone={(i.getValue() ?? 100) < 99 ? 'warn' : undefined}>
              {fmt(i.getValue(), (i.getValue() ?? 100) % 1 ? 2 : 0)}%
            </span>
          ),
        }),
        helper.display({
          id: 'watch',
          header: () => <span className="sr-only">Watch</span>,
          cell: ({ row }) => (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${watch.includes(row.original.vote) ? 'Unwatch' : 'Watch'} ${row.original.name}`}
              aria-pressed={watch.includes(row.original.vote)}
              onClick={() => star(row.original.vote)}
            >
              <Star
                className={watch.includes(row.original.vote) ? 'fill-primary text-primary' : 'text-muted-foreground'}
              />
            </Button>
          ),
        }),
      ]),
    [watch, selected, sort, direction],
  );
  const table = useTable({ data: filtered, columns, features });
  const rows = table.getRowModel().rows;
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 72,
    overscan: 8,
  });
  const items =
    rows.length > 50
      ? virtual.getVirtualItems()
      : rows.map((r, i) => ({ index: i, key: r.id, start: i * 72, size: 72, end: (i + 1) * 72 }));
  if (!query.data) return <QueryState pending={query.isPending} error={query.error} retry={query.refetch} />;
  const chosen = query.data.rows.filter((r) => selected.includes(r.vote));
  return (
    <>
      <PageHeading
        title="Validators"
        large
        eyebrow="Network · operators"
        description="Look past the yield. Compare health, fees kept after vote costs and who the stake depends on."
        stats={[
          { label: 'Network validators', value: fmt(network.data?.validators.total), detail: `${network.data?.validators.delinquent ?? '—'} delinquent` },
          { label: 'Superminority', value: fmt(network.data?.validators.superminorityCount), detail: 'hold ⅓ of all stake' },
          { label: 'Under break-even', value: fmt(network.data?.validators.belowBreakEven), detail: 'revenue below vote fees', tone: 'warn' },
          { label: 'Rely on one delegator', value: fmt(network.data?.validators.dependOnOneDelegator), detail: 'over half their stake', tone: 'warn' },
          { label: 'Median APY', value: `${fmt(network.data?.stake.medianApyPct, 2)}%`, detail: `Firedancer ${fmt(network.data?.clients.firedancerPct, 1)}% of stake`, tone: 'accent' },
        ]}
      >
        <Source data={query.data} />
        <Button
          variant="outline"
          onClick={() =>
            downloadCsv(
              'validators',
              ['Name', 'Vote', 'Stake SOL', 'APY %', 'Score', 'Net SOL per epoch'],
              filtered.map((r) => [r.name, r.vote, r.stakeSol, r.apyPct, r.epochScore, r.healthPerEpochSol]),
            )
          }
        >
          <Download />
          Export CSV
        </Button>
      </PageHeading>
      <StakeMap rows={query.data.rows} />
      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList variant="line" className="h-12 gap-6 border-b border-border">
          <TabsTrigger className="px-1" value="all">
            All validators
          </TabsTrigger>
          <TabsTrigger className="px-1" value="healthy">
            Healthy
          </TabsTrigger>
          <TabsTrigger className="px-1" value="watch">
            Watch
          </TabsTrigger>
          <TabsTrigger className="px-1" value="watchlist">
            Watchlist <span className="num text-xs">{watch.length}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Search validators"
            className="h-11 pl-10"
            placeholder="Search by name or vote account"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button variant="outline" onClick={() => setFilters(true)}>
          <SlidersHorizontal />
          Filters{(country || client) && ' · active'}
        </Button>
        <label className="sr-only" htmlFor="validator-sort">
          Sort validators
        </label>
        <select
          id="validator-sort"
          className="rounded-lg border border-input bg-card px-3 text-sm"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="stake">Stake</option>
          <option value="apy">APY</option>
          <option value="score">Epoch Score</option>
          <option value="kept">Net revenue</option>
          <option value="fee">Commission</option>
        </select>
        <Button
          variant="outline"
          aria-label="Reverse sort direction"
          onClick={() => setDirection(direction === 'desc' ? 'asc' : 'desc')}
        >
          <ArrowDown className={direction === 'asc' ? 'rotate-180' : ''} />
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {chipOptions.map(([key, label]) => (
          <Button
            key={key}
            variant={chips.split(',').includes(key) ? 'secondary' : 'outline'}
            className={`text-xs ${chips.split(',').includes(key) ? 'border-primary text-primary' : ''}`}
            aria-pressed={chips.split(',').includes(key)}
            onClick={() =>
              setChips(
                chips.split(',').includes(key)
                  ? chips
                      .split(',')
                      .filter((c) => c !== key)
                      .join(',')
                  : [...chips.split(',').filter(Boolean), key].join(','),
              )
            }
          >
            {label}
          </Button>
        ))}
      </div>
      <div
        className="vt-wrap hidden overflow-auto md:block"
        ref={scroll}
        style={{ maxHeight: rows.length > 50 ? 720 : undefined }}
      >
        <table className="vt w-full text-sm">
          <thead className="sticky top-0 z-10 bg-background">
            {table.getHeaderGroups().map((g) => (
              <tr key={g.id} className="border-b border-border">
                {g.headers.map((h, i) => (
                  <th key={h.id} className={`py-3 font-normal label-caps ${i < 2 ? 'text-left' : 'text-right'}`}>
                    <table.FlexRender header={h} />
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length > 50 && items[0]?.start > 0 && (
              <tr aria-hidden>
                <td colSpan={13} style={{ height: items[0].start }} />
              </tr>
            )}
            {items.map((item) => {
              const row = rows[item.index];
              return (
                <tr key={row.id} className="vt-row" style={{ height: 72 }}>
                  {row.getAllCells().map((cell, i) => (
                    <td className={`${i < 2 ? 'text-left' : 'text-right'} ${i === 0 ? 'w-10' : ''}`} key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              );
            })}
            {rows.length > 50 && (
              <tr aria-hidden>
                <td colSpan={13} style={{ height: Math.max(0, virtual.getTotalSize() - (items.at(-1)?.end ?? 0)) }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 md:hidden">
        {filtered.map((r) => (
          <div className="rounded-xl border border-border bg-card p-4" key={r.vote}>
            <div className="flex items-center gap-3">
              <Checkbox
                checked={selected.includes(r.vote)}
                disabled={selected.length >= 3 && !selected.includes(r.vote)}
                onCheckedChange={() => check(r.vote)}
                aria-label={`Compare ${r.name}`}
              />
              <Link href={`/validators/${r.vote}`} className="min-w-0 flex-1 truncate font-medium">
                {r.name}
              </Link>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${watch.includes(r.vote) ? 'Unwatch' : 'Watch'} ${r.name}`}
                onClick={() => star(r.vote)}
              >
                <Star className={watch.includes(r.vote) ? 'fill-primary text-primary' : ''} />
              </Button>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <div>
                <p className="label-caps">Stake</p>
                <p className="num mt-2 text-sm">{compact(r.stakeSol)} SOL</p>
              </div>
              <div>
                <p className="label-caps">APY</p>
                <p className="num mt-2 text-sm">{fmt(r.apyPct, 2)}%</p>
              </div>
              <div>
                <p className="label-caps">Score</p>
                <p className="num mt-2 text-sm text-primary">{r.epochScore}/100</p>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              {r.client} · {r.country} · {r.health}
            </p>
          </div>
        ))}
      </div>
      {!filtered.length && (
        <div className="py-16 text-center">
          <p>No validator matches these filters.</p>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => {
              setChips('');
              setSearch('');
              setTab('all');
              setCountry('');
              setClient('');
            }}
          >
            Clear filters
          </Button>
        </div>
      )}
      <div className="flex flex-wrap justify-between gap-3 text-xs text-muted-foreground">
        <p className="num">
          {filtered.length} matching · {query.data.rows.length} loaded · {query.data.total} in this dataset
        </p>
        <p>Watchlist is saved on this device.</p>
      </div>
      <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
        Epoch Score combines vote credits, commission and tenure. Top-18 validators are capped at 50. Net revenue is an
        estimate after voting costs. APY is historical and can change.
      </p>
      {selected.length > 0 && (
        <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ep-accent-line bg-ep-raised p-4">
          <span className="text-sm">
            <span className="num">{selected.length}/3</span> validators selected
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setSelected([])}>
              Clear
            </Button>
            <Button disabled={selected.length < 2} onClick={() => setCompare(true)}>
              Compare side by side
            </Button>
          </div>
        </div>
      )}
      <Dialog open={compare} onOpenChange={setCompare}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Compare validators</DialogTitle>
            <DialogDescription>Compare health and concentration alongside historical returns.</DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="vt w-full text-sm">
              <thead>
                <tr>
                  <th className="p-3 text-left">Metric</th>
                  {chosen.map((r) => (
                    <th key={r.vote} className="p-3 text-left">
                      {r.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ['Stake (SOL)', (r: ValidatorRow) => compact(r.stakeSol)],
                  ['APY', (r: ValidatorRow) => `${fmt(r.apyPct, 2)}%`],
                  ['Epoch Score', (r: ValidatorRow) => `${r.epochScore}/100`],
                  ['Commission', (r: ValidatorRow) => `${r.commissionPct}%`],
                  ['Largest delegator', (r: ValidatorRow) => `${fmt(r.biggestDelegatorSharePct, 1)}%`],
                  ['Net SOL / epoch', (r: ValidatorRow) => fmt(r.healthPerEpochSol, 2)],
                ].map(([label, get]) => (
                  <tr key={String(label)} className="border-t border-border">
                    <td className="p-3 text-muted-foreground">{String(label)}</td>
                    {chosen.map((r) => (
                      <td key={r.vote} className="num p-3">
                        {(get as (r: ValidatorRow) => string)(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={filters} onOpenChange={setFilters}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Filter validators</DialogTitle>
            <DialogDescription>Filters are saved in the URL so you can share this view.</DialogDescription>
          </DialogHeader>
          <label className="space-y-2 text-sm">
            Client
            <select
              className="h-11 w-full rounded-lg border border-input bg-card px-3"
              value={client}
              onChange={(e) => setClient(e.target.value)}
            >
              <option value="">All clients</option>
              {[...new Set(query.data.rows.map((r) => r.client))].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm">
            Country
            <select
              className="h-11 w-full rounded-lg border border-input bg-card px-3"
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            >
              <option value="">All countries</option>
              {[...new Set(query.data.rows.map((r) => r.country))].sort().map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <Button onClick={() => setFilters(false)}>Show results</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
