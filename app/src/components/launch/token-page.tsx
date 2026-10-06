"use client";
// /launch/[mint]: Wealthsimple's NVDA page (the kit's lock): an identity row with a watch star and "View on ▾", one hero
// price with its change, one chart with dashed reference lines and pills under it, the sticky Trade card on the right
// (a bottom sheet on phones, LP28), then the blocks that say what backs the token (token-sections.tsx).
// Data (docs/pages/launch.md): GET /page for the first paint, /buybacks, /candles, /holders and /fees, and WS
// `launch:<mint>` merged into the caches (useLaunchStream). Sample mode shows recorded runs, labelled Sample.

import { ArrowLeft, ChevronDown, ExternalLink, Star } from "lucide-react";
import Link from "next/link";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useCallback, useMemo, useState } from "react";
import { useMediaQuery } from "usehooks-ts";
import { useWallet } from "@solana/wallet-adapter-react";

import { EmptyBlock, ErrorCard, PriceText, SectionHeading, Tip } from "@/components/data/primitives";
import { DataStatus } from "@/components/data/source-badge";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuLinkItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { apiGet, isApiError } from "@/lib/api/client";
import { useStreamStatus } from "@/lib/api/stream";
import { useLaunchBuybacks, useLaunchCandles, useLaunchFees, useLaunchHolders, useLaunchPage, useLaunchStream } from "@/lib/data/launch";
import { isSampleKind } from "@/lib/data/query";
import type { LaunchCandleInterval, LaunchTrade, LaunchTradeList } from "@/lib/data/types";
import { clusterLabel, explorerAddress } from "@/lib/explorers";
import { fmtDateTimeIst, fmtSignedPct, fmtSolValue, fmtTimeIst, fmtUsd, shortKey } from "@/lib/format";
import { cn } from "@/lib/utils";

import { TradesTable } from "./fun-launch/trades-table";
import { HowItWorksDialog } from "./how-it-works";
import { initials, STATUS_WORDS, useLaunchWatchlist } from "./launch-list";
import { INTERVALS, PriceChart } from "./price-chart";
import { AboutBlock, BacksGrid, BuybacksBlock, CurveCard, FeesBlock, HoldersBlock, TermsBlock } from "./token-sections";
import { TradeCard, type TradeSide } from "./trade-card";

const SIDES = ["buy", "sell", "redeem"] as const;
const INTERVAL_VALUES = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;

