"use client";
// The trade feed. Adapted from Meteora's fun-launch scaffold (MIT, Copyright (c) 2025 Meteora; see
// app/THIRD-PARTY-NOTICES.md): `components/TokenTable/TxnsTab/columns.tsx` (the Date / Age header toggle, the buy /
// sell type badge, price, amounts, the trader with a "You" tag, the explorer link) and `TxTable.tsx`. Changed:
// TanStack Table v9 through Epoch's DataTable, SOL instead of USD, the venue column (curve or DAMM v2), buybacks by
// the program's escrow labelled "Buyback · burned", Epoch tokens and IST times.

import { ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";

import { type Column, columnHelper, DataTable } from "@/components/data/data-table";
import { PriceText } from "@/components/data/primitives";
import type { LaunchTrade } from "@/lib/data/types";
import { fmtSolValue, fmtTimeSecIst, fmtTokens, shortKey } from "@/lib/format";
import { cn } from "@/lib/utils";

import { CurrentAge } from "./age";

const h = columnHelper<LaunchTrade>();

function TypeBadge({ kind }: { kind: "buy" | "sell" | "buyback" }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-sm px-1.5 text-xs font-medium",
        kind === "buy" && "bg-ep-accent-soft text-ep-accent",
        kind === "sell" && "bg-ep-warn-soft text-ep-warn",
        kind === "buyback" && "bg-ep-info-soft text-ep-info",
      )}
    >
      {kind === "buyback" ? "Buyback · burned" : kind === "buy" ? "Buy" : "Sell"}
    </span>
  );
}

export function TradesTable({
  trades,
  escrow,
  wallet,
  symbol,
  frozenAt,
  pendingSignature,
}: {
  trades: LaunchTrade[];
  escrow: string | null;
  wallet: string | null;
  symbol: string;
  frozenAt?: number;
  pendingSignature?: string | null;
}) {
  const [mode, setMode] = useState<"age" | "date">("age");
  const columns = useMemo(
    () =>
      [
        h.accessor("t", {
          id: "time",
          enableSorting: false,
          header: () => (
            <span className="inline-flex items-center gap-1" role="group" aria-label="Show time as">
              {(["date", "age"] as const).map((m, i) => (
                <span key={m} className="inline-flex items-center gap-1">
                  {i ? <span aria-hidden className="text-ep-line-strong">/</span> : null}
                  <button
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    className={cn("min-h-8 uppercase tracking-wider transition-colors duration-150", mode === m ? "text-ep-text" : "text-ep-muted hover:text-ep-text-2")}
                  >
                    {m === "date" ? "Date" : "Age"}
                  </button>
                </span>
              ))}
            </span>
          ),
          cell: (c) => (
            <span className="num text-ep-text-2">
              {mode === "date" ? fmtTimeSecIst(c.getValue()).replace(" IST", "") : <CurrentAge date={new Date(c.getValue())} frozenAt={frozenAt} />}
            </span>
          ),
        }),
        h.accessor((r) => (escrow && r.trader === escrow ? "buyback" : r.side), {
          id: "type",
          header: "Type",
          cell: (c) => <TypeBadge kind={c.getValue() as "buy" | "sell" | "buyback"} />,
        }),
        h.accessor("venue", { header: "Venue", cell: (c) => <span className="text-xs text-ep-muted">{c.getValue() === "dbc" ? "Curve (DBC)" : "DAMM v2"}</span> }),
        h.accessor("priceSol", { header: "Price SOL", meta: { numeric: true }, cell: (c) => <PriceText value={c.getValue()} /> }),
        h.accessor("solAmount", { header: "SOL", meta: { numeric: true }, cell: (c) => fmtSolValue(c.getValue()) }),
        h.accessor("tokenAmount", { header: () => <span className="normal-case">{symbol}</span>, meta: { numeric: true }, cell: (c) => fmtTokens(c.getValue()) }),
        h.accessor("trader", {
          header: "Trader",
          enableSorting: false,
          cell: (c) => {
            const t = c.getValue();
            return (
              <span className="flex items-center gap-1.5">
                {wallet && t === wallet ? <span className="rounded-sm bg-ep-hover px-1 text-xs text-ep-text">You</span> : null}
                {escrow && t === escrow ? <span className="text-xs text-ep-info">Escrow</span> : null}
                <span className="num text-xs text-ep-muted">{shortKey(t, 3, 3)}</span>
              </span>
            );
          },
        }),
        h.accessor("explorerUrl", {
          header: () => <span className="sr-only">Explorer</span>,
          enableSorting: false,
          cell: (c) => (
            <a href={c.getValue()} target="_blank" rel="noreferrer" className="inline-flex size-8 items-center justify-center rounded-sm text-ep-muted hover:text-ep-accent" aria-label={`Open trade ${shortKey(c.row.original.signature)} on Solana Explorer`}>
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          ),
        }),
      ] as Column<LaunchTrade>[],
    [mode, escrow, wallet, symbol, frozenAt],
  );
  return (
    <DataTable
      columns={columns}
      data={trades}
      getRowId={(r) => r.id}
      caption={`Trades of ${symbol}, newest first`}
      emptyText="No trades yet."
      rowClassName={(r) => (pendingSignature && r.signature === pendingSignature ? "bg-ep-accent-soft" : escrow && r.trader === escrow ? "bg-ep-info-soft/40" : undefined)}
    />
  );
}
