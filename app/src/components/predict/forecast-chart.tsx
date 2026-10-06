"use client";
// The crowd's forecast of one epoch's Fee Index, read from the YES prices of Epoch's strike ladder on Panta
// (GET /v1/predict/panta/forecast). Drawn as a survival curve: x = µL/CU, y = P(index > x). Dots: each strike's
// implied probability (open where the monotonic fit moved it); line: the lognormal fit; shaded: the 80% band; dashed:
// the median, and the index Solami is streaming live for the running epoch. Informational, never advice.

import { CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, Scatter, XAxis, YAxis } from "recharts";

import { type ChartConfig, ChartContainer, ChartTooltip } from "@/components/ui/chart";
import type { PantaForecastView } from "@/lib/data/types";
import { fmtCu, fmtCuTick, fmtProb } from "@/lib/format";

const config = {
  curve: { label: "Fitted curve", color: "var(--ep-chart-1)" },
  implied: { label: "Market (implied)", color: "var(--ep-chart-1)" },
  empirical: { label: "Past epochs", color: "var(--ep-chart-4)" },
} satisfies ChartConfig;

/** Abramowitz–Stegun 7.1.26: the standard normal CDF. */
function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export function ForecastChart({
  forecast,
  liveIndex,
  liveEpoch,
  highlightStrike,
}: {
  forecast: PantaForecastView;
  liveIndex: number | null;
  liveEpoch: number | null;
  highlightStrike?: number | null;
}) {
  const strikes = forecast.strikes.map((s) => s.strikeMicroLamports);
  const lo = Math.min(...strikes, forecast.band?.low ?? Infinity, forecast.median ?? Infinity);
  const hi = Math.max(...strikes, forecast.band?.high ?? -Infinity, forecast.median ?? -Infinity);
  const min = Math.max(0, Math.floor((lo * 0.75) / 50) * 50);
  const max = Math.ceil((hi * 1.2) / 50) * 50;
  const fit = forecast.fit;
  const curve = fit
    ? Array.from({ length: 64 }, (_, i) => {
        const x = min + ((max - min) * i) / 63;
        return { x, curve: x <= 0 ? 1 : 1 - phi((Math.log(x) - fit.mu) / fit.sigma) };
      })
    : forecast.strikes.filter((s) => s.curveProbability !== null).map((s) => ({ x: s.strikeMicroLamports, curve: s.curveProbability as number }));
  const implied = forecast.strikes
    .filter((s) => s.impliedProbability !== null)
    .map((s) => ({ x: s.strikeMicroLamports, implied: s.impliedProbability as number, moved: s.fittedProbability !== null && Math.abs((s.fittedProbability ?? 0) - (s.impliedProbability ?? 0)) > 0.005 }));
  const empirical = forecast.strikes.filter((s) => s.empiricalProbability !== null).map((s) => ({ x: s.strikeMicroLamports, empirical: s.empiricalProbability as number }));
  const liveInRange = liveIndex !== null && liveIndex >= min && liveIndex <= max;

  return (
    <figure className="flex flex-col gap-2">
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <ComposedChart margin={{ top: 22, right: 12, bottom: 4, left: 0 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--ep-chart-grid)" />
          <XAxis type="number" dataKey="x" domain={[min, max]} tickFormatter={(v: number) => fmtCuTick(v)} tickLine={false} axisLine={false} tickMargin={8} allowDataOverflow />
          <YAxis type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v: number) => fmtProb(v)} width={40} tickLine={false} axisLine={false} />
          {forecast.band ? <ReferenceArea x1={forecast.band.low} x2={forecast.band.high} fill="var(--ep-accent-soft)" fillOpacity={0.9} ifOverflow="hidden" /> : null}
          {highlightStrike ? <ReferenceLine x={highlightStrike} stroke="var(--ep-line-strong)" strokeDasharray="2 3" /> : null}
          {forecast.median !== null ? (
            <ReferenceLine x={forecast.median} stroke="var(--ep-accent)" strokeDasharray="4 4" label={{ value: `median ≈ ${fmtCu(forecast.median)}`, position: "top", fill: "var(--ep-accent)", fontSize: 11 }} />
          ) : null}
          {liveInRange ? (
            <ReferenceLine x={liveIndex} stroke="var(--ep-info)" strokeDasharray="4 4" label={{ value: `live ${fmtCu(liveIndex)}`, position: "insideTopRight", fill: "var(--ep-info)", fontSize: 11 }} />
          ) : null}
          <Line data={curve} dataKey="curve" type="monotone" stroke="var(--color-curve)" strokeWidth={2} dot={false} isAnimationActive={false} name="Fitted curve" />
          <Scatter data={empirical} dataKey="empirical" fill="var(--color-empirical)" shape="diamond" isAnimationActive={false} name="Past epochs" />
          <Scatter
            data={implied}
            dataKey="implied"
            isAnimationActive={false}
            name="Market (implied)"
            shape={(props: unknown) => {
              const p = props as { cx?: number; cy?: number; payload?: { moved: boolean } };
              if (p.cx === undefined || p.cy === undefined) return <g />;
              return p.payload?.moved ? (
                <circle cx={p.cx} cy={p.cy} r={5} fill="var(--ep-surface)" stroke="var(--ep-accent)" strokeWidth={2} />
              ) : (
                <circle cx={p.cx} cy={p.cy} r={5} fill="var(--ep-accent)" />
              );
            }}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--ep-chart-crosshair)", strokeDasharray: "3 3" }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as { x: number; curve?: number; implied?: number; empirical?: number };
              return (
                <div className="rounded-md border border-ep-line-strong bg-ep-raised px-3 py-2 text-xs">
                  <p className="num text-ep-text">{fmtCu(row.x)} µL/CU</p>
                  {row.curve !== undefined ? <p className="text-ep-text-2">P(index &gt; x), fitted: <span className="num">{fmtProb(row.curve, 1)}</span></p> : null}
                  {row.implied !== undefined ? <p className="text-ep-text-2">Market (YES price): <span className="num">{fmtProb(row.implied)}</span></p> : null}
                  {row.empirical !== undefined ? <p className="text-ep-text-2">Past epochs above: <span className="num">{fmtProb(row.empirical)}</span></p> : null}
                </div>
              );
            }}
          />
        </ComposedChart>
      </ChartContainer>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ep-muted">
        <span className="flex items-center gap-1.5"><span aria-hidden className="h-0.5 w-4 bg-ep-accent" /> fitted P(index &gt; x)</span>
        <span className="flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-ep-accent" /> a strike&apos;s YES price (open: moved by the fit)</span>
        <span className="flex items-center gap-1.5"><span aria-hidden className="size-2 rotate-45 bg-chart-4" /> share of past epochs above</span>
        {forecast.band ? <span className="flex items-center gap-1.5"><span aria-hidden className="h-2 w-4 bg-ep-accent-soft" /> 80% band</span> : null}
        {liveIndex !== null ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="h-px w-4 border-t border-dashed border-ep-info" />
            {liveInRange ? "live index" : `live index ${fmtCu(liveIndex)} µL/CU`} (epoch {liveEpoch ?? "—"}, streamed through Solami){liveInRange ? "" : ", off this scale"}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
