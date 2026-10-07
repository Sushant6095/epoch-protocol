'use client';
import { useEffect, useRef, useState } from 'react';
import { createChart, AreaSeries, HistogramSeries, ColorType, type Time, type UTCTimestamp } from 'lightweight-charts';
import { compact, fmt } from './shared';
export interface ChartPoint {
  epoch: number;
  value: number;
  inflow?: number;
  outflow?: number;
  status?: string;
}
// Epoch numbers are encoded as evenly spaced days solely for the chart's ordered time scale.
// All labels explicitly decode to epochs; these are never presented as calendar dates.
const time = (epoch: number) => (epoch * 86400) as UTCTimestamp;
export function EpochChart({
  points,
  height = 330,
  unit = 'SOL',
  precision = 2,
  bars = false,
  flow = false,
}: {
  points: ChartPoint[];
  height?: number;
  unit?: string;
  precision?: number;
  bars?: boolean;
  flow?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<ChartPoint | null>(null);
  useEffect(() => {
    const el = container.current;
    if (!el || points.length === 0) return;
    const css = getComputedStyle(document.documentElement);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const chart = createChart(el, {
      autoSize: true,
      // Layout width stays correct when a marketing parent is CSS-scaled.
      width: el.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: color('--ep-surface') },
        textColor: color('--ep-muted'),
        fontFamily: css.getPropertyValue('--ep-font-mono'),
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: color('--ep-chart-grid') } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: flow ? 0.32 : 0.1 } },
      timeScale: { borderVisible: false, tickMarkFormatter: (t: Time) => `E${Number(t) / 86400}`, rightOffset: 1 },
      localization: {
        timeFormatter: (t: Time) => `Epoch ${Number(t) / 86400}`,
        priceFormatter: (v: number) => (Math.abs(v) < 10 ? fmt(v, 4) : compact(v)),
      },
      crosshair: {
        vertLine: { color: color('--ep-chart-crosshair') },
        horzLine: { color: color('--ep-chart-crosshair') },
      },
    });
    const sorted = [...points]
      .sort((a, b) => a.epoch - b.epoch)
      .filter((p, i, a) => i === 0 || p.epoch !== a[i - 1].epoch);
    if (bars) {
      const s = chart.addSeries(HistogramSeries, {
        color: color('--ep-info'),
        priceLineVisible: false,
        lastValueVisible: false,
      });
      s.setData(
        sorted.map((p) => ({
          time: time(p.epoch),
          value: p.value,
          color: color(p.status === 'proposed' ? '--ep-accent' : '--ep-info'),
        })),
      );
    } else {
      const s = chart.addSeries(AreaSeries, {
        lineColor: color('--ep-accent'),
        topColor: color('--ep-accent-soft'),
        bottomColor: color('--ep-bg'),
        lineWidth: 2,
        priceFormat: { type: 'price', precision, minMove: 10 ** -precision },
        priceLineVisible: false,
        lastValueVisible: false,
      });
      s.setData(sorted.map((p) => ({ time: time(p.epoch), value: p.value })));
    }
    if (flow) {
      const s = chart.addSeries(HistogramSeries, {
        priceScaleId: 'flow',
        priceLineVisible: false,
        lastValueVisible: false,
      });
      s.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      s.setData(
        sorted.map((p) => ({
          time: time(p.epoch),
          value: (p.inflow ?? 0) - (p.outflow ?? 0),
          color: color((p.inflow ?? 0) >= (p.outflow ?? 0) ? '--ep-accent-line' : '--ep-warn-line'),
        })),
      );
    }
    chart.subscribeCrosshairMove((p) =>
      setHover(p.time ? (sorted.find((v) => time(v.epoch) === p.time) ?? null) : null),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, height, bars, flow, precision]);
  if (points.length === 0)
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        No history available yet.
      </div>
    );
  return (
    <div>
      <div className="min-h-8 text-xs num text-muted-foreground" aria-live="off">
        {hover
          ? `Epoch ${hover.epoch} · ${fmt(hover.value, precision)} ${unit}${flow ? ` · Arriving ${compact(hover.inflow)} · Leaving ${compact(hover.outflow)}` : ''}`
          : ''}
      </div>
      <div
        ref={container}
        style={{ height }}
        role="group"
        aria-label={`${unit} by epoch, ${points.length} observations. Values available in the accompanying data or CSV export.`}
      />
    </div>
  );
}
