'use client';
import { useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { deposit, solToLamports } from '@epoch/epoch-sdk';
import { ShieldCheck, ArrowUpRight, ArrowDownToLine, Info } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { useQueryState, parseAsString } from 'nuqs';
import { useVault } from '@/lib/data/resources';
import { CapitalFlow } from '@/components/epoch/capital-flow';
import { Panel, PageHeading, Metric, Source, QueryState, fmt } from '@/components/epoch/shared';
import { EpochChart } from '@/components/epoch/epoch-chart';
import { TransactionReview, PROGRAM_ID, PROGRAM_NETWORK, RPC_URL } from '@/components/epoch/transaction-review';
import { ConnectWallet } from '@/components/epoch/connect-wallet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from '@/components/ui/table';
export default function Vault() {
  const query = useVault(),
    wallet = useWallet();
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('tranches'));
  const [depositOpen, setDepositOpen] = useState(false);
  const [tranche, setTranche] = useState<'senior' | 'junior'>('senior');
  const [amount, setAmount] = useState('');
  const [risk, setRisk] = useState(false);
  const [rules, setRules] = useState(false);
  const [loss, setLoss] = useState(50);
  const v = query.data;
  const points = useMemo(
    () =>
      v?.series.epochs.map((epoch, i) => ({
        epoch,
        value: tranche === 'senior' ? v.series.seniorSharePrice[i] : v.series.juniorSharePrice[i],
      })) ?? [],
    [v, tranche],
  );
  if (!v) return <QueryState pending={query.isPending} error={query.error} retry={query.refetch} />;
  const junior = v.tranches.junior,
    senior = v.tranches.senior;
  const number = Number(amount);
  const price = tranche === 'senior' ? senior.sharePrice : junior.sharePrice;
  let valid = false;
  try {
    valid = solToLamports(amount) > 0n;
  } catch {}
  const roomOk =
    tranche !== 'senior' || senior.roomBeforeJuniorMustGrowSol === null || number <= senior.roomBeforeJuniorMustGrowSol;
  const gross = v.openAdvancesForStressTest.reduce((s, a) => s + (a.outstandingPrincipalSol * loss) / 100, 0);
  const covered = v.openAdvancesForStressTest.reduce(
    (s, a) => s + Math.min((a.outstandingPrincipalSol * loss) / 100, a.bondSol),
    0,
  );
  const juniorLoss = Math.min(junior.assetsSol, Math.max(0, gross - covered));
  const seniorLoss = Math.max(0, gross - covered - juniorLoss);
  function openDeposit(t: 'senior' | 'junior') {
    setTranche(t);
    setRisk(false);
    setDepositOpen(true);
  }
  return (
    <>
      <PageHeading
        title="Vault"
        eyebrow="Capital · lenders"
        description="SOL lent to validators against their next epochs of revenue. Senior is paid first; Junior earns the rest and absorbs losses after the borrower’s bond."
        stats={[
          { label: 'In the vault', value: `${fmt(v.pool.tvlSol)} SOL`, detail: `${fmt(v.pool.lenders)} lenders` },
          { label: 'Lent out', value: `${fmt(v.pool.utilizationPct, 1)}%`, detail: `${fmt(v.pool.outstandingPrincipalSol, 2)} SOL · cap ${v.pool.utilizationCapPct}%` },
          { label: 'Senior target', value: `${fmt(senior.apyPct, 1)}%`, detail: 'a year · paid first', tone: 'accent' },
          { label: 'Junior since launch', value: `${fmt(junior.apySinceLaunchPct, 1)}%`, detail: `${junior.lockEpochs}-epoch lock · first loss`, tone: 'info' },
          { label: 'Lost by lenders', value: `${fmt(v.pool.lostByLendersSol)} SOL`, detail: `${v.pool.defaults} default so far` },
        ]}
      >
        <Source data={v} />
        <Button variant="ghost" onClick={() => setRules(true)}>
          Rules & risks
          <Info />
        </Button>
        <Button onClick={() => openDeposit('senior')}>
          <ArrowDownToLine />
          Deposit
        </Button>
      </PageHeading>
      <CapitalFlow
        tvl={v.pool.tvlSol}
        senior={senior.assetsSol}
        junior={junior.assetsSol}
        lent={v.pool.outstandingPrincipalSol}
        lenders={v.pool.lenders}
        remitPct={((v.params.find((p) => p.field === 'remit_bps')?.value as number | null) ?? 5000) / 100}
        advances={v.advances}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="In the vault" aside={<ShieldCheck className="size-4 text-muted-foreground" />}>
          <p className="num mt-3 text-4xl lg:text-5xl">
            {fmt(v.pool.tvlSol, 2)} <span className="text-lg text-muted-foreground">SOL</span>
          </p>
          <div className="mt-8 grid grid-cols-2 gap-4">
            <Metric
              label="Lent out now"
              value={fmt(v.pool.outstandingPrincipalSol, 2)}
              detail="SOL in validator advances"
            />
            <Metric
              label="Utilization"
              value={`${fmt(v.pool.utilizationPct, 1)}%`}
              detail={`${v.pool.utilizationCapPct}% maximum`}
            />
          </div>
          <Progress className="mt-6" value={v.pool.utilizationPct} aria-label="Vault utilization" />
        </Panel>
        <Panel title="Capital allocation" aside={<Source data={v} />}>
          <div className="flex flex-col items-center gap-6 sm:flex-row">
            <div
              className="h-32 w-32"
              role="img"
              aria-label={`Senior ${fmt((senior.assetsSol / v.pool.tvlSol) * 100, 1)}%, Junior ${fmt(junior.sharePctOfVault, 1)}%`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[
                      { name: 'Senior', value: senior.assetsSol },
                      { name: 'Junior', value: junior.assetsSol },
                    ]}
                    dataKey="value"
                    innerRadius={44}
                    outerRadius={60}
                    stroke="var(--ep-surface)"
                    strokeWidth={4}
                  >
                    <Cell fill="var(--ep-accent)" />
                    <Cell fill="var(--ep-info)" />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="w-full flex-1 space-y-4 text-sm sm:w-auto">
              <div className="flex justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-primary" />
                  Senior
                </span>
                <span className="num whitespace-nowrap">{fmt(senior.assetsSol, 2)} SOL</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-ep-info" />
                  Junior
                </span>
                <span className="num whitespace-nowrap">{fmt(junior.assetsSol, 2)} SOL</span>
              </div>
            </div>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-4 border-t border-border pt-5">
            <Metric label="Senior target APY" value={`${fmt(senior.apyPct, 1)}%`} tone="text-primary" />
            <Metric label="Lenders" value={fmt(v.pool.lenders)} />
          </div>
        </Panel>
      </div>
      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList variant="line" className="h-12 max-w-full justify-start overflow-x-auto gap-4">
          {[
            ['tranches', 'Tranches'],
            ['protection', 'Protection'],
            ['loans', 'Loan book'],
            ['queue', 'Withdrawal queue'],
            ['lenders', 'Lenders'],
            ['params', 'Parameters'],
          ].map(([key, label]) => (
            <TabsTrigger key={key} className="px-2" value={key}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === 'tranches' && (
        <>
          {(['senior', 'junior'] as const).map((t) => (
            <div key={t} className="grid gap-8 border-b border-border py-7 lg:grid-cols-3">
              <div className="flex gap-4 lg:col-span-2">
                <span
                  className={`mt-1 flex size-12 shrink-0 items-center justify-center rounded-full border ${t === 'senior' ? 'border-ep-accent-line text-primary' : 'border-ep-info-line text-ep-info'}`}
                >
                  <ShieldCheck className="size-5" />
                </span>
                <div>
                  <h2 className="text-xl capitalize">{t}</h2>
                  <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
                    {t === 'senior'
                      ? 'Paid first from advance fees, with a target rate. Junior capital and each borrower’s bond sit ahead of Senior in the loss order.'
                      : `Earns the remaining fees after the Senior target. Takes the first lender loss after borrower bonds. Deposits are locked for ${junior.lockEpochs} epochs.`}
                  </p>
                  <Button className="mt-6" variant="outline" onClick={() => openDeposit(t)}>
                    Deposit in {t === 'senior' ? 'Senior' : 'Junior'}
                    <ArrowUpRight />
                  </Button>
                </div>
              </div>
              <dl className="space-y-4 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t === 'senior' ? 'Target APY' : 'APY since launch'}</dt>
                  <dd className={`num ${t === 'senior' ? 'text-primary' : 'text-ep-info'}`}>
                    {fmt(t === 'senior' ? senior.apyPct : junior.apySinceLaunchPct, 1)}%
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Share price</dt>
                  <dd className="num">{fmt(t === 'senior' ? senior.sharePrice : junior.sharePrice, 4)} SOL</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Withdrawal</dt>
                  <dd>{t === 'senior' ? 'Request any epoch' : `${junior.lockEpochs}-epoch lock`}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Loss order</dt>
                  <dd>{t === 'senior' ? 'After Junior' : 'After borrower bond'}</dd>
                </div>
              </dl>
            </div>
          ))}
          <Panel title="Share price history" aside={<Source data={v} />}>
            <div className="mb-4 flex gap-2">
              {(['senior', 'junior'] as const).map((t) => (
                <Button
                  key={t}
                  variant={tranche === t ? 'secondary' : 'ghost'}
                  className="capitalize"
                  onClick={() => setTranche(t)}
                >
                  {t}
                </Button>
              ))}
            </div>
            <EpochChart points={points} height={240} unit="SOL per share" precision={4} />
          </Panel>
        </>
      )}
      {tab === 'protection' && (
        <Panel title="Stress test the protection" aside={<Source data={v} />}>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Assume the same loss percentage on every open advance. Each borrower’s bond covers only that borrower’s
            loss. Remaining losses reach Junior, then Senior.
          </p>
          <label className="mt-8 block text-sm" htmlFor="loss">
            Unrecovered principal <span className="num text-ep-warn">{loss}%</span>
          </label>
          <input
            id="loss"
            type="range"
            className="my-5 w-full accent-primary"
            min="0"
            max="100"
            value={loss}
            onChange={(e) => setLoss(Number(e.target.value))}
          />
          <div className="grid gap-6 sm:grid-cols-3">
            <Metric label="Covered by bonds" value={`${fmt(covered, 2)} SOL`} />
            <Metric label="Junior loss" value={`${fmt(juniorLoss, 2)} SOL`} tone="text-ep-warn" />
            <Metric label="Senior loss" value={`${fmt(seniorLoss, 2)} SOL`} tone="text-ep-warn" />
          </div>
          <p className="mt-6 text-xs text-muted-foreground">
            Illustrative loss allocation. It does not model recovery timing or changing collateral values.
          </p>
        </Panel>
      )}
      {['loans', 'queue', 'lenders', 'params'].includes(tab) && (
        <Table>
          <TableHeader>
            <TableRow>
              {(tab === 'loans'
                ? ['Validator', 'Principal', 'Repaid', 'Bond', 'Status']
                : tab === 'queue'
                  ? ['Request', 'Tranche', 'Amount', 'Asked epoch', 'Status']
                  : tab === 'lenders'
                    ? ['Lender', 'Tranche', 'Capital', 'Share', 'Since epoch']
                    : ['Parameter', 'Value']
              ).map((h) => (
                <TableHead className="label-caps" key={h}>
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {tab === 'loans' &&
              v.advances.map((a) => (
                <TableRow key={a.validator}>
                  <TableCell className="py-5">{a.validator}</TableCell>
                  <TableCell className="num">{fmt(a.borrowedSol, 2)} SOL</TableCell>
                  <TableCell className="num">{fmt(a.repaidSol, 2)} SOL</TableCell>
                  <TableCell className="num">{fmt(a.bondSol, 2)} SOL</TableCell>
                  <TableCell className={a.status === 'late' ? 'text-ep-warn' : 'text-primary'}>{a.status}</TableCell>
                </TableRow>
              ))}
            {tab === 'queue' &&
              v.withdrawQueue.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="num py-5">#{a.id}</TableCell>
                  <TableCell>{a.tranche}</TableCell>
                  <TableCell className="num">{fmt(a.sol, 2)} SOL</TableCell>
                  <TableCell className="num">{a.askedEpoch}</TableCell>
                  <TableCell>{a.status}</TableCell>
                </TableRow>
              ))}
            {tab === 'lenders' &&
              v.lenders.map((a, i) => (
                <TableRow key={i}>
                  <TableCell className="py-5">{a.label || a.walletShort || 'Unlabelled'}</TableCell>
                  <TableCell>{a.tranche}</TableCell>
                  <TableCell className="num">{fmt(a.sol, 2)} SOL</TableCell>
                  <TableCell className="num">{fmt(a.shareOfTranchePct, 1)}%</TableCell>
                  <TableCell className="num">{a.sinceEpoch}</TableCell>
                </TableRow>
              ))}
            {tab === 'params' &&
              v.params.map((a) => (
                <TableRow key={a.field}>
                  <TableCell className="py-5">{a.name}</TableCell>
                  <TableCell className="num">{a.display}</TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      )}
      <div className="rounded-xl border border-ep-warn-line bg-ep-warn-soft p-5 text-sm leading-relaxed text-ep-warn">
        Targets are not promises. Vault SOL is not staked; unlent SOL earns nothing. Withdrawals wait for available
        cash. Epoch is pre-alpha and unaudited.
      </div>
      <Sheet open={depositOpen} onOpenChange={setDepositOpen}>
        <SheetContent className="overflow-y-auto p-6">
          <SheetHeader className="px-0">
            <SheetTitle>Deposit into the Vault</SheetTitle>
            <SheetDescription>Choose how your capital participates in validator advances.</SheetDescription>
          </SheetHeader>
          <div className="space-y-6">
            <Tabs
              value={tranche}
              onValueChange={(t) => {
                setTranche(t as 'senior' | 'junior');
                setRisk(false);
              }}
            >
              <TabsList className="h-11 w-full">
                <TabsTrigger value="senior">Senior</TabsTrigger>
                <TabsTrigger value="junior">Junior</TabsTrigger>
              </TabsList>
            </Tabs>
            <label className="block text-sm" htmlFor="deposit-amount">
              Deposit amount · SOL
            </label>
            <Input
              id="deposit-amount"
              inputMode="decimal"
              className="h-16 num text-2xl"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
            <div className="flex gap-2">
              {[1, 4, 25, 100].map((a) => (
                <Button variant="outline" key={a} className="num flex-1" onClick={() => setAmount(String(a))}>
                  {a}
                </Button>
              ))}
            </div>
            <div className="space-y-3 border-y border-border py-5 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Estimated shares</span>
                <span className="num">{valid ? fmt(number / price, 6) : '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Share price</span>
                <span className="num">{fmt(price, 4)} SOL</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Lock</span>
                <span>{tranche === 'senior' ? 'None' : `${junior.lockEpochs} epochs`}</span>
              </div>
            </div>
            {!roomOk && (
              <p className="text-sm text-ep-warn">This exceeds the Senior capacity. Junior capital must grow first.</p>
            )}
            <label className="flex items-start gap-3 text-sm leading-relaxed">
              <Checkbox
                checked={risk}
                onCheckedChange={(value) => setRisk(Boolean(value))}
                aria-label="I understand the deposit risks"
              />
              <span>I understand that returns are not guaranteed and my deposit can lose value.</span>
            </label>
            {!wallet.publicKey ? (
              <ConnectWallet className="w-full" />
            ) : (
              <TransactionReview
                title="Review deposit"
                summary={`${amount || '0'} SOL into the ${tranche} tranche.`}
                disabled={
                  !valid || !risk || !roomOk || v.kind !== 'real' || !PROGRAM_ID || !RPC_URL || !PROGRAM_NETWORK
                }
                build={async () =>
                  deposit({
                    programId: new PublicKey(PROGRAM_ID),
                    owner: wallet.publicKey!,
                    tranche,
                    lamports: solToLamports(amount),
                  })
                }
              />
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {v.kind !== 'real'
                ? 'This vault contains sample figures. Real deposits are unavailable until the deployed program and RPC are connected.'
                : 'You will review the program, accounts and network fee before approving in your wallet.'}
            </p>
          </div>
        </SheetContent>
      </Sheet>
      <Dialog open={rules} onOpenChange={setRules}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rules and risks</DialogTitle>
            <DialogDescription>
              Understand the source of yield and the order of losses before depositing.
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc space-y-3 pl-5 text-sm text-muted-foreground">
            <li>Epoch is pre-alpha and unaudited.</li>
            <li>Vault SOL is not staked. Unlent SOL earns nothing.</li>
            <li>The Senior rate is a target paid only from actual fees.</li>
            <li>Junior takes losses before Senior, after borrower bonds.</li>
            <li>Withdrawals wait for cash and may be delayed.</li>
            <li>Pool parameters can change. Review the Parameters tab.</li>
          </ul>
          <Button onClick={() => setRules(false)}>Understood</Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
