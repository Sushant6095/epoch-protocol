"use client";
// Leaders of the epoch, by stake: each leader's median of its slot medians, its stake weight, and the leader whose
// median IS the index (the stake-weighted median) highlighted with words, not only colour.

import { useMemo } from "react";

import { type Column, columnHelper, DataTable } from "@/components/data/data-table";
import { Badge } from "@/components/ui/badge";
import type { LiveLeader } from "@/lib/data/types";
import { fmtCompact, fmtCu, fmtInt, fmtPct, shortKey } from "@/lib/format";

const h = columnHelper<LiveLeader>();

export function LeadersTable({ leaders, epoch }: { leaders: LiveLeader[]; epoch: number }) {
  // Running stake share by median: where it crosses 50% is the index (shown as a column, so the rule is visible).
  const cumulative = useMemo(() => {
    const byMedian = [...leaders].sort((a, b) => a.medianCuPrice - b.medianCuPrice);
    const total = byMedian.reduce((a, l) => a + (l.stakeSol ?? 0), 0) || 1;
    let run = 0;
    const out = new Map<string, number>();
    for (const l of byMedian) {
      run += l.stakeSol ?? 0;
      out.set(l.identity, (run / total) * 100);
    }
    return out;
  }, [leaders]);

  const columns = useMemo(
    () =>
      [
        h.accessor("rank", { header: "Rank", meta: { numeric: true }, cell: (c) => fmtInt(c.getValue()) }),
        h.accessor((r) => r.name ?? r.identity, {
          id: "leader",
          header: "Leader",
          cell: (c) => (
            <span className="flex items-center gap-2">
              <span className="text-ep-text">{c.row.original.name ?? <span className="num">{shortKey(c.row.original.identity)}</span>}</span>
              {c.row.original.setsIndex ? (
                <Badge variant="outline" className="border-ep-info-line bg-ep-info-soft text-ep-info">
                  sets the index
                </Badge>
              ) : null}
            </span>
          ),
        }),
        h.accessor("medianCuPrice", { header: () => <>Median <span className="normal-case">µL/CU</span></>, meta: { numeric: true }, cell: (c) => fmtCu(c.getValue()) }),
        h.accessor("slots", { header: "Slots", meta: { numeric: true }, cell: (c) => fmtInt(c.getValue()) }),
        h.accessor("pricedTxs", { header: "Priced txs", meta: { numeric: true }, cell: (c) => fmtInt(c.getValue()) }),
        h.accessor("stakeSol", { header: "Stake SOL", meta: { numeric: true }, sortUndefined: "last", cell: (c) => fmtCompact(c.getValue(), 2) }),
        h.accessor("weightPct", { header: "Weight", meta: { numeric: true }, cell: (c) => fmtPct(c.getValue(), 2) }),
        h.accessor((r) => cumulative.get(r.identity) ?? 0, {
          id: "cum",
          header: "Cum. weight by median",
          meta: { numeric: true },
          cell: (c) => fmtPct(c.getValue(), 1),
        }),
      ] as Column<LiveLeader>[],
    [cumulative],
  );

  return (
    <DataTable
      columns={columns}
      data={leaders}
      getRowId={(r) => r.identity}
      initialSorting={[{ id: "rank", desc: false }]}
      rowClassName={(r) => (r.setsIndex ? "bg-ep-info-soft hover:bg-ep-info-soft" : undefined)}
      caption={`Slot leaders of epoch ${epoch} with priced slots, by stake`}
      emptyText="No priced slots in this epoch yet."
    />
  );
}
