"use client";
// The Live page (docs/pages/live.md): the Solana Fee Index computed from mainnet as it happens. Terminal style from
// the kit: title row with the data-source badge, a one-line KPI strip (Kraken Pro), the hero metric over one large
// chart (Mercury Insights), side cards, then docked tabbed tables. Every state in the contract has its words:
// loading, empty, live, stale, reconnecting, catching up, partial epoch, sampled, error.

import NumberFlow from "@number-flow/react";
import { ArrowDown, ExternalLink, Info } from "lucide-react";
import Link from "next/link";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useEffect, useState } from "react";

import { DataStatus, LiveDot } from "@/components/data/source-badge";
import { DataTable, columnHelper, type Column } from "@/components/data/data-table";
import { EmptyBlock, ErrorCard, KeyValue, Panel, SectionHeading, SkeletonRows, Tip } from "@/components/data/primitives";
import { PageHeader } from "@/components/shell/page-header";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { env } from "@/lib/env";
import { useLiveDistribution, useLiveLeaders, useLiveSlots, useLiveSummary } from "@/lib/data/live";
import type { LiveLeaders, LiveSlot, LiveSummary } from "@/lib/data/types";
import { fmtAgo, fmtCu, fmtEpoch, fmtInt, fmtNum, fmtPct, fmtSignedPct, fmtTimeSecIst, secondsSince, shortKey } from "@/lib/format";
import { useStreamStatus } from "@/lib/api/stream";

import { DistributionChart } from "./distribution-chart";
import { LeadersTable } from "./leaders-table";
import { SlotStrip } from "./slot-strip";
import { SolamiPanel } from "./solami-panel";

const MODE_WORDS: Record<string, string> = {
  grpc: "Solami gRPC (Yellowstone)",
  hybrid: "Solami gRPC block meta + Solami RPC blocks",
  rpc: "RPC polling",
};

/** A ticking "N s ago" from an ISO time (re-renders every second while mounted). */
function useAgo(iso: string | null | undefined, frozenAt?: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (frozenAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [frozenAt]);
  return secondsSince(iso, frozenAt ?? now);
}

