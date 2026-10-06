"use client";
// /launch: OpenSea Drops' structure (the kit's lock): a bold title over two tabs, group headings between wide cards,
// one card per revenue token with a status badge, the token and its validator, a stats line, the raise bar and one
// small button. Epoch draws no artwork: the banner is a token gradient with the Epoch ring and the validator's
// initials (click map LP3–LP9).

import { ArrowDown, ArrowRight, BookOpen, Eye, EyeOff } from "lucide-react";
import Link from "next/link";
import { parseAsStringLiteral, useQueryState } from "nuqs";
import { useEffect, useState } from "react";

import { DataStatus } from "@/components/data/source-badge";
import { EmptyBlock, ErrorCard, PriceText, Tip } from "@/components/data/primitives";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { isSampleKind } from "@/lib/data/query";
import { useLaunches } from "@/lib/data/launch";
import type { LaunchSummary } from "@/lib/data/types";
import { clusterLabel } from "@/lib/explorers";
import { env } from "@/lib/env";
import { fmtBps, fmtEpoch, fmtNum, fmtPct, fmtSolValue } from "@/lib/format";
import { cn } from "@/lib/utils";

import { CurveProgress } from "./fun-launch/curve-progress";
import { HowItWorksDialog } from "./how-it-works";

const WATCH_KEY = "epoch.watchlist.launch";