export function TokenPage({ routeKey }: { routeKey: string }) {
  const pageQuery = useLaunchPage(routeKey);
  const sourced = pageQuery.data;
  const page = sourced?.data ?? null;
  // `recorded`: this browser shows fixtures (the API is unreachable or sample mode is forced): no explorer links, no
  // trading. `sample`: the badge, also when the API itself labels its answer sample (it could not read the chain).
  const recorded = sourced?.source === "sample";
  const sample = recorded || isSampleKind(page?.kind);
  const live = sourced?.source === "api";
  const socket = useStreamStatus();
  const mint = page?.launch.mint ?? null;

  useLaunchStream(page, routeKey, live);
  const feedQ = useLaunchBuybacks(mint, page?.links.buybacks ?? null);
  const holdersQ = useLaunchHolders(mint, page?.holders);
  const feesQ = useLaunchFees(mint, page?.fees);
  const [intervalParam, setIntervalParam] = useQueryState("interval", parseAsStringLiteral(INTERVAL_VALUES));
  const interval: LaunchCandleInterval = intervalParam ?? page?.candles.interval ?? "15m";
  const candlesQ = useLaunchCandles(mint, interval);
  const [sideParam, setSide] = useQueryState("side", parseAsStringLiteral(SIDES).withDefault("buy"));
  const watch = useLaunchWatchlist();
  const wallet = useWallet();
  const address = wallet.publicKey?.toBase58() ?? null;
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 64rem)", { initializeWithValue: false });

  // Older trades (/trades?before=): the bundle has the newest 50.
  const [older, setOlder] = useState<{ trades: LaunchTrade[]; cursor: string | null; done: boolean; loading: boolean; error: string | null }>({ trades: [], cursor: null, done: false, loading: false, error: null });
  const loadOlder = useCallback(async () => {
    if (!page) return;
    setOlder((o) => ({ ...o, loading: true, error: null }));
    try {
      const path = older.cursor ? `${page.links.trades}?limit=50&before=${encodeURIComponent(older.cursor)}` : `${page.links.trades}?limit=100`;
      const res = await apiGet<LaunchTradeList>(path);
      setOlder((o) => ({ trades: [...o.trades, ...res.trades], cursor: res.nextCursor, done: res.nextCursor === null, loading: false, error: null }));
    } catch (e) {
      setOlder((o) => ({ ...o, loading: false, error: e instanceof Error ? e.message : "Couldn't load older trades." }));
    }
  }, [page, older.cursor]);

  const trades = useMemo(() => {
    const seen = new Set<string>();
    return [...(page?.trades ?? []), ...older.trades]
      .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
      .sort((a, b) => b.slot - a.slot || Date.parse(b.t) - Date.parse(a.t));
  }, [page?.trades, older.trades]);

  if (pageQuery.isPending) return <TokenSkeleton />;
  if (!page) {
    if (isApiError(pageQuery.error, "NOT_FOUND") || (sourced && sourced.data === null))
      return (
        <div className="flex flex-col gap-6">
          <BackLink />
          <h1 className="text-3xl font-semibold tracking-tight text-ep-text">Token not found</h1>
          <EmptyBlock
            title={`No revenue token called ${routeKey.length > 16 ? shortKey(routeKey, 6, 6) : routeKey}`}
            body="It is not in the launch registry. Check the mint or the symbol."
            action={
              <Link href="/launch" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
                See every launch
              </Link>
            }
          />
        </div>
      );
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
        <h1 className="text-3xl font-semibold tracking-tight text-ep-text">{routeKey.length > 16 ? shortKey(routeKey, 6, 6) : routeKey}</h1>
        <ErrorCard error={pageQuery.error} what="this token" onRetry={() => void pageQuery.refetch()} />
      </div>
    );
  }

  const { launch, market, detail, revenueToken, network } = page;
  const feed = feedQ.data?.data ?? null;
  const escrow = revenueToken.buybackEscrow ?? detail.escrow.address ?? feed?.escrow.address ?? null;
  const price = market.priceSol ?? launch.priceSol;
  const sinceOpen = price !== null && detail.curve.bandLowSol ? ((price - detail.curve.bandLowSol) / detail.curve.bandLowSol) * 100 : null;
  const day = market.day.priceChangePct;
  const marketKnown = market.freshness.asOf !== null;
  const marketLive = live && socket.state === "open" && !market.freshness.stale && marketKnown;
  const cluster = network === "mainnet" ? null : network;
  const watched = watch.list.includes(launch.symbol);
  const holders = holdersQ.data?.data ?? page.holders;
  const fees = feesQ.data?.data ?? page.fees;
  const buybackTrades = escrow ? trades.filter((t) => t.trader === escrow) : [];
  const side: TradeSide = sideParam;

  const card = (prefix: string, inSheet = false) => (
    <TradeCard
      page={page}
      feed={feed}
      sample={recorded}
      side={side}
      onSide={(s) => void setSide(s)}
      watched={watched}
      onWatch={() => watch.toggle(launch.symbol)}
      onPending={setPending}
      onBusy={setBusy}
      idPrefix={prefix}
      inSheet={inSheet}
    />
  );

  const viewOn: { label: string; address: string | null }[] = [
    { label: "Token mint", address: launch.mint },
    { label: "Curve pool (DBC)", address: detail.curve.dbcPool },
    { label: "DAMM v2 pool", address: market.graduation.dammPool ?? detail.curve.dammPool },
    { label: "Buyback escrow", address: escrow },
    { label: "RevenueToken account", address: revenueToken.address },
    { label: "Epoch treasury", address: revenueToken.treasury },
  ];

  return (
    <div className="flex flex-col gap-8 pb-24 lg:pb-0">
      <BackLink />

      {/* Identity row (LP12–LP13) */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <span aria-hidden className="num flex size-14 shrink-0 items-center justify-center rounded-full border border-ep-accent-line bg-ep-accent-soft text-lg text-ep-accent">
            {initials(launch.validator.name) || launch.symbol.slice(1, 3).toUpperCase()}
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold tracking-tight text-ep-text">{launch.symbol}</h1>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-pressed={watched}
                aria-label={watched ? `Stop watching ${launch.symbol}` : `Watch ${launch.symbol}`}
                onClick={() => watch.toggle(launch.symbol)}
              >
                <Star className={cn(watched ? "fill-ep-accent text-ep-accent" : "text-ep-muted")} aria-hidden />
              </Button>
              <Badge
                variant="outline"
                className={cn(
                  "uppercase tracking-wider",
                  market.status === "curve" && "border-ep-accent-line bg-ep-accent-soft text-ep-accent",
                  market.status === "graduated" && "border-ep-info-line bg-ep-info-soft text-ep-info",
                  market.status === "upcoming" && "border-ep-warn-line bg-ep-warn-soft text-ep-warn",
                )}
              >
                {market.graduation.state === "complete" ? "Graduating" : STATUS_WORDS[market.status]}
              </Badge>
              <Tip tip={`Epoch's program and this token's Meteora pools run on ${clusterLabel(network).toLowerCase()} for now.`}>
                <Badge variant="outline" className="border-ep-warn-line bg-ep-warn-soft font-mono uppercase text-ep-warn">
                  {clusterLabel(network)}
                </Badge>
              </Tip>
            </div>
            <p className="truncate text-sm text-ep-text-2">
              {launch.name} · by {launch.validator.name}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <HowItWorksDialog />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
              View on <ChevronDown aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuGroup>
                <DropdownMenuLabel>{recorded ? "Sample: recorded on a local chain" : `Solana Explorer · ${clusterLabel(network)}`}</DropdownMenuLabel>
                {viewOn.map((v) =>
                  v.address && !recorded ? (
                    <DropdownMenuLinkItem key={v.label} href={explorerAddress(v.address, cluster)} target="_blank" rel="noreferrer" className="justify-between">
                      <span>{v.label}</span>
                      <span className="num flex items-center gap-1 text-xs text-ep-muted">
                        {shortKey(v.address)} <ExternalLink className="size-3" aria-hidden />
                      </span>
                    </DropdownMenuLinkItem>
                  ) : (
                    <DropdownMenuItem key={v.label} disabled className="justify-between">
                      <span>{v.label}</span>
                      <span className="num text-xs text-ep-muted">{v.address ? shortKey(v.address) : "none yet"}</span>
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="grid gap-10 lg:grid-cols-12">
        <div className="flex min-w-0 flex-col gap-12 lg:col-span-8">
          {/* Hero (LP14) */}
          <section aria-label="Price" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <DataStatus
                source={sample ? "sample" : sourced?.source}
                live={marketLive}
                stale={market.freshness.stale}
                unavailable={!marketKnown}
                unavailableLabel="Market not readable right now"
                unavailableDetail="The API could not read the pool this time; the price, raise and market cap are not shown as current."
                asOf={market.freshness.asOf}
                liveDetail={page.ingest.mode}
                idleLabel={`Read ${fmtTimeIst(market.freshness.asOf)}`}
                sampleNote={page.note ?? undefined}
              />
              {page.unavailable.length ? <span className="text-xs text-ep-muted">Not available right now: {page.unavailable.join(", ")}</span> : null}
            </div>
            {market.status === "upcoming" ? (
              <p className="text-4xl font-medium text-ep-text">
                <PriceText value={launch.bandLowSol} />–<PriceText value={launch.bandHighSol} /> <span className="text-unit text-ep-muted">SOL</span>
              </p>
            ) : !marketKnown ? (
              <p className="flex flex-col gap-1">
                <span className="text-4xl font-medium text-ep-muted sm:text-5xl">—</span>
                <span className="text-sm text-ep-muted">The pool could not be read right now, so there is no current price.</span>
              </p>
            ) : (
              <Tip
                tip={
                  <>
                    <span>
                      {price !== null ? `${price.toPrecision(6)} SOL a token` : "No price yet"}
                      {market.priceUsd !== null ? ` · ≈ ${fmtUsd(market.priceUsd)}` : ""}
                    </span>
                    <span className="text-ep-muted">
                      From the {market.venue === "dbc" ? "Meteora curve" : market.venue === "damm-v2" ? "Meteora DAMM v2 pool" : "pool"}, read {fmtDateTimeIst(market.freshness.asOf)}.
                    </span>
                  </>
                }
                className="self-start"
              >
                <span className="text-4xl font-medium text-ep-text sm:text-5xl">
                  <PriceText value={price} />
                  <span className="text-unit ml-2 text-ep-muted">SOL</span>
                </span>
              </Tip>
            )}
            <p className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-sm", !marketKnown && "hidden")}>
              {market.priceUsd !== null ? <span className="num text-ep-text-2">≈ {fmtUsd(market.priceUsd)}</span> : null}
              {sinceOpen !== null && market.status !== "upcoming" ? (
                <span>
                  <span className={cn("num", sinceOpen < 0 ? "text-ep-warn" : "text-ep-accent")}>{fmtSignedPct(sinceOpen, 1)}</span> <span className="text-ep-text-2">since the curve opened</span>
                </span>
              ) : null}
              {day !== null ? (
                <span>
                  <span className={cn("num", day < 0 ? "text-ep-warn" : "text-ep-text-2")}>{fmtSignedPct(day, 2)}</span> <span className="text-ep-muted">in 24 h</span>
                </span>
              ) : null}
              <span className="text-ep-muted">
                Market cap {market.marketCapSol !== null ? `${fmtSolValue(market.marketCapSol)} SOL` : "—"} fully diluted
              </span>
            </p>
          </section>

          {/* Chart (LP15–LP16) */}
          {market.status !== "upcoming" ? (
            <section aria-label="Price chart" className="flex flex-col gap-3">
              <PriceChart
                candles={candlesQ.data?.data}
                loading={candlesQ.isPending}
                interval={interval}
                symbol={launch.symbol}
                bandHighSol={detail.curve.bandHighSol}
                valuePerTokenSol={detail.curve.valuePerTokenSol}
                buybackTrades={buybackTrades}
                buybacks={feed?.buybacks ?? []}
              />
              <ToggleGroup value={[interval]} onValueChange={(v: string[]) => v[0] && void setIntervalParam(v[0] as LaunchCandleInterval)} aria-label="Candle interval" className="flex-wrap">
                {INTERVALS.map((i) => (
                  <ToggleGroupItem key={i.value} value={i.value} size="sm" variant="outline" className="aria-pressed:border-ep-accent-line aria-pressed:bg-ep-accent-soft aria-pressed:text-ep-accent">
                    {i.label}
                    <span className="sr-only">, {i.span}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </section>
          ) : null}

          <CurveCard page={page} sample={recorded} />
          <BacksGrid page={page} fees={fees} holders={holders} />
          <BuybacksBlock feed={feed} source={sample ? "sample" : feedQ.data?.source} loading={feedQ.isPending} error={feedQ.error} symbol={launch.symbol} trades={trades} page={page} />

          {/* Trades */}
          <section aria-labelledby="trades-title" className="flex flex-col gap-4">
            <SectionHeading
              id="trades-title"
              title="Trades"
              description={
                !page.ingest.running
                  ? "This API is not ingesting trades right now: the feed shows what it has stored."
                  : page.ingest.mode === "polling"
                    ? `Updates every ${page.ingest.pollSeconds ?? 10} s (no push source right now).`
                    : `Each swap on the ${market.venue === "damm-v2" ? "DAMM v2 pool" : "curve"} arrives about a second after it confirms (${page.ingest.mode === "grpc" ? "Yellowstone gRPC" : "the RPC's logsSubscribe"}). Buybacks by the escrow are marked.`
              }
              action={
                <DataStatus
                  source={sample ? "sample" : sourced?.source}
                  live={live && socket.state === "open" && page.ingest.running && !page.ingest.stale && page.ingest.mode !== "polling"}
                  stale={page.ingest.stale}
                  unavailable={!page.ingest.running}
                  unavailableLabel="Feed not running"
                  unavailableDetail="The API's trade ingester is off (LAUNCH_TRADES_INGEST) or has no registry; stored trades still show."
                  staleWord="Feed delayed"
                  asOf={page.ingest.lastPollAt}
                  liveDetail={page.ingest.lagSeconds !== null ? `${page.ingest.lagSeconds.toFixed(1)} s lag` : undefined}
                  idleLabel={page.ingest.mode === "polling" ? `Every ${page.ingest.pollSeconds ?? 10} s` : undefined}
                />
              }
            />
            <TradesTable trades={trades} escrow={escrow} wallet={address} symbol={launch.symbol} frozenAt={recorded ? Date.parse(page.asOf) : undefined} pendingSignature={pending} />
            {pending && !trades.some((t) => t.signature === pending) ? (
              <p className="text-xs text-ep-muted" role="status">
                Your trade {shortKey(pending, 6, 6)} is confirmed and on its way to the feed.
              </p>
            ) : null}
            {!recorded && page.trades.length >= 50 && !older.done ? (
              <Button variant="outline" size="sm" className="self-start" disabled={older.loading} onClick={() => void loadOlder()}>
                {older.loading ? "Loading…" : "Load older trades"}
              </Button>
            ) : null}
            {older.error ? <p className="text-xs text-ep-warn">{older.error}</p> : null}
          </section>

          <HoldersBlock holders={holders} source={sample ? "sample" : holdersQ.data?.source ?? sourced?.source} loading={holdersQ.isPending && !page.holders} unavailable={page.unavailable.includes("holders") && !holdersQ.data?.data} symbol={launch.symbol} wallet={address} />
          <FeesBlock fees={fees} feed={feed} source={sample ? "sample" : feesQ.data?.source ?? sourced?.source} loading={feesQ.isPending && !page.fees} unavailable={page.unavailable.includes("fees") && !feesQ.data?.data} symbol={launch.symbol} network={network} sample={recorded} />
          <TermsBlock page={page} sample={recorded} />
          <AboutBlock page={page} />
        </div>

        <aside aria-label="Trade" className="hidden lg:col-span-4 lg:block">
          <div className="sticky top-20 flex flex-col gap-4">{isDesktop ? card("trade") : null}</div>
        </aside>
      </div>

      {/* Phones: the Trade card as a bottom sheet (LP28). */}
      {!isDesktop ? (
        <>
          <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-3 border-t border-ep-line bg-ep-surface p-3 lg:hidden">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ep-text">{launch.symbol}</p>
              <p className="num truncate text-xs text-ep-muted">
                <PriceText value={price} /> SOL
              </p>
            </div>
            <Button size="lg" className="px-8" onClick={() => setSheet(true)}>
              Trade
            </Button>
          </div>
          <Drawer open={sheet} onOpenChange={(open) => (open || !busy) && setSheet(open)}>
            <DrawerContent>
              <DrawerHeader>
                <DrawerTitle>Trade {launch.symbol}</DrawerTitle>
                <DrawerDescription>{market.venue === "damm-v2" ? "On the Meteora DAMM v2 pool" : "On the Meteora curve"} · {clusterLabel(network)}</DrawerDescription>
              </DrawerHeader>
              <div className="overflow-y-auto px-4 pb-6">{card("trade-sheet", true)}</div>
            </DrawerContent>
          </Drawer>
        </>
      ) : null}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/launch" className="inline-flex items-center gap-1.5 self-start text-sm text-ep-text-2 hover:text-ep-text">
      <ArrowLeft className="size-4" aria-hidden /> Launch
    </Link>
  );
}

function TokenSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading the token">
      <Skeleton className="h-5 w-24" />
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      <div className="grid gap-10 lg:grid-cols-12">
        <div className="flex flex-col gap-6 lg:col-span-8">
          <Skeleton className="h-14 w-72" />
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
        <Skeleton className="hidden h-96 lg:col-span-4 lg:block" />
      </div>
    </div>
  );
}
