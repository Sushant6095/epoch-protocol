"use client";
// This epoch's slot medians in log-spaced buckets (four per decade), with the index marked: shadcn chart (Recharts).

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, XAxis, YAxis } from "recharts";

import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import type { FeeDistribution } from "@/lib/data/types";
import { fmtCu, fmtCuTick, fmtInt } from "@/lib/format";

const config = {
  slots: { label: "Blocks", color: "var(--ep-chart-1)" },
} satisfies ChartConfig;

export function DistributionChart({ dist }: { dist: FeeDistribution }) {
  const data = dist.buckets.map((b) => ({
    label: `${fmtCuTick(b.fromCuPrice)}–${fmtCuTick(b.toCuPrice)}`,
    slots: b.slots,
    hasIndex: dist.indexValue !== null && dist.indexValue >= b.fromCuPrice && dist.indexValue < b.toCuPrice,
  }));
  const indexBucket = data.find((d) => d.hasIndex)?.label;
  return (
    <figure className="flex flex-col gap-3">
      <ChartContainer config={config} className="aspect-auto h-56 w-full">
        <BarChart data={data} margin={{ top: 18, right: 8, bottom: 0, left: 0 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--ep-chart-grid)" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" tickMargin={8} minTickGap={8} />
          <YAxis width={32} allowDecimals={false} tickLine={false} axisLine={false} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(l) => `${l} µL/CU`} />} />
          <Bar dataKey="slots" radius={3} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.label} fill={d.hasIndex ? "var(--ep-accent)" : "var(--ep-accent-line)"} />
            ))}
          </Bar>
          {indexBucket ? (
            <ReferenceLine
              x={indexBucket}
              stroke="var(--ep-info)"
              strokeDasharray="4 4"
              label={{ value: `index ${fmtCu(dist.indexValue)}`, position: "top", fill: "var(--ep-info)", fontSize: 11 }}
            />
          ) : null}
        </BarChart>
      </ChartContainer>
      <figcaption className="sr-only">
        {fmtInt(dist.slots)} blocks of epoch {dist.epoch}; the index ({fmtCu(dist.indexValue)} µL/CU) falls in the {indexBucket ?? "—"} bucket.
      </figcaption>
    </figure>
  );
}
