"use client";
// Predict hooks (docs/pages/predict.md). Real tab: Panta through Epoch's API (`/v1/predict/panta/*`), prices pushed on
// WS `predict:panta` about every 15 s and merged into the cards by marketId. Points tab: `/v1/predict/*`.

import { useQueryClient } from "@tanstack/react-query";

import { useStreamChannel } from "@/lib/api/stream";
import {
  feeIndexEpochSample,
  pantaCategoriesSample,
  pantaForecastSample,
  pantaMarketDetailSample,
  pantaMarketsSample,
  pantaPositionsSample,
  pantaStatsSample,
  pointsLeaderboardSample,
  pointsSnapshotSample,
} from "@/fixtures/predict";

import { apiKey, type Sourced, useEpochQuery } from "./query";
import type {
  FeeIndexEpochView,
  PantaCategoriesView,
  PantaForecastView,
  PantaMarketDetail,
  PantaMarketsPage,
  PantaPositionsView,
  PantaStatsView,
  PantaStreamData,
  PredictLeaderboard,
  PredictSnapshot,
} from "./types";

export interface MarketsQuery {
  category?: string | null;
  q?: string | null;
  status?: string | null;
}

const qs = (params: Record<string, string | number | null | undefined>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : "";
};

export function usePantaMarkets(params: MarketsQuery = {}) {
  const qc = useQueryClient();
  const key = ["predict", "panta", "markets", params.category ?? null, params.q ?? null, params.status ?? null];
  const query = useEpochQuery<PantaMarketsPage>({
    key,
    path: `/v1/predict/panta/markets${qs({ category: params.category, q: params.q, status: params.status, limit: 24 })}`,
    sample: () => {
      const page = pantaMarketsSample();
      const q = params.q?.toLowerCase();
      const items = page.discover.items.filter(
        (m) => (!params.category || m.category === params.category) && (!q || m.title.toLowerCase().includes(q)),
      );
      return { ...page, discover: { ...page.discover, items, category: params.category ?? null, q: params.q ?? null } };
    },
    refetchInterval: 30_000,
    keepPrevious: true,
  });
  // Our markets' prices, pushed while subscribed (falls back to the 30 s poll when the server has no Panta key).
  useStreamChannel<PantaStreamData>(query.data?.source === "api" ? "predict:panta" : null, (frame) => {
    qc.setQueryData<Sourced<PantaMarketsPage>>(apiKey(...key), (prev) => {
      if (!prev) return prev;
      const byId = new Map(frame.markets.map((m) => [m.marketId, m]));
      const ours = prev.data.ours.map((m) => {
        const u = byId.get(m.marketId);
        if (!u) return m;
        return {
          ...m,
          yesPrice: u.yesPrice,
          noPrice: u.noPrice,
          volumeUsdc: u.volumeUsdc ?? m.volumeUsdc,
          phase: u.phase,
          pricesAsOf: frame.asOf,
          pricesStale: frame.stale,
          intelligence: { ...m.intelligence, impliedProbability: u.impliedProbability, modelProbability: u.modelProbability ?? m.intelligence.modelProbability },
        };
      });
      return { ...prev, data: { ...prev.data, ours }, receivedAt: Date.now() };
    });
    // The forecast headline follows the same prices.
    for (const f of frame.forecasts) {
      qc.setQueryData<Sourced<PantaForecastView>>(apiKey("predict", "panta", "forecast", f.epoch), (prev) =>
        prev ? { ...prev, data: { ...prev.data, median: f.median, expected: f.expected, band: f.band }, receivedAt: Date.now() } : prev,
      );
    }
  });
  return query;
}

export function usePantaMarket(marketId: string | null) {
  return useEpochQuery<PantaMarketDetail | null>({
    key: ["predict", "panta", "market", marketId],
    path: marketId ? `/v1/predict/panta/markets/${encodeURIComponent(marketId)}` : null,
    sample: () => (marketId ? pantaMarketDetailSample(marketId) : null),
    refetchInterval: 30_000,
    enabled: !!marketId,
  });
}

export function usePantaCategories() {
  return useEpochQuery<PantaCategoriesView>({
    key: ["predict", "panta", "categories"],
    path: "/v1/predict/panta/categories",
    sample: () => pantaCategoriesSample,
  });
}

export function usePantaPositions(wallet: string | null) {
  return useEpochQuery<PantaPositionsView | null>({
    key: ["predict", "panta", "positions", wallet],
    path: wallet ? `/v1/predict/panta/positions?wallet=${wallet}` : null,
    sample: () => (wallet ? pantaPositionsSample(wallet) : null),
    refetchInterval: 30_000,
    enabled: !!wallet,
  });
}

export function usePantaStats() {
  return useEpochQuery<PantaStatsView>({
    key: ["predict", "panta", "stats"],
    path: "/v1/predict/panta/stats",
    sample: () => pantaStatsSample,
    refetchInterval: 60_000,
  });
}

/** `epoch` null: the soonest epoch still trading (the API's default). */
export function usePantaForecast(epoch: number | null) {
  return useEpochQuery<PantaForecastView>({
    key: ["predict", "panta", "forecast", epoch],
    path: `/v1/predict/panta/forecast${epoch ? `?epoch=${epoch}` : ""}`,
    sample: () => pantaForecastSample(epoch),
    refetchInterval: 30_000,
    keepPrevious: true,
  });
}

export function useFeeIndexEpoch(epoch: number | null) {
  return useEpochQuery<FeeIndexEpochView>({
    key: ["index", "epoch", epoch],
    path: epoch ? `/v1/index/epochs/${epoch}` : null,
    sample: () => feeIndexEpochSample(epoch ?? 0),
    refetchInterval: 60_000,
    enabled: !!epoch,
  });
}

export function usePointsSnapshot() {
  return useEpochQuery<PredictSnapshot>({
    key: ["predict", "points", "markets"],
    path: "/v1/predict/markets",
    sample: () => pointsSnapshotSample,
    refetchInterval: 30_000,
  });
}

export function usePointsLeaderboard() {
  return useEpochQuery<PredictLeaderboard>({
    key: ["predict", "points", "leaderboard"],
    path: "/v1/predict/leaderboard?epochs=30",
    sample: () => pointsLeaderboardSample,
    refetchInterval: 120_000,
  });
}
