"use client";
// The featured market as a poll card (Stocktwits poll on an asset page, the kit's Predict primary): the question, one
// bar per outcome with its price (the market's implied probability), volume, the trading close countdown and the
// resolution source. Prices are Panta's: "Powered by Panta" sits on the card, and a Delayed chip replaces any live
// cue when Panta could not be read (pricesStale).

import { CalendarClock, ExternalLink, Scale } from "lucide-react";
import { useEffect, useState } from "react";

import { StaleBadge } from "@/components/data/source-badge";
import { PoweredByPanta } from "@/components/integrations/powered-by-panta";
import { Badge } from "@/components/ui/badge";
import { env } from "@/lib/env";
import type { PantaFeeIndexMarket, PantaMarketCard, PantaSide } from "@/lib/data/types";
import { fmtCountdown, fmtDateTimeIst, fmtEpoch, fmtInt, fmtProb, fmtSharePrice, fmtUsdc } from "@/lib/format";
import { cn } from "@/lib/utils";

export const isOurs = (m: PantaMarketCard | PantaFeeIndexMarket): m is PantaFeeIndexMarket => m.ours === true && "epoch" in m;

/** Ticks every 30 s for countdowns; frozen at `frozenAt` for sample data (a snapshot keeps its own clock). */
export function useNow(frozenAt?: number) {
  const [now, setNow] = useState(() => frozenAt ?? Date.now());
  useEffect(() => {
    if (frozenAt) {
      setNow(frozenAt);
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, [frozenAt]);
  return now;
}

/** Art for Epoch's markets: the API's own catalog image, or the ring motif when the API can't serve it. */
export function MarketArt({ market, sample, className }: { market: PantaMarketCard; sample: boolean; className?: string }) {
  const [broken, setBroken] = useState(false);
  const src = market.ours && !sample ? `${env.apiUrl}/v1/predict/panta/market-image.png` : market.imageUrl && !sample ? market.imageUrl : null;
  if (src && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" onError={() => setBroken(true)} className={cn("size-12 shrink-0 rounded-md border border-ep-line object-cover", className)} />;
  }
  const label = isOurs(market) ? fmtInt(market.thresholdMicroLamports) : market.title.slice(0, 2).toUpperCase();
  return (
    <span aria-hidden className={cn("relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-ep-line bg-ep-inset", className)}>
      <svg viewBox="0 0 48 48" className="absolute inset-0 size-full opacity-60">
        <circle cx="24" cy="24" r="17" fill="none" stroke="var(--ep-line-strong)" strokeWidth="4" />
        <circle cx="24" cy="24" r="17" fill="none" stroke="var(--ep-accent-line)" strokeWidth="4" strokeDasharray="70 200" transform="rotate(-90 24 24)" />
      </svg>
      <span className="num relative text-xs text-ep-text">{label}</span>
    </span>
  );
}

export function PollBars({
  yes,
  no,
  selected,
  onPick,
  disabled,
}: {
  yes: number | null;
  no: number | null;
  selected?: PantaSide | null;
  onPick?: (side: PantaSide) => void;
  disabled?: boolean;
}) {
  const rows: { side: PantaSide; label: string; price: number | null }[] = [
    { side: "yes", label: "Yes", price: yes },
    { side: "no", label: "No", price: no },
  ];
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Outcomes">
      {rows.map((r) => {
        const pct = r.price === null ? 0 : Math.round(r.price * 100);
        const active = selected === r.side;
        return (
          <button
            key={r.side}
            type="button"
            disabled={disabled || !onPick}
            aria-pressed={onPick ? active : undefined}
            onClick={() => onPick?.(r.side)}
            className={cn(
              "group relative flex h-12 w-full items-center overflow-hidden rounded-md border text-left transition-colors duration-200",
              active ? "border-ep-accent bg-ep-inset" : "border-ep-line bg-ep-inset hover:border-ep-line-strong",
              "disabled:cursor-default",
            )}
          >
            <span
              aria-hidden
              className={cn("absolute inset-y-0 left-0 origin-left", r.side === "yes" ? "bg-ep-accent-soft" : "bg-ep-info-soft")}
              style={{ width: `${pct}%` }}
            />
            <span className="relative flex w-full items-center gap-3 px-4">
              <span className={cn("font-medium", r.side === "yes" ? "text-ep-accent" : "text-ep-info")}>{r.label}</span>
              <span className="num ml-auto text-ep-text">{r.price === null ? "—" : `${fmtProb(r.price)}`}</span>
              <span className="num w-20 text-right text-xs text-ep-muted">{r.price === null ? "no price" : `${fmtSharePrice(r.price)} USDC`}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function PollCard({
  market,
  sample,
  side,
  onPick,
}: {
  market: PantaMarketCard | PantaFeeIndexMarket;
  sample: boolean;
  side: PantaSide;
  onPick: (side: PantaSide) => void;
}) {
  const ours = isOurs(market) ? market : null;
  const now = useNow(sample && ours?.pricesAsOf ? Date.parse(ours.pricesAsOf) : undefined);
  const closed = !market.tradable;
  return (
    <article className="flex flex-col gap-5 rounded-lg border border-ep-line bg-ep-surface p-5" aria-labelledby="featured-market">
      <div className="flex items-start gap-4">
        <MarketArt market={market} sample={sample} />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            {ours ? (
              <Badge variant="outline" className="border-ep-accent-line text-ep-accent">
                Epoch&apos;s market · epoch {fmtEpoch(ours.epoch)}
              </Badge>
            ) : (
              <Badge variant="outline">Panta catalog · {market.category ?? "other"}</Badge>
            )}
            <Badge variant="outline" className={closed ? "text-ep-muted" : "text-ep-text-2"}>
              {market.resolved ? "Resolved" : closed ? "Trading closed" : `Phase: ${market.phase}`}
            </Badge>
            {ours?.pricesStale ? <StaleBadge asOf={ours.pricesAsOf} word="Delayed" /> : null}
          </div>
          <h2 id="featured-market" className="text-lg font-semibold leading-snug text-ep-text sm:text-xl">
            {ours?.question ?? market.title}
          </h2>
        </div>
      </div>
      <PollBars yes={market.yesPrice} no={market.noPrice} selected={market.tradable ? side : null} onPick={market.tradable ? onPick : undefined} />
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="label-caps">Volume</dt>
          <dd className="num text-ep-text">{fmtUsdc(market.volumeUsdc)} USDC</dd>
        </div>
        <div>
          <dt className="label-caps">Trading closes</dt>
          <dd className="num text-ep-text">{market.tradable ? `in ${fmtCountdown(market.endsAt, now)}` : "closed"}</dd>
          <dd className="text-xs text-ep-muted">{fmtDateTimeIst(market.endsAt)}</dd>
        </div>
        <div>
          <dt className="label-caps">Resolves after</dt>
          <dd className="num text-ep-text">{fmtDateTimeIst(market.resolvesAt)}</dd>
        </div>
        <div>
          <dt className="label-caps">Threshold</dt>
          <dd className="num text-ep-text">{ours ? <>{fmtInt(ours.thresholdMicroLamports)} <span className="text-unit text-ep-muted">µL/CU</span></> : "—"}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ep-line pt-4 text-xs text-ep-muted">
        {ours ? (
          <a href={ours.resolutionUrl.startsWith("http") && !ours.resolutionUrl.includes("epoch.example") ? ours.resolutionUrl : `${env.apiUrl}/v1/index/epochs/${ours.epoch}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-ep-text-2 underline-offset-4 hover:text-ep-accent hover:underline">
            <Scale className="size-3.5" aria-hidden /> Resolution source: /v1/index/epochs/{fmtEpoch(ours.epoch)} <ExternalLink className="size-3" aria-hidden />
          </a>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock className="size-3.5" aria-hidden /> {market.description ?? "Resolves as written in Panta's market rule."}
          </span>
        )}
        <span>{ours ? "Resolves from Epoch's final Fee Index (posted on chain, past its dispute window)." : null}</span>
        <PoweredByPanta className="ml-auto" />
      </div>
    </article>
  );
}
