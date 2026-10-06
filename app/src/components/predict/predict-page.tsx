"use client";
// The Predict page (docs/pages/predict.md): two tabs, Real (USDC through Panta, Solana mainnet) and Points (the free
// tier). The look follows the kit's Predict lock: the Stocktwits poll card inside a data page as the hero, the Kraken
// Pro order form as the ticket on the right, Coinbase's gated ticket for the gates and Reown's preview for review.

import { ArrowDown, Info } from "lucide-react";
import Link from "next/link";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useMemo, useState } from "react";

import { DataStatus } from "@/components/data/source-badge";
import { EmptyBlock, ErrorCard, SectionHeading } from "@/components/data/primitives";
import { PoweredByPanta } from "@/components/integrations/powered-by-panta";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isApiError } from "@/lib/api/client";
import { useLiveSummary } from "@/lib/data/live";
import { usePantaForecast, usePantaMarket, usePantaMarkets } from "@/lib/data/predict";
import type { PantaFeeIndexMarket, PantaMarketCard, PantaSide } from "@/lib/data/types";
import { fmtCu, fmtEpoch, fmtInt, fmtProb, fmtTimeIst } from "@/lib/format";

import { BuyTicket } from "./buy-ticket";
import { ForecastChart } from "./forecast-chart";
import { PointsTab } from "./points-tab";
import { PollCard, isOurs } from "./poll-card";
import { PositionsPanel } from "./positions-panel";
import { Catalog, IntelligenceCard, MarketTape, ResolutionCard, StrikeLadder, TractionStrip } from "./real-sections";

/** The market to feature first: the soonest epoch still trading, the strike priced closest to even. */
function defaultFeatured(ours: PantaFeeIndexMarket[]): PantaFeeIndexMarket | null {
  const open = ours.filter((m) => m.tradable && !m.resolved);
  if (!open.length) return ours[0] ?? null;
  const soonest = Math.min(...open.map((m) => m.epoch));
  return open.filter((m) => m.epoch === soonest).sort((a, b) => Math.abs((a.yesPrice ?? 0.5) - 0.5) - Math.abs((b.yesPrice ?? 0.5) - 0.5))[0];
}

