"use client";
// LP15–LP16: the token's price (Wealthsimple's chart: one series, a crosshair, dashed reference lines labelled at the
// right edge, pills under it). Candles from `/candles` (the trade feed, SOL per token) with volume under them; on
// `basis: samples` (no trades yet) a line of the sampled pool price. Dashed lines: the curve's top (where it graduates)
// and the share's value per token. A small marker under a candle is a buyback slice by the program's escrow.
// Prices are tiny, so the axis writes the run of zeros as a subscript (0.0₅947). Times are IST. Up candles are mint,
// down candles orange: never red, and the legend says the change in words.

import {
  type AutoscaleInfo,
  CandlestickSeries,
  createSeriesMarkers,
  HistogramSeries,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  LineSeries,
  LineStyle,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useLightweightChart, withAlpha } from "@/components/charts/use-lw-chart";
import { PriceText } from "@/components/data/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import type { LaunchBuyback, LaunchCandle, LaunchCandleInterval, LaunchCandles, LaunchTrade } from "@/lib/data/types";
import { fmtPrice, fmtSignedPct, fmtSolValue, fmtTokens, plural } from "@/lib/format";
import { cn } from "@/lib/utils";

export const INTERVALS: { value: LaunchCandleInterval; label: string; span: string }[] = [
  { value: "1m", label: "1m", span: "1-minute candles" },
  { value: "5m", label: "5m", span: "5-minute candles" },
  { value: "15m", label: "15m", span: "15-minute candles over 24 h" },
  { value: "1h", label: "1h", span: "hourly candles over 7 days" },
  { value: "4h", label: "4h", span: "4-hour candles over 7 days" },
  { value: "1d", label: "1d", span: "daily candles over 90 days" },
];

const istTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const istDay = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
const istFull = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const asTime = (s: number) => s as UTCTimestamp;

function bucketOf(t: string, interval: LaunchCandleInterval): number {
  const seconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 }[interval];
  return Math.floor(Date.parse(t) / 1000 / seconds) * seconds;
}

export interface PriceChartProps {
  candles: LaunchCandles | undefined;
  loading: boolean;
  interval: LaunchCandleInterval;
  symbol: string;
  /** The curve's top (graduation price) and the share's value per token: dashed reference lines. */
  bandHighSol: number | null;
  valuePerTokenSol: number | null;
  /** Trades by the buyback escrow, matched to the buyback feed's slices for the legend. */
  buybackTrades: LaunchTrade[];
  buybacks: LaunchBuyback[];
}

