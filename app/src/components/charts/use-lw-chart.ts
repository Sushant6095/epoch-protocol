"use client";
// lightweight-charts 5 with Epoch's tokens: colours are read from the CSS variables at mount (never hex in code),
// `autoSize` keeps the canvas sized to its box, and the chart is removed on unmount. The TradingView attribution
// logo stays on (Apache-2.0 requirement; the footer also links it).

import { type ChartOptions, ColorType, createChart, type DeepPartial, type IChartApi, LineStyle } from "lightweight-charts";
import { type RefObject, useEffect, useRef, useState } from "react";

export interface ChartColors {
  text: string;
  muted: string;
  grid: string;
  crosshair: string;
  accent: string;
  accentSoft: string;
  info: string;
  warn: string;
  line: string;
  lineStrong: string;
  surface: string;
}

export function readChartColors(): ChartColors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    text: v("--ep-text"),
    muted: v("--ep-muted"),
    grid: v("--ep-chart-grid"),
    crosshair: v("--ep-chart-crosshair"),
    accent: v("--ep-accent"),
    accentSoft: v("--ep-accent-line"),
    info: v("--ep-info"),
    warn: v("--ep-warn"),
    line: v("--ep-line"),
    lineStrong: v("--ep-line-strong"),
    surface: v("--ep-surface"),
  };
}

/** A hex colour with an alpha (charts need rgba strings; the hex comes from the tokens). */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return hex;
  const n = Number.parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function useLightweightChart(
  ref: RefObject<HTMLDivElement | null>,
  options: (c: ChartColors) => DeepPartial<ChartOptions>,
): { chart: IChartApi | null; colors: ChartColors | null } {
  const [state, setState] = useState<{ chart: IChartApi | null; colors: ChartColors | null }>({ chart: null, colors: null });
  const optionsRef = useRef(options);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const colors = readChartColors();
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: colors.muted,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--ep-font-mono").trim() || "monospace",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.line },
      timeScale: { borderColor: colors.line },
      crosshair: {
        vertLine: { color: colors.crosshair, style: LineStyle.Dashed, labelBackgroundColor: colors.lineStrong },
        horzLine: { color: colors.crosshair, style: LineStyle.Dashed, labelBackgroundColor: colors.lineStrong },
      },
    });
    // Page options are merged deeply on top of the base theme.
    chart.applyOptions(optionsRef.current(colors));
    setState({ chart, colors });
    return () => {
      setState({ chart: null, colors: null });
      chart.remove();
    };
  }, [ref]);
  return state;
}