export function PredictPage() {
  const [tab, setTab] = useQueryState("tab", parseAsStringLiteral(["real", "points"] as const));
  const [marketParam, setMarketParam] = useQueryState("market");
  const [side, setSide] = useState<PantaSide>("yes");
  const [catalogPick, setCatalogPick] = useState<PantaMarketCard | null>(null);
  const [forecastEpoch, setForecastEpoch] = useState<number | null>(null);

  const markets = usePantaMarkets();
  const summary = useLiveSummary();
  const notConfigured = isApiError(markets.error, "PANTA_NOT_CONFIGURED");
  const activeTab = tab ?? (notConfigured ? "points" : "real");

  const page = markets.data?.data;
  const sample = markets.data?.source === "sample";
  const ours = useMemo(() => page?.ours ?? [], [page]);
  const selectedOurs = ours.find((m) => m.marketId === marketParam) ?? null;
  const fromCatalog = !selectedOurs && catalogPick && catalogPick.marketId === marketParam ? catalogPick : null;
  const featuredBase: PantaMarketCard | PantaFeeIndexMarket | null = selectedOurs ?? fromCatalog ?? defaultFeatured(ours);
  // Catalog rows carry no prices: read the detail for the featured catalog market.
  const detail = usePantaMarket(featuredBase && !featuredBase.ours ? featuredBase.marketId : null);
  const featured = featuredBase && !featuredBase.ours && detail.data?.data ? detail.data.data.market : featuredBase;
  const featuredOurs = featured && isOurs(featured) ? featured : null;
  const forecast = usePantaForecast(forecastEpoch ?? featuredOurs?.epoch ?? null);

  const live = summary.data?.data;
  const liveIndex = live?.estimate?.value ?? null;
  const liveEpoch = live?.estimate?.epoch ?? null;
  // A live index from an epoch that already has a final value (two sample snapshots of different days) is not drawn.
  const lastFinalEpoch = ours[0]?.intelligence.index.last?.epoch ?? null;
  const liveCurrent = liveEpoch !== null && (lastFinalEpoch === null || liveEpoch > lastFinalEpoch);

  const select = (id: string) => {
    void setMarketParam(id);
    setForecastEpoch(null);
  };

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={
          <>
            <span className="text-ep-info">Panta</span> side track · real-USDC markets on the Solana Fee Index
          </>
        }
        title="Predict"
        badges={
          markets.data ? (
            <DataStatus source={markets.data.source} stale={page?.stale} asOf={page?.asOf} staleWord="Delayed" idleLabel={`Prices ${fmtTimeIst(page?.asOf)}`} sampleNote="Built from the examples in docs/pages/predict.md (6 Oct 2026, 08:30 IST)." />
          ) : null
        }
        description="Every epoch Epoch opens YES/NO markets on Panta on its own number: will the Solana Fee Index close above a strike? Trade them, or anything in Panta's catalog, in USDC on Solana mainnet. Each of our markets resolves from Epoch's final, on-chain index."
        actions={
          <Link href="#integration" className="inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm text-ep-text-2 transition-colors duration-200 hover:bg-ep-hover hover:text-ep-text">
            How we integrate Panta <ArrowDown className="size-3.5" aria-hidden />
          </Link>
        }
      />

      <Tabs value={activeTab} onValueChange={(v) => void setTab(v as "real" | "points")}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-ep-line">
          <TabsList variant="line">
            <TabsTrigger value="real">Real · USDC via Panta</TabsTrigger>
            <TabsTrigger value="points">Points</TabsTrigger>
          </TabsList>
          {activeTab === "real" ? <PoweredByPanta /> : null}
        </div>

        <TabsContent value="real" className="flex flex-col gap-8 pt-6">
          {markets.isPending ? (
            <div className="grid gap-4 lg:grid-cols-12">
              <div className="flex flex-col gap-4 lg:col-span-8">
                <Skeleton className="h-72" />
                <Skeleton className="h-40" />
              </div>
              <Skeleton className="h-96 lg:col-span-4" />
            </div>
          ) : notConfigured ? (
            <EmptyBlock
              title="Real-money markets are coming soon"
              body="This server has no Panta key yet. The Points tab works today."
              action={<button type="button" className="text-sm text-ep-accent underline-offset-4 hover:underline" onClick={() => void setTab("points")}>Open the Points tab</button>}
            />
          ) : !page ? (
            <ErrorCard error={markets.error} what="the markets" onRetry={() => void markets.refetch()} />
          ) : (
            <>
              <Ticker ours={ours} liveIndex={liveIndex} liveEpoch={liveEpoch} liveSource={summary.data?.source} />
              <AccessBanner access={page.access} onPoints={() => void setTab("points")} />
              <TractionStrip />
              <div className="grid gap-6 lg:grid-cols-12">
                <div className="flex min-w-0 flex-col gap-6 lg:col-span-8">
                  {featured ? (
                    <PollCard market={featured} sample={sample} side={side} onPick={setSide} />
                  ) : (
                    <EmptyBlock title="The next Fee Index market opens soon" body="Epoch's bot opens a strike ladder for each epoch before it starts. Meanwhile, Panta's catalog is below." />
                  )}
                  {featuredOurs ? (
                    <section aria-labelledby="forecast-title" className="flex flex-col gap-4 rounded-lg border border-ep-line bg-ep-surface p-5">
                      <SectionHeading
                        as="h3"
                        id="forecast-title"
                        title="Crowd forecast"
                        description={
                          forecast.data?.data.reason ? (
                            forecast.data.data.reason
                          ) : forecast.data?.data.median !== null && forecast.data?.data.median !== undefined ? (
                            <>
                              The crowd expects ≈ <span className="num text-ep-text">{fmtCu(forecast.data.data.median)}</span> µL/CU for epoch {fmtEpoch(forecast.data.data.epoch)}
                              {forecast.data.data.band ? (
                                <>
                                  {" "}
                                  (80%: <span className="num">{fmtCu(forecast.data.data.band.low)} – {fmtCu(forecast.data.data.band.high)}</span>)
                                </>
                              ) : null}
                              .
                            </>
                          ) : (
                            "No live prices yet."
                          )
                        }
                        action={
                          forecast.data && forecast.data.data.epochs.length > 1 ? (
                            <ToggleGroup
                              value={[String(forecast.data.data.epoch)]}
                              onValueChange={(v: string[]) => v[0] && setForecastEpoch(Number(v[0]))}
                              aria-label="Forecast epoch"
                            >
                              {forecast.data.data.epochs.map((e) => (
                                <ToggleGroupItem key={e} value={String(e)} size="sm" variant="outline" className="aria-pressed:border-ep-accent-line aria-pressed:bg-ep-accent-soft aria-pressed:text-ep-accent">
                                  Epoch {fmtEpoch(e)}
                                </ToggleGroupItem>
                              ))}
                            </ToggleGroup>
                          ) : null
                        }
                      />
                      {forecast.data && !forecast.data.data.reason && forecast.data.data.strikes.length ? (
                        <ForecastChart forecast={forecast.data.data} liveIndex={liveCurrent ? liveIndex : null} liveEpoch={liveEpoch} highlightStrike={featuredOurs.thresholdMicroLamports} />
                      ) : forecast.isPending ? (
                        <Skeleton className="h-64 w-full" />
                      ) : null}
                      <div className="flex flex-wrap items-start gap-3 border-t border-ep-line pt-3 text-xs text-ep-muted">
                        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                        <p className="min-w-0 flex-1">{forecast.data?.data.disclaimer ?? "Informational only, not advice."}</p>
                        <PoweredByPanta />
                      </div>
                      <div className="border-t border-ep-line pt-4">
                        <IntelligenceCard market={featuredOurs} />
                      </div>
                    </section>
                  ) : null}
                  {ours.length ? (
                    <section aria-labelledby="ladder-title" className="flex flex-col gap-3">
                      <SectionHeading as="h3" id="ladder-title" title="Epoch's markets" description="One market per strike, per epoch. Trading closes before the epoch starts, so nobody trades while watching its fees." action={<PoweredByPanta />} />
                      <StrikeLadder markets={ours} selectedId={featured?.marketId ?? null} onSelect={select} sample={sample} />
                    </section>
                  ) : null}
                  {featured ? <MarketTape marketId={featured.marketId} sample={sample} /> : null}
                  {featuredOurs ? <ResolutionCard market={featuredOurs} /> : null}
                </div>
                <aside className="flex min-w-0 flex-col gap-4 lg:col-span-4 lg:sticky lg:top-20 lg:self-start" aria-label="Trade">
                  {featured ? <BuyTicket market={featured} access={page.access} sample={sample} side={side} onSide={setSide} /> : null}
                  <PositionsPanel sample={sample} />
                </aside>
              </div>
              <Catalog
                selectedId={featured?.marketId ?? null}
                sample={sample}
                onSelect={(m) => {
                  setCatalogPick(m);
                  select(m.marketId);
                  window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
                }}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="points" className="pt-6">
          <PointsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Ticker({ ours, liveIndex, liveEpoch, liveSource }: { ours: PantaFeeIndexMarket[]; liveIndex: number | null; liveEpoch: number | null; liveSource: string | undefined }) {
  const open = ours.filter((m) => m.tradable && !m.resolved).sort((a, b) => a.epoch - b.epoch || a.thresholdMicroLamports - b.thresholdMicroLamports);
  const last = ours[0]?.intelligence.index.last ?? null;
  // Two sample snapshots can come from different days: never show a "live" index older than the last final one.
  const liveBehind = liveEpoch !== null && last !== null && liveEpoch <= last.epoch;
  return (
    <ul className="flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-ep-line py-2.5 text-xs" aria-label="Market ticker">
      <li className="flex items-center gap-2">
        <span className="label-caps">Live index</span>
        {liveBehind ? (
          <span className="text-ep-muted">— · the {liveSource === "sample" ? "sample snapshot" : "stream"} is from epoch {fmtEpoch(liveEpoch)}</span>
        ) : (
          <>
            <span className="num text-ep-text">{fmtCu(liveIndex)}</span>
            <span className="text-ep-muted">
              µL/CU · epoch {fmtEpoch(liveEpoch)} · {liveSource === "sample" ? "sample" : "Solami"}
            </span>
          </>
        )}
      </li>
      {last ? (
        <li className="flex items-center gap-2">
          <span className="label-caps">Last {last.status}</span>
          <span className="num text-ep-text">{fmtCu(last.value)}</span>
          <span className="text-ep-muted">epoch {fmtEpoch(last.epoch)}</span>
        </li>
      ) : null}
      {open.map((m) => (
        <li key={m.marketId} className="flex items-center gap-1.5">
          <span className="text-ep-muted">
            {fmtEpoch(m.epoch)} &gt; {fmtInt(m.thresholdMicroLamports)}
          </span>
          <span className="num text-ep-accent">{fmtProb(m.yesPrice)}</span>
        </li>
      ))}
    </ul>
  );
}

function AccessBanner({ access, onPoints }: { access: { tradingEnabled: boolean; geoBlocked: boolean; country: string | null; reason: string | null }; onPoints: () => void }) {
  if (access.tradingEnabled && !access.geoBlocked) return null;
  const text = access.geoBlocked
    ? access.country === null
      ? access.reason ?? "Trading needs your region, which could not be determined."
      : "Real-money trading isn't available in your region."
    : access.reason ?? "Trading is switched off right now. You can still browse.";
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-ep-warn-line bg-ep-warn-soft p-4 text-sm text-ep-text-2">
      <span className="flex-1">{text}</span>
      {access.geoBlocked ? (
        <button type="button" onClick={onPoints} className="text-ep-accent underline-offset-4 hover:underline">
          Use the free Points tab
        </button>
      ) : null}
    </div>
  );
}
