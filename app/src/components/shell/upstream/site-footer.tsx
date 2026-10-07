"use client";
// Footer strip (SH10–SH13): where the data comes from (the Epoch API, or sample data when it can't be reached), the
// socket's state, the network badge (chain data is mainnet; Launch pages add their own Devnet badge), the
// lightweight-charts attribution and the pre-alpha line. Times on every page are IST.

import { Badge } from "@/components/ui/badge";
import { LiveDot, SampleBadge } from "@/components/data/source-badge";
import { useApiStatus } from "@/lib/api/status";
import { useStreamStatus } from "@/lib/api/stream";
import { apiHost } from "@/lib/env";

const STREAM_WORDS = { idle: "stream idle", connecting: "stream connecting", open: "stream connected", reconnecting: "stream reconnecting…" } as const;

export function SiteFooter() {
  const mode = useApiStatus((s) => s.mode);
  const latency = useApiStatus((s) => s.latencyMs);
  const { state } = useStreamStatus();
  return (
    <footer className="border-t border-ep-line bg-ep-bg-bar">
      <div className="page-gutter mx-auto flex min-h-11 max-w-screen-2xl flex-wrap items-center gap-x-5 gap-y-2 py-2.5 text-xs text-ep-muted">
        <Badge variant="outline" className="h-6 border-ep-line-strong px-2 font-mono text-xs text-ep-text-2">
          Mainnet data
        </Badge>
        <span className="flex items-center gap-2">
          <span className="label-caps">Data</span>
          {mode === "online" ? (
            <span className="flex items-center gap-1.5 text-ep-text-2">
              <LiveDot on={state === "open"} />
              Epoch API · <span className="num">{apiHost()}</span>
              {latency !== null ? <span className="num text-ep-muted">· {latency} ms</span> : null}
              <span className="text-ep-muted">· {STREAM_WORDS[state]}</span>
            </span>
          ) : mode === "checking" ? (
            <span>checking the Epoch API…</span>
          ) : (
            <span className="flex items-center gap-2">
              <SampleBadge />
              <span>{mode === "sample" ? "sample mode is on" : <>the Epoch API at <span className="num">{apiHost()}</span> can&apos;t be reached</>}</span>
            </span>
          )}
        </span>
        <span>Times in IST</span>
        <span className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1">
          <span>Unaudited pre-alpha · not financial advice</span>
          <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="underline-offset-4 hover:text-ep-text hover:underline">
            Charts by TradingView
          </a>
        </span>
      </div>
    </footer>
  );
}