export function LiveConsole() {
  const summary = useLiveSummary();
  const slots = useLiveSlots();
  const s = summary.data?.data;
  const source = summary.data?.source;
  const epoch = s?.epoch?.number ?? s?.estimate?.epoch ?? null;
  const leaders = useLiveLeaders(summary.data ? epoch : undefined);
  const dist = useLiveDistribution(epoch);
  const { state: socket } = useStreamStatus();

  const isSample = source === "sample";
  const isLive = source === "api" && s?.live === true;
  const frozen = isSample && s ? Date.parse(s.asOf) : undefined;
  const lastSlotAgo = useAgo(s?.stream.lastSlotAt, frozen);
  const reconnecting = s ? s.stream.status === "reconnecting" || s.stream.status === "connecting" : false;

  const header = (
    <PageHeader
      eyebrow={
        <>
          <span className="text-ep-info">Solami</span> side track · the Fee Index streamed from mainnet
        </>
      }
      title="Live"
      badges={
        <span className="flex flex-wrap items-center gap-2">
          <DataStatus
            source={source}
            live={isLive}
            stale={source === "api" && s ? !s.live : false}
            asOf={s?.stream.lastSlotAt ?? s?.asOf}
            liveDetail={s?.dataSource}
            sampleNote="Recorded 3 Oct 2026, mainnet epoch 1048, RPC sampling mode on public RPC."
          />
          {reconnecting ? <span className="text-xs text-ep-muted">reconnecting to Solami…</span> : null}
          {source === "api" && socket !== "open" ? <span className="text-xs text-ep-muted">socket {socket}, polling every 5 s</span> : null}
        </span>
      }
      description="The Solana Fee Index computed from mainnet as it happens: each block's median priority fee, the epoch's running index, the leaders whose medians form it and how the slot medians spread."
      actions={
        <Link href="#integration" className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-ep-text-2 transition-colors duration-200 hover:bg-ep-hover hover:text-ep-text">
          How we integrate Solami <ArrowDown className="size-3.5" aria-hidden />
        </Link>
      }
    />
  );

  if (summary.isPending) {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-4 lg:grid-cols-12">
          <Skeleton className="h-104 lg:col-span-8" />
          <Skeleton className="h-104 lg:col-span-4" />
        </div>
      </div>
    );
  }

  if (!s) {
    return (
      <div className="flex flex-col gap-8">
        {header}
        <ErrorCard error={summary.error} what="the live Fee Index" onRetry={() => void summary.refetch()} />
      </div>
    );
  }

  const empty = s.estimate === null && s.stream.status === "offline";
  const est = s.estimate;
  const sampled = est?.sampled ?? false;
  const delta = est?.value !== null && est?.value !== undefined && s.lastFinal ? ((est.value - s.lastFinal.value) / s.lastFinal.value) * 100 : null;

  return (
    <div className="flex flex-col gap-8">
      {header}
      {summary.isError ? <ErrorCard error={summary.error} what="the newest summary (showing the last good one, not live)" onRetry={() => void summary.refetch()} /> : null}

      {/* KPI strip (Kraken Pro): one line of label/value pairs, no cards */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-y border-ep-line py-4 sm:grid-cols-4 lg:grid-cols-7">
        <KeyValue
          label="Epoch"
          value={fmtEpoch(s.epoch?.number)}
          sub={s.epoch ? `${fmtPct(s.epoch.progressPct, 1)} · slot ${fmtInt(s.epoch.slotIndex)} of ${fmtInt(s.epoch.slotsInEpoch)}` : undefined}
        />
        <KeyValue label="Tip slot" value={fmtInt(s.tipSlot)} sub="mainnet" />
        <KeyValue label="Processed" value={fmtInt(s.processedSlot)} sub={lastSlotAgo !== null ? `last block ${fmtAgo(lastSlotAgo)}` : undefined} />
        <KeyValue label="Lag" value={s.lagSlots !== null ? `${fmtInt(s.lagSlots)} slots` : "—"} sub={s.lagSeconds !== null ? `${fmtNum(s.lagSeconds, 1)} s behind the tip` : undefined} />
        <KeyValue label="Stream" value={s.stream.status} sub={s.stream.endpoint ?? undefined} />
        <KeyValue label="Leaders priced" value={fmtInt(est?.leaders)} sub={est ? `${fmtInt(est.slotsWithFees)} blocks with fees` : undefined} />
        <KeyValue label="Priced txs" value={fmtInt(est?.pricedTxs)} sub={est?.stakeEpoch ? `stake of epoch ${est.stakeEpoch}` : undefined} />
      </dl>

      <h2 className="sr-only">The Fee Index, block by block</h2>
      {empty ? (
        <EmptyBlock title="The indexer has not run yet" body={s.note ?? "Start indexer_app with a Solami key (or on public RPC) and this page fills block by block."} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-12">
          {/* Hero: the running index over the slot strip */}
          <Panel className="flex flex-col gap-5 lg:col-span-8">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="label-caps">
                  {sampled ? "Sampled estimate (demo data, not the index)" : `Solana Fee Index · epoch ${fmtEpoch(est?.epoch ?? epoch)} · running`}
                </span>
                <div className="flex items-baseline gap-2">
                  <span className="num text-5xl font-medium tracking-tight text-ep-text">
                    {est?.value !== null && est?.value !== undefined ? (
                      isLive ? <NumberFlow value={est.value} format={{ maximumFractionDigits: 0 }} locales="en-US" /> : fmtCu(est.value)
                    ) : (
                      "—"
                    )}
                  </span>
                  <span className="text-lg text-ep-muted">µL/CU</span>
                </div>
                <p className="text-sm text-ep-text-2">
                  {delta !== null && s.lastFinal ? (
                    <>
                      <span className="num">{fmtSignedPct(delta, 1)}</span> vs epoch {s.lastFinal.epoch} ({fmtCu(s.lastFinal.value)} µL/CU, final)
                    </>
                  ) : (
                    "No finished epoch to compare with yet."
                  )}
                </p>
                <p className="text-xs text-ep-muted">
                  {est?.coveragePct !== null && est?.coveragePct !== undefined && est.coveragePct < 100
                    ? `Covers ${fmtPct(est.coveragePct, 1)} of the epoch so far (indexing started at slot ${fmtInt(est.coverageFromSlot)}).`
                    : "Covers the whole epoch so far."}
                  {s.stream.catchingUp ? ` Filling ${fmtInt(s.stream.gapSlots)} slots.` : ""}
                  {sampled ? " RPC sampling mode: one slot in N, never posted." : ""}
                </p>
              </div>
              <Tip tip="Stake-weighted median of each leader's median priority fee, from every block's priced, non-vote transactions; leader-paid transactions are left out. 10,000 µL/CU = 0.01 lamports per CU = 2,000 lamports (0.000002 SOL) for 200,000 CU.">
                <span className="flex items-center gap-1.5 text-xs text-ep-muted">
                  <Info className="size-3.5" aria-hidden /> What is µL/CU?
                </span>
              </Tip>
            </div>
            {slots.data?.data.slots.length ? (
              <SlotStrip slots={slots.data.data.slots} indexValue={est?.value ?? null} animate={isLive} />
            ) : slots.isPending ? (
              <Skeleton className="h-80 w-full" />
            ) : slots.isError ? (
              <ErrorCard error={slots.error} what="the newest blocks" onRetry={() => void slots.refetch()} />
            ) : (
              <EmptyBlock title="No blocks yet" body="Blocks appear here one by one as the indexer processes them." />
            )}
          </Panel>

          {/* Stream health */}
          <Panel className="flex flex-col gap-5 lg:col-span-4">
            <SectionHeading as="h3" title="Stream health" />
            <StreamHealth s={s} lastSlotAgo={lastSlotAgo} live={isLive} />
          </Panel>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-12">
        <Panel className="flex flex-col gap-4 lg:col-span-7">
          <SectionHeading
            as="h3"
            title={`How the slot medians spread${dist.data ? ` · epoch ${dist.data.data.epoch}` : ""}`}
            description={dist.data ? `${fmtInt(dist.data.data.slots)} blocks with priced transactions, in log buckets (four per decade).` : undefined}
          />
          {dist.data ? (
            dist.data.data.slots === 0 ? (
              <EmptyBlock title="No priced blocks in this epoch yet" />
            ) : (
              <>
                <DistributionChart dist={dist.data.data} />
                {dist.data.data.percentiles ? (
                  <dl className="grid grid-cols-5 gap-2 border-t border-ep-line pt-3">
                    {(["p10", "p25", "p50", "p75", "p90"] as const).map((k) => (
                      <KeyValue key={k} label={k} value={fmtCu(dist.data!.data.percentiles![k])} valueClassName="text-sm" />
                    ))}
                  </dl>
                ) : null}
              </>
            )
          ) : dist.isError ? (
            <ErrorCard error={dist.error} what="the distribution" onRetry={() => void dist.refetch()} />
          ) : (
            <Skeleton className="h-56 w-full" />
          )}
        </Panel>
        <Panel className="flex flex-col gap-4 lg:col-span-5">
          <SectionHeading as="h3" title="Powered by Solami" description="What this page's data path uses of Solami right now, per component (GET /v1/live/solami, every 10 s)." />
          <SolamiPanel />
        </Panel>
      </div>

      <DockedTables
        epoch={epoch}
        leaders={leaders.data?.data ?? null}
        leadersState={{ pending: leaders.isPending, error: leaders.error, retry: () => void leaders.refetch() }}
        slots={slots.data?.data.slots ?? []}
      />
    </div>
  );
}

function StreamHealth({ s, lastSlotAgo, live }: { s: LiveSummary; lastSlotAgo: number | null; live: boolean }) {
  const st = s.stream;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-md border border-ep-line bg-ep-inset p-3">
        <LiveDot on={live} className="mt-1.5" />
        <div className="min-w-0">
          <p className="text-sm text-ep-text">{s.dataSource}</p>
          <p className="text-xs text-ep-muted">
            {st.source ? MODE_WORDS[st.source] ?? st.source : "no source"} · {st.status}
            {!live ? ` · last block ${fmtAgo(lastSlotAgo)}` : ""}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
        <KeyValue label="Mode" value={st.source ?? "—"} sub={st.endpoint ?? undefined} />
        <KeyValue label="Last block" value={fmtTimeSecIst(st.lastSlotAt)} sub={lastSlotAgo !== null ? fmtAgo(lastSlotAgo) : undefined} />
        <KeyValue label="Indexer seen" value={fmtTimeSecIst(st.indexerSeenAt)} sub="heartbeat" />
        <KeyValue label="Gap fill" value={st.catchingUp ? `${fmtInt(st.gapSlots)} slots` : "none"} sub={st.catchingUp ? "catching up" : "contiguous"} />
      </dl>
      {s.epoch ? (
        <div className="flex flex-col gap-2">
          <div className="flex justify-between text-xs text-ep-muted">
            <span>Epoch {fmtEpoch(s.epoch.number)}</span>
            <span className="num">{fmtPct(s.epoch.progressPct, 1)}</span>
          </div>
          <Progress value={s.epoch.progressPct} aria-label={`Epoch ${s.epoch.number} progress`} />
        </div>
      ) : null}
      <div className="flex flex-col gap-1 border-t border-ep-line pt-3 text-xs text-ep-muted">
        <span className="label-caps">Last finished epoch</span>
        {s.lastFinal ? (
          <span className="text-ep-text-2">
            Epoch {s.lastFinal.epoch}: <span className="num text-ep-text">{fmtCu(s.lastFinal.value)} µL/CU</span>
            {s.lastFinal.postedSignature ? <> · posted <span className="num">{shortKey(s.lastFinal.postedSignature, 4, 4)}</span></> : " · not posted yet"}
            {" · "}
            <a
              className="inline-flex items-center gap-1 underline-offset-4 hover:text-ep-text hover:underline"
              href={`${env.apiUrl}/v1/index/epochs/${s.lastFinal.epoch}`}
              target="_blank"
              rel="noreferrer"
            >
              status <ExternalLink className="size-3" aria-hidden />
            </a>
          </span>
        ) : (
          <span>None yet: the first value lands once an epoch is fully indexed.</span>
        )}
      </div>
    </div>
  );
}

const sh = columnHelper<LiveSlot>();
const slotColumns = [
  sh.accessor("slot", { header: "Slot", meta: { numeric: true }, cell: (c) => fmtInt(c.getValue()) }),
  sh.accessor("time", { header: "Time (IST)", meta: { numeric: true }, enableSorting: false, cell: (c) => fmtTimeSecIst(c.getValue()).replace(" IST", "") }),
  sh.accessor((r) => r.leaderName ?? r.leader, { id: "leader", header: "Leader", cell: (c) => c.row.original.leaderName ?? <span className="num">{shortKey(c.row.original.leader)}</span> }),
  sh.accessor("medianCuPrice", { header: "Median", meta: { numeric: true }, sortUndefined: "last", cell: (c) => fmtCu(c.getValue()) }),
  sh.accessor("p25CuPrice", { header: "p25", meta: { numeric: true }, cell: (c) => fmtCu(c.getValue()) }),
  sh.accessor("p75CuPrice", { header: "p75", meta: { numeric: true }, cell: (c) => fmtCu(c.getValue()) }),
  sh.accessor("pricedTxs", { header: "Priced", meta: { numeric: true }, cell: (c) => fmtInt(c.getValue()) }),
  sh.accessor("unpricedTxs", { header: "No fee", meta: { numeric: true }, cell: (c) => fmtInt(c.getValue()) }),
  sh.accessor("leaderPaidTxs", { header: "Leader-paid", meta: { numeric: true }, cell: (c) => fmtInt(c.getValue()) }),
  sh.accessor("failedTxs", { header: "Failed", meta: { numeric: true }, cell: (c) => fmtInt(c.getValue()) }),
  sh.accessor("source", { header: "Source", enableSorting: false }),
] as Column<LiveSlot>[];

function DockedTables({
  epoch,
  leaders,
  leadersState,
  slots,
}: {
  epoch: number | null;
  leaders: LiveLeaders | null;
  leadersState: { pending: boolean; error: Error | null; retry: () => void };
  slots: LiveSlot[];
}) {
  const [tab, setTab] = useQueryState("tab", parseAsStringLiteral(["leaders", "blocks"] as const).withDefault("leaders"));
  return (
    <Panel className="flex flex-col gap-2 p-0" aria-labelledby="live-tables">
      <h2 id="live-tables" className="sr-only">
        Leaders and blocks
      </h2>
      <Tabs value={tab} onValueChange={(v) => void setTab(v as "leaders" | "blocks")}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ep-line px-5">
          <TabsList variant="line">
            <TabsTrigger value="leaders">Leaders{leaders ? ` · ${fmtInt(leaders.leaderCount)}` : ""}</TabsTrigger>
            <TabsTrigger value="blocks">Recent blocks · {fmtInt(slots.length)}</TabsTrigger>
          </TabsList>
          {leaders && tab === "leaders" ? (
            <span className="text-xs text-ep-muted">
              Epoch {leaders.epoch} · {leaders.final ? "final" : "so far"} · index {fmtCu(leaders.value)} µL/CU · stake {fmtNum(leaders.totalStakeSol / 1e6, 1)}M SOL
            </span>
          ) : null}
        </div>
        <TabsContent value="leaders" className="px-2 pb-3">
          {leaders ? (
            <LeadersTable leaders={leaders.leaders} epoch={leaders.epoch} />
          ) : leadersState.pending ? (
            <SkeletonRows rows={6} className="p-3" />
          ) : leadersState.error ? (
            <ErrorCard error={leadersState.error} what={`the leaders of epoch ${fmtEpoch(epoch)}`} onRetry={leadersState.retry} className="m-3" />
          ) : null}
        </TabsContent>
        <TabsContent value="blocks" className="px-2 pb-3">
          <DataTable columns={slotColumns} data={slots} getRowId={(r) => String(r.slot)} initialSorting={[{ id: "slot", desc: true }]} caption="The newest blocks" emptyText="No blocks yet." />
        </TabsContent>
      </Tabs>
    </Panel>
  );
}
