"use client";
// The Real tab's supporting blocks: the "Epoch on Panta" traction strip, the strike ladder of Epoch's markets, the
// Fee Index intelligence (informational), the market tape, the resolution card and Panta's catalog.

import { ChevronDown, ExternalLink, Search } from "lucide-react";
import { useState } from "react";
import { useDebounceValue } from "usehooks-ts";

import { DataStatus, StaleBadge } from "@/components/data/source-badge";
import { EmptyBlock, ErrorCard, KeyValue, KeyValueGrid, SectionHeading, Tip, Unavailable } from "@/components/data/primitives";
import { PoweredByPanta } from "@/components/integrations/powered-by-panta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { env } from "@/lib/env";
import { useFeeIndexEpoch, usePantaCategories, usePantaMarket, usePantaMarkets, usePantaStats } from "@/lib/data/predict";
import type { PantaFeeIndexMarket, PantaMarketCard } from "@/lib/data/types";
import { fmtCountdown, fmtCu, fmtDateTimeIst, fmtEpoch, fmtInt, fmtProb, fmtSharePrice, fmtTimeIst, fmtUsdc } from "@/lib/format";
import { cn } from "@/lib/utils";

import { MarketArt, isOurs, useNow } from "./poll-card";

// ── Traction ("Epoch on Panta") ───────────────────────────────────────────────────────────────────────
export function TractionStrip() {
  const stats = usePantaStats();
  const t = stats.data?.data.traction;
  return (
    <section aria-labelledby="traction-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="traction-title" className="label-caps text-ep-text-2">
          Epoch on Panta
        </h2>
        {stats.data ? (
          <DataStatus
            source={stats.data.source}
            stale={t?.stale}
            asOf={t?.asOf}
            staleWord="Delayed"
            idleLabel={`As of ${fmtTimeIst(t?.asOf)}`}
            unavailable={!!t && t.asOf === null}
            unavailableLabel="Panta's metrics not readable right now"
            unavailableDetail={stats.data.data.note || undefined}
            sampleNote="The traction example in docs/pages/predict.md."
          />
        ) : null}
        <PoweredByPanta />
      </div>
      {t && t.asOf === null ? (
        <Unavailable body={`${stats.data?.data.note ? `${stats.data.data.note} ` : ""}Epoch's own counts: ${fmtInt(stats.data?.data.epoch.trades ?? 0)} trades and ${fmtInt(stats.data?.data.epoch.marketsCreated ?? 0)} markets created through Epoch so far.`} />
      ) : t ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-lg border border-ep-line bg-ep-surface p-4 sm:grid-cols-3 lg:grid-cols-6">
          <KeyValue label="Markets created" value={fmtInt(t.marketsCreated)} sub={t.createsByStatus.pending ? `${fmtInt(t.createsByStatus.pending)} pending` : "registered on Panta"} />
          <KeyValue label="Volume (attributed)" value={`${fmtUsdc(t.attributedVolumeUsdc)}`} sub="USDC credited to Epoch" />
          <KeyValue label="Volume on our markets" value={fmtUsdc(t.marketsVolumeUsdc)} sub="USDC, any app" />
          <KeyValue label="Traders" value={`${fmtInt(t.traders)}${t.tradersComplete ? "" : "+"}`} sub="distinct wallets" />
          <KeyValue label="Trades" value={fmtInt(t.attributedTrades)} sub={Object.entries(t.tradesByKind).map(([k, v]) => `${fmtInt(v)} ${k}`).join(" · ")} />
          <KeyValue
            label="Creator fees"
            value={fmtUsdc(t.creatorFeesClaimedUsdc)}
            sub={
              <Tip tip="Panta's primary fee on buys through Epoch, estimated as Panta's metrics docs suggest (volume × 200 bps).">
                ≈ fees to Panta (est.) {fmtUsdc(t.estimatedProtocolFeesUsdc)}
              </Tip>
            }
          />
        </dl>
      ) : stats.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <ErrorCard error={stats.error} what="Epoch's traction on Panta" onRetry={() => void stats.refetch()} />
      )}
    </section>
  );
}