export function useLaunchWatchlist() {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    try {
      setList(JSON.parse(window.localStorage.getItem(WATCH_KEY) ?? "[]") as string[]);
    } catch {
      setList([]);
    }
  }, []);
  const toggle = (symbol: string) =>
    setList((prev) => {
      const next = prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol];
      try {
        window.localStorage.setItem(WATCH_KEY, JSON.stringify(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  return { list, toggle };
}

export const STATUS_WORDS: Record<LaunchSummary["status"], string> = {
  upcoming: "Upcoming",
  curve: "On the curve",
  graduated: "Graduated",
  ended: "Ended",
};

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function TokenBanner({ launch, className }: { launch: LaunchSummary; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden bg-linear-to-br from-ep-accent-soft via-ep-surface to-ep-inset", className)} aria-hidden>
      <svg viewBox="0 0 200 200" className="absolute -right-10 -bottom-12 size-56 opacity-70">
        <circle cx="100" cy="100" r="70" fill="none" stroke="var(--ep-line-strong)" strokeWidth="14" />
        <circle
          cx="100"
          cy="100"
          r="70"
          fill="none"
          stroke="var(--ep-accent-line)"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${(Math.max(4, launch.raise.progressPct) / 100) * 440} 440`}
          transform="rotate(-90 100 100)"
        />
      </svg>
      <span className="num absolute top-4 left-4 flex size-12 items-center justify-center rounded-full border border-ep-accent-line bg-ep-bg text-base text-ep-accent">
        {initials(launch.validator.name) || launch.symbol.slice(1, 3).toUpperCase()}
      </span>
      <span className="num absolute bottom-4 left-4 text-2xl font-medium text-ep-text">{launch.symbol}</span>
    </div>
  );
}

function LaunchCard({ launch, watched, onWatch }: { launch: LaunchSummary; watched: boolean; onWatch: () => void }) {
  const href = `/launch/${launch.mint ?? launch.symbol}`;
  const share = `${fmtBps(launch.shareBps)} of ${launch.validator.name}'s revenue for ${launch.termEpochs} epochs (${fmtEpoch(launch.startEpoch)}–${fmtEpoch(launch.endEpoch)})`;
  const upcoming = launch.status === "upcoming";
  return (
    <article aria-labelledby={`launch-${launch.symbol}`} className="group grid overflow-hidden rounded-xl border border-ep-line bg-ep-surface transition-colors duration-200 hover:border-ep-line-strong md:grid-cols-12">
      <Link href={href} tabIndex={-1} aria-hidden className="block md:col-span-4">
        <TokenBanner launch={launch} className="h-36 md:h-full md:min-h-56" />
      </Link>
      <div className="flex flex-col gap-4 p-5 md:col-span-8 md:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              "uppercase tracking-wider",
              launch.status === "curve" && "border-ep-accent-line bg-ep-accent-soft text-ep-accent",
              launch.status === "graduated" && "border-ep-info-line bg-ep-info-soft text-ep-info",
              launch.status === "upcoming" && "border-ep-warn-line bg-ep-warn-soft text-ep-warn",
            )}
          >
            {upcoming && launch.opensAtEpoch !== null ? `Opens in epoch ${fmtEpoch(launch.opensAtEpoch)}` : STATUS_WORDS[launch.status]}
          </Badge>
          <span className="text-xs text-ep-muted">Revenue token</span>
        </div>
        <div className="flex flex-col gap-1">
          <h3 id={`launch-${launch.symbol}`} className="text-xl font-semibold text-ep-text">
            <Link href={href} className="hover:underline hover:underline-offset-4">
              {launch.symbol} <span className="font-normal text-ep-text-2">· {launch.name}</span>
            </Link>
          </h3>
          <p className="text-sm text-ep-text-2">
            by {launch.validator.name} ·{" "}
            <Tip tip="The share and the term are immutable once the validator registers the token with the Epoch program.">{share}</Tip>
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="label-caps">{upcoming ? "Curve band" : "Price"}</dt>
            <dd className="text-ep-text">
              {upcoming ? (
                <span className="num">
                  <PriceText value={launch.bandLowSol} />–<PriceText value={launch.bandHighSol} />
                </span>
              ) : (
                <PriceText value={launch.priceSol} unit="SOL" />
              )}
            </dd>
          </div>
          <div>
            <dt className="label-caps">Market cap</dt>
            <dd className="num text-ep-text">
              <Tip tip="Fully diluted: price × tokens not burned.">{launch.marketCapSol === null ? "—" : `${fmtSolValue(launch.marketCapSol)} SOL`}</Tip>
            </dd>
          </div>
          <div>
            <dt className="label-caps">Buyback / epoch</dt>
            <dd className="num text-ep-text">
              <Tip tip="The live estimate of the validator's revenue × the share: what the program spends on buybacks each epoch. 0 while unknown.">
                {launch.shareRevenuePerEpochSol ? `${fmtSolValue(launch.shareRevenuePerEpochSol)} SOL` : "—"}
              </Tip>
            </dd>
          </div>
          <div>
            <dt className="label-caps">Backing</dt>
            <dd className="num text-ep-text">
              <Tip tip="Expected buybacks left in the term (share revenue × epochs left) ÷ market cap. Not a promise.">
                {launch.backingRatio !== null ? `${fmtNum(launch.backingRatio, 2)}×` : launch.impliedYieldPctPerEpoch !== null ? `${fmtPct(launch.impliedYieldPctPerEpoch, 2)} / epoch` : "—"}
              </Tip>
            </dd>
          </div>
        </dl>
        {launch.status === "curve" || launch.status === "graduated" ? (
          <CurveProgress progressPct={launch.raise.progressPct} raisedSol={launch.raise.raisedSol} targetSol={launch.raise.targetSol} graduated={launch.status === "graduated"} />
        ) : null}
        <div className="mt-auto flex flex-wrap items-center gap-3">
          <span className="text-xs text-ep-muted">
            {launch.raise.buyers} {launch.raise.buyers === 1 ? "buyer" : "buyers"}
            {launch.status === "graduated" ? " · trading on Meteora DAMM v2 · buybacks run every epoch" : launch.status === "curve" ? " · trading on the Meteora curve" : ""}
          </span>
          {upcoming ? (
            <Button variant="outline" size="sm" className="ml-auto" aria-pressed={watched} onClick={onWatch}>
              {watched ? <EyeOff aria-hidden /> : <Eye aria-hidden />} {watched ? "Watching" : "Watch"}
            </Button>
          ) : null}
          <Link href={href} className={cn(buttonVariants({ size: "sm" }), upcoming ? "" : "ml-auto")}>
            View token <ArrowRight aria-hidden />
          </Link>
        </div>
      </div>
    </article>
  );
}

function Group({ title, launches, watch }: { title: string; launches: LaunchSummary[]; watch: ReturnType<typeof useLaunchWatchlist> }) {
  if (!launches.length) return null;
  return (
    <section className="flex flex-col gap-4" aria-label={title}>
      <h2 className="text-lg font-semibold text-ep-text">{title}</h2>
      <div className="flex flex-col gap-4">
        {launches.map((l) => (
          <LaunchCard key={l.mint ?? l.symbol} launch={l} watched={watch.list.includes(l.symbol)} onWatch={() => watch.toggle(l.symbol)} />
        ))}
      </div>
    </section>
  );
}

export function LaunchList() {
  const list = useLaunches();
  const [tab, setTab] = useQueryState("tab", parseAsStringLiteral(["live", "past"] as const).withDefault("live"));
  const watch = useLaunchWatchlist();
  const data = list.data?.data;
  const launches = data?.launches ?? [];
  const onCurve = launches.filter((l) => l.status === "curve");
  const upcoming = launches.filter((l) => l.status === "upcoming").sort((a, b) => (a.opensAtEpoch ?? 0) - (b.opensAtEpoch ?? 0));
  const graduated = launches.filter((l) => l.status === "graduated");
  const ended = launches.filter((l) => l.status === "ended");
  const network = data?.network ?? "devnet";
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow={
          <>
            <span className="text-ep-info">Meteora</span> side track · validator revenue tokens on the Dynamic Bonding Curve
          </>
        }
        title="Launch"
        badges={
          <span className="flex flex-wrap items-center gap-2">
            <Tip tip={`Epoch's program and these Meteora pools run on ${clusterLabel(network).toLowerCase()} for now.`}>
              <Badge variant="outline" className="h-6 border-ep-warn-line bg-ep-warn-soft font-mono text-xs uppercase text-ep-warn">
                {clusterLabel(network)}
              </Badge>
            </Tip>
            {list.data ? (
              <DataStatus
                source={isSampleKind(data?.kind) ? "sample" : list.data.source}
                asOf={data?.asOf}
                sampleNote={list.data.source === "sample" ? "Tokens recorded on the local stand-in that runs Meteora's mainnet programs (3–5 Oct 2026)." : data?.note || undefined}
              />
            ) : null}
          </span>
        }
        description={
          <>
            A validator sells a fixed share of its revenue for a fixed term as a token on a Meteora curve. It graduates to a DAMM v2 pool, and every epoch the Epoch program buys it back out of that revenue and burns it.{" "}
            <span className="text-ep-muted">{network === "mainnet" ? "Real SOL." : "Devnet demo."} Revenue tokens can be securities in many countries; nothing here is an offer.</span>
          </>
        }
        actions={
          <>
            <HowItWorksDialog />
            <Link href="#integration" className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
              How we integrate Meteora <ArrowDown aria-hidden />
            </Link>
          </>
        }
      />
      <Tabs value={tab} onValueChange={(v) => void setTab(v as "live" | "past")}>
        <div className="border-b border-ep-line">
          <TabsList variant="line">
            <TabsTrigger value="live">Live &amp; upcoming · {onCurve.length + upcoming.length}</TabsTrigger>
            <TabsTrigger value="past">Graduated &amp; ended · {graduated.length + ended.length}</TabsTrigger>
          </TabsList>
        </div>
        {list.isPending ? (
          <div className="flex flex-col gap-4 pt-6">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-56 w-full rounded-xl" />
            ))}
          </div>
        ) : !data ? (
          <ErrorCard className="mt-6" error={list.error} what="launches" onRetry={() => void list.refetch()} />
        ) : (
          <>
            <TabsContent value="live" className="flex flex-col gap-10 pt-6">
              {onCurve.length + upcoming.length === 0 ? <EmptyBlock title="No launches here yet." body="Graduated tokens are on the other tab." /> : null}
              <Group title="On the curve now" launches={onCurve} watch={watch} />
              {[...new Set(upcoming.map((u) => u.opensAtEpoch))].map((e) => (
                <Group key={String(e)} title={e !== null ? `Opens in epoch ${fmtEpoch(e)}` : "Upcoming"} launches={upcoming.filter((u) => u.opensAtEpoch === e)} watch={watch} />
              ))}
            </TabsContent>
            <TabsContent value="past" className="flex flex-col gap-10 pt-6">
              {graduated.length + ended.length === 0 ? <EmptyBlock title="No launches here yet." /> : null}
              <Group title="Graduated · buybacks still running" launches={graduated} watch={watch} />
              <Group title="Ended" launches={ended} watch={watch} />
            </TabsContent>
          </>
        )}
      </Tabs>
      <p className="flex items-start gap-2 text-sm text-ep-muted">
        <BookOpen className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          Validators: a launch is set up with Epoch through the{" "}
          <a className="text-ep-text-2 underline underline-offset-4 hover:text-ep-accent" href={`${env.githubTree}/packages/meteora/scripts`} target="_blank" rel="noreferrer">
            launch script
          </a>
          : your share, your term and a curve built from your revenue, then register_revenue_token signed by your operator.
        </span>
      </p>
    </div>
  );
}