export function PriceChart({ candles, loading, interval, symbol, bandHighSol, valuePerTokenSol, buybackTrades, buybacks }: PriceChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { chart, colors } = useLightweightChart(ref, () => ({
    rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.22 } },
    timeScale: {
      rightOffset: 2,
      barSpacing: 10,
      minBarSpacing: 2,
      timeVisible: true,
      secondsVisible: false,
    },
    localization: {
      priceFormatter: (p: number) => fmtPrice(p, 4),
      timeFormatter: (t: Time) => `${istFull.format(new Date(Number(t) * 1000))} IST`,
    },
  }));

  // Axis labels follow the interval: days for 4h and 1d, IST clock times otherwise.
  useEffect(() => {
    chart?.applyOptions({
      timeScale: {
        tickMarkFormatter: (t: Time) => {
          const d = new Date(Number(t) * 1000);
          return interval === "1d" || interval === "4h" ? istDay.format(d) : istTime.format(d);
        },
      },
    });
  }, [chart, interval]);

  const rows = useMemo(() => candles?.candles ?? [], [candles]);
  const basis = candles?.basis ?? "none";
  const byTime = useMemo(() => new Map(rows.map((c) => [c.time, c])), [rows]);
  const slices = useMemo(() => {
    const bySig = new Map(buybacks.filter((b) => b.signature).map((b) => [b.signature!, b]));
    const map = new Map<number, { trade: LaunchTrade; slice: LaunchBuyback | null }[]>();
    for (const t of buybackTrades) {
      const k = bucketOf(t.t, interval);
      const list = map.get(k) ?? [];
      list.push({ trade: t, slice: bySig.get(t.signature) ?? null });
      map.set(k, list);
    }
    return map;
  }, [buybackTrades, buybacks, interval]);

  const [hover, setHover] = useState<number | null>(null);
  const series = useRef<{ price: ISeriesApi<"Candlestick"> | ISeriesApi<"Line">; volume: ISeriesApi<"Histogram"> | null; markers: ISeriesMarkersPluginApi<Time> } | null>(null);
  const refs = useRef({ bandHighSol, valuePerTokenSol });
  useEffect(() => {
    refs.current = { bandHighSol, valuePerTokenSol };
  }, [bandHighSol, valuePerTokenSol]);

  // (Re)create the series when the chart, the basis or the reference lines change; set the data each time.
  useEffect(() => {
    if (!chart || !colors) return;
    const extra = [bandHighSol, valuePerTokenSol].filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
    const priceFormat = { type: "custom" as const, formatter: (p: number) => fmtPrice(p, 4), minMove: 1e-12 };
    // Keep the reference lines on screen: the scale covers them as well as the candles.
    const autoscaleInfoProvider = (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
      const r = original();
      if (!r?.priceRange) return r;
      return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...extra), maxValue: Math.max(r.priceRange.maxValue, ...extra) } };
    };
    const price =
      basis === "samples"
        ? chart.addSeries(LineSeries, { color: colors.accent, lineWidth: 2, priceFormat, autoscaleInfoProvider, lastValueVisible: true, priceLineVisible: false })
        : chart.addSeries(CandlestickSeries, {
            upColor: colors.accent,
            downColor: colors.warn,
            borderUpColor: colors.accent,
            borderDownColor: colors.warn,
            wickUpColor: colors.accent,
            wickDownColor: colors.warn,
            priceFormat,
            autoscaleInfoProvider,
            priceLineVisible: false,
          });
    const volume =
      basis === "trades"
        ? chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false })
        : null;
    if (volume) chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    const markers = createSeriesMarkers(price as ISeriesApi<"Candlestick">, []);
    if (bandHighSol)
      price.createPriceLine({ price: bandHighSol, color: colors.info, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "curve top" });
    if (valuePerTokenSol)
      price.createPriceLine({ price: valuePerTokenSol, color: colors.muted, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "share's value" });
    series.current = { price, volume, markers };
    const onMove = (param: { time?: Time }) => setHover(param.time === undefined ? null : Number(param.time));
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      markers.detach();
      if (volume) chart.removeSeries(volume);
      chart.removeSeries(price);
      series.current = null;
    };
  }, [chart, colors, basis, bandHighSol, valuePerTokenSol]);

  useEffect(() => {
    const s = series.current;
    if (!s || !colors || !chart) return;
    if (basis === "samples") {
      (s.price as ISeriesApi<"Line">).setData(rows.map((c) => ({ time: asTime(c.time), value: c.close })));
    } else {
      (s.price as ISeriesApi<"Candlestick">).setData(rows.map((c) => ({ time: asTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    }
    s.volume?.setData(
      rows.map((c) => ({ time: asTime(c.time), value: c.volumeSol, color: withAlpha(c.close >= c.open ? colors.accent : colors.warn, c.volumeSol ? 0.35 : 0) })),
    );
    s.markers.setMarkers(
      [...slices.keys()]
        .filter((k) => byTime.has(k))
        .sort((a, b) => a - b)
        .map((k) => ({ time: asTime(k), position: "belowBar" as const, shape: "circle" as const, color: colors.info, size: 0.6 })),
    );
    chart.timeScale().fitContent();
  }, [rows, basis, slices, byTime, colors, chart]);

  // ←/→ move the crosshair from candle to candle when the chart has focus.
  const onKey = (e: React.KeyboardEvent) => {
    if (!chart || !series.current || !rows.length) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const idx = hover === null ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, rows.findIndex((c) => c.time === hover) + (e.key === "ArrowLeft" ? -1 : 1)));
    const c = rows[idx];
    chart.setCrosshairPosition(c.close, asTime(c.time), series.current.price);
    setHover(c.time);
  };

  const shown: LaunchCandle | undefined = (hover !== null ? byTime.get(hover) : undefined) ?? rows[rows.length - 1];
  const shownSlices = shown ? slices.get(shown.time) ?? [] : [];
  const change = shown && shown.open ? ((shown.close - shown.open) / shown.open) * 100 : null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const empty = !loading && (basis === "none" || rows.length === 0);
  const span = INTERVALS.find((i) => i.value === interval)?.span ?? interval;

  return (
    <figure className="relative flex flex-col gap-2" aria-labelledby="price-chart-caption">
      <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ep-muted", !empty && "min-h-10")}>
        {shown && !empty ? (
          <>
            <span className="num text-ep-text-2">{istFull.format(new Date(shown.time * 1000))} IST</span>
            {basis === "trades" ? (
              <>
                <span className="num">
                  O <PriceText value={shown.open} className="text-ep-text-2" /> H <PriceText value={shown.high} className="text-ep-text-2" /> L{" "}
                  <PriceText value={shown.low} className="text-ep-text-2" /> C <PriceText value={shown.close} className="text-ep-text-2" />
                </span>
                <span className={cn("num", change !== null && change < 0 ? "text-ep-warn" : change ? "text-ep-accent" : "")}>
                  {change === null ? "" : `${fmtSignedPct(change)} ${change > 0 ? "up" : change < 0 ? "down" : "flat"}`}
                </span>
                <span className="num">
                  {fmtSolValue(shown.volumeSol)} SOL · {shown.trades} {plural(shown.trades, "trade")}
                </span>
              </>
            ) : (
              <span className="num">
                Pool price <PriceText value={shown.close} className="text-ep-text-2" /> SOL (sampled, no trades yet)
              </span>
            )}
            {shownSlices.length ? (
              <span className="flex items-center gap-1.5 text-ep-info">
                <span aria-hidden className="inline-block size-2 rounded-full bg-ep-info" />
                {shownSlices
                  .map(({ trade, slice }) =>
                    slice
                      ? `Buyback slice ${slice.slice + 1} of ${slice.slices}: ${fmtSolValue(slice.solIn)} SOL → ${fmtTokens(slice.tokensBurned)} burned`
                      : `Buyback: ${fmtSolValue(trade.solAmount)} SOL → ${fmtTokens(trade.tokenAmount)} burned`,
                  )
                  .join(" · ")}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      <div className="relative">
        <div
          ref={ref}
          tabIndex={empty ? -1 : 0}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          aria-label={`Price chart of ${symbol}. Use the left and right arrow keys to move between candles.`}
          role="group"
          aria-roledescription="chart"
          className={cn("h-72 w-full rounded-md outline-offset-4 sm:h-80", empty && "invisible")}
        />
        {loading && !rows.length ? <Skeleton className="absolute inset-0 rounded-md" /> : null}
        {empty ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-ep-line text-center">
            <p className="text-sm font-medium text-ep-text-2">No trades yet</p>
            <p className="max-w-xs text-xs text-ep-muted">The chart starts with the first trade on the curve.</p>
          </div>
        ) : null}
      </div>
      <figcaption id="price-chart-caption" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ep-muted">
        <span>
          {symbol} in SOL per token, {span}, IST
        </span>
        {bandHighSol ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-px w-4 border-t border-dashed border-ep-info" /> curve top <PriceText value={bandHighSol} />
          </span>
        ) : null}
        {valuePerTokenSol ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-px w-4 border-t border-dashed border-ep-muted" /> share&apos;s value <PriceText value={valuePerTokenSol} />
          </span>
        ) : null}
        {slices.size ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block size-2 rounded-full bg-ep-info" /> buyback slice
          </span>
        ) : null}
        <span className="sr-only">
          {rows.length
            ? `${rows.length} candles from ${istFull.format(new Date(first.time * 1000))} to ${istFull.format(new Date(last.time * 1000))} IST; last close ${fmtPrice(last.close)} SOL.`
            : "No candles yet."}
        </span>
      </figcaption>
    </figure>
  );
}