// ── Strike ladder (Epoch's markets) ───────────────────────────────────────────────────────────────────
export function StrikeLadder({
  markets,
  selectedId,
  onSelect,
  sample,
}: {
  markets: PantaFeeIndexMarket[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  sample: boolean;
}) {
  const now = useNow(sample ? Date.parse(markets[0]?.pricesAsOf ?? markets[0]?.startsAt ?? "") || undefined : undefined);
  const byEpoch = new Map<number, PantaFeeIndexMarket[]>();
  for (const m of markets) byEpoch.set(m.epoch, [...(byEpoch.get(m.epoch) ?? []), m]);
  const epochs = [...byEpoch.keys()].sort((a, b) => b - a);
  return (
    <div className="flex flex-col gap-4">
      {epochs.map((e) => (
        <div key={e} className="flex flex-col gap-2">
          <h3 className="label-caps">
            Epoch {fmtEpoch(e)} · {byEpoch.get(e)!.length} {byEpoch.get(e)!.length === 1 ? "strike" : "strikes"}
          </h3>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {byEpoch
              .get(e)!
              .sort((a, b) => a.thresholdMicroLamports - b.thresholdMicroLamports)
              .map((m) => {
                const active = m.marketId === selectedId;
                return (
                  <li key={m.marketId}>
                    <button
                      type="button"
                      onClick={() => onSelect(m.marketId)}
                      aria-pressed={active}
                      className={cn(
                        "flex w-full flex-col gap-2 rounded-md border p-3 text-left transition-colors duration-200",
                        active ? "border-ep-accent bg-ep-accent-soft" : "border-ep-line bg-ep-surface hover:border-ep-line-strong hover:bg-ep-hover",
                      )}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-sm text-ep-text">
                          Above <span className="num">{fmtInt(m.thresholdMicroLamports)}</span> <span className="text-xs text-ep-muted">µL/CU</span>
                        </span>
                        <span className="num text-base text-ep-accent">{m.resolved ? "—" : fmtProb(m.yesPrice)}</span>
                      </span>
                      <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-ep-muted">
                        <span className="num">{fmtUsdc(m.volumeUsdc)} USDC</span>
                        <span>{m.resolved ? "Resolved" : m.tradable ? `closes in ${fmtCountdown(m.endsAt, now)}` : "Trading closed"}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ── Fee Index intelligence (informational) ────────────────────────────────────────────────────────────
export function IntelligenceCard({ market }: { market: PantaFeeIndexMarket }) {
  const i = market.intelligence;
  return (
    <section aria-labelledby="intel-title" className="flex flex-col gap-4">
      <SectionHeading
        as="h3"
        id="intel-title"
        title="Fee Index intelligence"
        action={<Badge variant="outline" className="text-ep-muted">Informational</Badge>}
      />
      <KeyValueGrid cols={4}>
        <KeyValue label="Market implies" value={fmtProb(i.impliedProbability)} sub="the YES price" />
        <KeyValue
          label="Past epochs above"
          value={fmtProb(i.modelProbability)}
          sub={`${fmtInt(i.model.above)} of the last ${fmtInt(i.model.sample)} closed above ${fmtInt(market.thresholdMicroLamports)}`}
        />
        <KeyValue label="Gap" value={i.gapPct === null ? "—" : `${i.gapPct > 0 ? "+" : i.gapPct < 0 ? "−" : ""}${Math.abs(i.gapPct)} pts`} sub="implied − past share" />
        <KeyValue
          label="Index"
          value={i.index.last ? `${fmtCu(i.index.last.value)}` : "—"}
          sub={
            i.index.last
              ? `epoch ${fmtEpoch(i.index.last.epoch)} (${i.index.last.status})${i.index.running ? ` · running ${fmtEpoch(i.index.running.epoch)}: ${fmtCu(i.index.running.value)}` : ""}`
              : undefined
          }
        />
      </KeyValueGrid>
      <p className="text-xs leading-relaxed text-ep-muted">{i.note}</p>
    </section>
  );
}

// ── Market tape ───────────────────────────────────────────────────────────────────────────────────────
export function MarketTape({ marketId, sample }: { marketId: string; sample: boolean }) {
  const detail = usePantaMarket(marketId);
  const d = detail.data?.data;
  return (
    <section aria-labelledby="tape-title" className="flex flex-col gap-3">
      <SectionHeading as="h3" id="tape-title" title="Recent trades" action={d?.stale ? <StaleBadge asOf={d.asOf} word="Delayed" /> : <PoweredByPanta />} />
      {detail.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : !d ? (
        detail.isError ? <ErrorCard error={detail.error} what="this market's trades" onRetry={() => void detail.refetch()} /> : <EmptyBlock title="No trades yet" />
      ) : d.note ? (
        <p className="text-sm text-ep-muted">{d.note}</p>
      ) : d.trades.length === 0 ? (
        <EmptyBlock title="No trades yet" body="The first buy appears here." />
      ) : (
        <ul className="flex flex-col divide-y divide-ep-line rounded-md border border-ep-line">
          {d.trades.slice(0, 12).map((t, i) => (
            <li key={`${t.signature ?? i}-${t.at}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs">
              <span className={cn("w-10 font-medium", t.side === "yes" ? "text-ep-accent" : t.side === "no" ? "text-ep-info" : "text-ep-muted")}>{t.side ? t.side.toUpperCase() : "—"}</span>
              <span className="num text-ep-text">{t.amountUsdc ? `${fmtUsdc(t.amountUsdc)} USDC` : "—"}</span>
              <span className="num text-ep-muted">{t.side === "no" ? t.noShares : t.yesShares} shares</span>
              <span className="text-ep-muted">{t.kind ?? "—"}</span>
              <span className="num text-ep-muted">{t.walletShort ?? "—"}</span>
              <span className="num ml-auto text-ep-muted">{fmtTimeIst(t.at)}</span>
              {t.signature && !sample ? (
                <a className="text-ep-text-2 hover:text-ep-accent" href={`https://explorer.solana.com/tx/${t.signature}`} target="_blank" rel="noreferrer" aria-label="Open the trade on Solana Explorer">
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ── Resolution ────────────────────────────────────────────────────────────────────────────────────────
export function ResolutionCard({ market }: { market: PantaFeeIndexMarket }) {
  const idx = useFeeIndexEpoch(market.epoch);
  const v = idx.data?.data;
  return (
    <section aria-labelledby="resolution-title" className="flex flex-col gap-3">
      <SectionHeading as="h3" id="resolution-title" title="Resolution" />
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-ep-line bg-ep-inset p-3 text-sm">
        <span className="label-caps">Epoch {fmtEpoch(market.epoch)} index</span>
        <span className="num text-ep-text">{v?.value !== null && v?.value !== undefined ? `${fmtCu(v.value)} µL/CU` : "—"}</span>
        <Badge variant="outline" className={v?.status === "final" ? "border-ep-accent-line text-ep-accent" : "text-ep-text-2"}>
          {v?.status ?? (idx.isPending ? "…" : "unknown")}
        </Badge>
        <span className="text-xs text-ep-muted">
          {v?.status === "final"
            ? `${market.thresholdMicroLamports < (v.value ?? 0) ? "above" : "not above"} ${fmtInt(market.thresholdMicroLamports)}: resolves ${market.thresholdMicroLamports < (v.value ?? 0) ? "YES" : "NO"}`
            : "Counts once final: posted on chain and past its dispute window"}
        </span>
        <a href={`${env.apiUrl}/v1/index/epochs/${market.epoch}`} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs text-ep-text-2 underline-offset-4 hover:text-ep-accent hover:underline">
          Resolution source <ExternalLink className="size-3" aria-hidden />
        </a>
      </div>
      <Collapsible>
        <CollapsibleTrigger className="group flex min-h-9 items-center gap-1 text-sm text-ep-text-2 hover:text-ep-text">
          The rule <ChevronDown className="size-4 transition-transform duration-200 group-data-[panel-open]:rotate-180" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2 text-sm leading-relaxed text-ep-text-2">{market.resolutionRule}</CollapsibleContent>
      </Collapsible>
      <ul className="flex flex-col gap-1 text-xs">
        {market.sourcesOfTruth.map((s) => (
          <li key={s}>
            <a href={s} target="_blank" rel="noreferrer" className="num break-all text-ep-muted underline-offset-4 hover:text-ep-text hover:underline">
              {s}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Panta's catalog ───────────────────────────────────────────────────────────────────────────────────
export function Catalog({ onSelect, selectedId, sample }: { onSelect: (m: PantaMarketCard) => void; selectedId: string | null; sample: boolean }) {
  const categories = usePantaCategories();
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [debouncedQ] = useDebounceValue(q, 500);
  const search = debouncedQ.trim().length >= 2 ? debouncedQ.trim() : null;
  const markets = usePantaMarkets({ category, q: search });
  const page = markets.data?.data;
  const items = page?.discover.items ?? [];
  return (
    <section aria-labelledby="catalog-title" className="flex flex-col gap-4">
      <SectionHeading
        id="catalog-title"
        title="Panta's catalog"
        description="Every public market on Panta, tradable from here with the same ticket. Catalog rows carry no live prices: pick one to read its prices."
        action={<PoweredByPanta />}
      />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Category">
          {[null, ...(categories.data?.data.categories ?? [])].map((c) => (
            <Button key={c ?? "all"} size="xs" variant={category === c ? "secondary" : "outline"} aria-pressed={category === c} onClick={() => setCategory(c)} className="capitalize">
              {c ?? "All"}
            </Button>
          ))}
        </div>
        <label className="relative sm:ml-auto sm:w-64">
          <span className="sr-only">Search markets</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ep-muted" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search markets" className="h-9 pl-9" />
        </label>
      </div>
      {markets.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyBlock
          title="No markets match"
          action={
            <Button variant="outline" size="sm" onClick={() => (setCategory(null), setQ(""))}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((m) => (
            <li key={m.marketId}>
              <button
                type="button"
                onClick={() => onSelect(m)}
                aria-pressed={m.marketId === selectedId}
                className={cn(
                  "flex h-full w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors duration-200",
                  m.marketId === selectedId ? "border-ep-accent bg-ep-accent-soft" : "border-ep-line bg-ep-surface hover:border-ep-line-strong hover:bg-ep-hover",
                )}
              >
                <MarketArt market={m} sample={sample} className="size-10" />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-sm font-medium text-ep-text">{m.title}</span>
                  <span className="flex flex-wrap gap-x-3 text-xs text-ep-muted">
                    <span className="capitalize">{m.category ?? "other"}</span>
                    <span className="num">{fmtUsdc(m.volumeUsdc)} USDC</span>
                    <span>{m.tradable ? `ends ${fmtDateTimeIst(m.endsAt)}` : m.phase}</span>
                    {m.yesPrice !== null ? <span className="num">YES {fmtSharePrice(m.yesPrice)}</span> : null}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {page?.discover.searched ? <p className="text-xs text-ep-muted">Searched the first {fmtInt(page.discover.searched)} catalog markets.</p> : null}
      {page ? <p className="text-xs text-ep-muted">Catalog as of {fmtTimeIst(page.asOf)}{page.stale ? " (delayed: Panta could not be read)" : ""}</p> : null}
    </section>
  );
}

export { isOurs };
