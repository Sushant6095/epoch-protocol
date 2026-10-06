"use client";
// The slot strip: one bar per block as it lands (WS `slots`). Each bar is a box from p25 to p75 with a whisker to p90
// (a candlestick drawn as a box plot) and a dot at the median, the slot's Fee Index input. Medians span four orders
// of magnitude, so the price scale is logarithmic. A block with no priced transaction leaves a gap. A small marker
// under a bar means the leader paid for some of its own transactions, which the index leaves out. The dashed line
// is the epoch's running index. lightweight-charts appends new blocks with `update()`, so the strip moves block by
// block without redrawing.

import {
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesMarkersPluginApi,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useLightweightChart, withAlpha } from "@/components/charts/use-lw-chart";
import type { LiveSlot } from "@/lib/data/types";
import { fmtCu, fmtCuTick, fmtInt, fmtTimeSecIst, shortKey } from "@/lib/format";

const asTime = (slot: number) => slot as UTCTimestamp;

export function SlotStrip({ slots, indexValue, animate }: { slots: LiveSlot[]; indexValue: number | null; animate: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { chart, colors } = useLightweightChart(ref, () => ({
    rightPriceScale: { mode: PriceScaleMode.Logarithmic, scaleMargins: { top: 0.08, bottom: 0.08 } },
    timeScale: {
      rightOffset: 1,
      barSpacing: 12,
      minBarSpacing: 3,
      fixLeftEdge: true,
      tickMarkFormatter: (t: Time) => `…${String(t).slice(-4)}`,
    },
    localization: {
      priceFormatter: (p: number) => fmtCuTick(p),
      timeFormatter: (t: Time) => `slot ${fmtInt(Number(t))}`,
    },
    handleScroll: false,
    handleScale: false,
  }));
  const series = useRef<{ box: ISeriesApi<"Candlestick">; median: ISeriesApi<"Line">; markers: ISeriesMarkersPluginApi<Time> } | null>(null);
  const indexLine = useRef<IPriceLine | null>(null);
  const lastSlot = useRef<number | null>(null);
  const [hover, setHover] = useState<{ slot: LiveSlot; x: number } | null>(null);

  const ordered = useMemo(() => [...slots].sort((a, b) => a.slot - b.slot), [slots]);
  const bySlot = useMemo(() => new Map(ordered.map((s) => [s.slot, s])), [ordered]);
  const bySlotRef = useRef(bySlot);
  useEffect(() => {
    bySlotRef.current = bySlot;
  }, [bySlot]);

  // Create the series once the chart exists.
  useEffect(() => {
    if (!chart || !colors) return;
    const box = chart.addSeries(CandlestickSeries, {
      upColor: withAlpha(colors.accent, 0.18),
      downColor: withAlpha(colors.accent, 0.18),
      borderUpColor: colors.accentSoft,
      borderDownColor: colors.accentSoft,
      wickUpColor: colors.lineStrong,
      wickDownColor: colors.lineStrong,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const median = chart.addSeries(LineSeries, {
      color: colors.accent,
      lineVisible: false,
      pointMarkersVisible: true,
      pointMarkersRadius: 2.5,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    });
    const markers = createSeriesMarkers(median, []);
    series.current = { box, median, markers };
    lastSlot.current = null;
    const onMove = (param: { time?: Time; point?: { x: number; y: number } }) => {
      if (!param.time || !param.point) return setHover(null);
      const s = bySlotRef.current.get(Number(param.time));
      setHover(s ? { slot: s, x: param.point.x } : null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      series.current = null;
    };
  }, [chart, colors]);

  // Data: append new blocks with update(); anything else (first paint, a reload after a reconnect) redraws.
  useEffect(() => {
    const s = series.current;
    if (!s || !colors) return;
    const box = (x: LiveSlot) =>
      x.medianCuPrice === null
        ? { time: asTime(x.slot) }
        : {
            time: asTime(x.slot),
            open: x.p25CuPrice ?? x.medianCuPrice,
            low: x.p25CuPrice ?? x.medianCuPrice,
            close: x.p75CuPrice ?? x.medianCuPrice,
            high: x.p90CuPrice ?? x.p75CuPrice ?? x.medianCuPrice,
          };
    const dot = (x: LiveSlot) => (x.medianCuPrice === null ? { time: asTime(x.slot) } : { time: asTime(x.slot), value: x.medianCuPrice });
    const last = lastSlot.current;
    const newer = last === null ? [] : ordered.filter((x) => x.slot > last);
    const canAppend = animate && last !== null && newer.length > 0 && newer.length <= 5 && ordered.some((x) => x.slot === last);
    if (canAppend) {
      for (const x of newer) {
        s.box.update(box(x));
        s.median.update(dot(x));
      }
    } else {
      s.box.setData(ordered.map(box));
      s.median.setData(ordered.map(dot));
      chartFit(chart);
    }
    lastSlot.current = ordered.length ? ordered[ordered.length - 1].slot : null;
    s.markers.setMarkers(
      ordered
        .filter((x) => x.leaderPaidTxs > 0 && x.medianCuPrice !== null)
        .map((x) => ({ time: asTime(x.slot), position: "belowBar" as const, shape: "square" as const, color: colors.muted, size: 0.4 })),
    );
  }, [ordered, animate, chart, colors]);

  // The running index as a dashed reference line.
  useEffect(() => {
    const s = series.current;
    if (!s || !colors) return;
    if (indexLine.current) {
      s.median.removePriceLine(indexLine.current);
      indexLine.current = null;
    }
    if (indexValue !== null) {
      indexLine.current = s.median.createPriceLine({
        price: indexValue,
        color: colors.info,
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: true,
        title: "index",
      });
    }
  }, [indexValue, colors, chart]);

  const latest = ordered[ordered.length - 1];
  return (
    <figure className="relative flex flex-col gap-2">
      <div ref={ref} className="h-72 w-full sm:h-80" />
      {hover ? (
        <div
          className="pointer-events-none absolute top-2 z-10 w-56 rounded-md border border-ep-line-strong bg-ep-raised p-3 text-xs shadow-lg"
          style={{ left: `clamp(8px, ${hover.x + 16}px, calc(100% - 232px))` }}
        >
          <p className="num text-ep-text">slot {fmtInt(hover.slot.slot)}</p>
          <p className="mb-2 text-ep-muted">
            {hover.slot.leaderName ?? shortKey(hover.slot.leader)} · {fmtTimeSecIst(hover.slot.time)}
          </p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <dt className="text-ep-muted">median</dt>
            <dd className="num text-right text-ep-accent">{fmtCu(hover.slot.medianCuPrice)}</dd>
            <dt className="text-ep-muted">p25 · p75</dt>
            <dd className="num text-right">{tick(hover.slot.p25CuPrice)} · {tick(hover.slot.p75CuPrice)}</dd>
            <dt className="text-ep-muted">p90</dt>
            <dd className="num text-right">{fmtCu(hover.slot.p90CuPrice)}</dd>
            <dt className="text-ep-muted">priced txs</dt>
            <dd className="num text-right">{fmtInt(hover.slot.pricedTxs)}</dd>
            <dt className="text-ep-muted">no fee set</dt>
            <dd className="num text-right">{fmtInt(hover.slot.unpricedTxs)}</dd>
            <dt className="text-ep-muted">leader-paid</dt>
            <dd className="num text-right">{fmtInt(hover.slot.leaderPaidTxs)}</dd>
            <dt className="text-ep-muted">failed (paid)</dt>
            <dd className="num text-right">{fmtInt(hover.slot.failedTxs)}</dd>
          </dl>
        </div>
      ) : null}
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ep-muted">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-3 w-2 rounded-sm border border-ep-accent-line bg-ep-accent-soft" /> p25–p75 of the block&apos;s priced txs, whisker to p90
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-1.5 rounded-full bg-ep-accent" /> median (µL/CU, log scale)
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-px w-4 border-t border-dashed border-ep-info" /> running index
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block size-1.5 bg-ep-muted" /> leader-paid txs left out
        </span>
        <span className="sr-only">
          {ordered.length} blocks, newest slot {latest ? fmtInt(latest.slot) : "—"} with a median of {fmtCu(latest?.medianCuPrice)} µL/CU.
        </span>
      </figcaption>
    </figure>
  );
}

const tick = (v: number | null) => (v === null ? "—" : fmtCuTick(v));

function chartFit(chart: IChartApi | null) {
  chart?.timeScale().fitContent();
}
