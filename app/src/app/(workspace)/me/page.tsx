'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { PublicKey } from '@solana/web3.js';
import { useQueryState, parseAsString } from 'nuqs';
import { Eye, ShieldCheck, ArrowUpRight, Wallet, Bell, Download } from 'lucide-react';
import { useMyStake, useSession } from '@/lib/data/resources';
import { useResource, apiConfigured } from '@/lib/data/client';
import fixture from '@/fixtures/my-stake.demo.json';
import { Panel, PageHeading, Metric, Source, QueryState, fmt, downloadCsv } from '@/components/epoch/shared';
import { EpochChart } from '@/components/epoch/epoch-chart';
import { ConnectWallet } from '@/components/epoch/connect-wallet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { AlertsDialog } from '@/components/epoch/alerts-dialog';
export default function MyStake() {
  const [address, setAddress] = useQueryState('address', parseAsString.withDefault(''));
  const [demo, setDemo] = useQueryState('demo', parseAsString.withDefault(''));
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [alerts, setAlerts] = useState(false);
  const session = useSession();
  const wallet = address || session.data?.address || '';
  const query = useMyStake(wallet);
  const sample = useResource('demo-wallet', fixture, false);
  const d = demo === '1' ? fixture : query.data;
  const points = useMemo(
    () => query.data?.rewardsByEpoch.map((r) => ({ epoch: r.epoch, value: r.sol })) ?? [],
    [query.data],
  );
  function view() {
    try {
      new PublicKey(typed.trim());
      setAddress(typed.trim());
      setDemo('');
      setError('');
    } catch {
      setError('Enter a valid Solana wallet address.');
    }
  }
  if (!wallet && demo !== '1')
    return (
      <div className="mx-auto grid min-h-screen max-w-6xl items-center gap-12 px-6 py-12 lg:grid-cols-2 lg:px-12">
        <div className="space-y-8">
          <Link href="/" className="inline-flex min-h-11 items-center text-sm text-primary">
            ← Epoch home
          </Link>
          <div className="flex size-16 items-center justify-center rounded-2xl border border-ep-accent-line bg-ep-accent-soft text-primary">
            <ShieldCheck className="size-8" />
          </div>
          <div>
            <p className="label-caps mb-5">Your stake, in focus</p>
            <h1 className="text-4xl leading-tight tracking-tight lg:text-5xl">
              See what your SOL
              <br />
              is really doing.
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground">
              Your validators, rewards and risks. A clear view of your stake, with you in control.
            </p>
          </div>
          <div className="space-y-5 text-sm text-muted-foreground">
            <p className="flex items-center gap-3">
              <ShieldCheck className="size-4 text-primary" />
              Signing in is a message, not a transaction.
            </p>
            <p className="flex items-center gap-3">
              <Wallet className="size-4 text-primary" />
              You approve every action in your wallet.
            </p>
            <p className="flex items-center gap-3">
              <Eye className="size-4 text-primary" />
              View any address without connecting.
            </p>
          </div>
        </div>
        <div className="mx-auto w-full max-w-sm space-y-6">
          <h2 className="text-2xl font-medium">Check your stake</h2>
          <ConnectWallet className="h-12 w-full" />
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            or view an address
            <div className="h-px flex-1 bg-border" />
          </div>
          <label htmlFor="wallet-address" className="sr-only">
            Solana wallet address
          </label>
          <Input
            id="wallet-address"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') view();
            }}
            placeholder="Paste a Solana wallet address"
            className="h-12 num text-xs"
          />
          <Button className="h-12 w-full" variant="outline" onClick={view}>
            View address
            <ArrowUpRight />
          </Button>
          {error && (
            <p role="alert" className="text-sm text-ep-warn">
              {error}
            </p>
          )}
          <button
            className="min-h-11 w-full text-sm text-muted-foreground underline underline-offset-4 hover:text-primary"
            onClick={() => setDemo('1')}
          >
            Explore a labelled demo wallet
          </button>
        </div>
      </div>
    );
  if (!d)
    return (
      <>
        <PageHeading title="My Stake" description="Read-only wallet view" />
        <p className="num break-all text-xs text-muted-foreground">{wallet}</p>
        <Button variant="outline" onClick={() => setAddress('')}>
          View another address
        </Button>
        {!apiConfigured ? (
          <Panel title="Wallet data needs the API">
            <p className="text-sm text-muted-foreground">
              This address is valid. Its balances can be loaded once the Epoch API is connected.
            </p>
            <Button
              className="mt-5"
              variant="outline"
              onClick={() => {
                setAddress('');
                setDemo('1');
              }}
            >
              Explore the demo wallet
            </Button>
          </Panel>
        ) : (
          <QueryState pending={query.isPending} error={query.error} retry={query.refetch} />
        )}
      </>
    );
  const total = d.stakeAccounts.reduce((sum, a) => sum + a.sol, 0);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-2">
          <Eye className="size-4" />
          {demo === '1'
            ? 'Demo wallet · balances are invented; validator data is historical.'
            : 'Read-only data view. No funds move by viewing an address.'}
        </span>
        {demo === '1' && (
          <Button
            variant="ghost"
            onClick={() => {
              setDemo('');
              setAddress('');
            }}
          >
            Exit demo
          </Button>
        )}
      </div>
      <PageHeading title="Your stake, at a glance" description={`${d.wallet.slice(0, 8)}…${d.wallet.slice(-6)}`}>
        <Source data={d} />
      </PageHeading>
      <div className="flex flex-wrap gap-2">
        <Button render={<Link href="/validators" />} nativeButton={false}>
          Explore validators
          <ArrowUpRight />
        </Button>
        <Button variant="outline" onClick={() => setAlerts(true)}>
          <Bell />
          Alerts
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            downloadCsv(
              'stake-accounts',
              ['Validator', 'Vote account', 'SOL', 'APY', 'Health'],
              d.stakeAccounts.map((a) => [a.validator, a.vote, a.sol, a.apyPct, a.health]),
            )
          }
        >
          <Download />
          Export accounts
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Total staked" aside={<ShieldCheck className="size-4 text-primary" />}>
          <p className="num my-5 text-4xl">
            {fmt(total, 2)} <span className="text-lg text-muted-foreground">SOL</span>
          </p>
          <div className="grid grid-cols-2 gap-4">
            <Metric label="Blended APY" value={`${fmt(d.blendedApyPct, 2)}%`} />
            <Metric label="Rewards / epoch" value={`${fmt(d.perEpochSol, 5)}`} detail="SOL estimate" />
          </div>
          {points.length > 0 ? (
            <EpochChart height={150} points={points} />
          ) : (
            <p className="mt-8 border-t border-border pt-4 text-xs text-muted-foreground">
              Reward history is not available in this demo. No chart is estimated.
            </p>
          )}
        </Panel>
        <Panel
          title="Stake accounts"
          aside={<span className="num text-xs text-muted-foreground">{d.stakeAccounts.length} accounts</span>}
        >
          <div className="divide-y divide-border">
            {d.stakeAccounts.map((a, i) => (
              <Link key={i} href={`/validators/${a.vote}`} className="flex items-center gap-3 py-5 hover:text-primary">
                <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted text-xs">
                  {a.initials}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{a.validator}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{a.health}</p>
                </div>
                <span className="num text-sm">{fmt(a.sol, 2)} SOL</span>
              </Link>
            ))}
          </div>
        </Panel>
        <Panel title="Reward estimates">
          <div className="grid grid-cols-2 gap-6">
            <Metric label="Per month" value={fmt(d.monthSol, 4)} detail="SOL estimate" />
            <Metric label="Per year" value={fmt(d.yearSol, 4)} detail="SOL estimate" />
          </div>
          <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
            Estimates use historical APY. Actual rewards depend on validator performance, commission and network
            conditions.
          </p>
        </Panel>
        <Panel title="Validator health">
          <div className="space-y-5">
            {d.stakeAccounts.map((a, i) => (
              <div key={i}>
                <div className="flex justify-between text-sm">
                  <span>{a.validator}</span>
                  <Badge variant="outline" className={a.health === 'healthy' ? 'text-primary' : 'text-ep-warn'}>
                    {a.health}
                  </Badge>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  {a.healthReasons.join(' · ') || 'No health flags in this snapshot'}
                </p>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <h2 className="mt-4 text-lg">Other operators to explore</h2>
      <div className="grid gap-4 lg:grid-cols-3">
        {d.suggestions.slice(0, 3).map((s) => (
          <Panel key={s.name} title={s.name}>
            <Metric label="Historical APY" value={`${fmt(s.apyPct, 2)}%`} />
            <p className="mt-4 text-xs text-muted-foreground">
              {s.city} · {s.country}
            </p>
            {s.vote && (
              <Link
                href={`/validators/${s.vote}`}
                className="mt-5 inline-flex min-h-11 items-center gap-2 text-sm text-primary"
              >
                View validator
                <ArrowUpRight className="size-4" />
              </Link>
            )}
          </Panel>
        ))}
      </div>
      <AlertsDialog open={alerts} onOpenChange={setAlerts} signedIn={Boolean(session.data) && demo !== '1'} />
    </>
  );
}
