"use client";
// Launch hooks (docs/pages/launch.md). `/page` gives the first paint; WS `launch:<mint>` then pushes a snapshot,
// trades, market reads and fee/lifecycle events, which are merged into the page's cache:
//   trade  → prepended to the feed (deduped on id); a trade by the buyback escrow re-reads /buybacks
//   market → replaces the market block (price, raise, venue, graduation)
//   fee    → re-reads /fees and /holders; `dammPoolCreated` re-reads /page (the venue is DAMM v2 from now on)

import { useQueryClient } from "@tanstack/react-query";

import { useStreamChannel, useStreamReconnect } from "@/lib/api/stream";
import { launchBuybacksSample, launchCandlesSample, launchPageSample, launchesSample } from "@/fixtures/launch";

import { apiKey, type Sourced, useEpochQuery } from "./query";
import type {
  LaunchBuybackFeed,
  LaunchCandleInterval,
  LaunchCandles,
  LaunchFees,
  LaunchHolders,
  LaunchList,
  LaunchPage,
  LaunchStreamMessage,
  LaunchTrade,
} from "./types";

export function useLaunches() {
  return useEpochQuery<LaunchList>({
    key: ["launch", "list"],
    path: "/v1/launches",
    sample: launchesSample,
    refetchInterval: 60_000,
  });
}

export function useLaunchPage(key: string) {
  return useEpochQuery<LaunchPage | null>({
    key: ["launch", "page", key],
    path: `/v1/launches/${encodeURIComponent(key)}/page`,
    sample: () => launchPageSample(key),
  });
}

export function useLaunchCandles(mint: string | null, interval: LaunchCandleInterval) {
  return useEpochQuery<LaunchCandles>({
    key: ["launch", "candles", mint, interval],
    path: mint ? `/v1/launches/${mint}/candles?interval=${interval}` : null,
    sample: () => launchCandlesSample(mint ?? "", interval),
    refetchInterval: 30_000,
    enabled: !!mint,
    keepPrevious: true,
  });
}

export function useLaunchHolders(mint: string | null, initial: LaunchPage["holders"] | undefined) {
  return useEpochQuery<LaunchHolders | null>({
    key: ["launch", "holders", mint],
    path: mint ? `/v1/launches/${mint}/holders` : null,
    sample: () => (initial ? { schemaVersion: 1, kind: "real", asOf: initial.freshness.asOf ?? "", source: "sample", network: "devnet", mint: mint ?? "", ...initial } : null),
    refetchInterval: 45_000,
    enabled: !!mint,
  });
}

export function useLaunchFees(mint: string | null, initial: LaunchPage["fees"] | undefined) {
  return useEpochQuery<LaunchFees | null>({
    key: ["launch", "fees", mint],
    path: mint ? `/v1/launches/${mint}/fees` : null,
    sample: () => (initial ? { schemaVersion: 1, kind: "real", asOf: initial.freshness.asOf ?? "", source: "sample", network: "devnet", mint: mint ?? "", ...initial } : null),
    refetchInterval: 45_000,
    enabled: !!mint,
  });
}

/** `link` is the bundle's `links.buybacks` (base58 mint; a symbol answers 400). */
export function useLaunchBuybacks(mint: string | null, link: string | null) {
  return useEpochQuery<LaunchBuybackFeed | null>({
    key: ["launch", "buybacks", mint],
    path: link,
    sample: () => (mint ? launchBuybacksSample(mint) : null),
    refetchInterval: 60_000,
    enabled: !!mint,
  });
}

/** Subscribe the token page to `launch:<mint>` and merge the frames into its caches. */
export function useLaunchStream(page: LaunchPage | null | undefined, routeKey: string, live: boolean) {
  const qc = useQueryClient();
  const mint = page?.launch.mint ?? null;
  const pageKey = apiKey("launch", "page", routeKey);
  const escrow = page?.revenueToken.buybackEscrow ?? page?.detail.escrow.address ?? null;

  const patchPage = (fn: (p: LaunchPage) => LaunchPage) =>
    qc.setQueryData<Sourced<LaunchPage | null>>(pageKey, (prev) => (prev?.data ? { ...prev, data: fn(prev.data), receivedAt: Date.now() } : prev));

  const addTrades = (incoming: LaunchTrade[]) =>
    patchPage((p) => {
      const seen = new Set(p.trades.map((t) => t.id));
      const fresh = incoming.filter((t) => !seen.has(t.id));
      if (!fresh.length) return p;
      const trades = [...fresh, ...p.trades].sort((a, b) => b.slot - a.slot || Date.parse(b.t) - Date.parse(a.t)).slice(0, 200);
      return { ...p, trades };
    });

  useStreamChannel<LaunchStreamMessage>(live && page ? page.stream.channel : null, (msg) => {
    switch (msg.type) {
      case "snapshot":
        patchPage((p) => ({ ...p, market: msg.market }));
        addTrades(msg.trades);
        break;
      case "trade":
        addTrades([msg.trade]);
        void qc.invalidateQueries({ queryKey: apiKey("launch", "candles", mint) });
        if (escrow && msg.trade.trader === escrow) void qc.invalidateQueries({ queryKey: apiKey("launch", "buybacks", mint) });
        break;
      case "market":
        patchPage((p) => ({ ...p, market: msg.market }));
        break;
      case "fee":
        void qc.invalidateQueries({ queryKey: apiKey("launch", "fees", mint) });
        void qc.invalidateQueries({ queryKey: apiKey("launch", "holders", mint) });
        if (msg.event.kind === "curveComplete") {
          patchPage((p) => ({ ...p, market: { ...p.market, venue: null, graduation: { ...p.market.graduation, state: "complete" } } }));
        }
        if (msg.event.kind === "dammPoolCreated") void qc.invalidateQueries({ queryKey: pageKey });
        break;
    }
  });

  // A reconnect sends a new snapshot; also re-read the slower blocks.
  useStreamReconnect(() => {
    if (!live || !mint) return;
    void qc.invalidateQueries({ queryKey: apiKey("launch", "fees", mint) });
    void qc.invalidateQueries({ queryKey: apiKey("launch", "buybacks", mint) });
  });
}
