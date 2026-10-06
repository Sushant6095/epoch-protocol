"use client";
// Live page hooks (docs/pages/live.md). REST for the first paint, then WS `index:live` (the whole summary, ≈ 2 s) and
// `slots` (one frame per block); leaders every 30 s, the distribution every 60 s, the Solami report every 10 s.

import { useQueryClient } from "@tanstack/react-query";

import { useStreamChannel, useStreamReconnect, useStreamStatus } from "@/lib/api/stream";
import { liveDistributionSample, liveLeadersSample, liveSlotsSample, liveSummarySample, solamiUsageSample } from "@/fixtures/live";

import { apiKey, type Sourced, useEpochQuery } from "./query";
import type { FeeDistribution, LiveLeaders, LiveSlot, LiveSlots, LiveSummary, SolamiUsageResponse } from "./types";

const SLOT_WINDOW = 60;

export function useLiveSummary() {
  const qc = useQueryClient();
  const { state } = useStreamStatus();
  const query = useEpochQuery<LiveSummary>({
    key: ["live", "summary"],
    path: "/v1/live/summary",
    sample: () => liveSummarySample,
    // The socket pushes every estimate; the poll is the fallback while it is down.
    refetchInterval: state === "open" ? 30_000 : 5_000,
  });
  useStreamChannel<LiveSummary>(query.data?.source === "api" ? "index:live" : null, (data) => {
    qc.setQueryData<Sourced<LiveSummary>>(apiKey("live", "summary"), { data, source: "api", receivedAt: Date.now() });
  });
  return query;
}

export function useLiveSlots() {
  const qc = useQueryClient();
  const query = useEpochQuery<LiveSlots>({
    key: ["live", "slots"],
    path: `/v1/live/slots?limit=${SLOT_WINDOW}`,
    sample: liveSlotsSample,
  });
  useStreamChannel<LiveSlot>(query.data?.source === "api" ? "slots" : null, (slot) => {
    qc.setQueryData<Sourced<LiveSlots>>(apiKey("live", "slots"), (prev) => {
      if (!prev) return prev;
      if (prev.data.slots.some((s) => s.slot === slot.slot)) return prev; // already have it
      const slots = [slot, ...prev.data.slots].sort((a, b) => b.slot - a.slot).slice(0, SLOT_WINDOW);
      return { ...prev, data: { ...prev.data, slots, live: true, asOf: new Date().toISOString() }, receivedAt: Date.now() };
    });
  });
  // A dropped socket may have missed blocks: reload the strip so it has no hole (contract, refresh step 4).
  useStreamReconnect(() => {
    void qc.invalidateQueries({ queryKey: apiKey("live", "slots") });
    void qc.invalidateQueries({ queryKey: apiKey("live", "summary") });
  });
  return query;
}

export function useLiveLeaders(epoch: number | null | undefined) {
  return useEpochQuery<LiveLeaders>({
    key: ["live", "leaders", epoch ?? "current"],
    path: epoch === undefined ? null : `/v1/live/leaders?limit=50${epoch ? `&epoch=${epoch}` : ""}`,
    sample: () => liveLeadersSample,
    refetchInterval: 30_000,
    keepPrevious: true,
  });
}

export function useLiveDistribution(epoch: number | null | undefined) {
  return useEpochQuery<FeeDistribution>({
    key: ["live", "distribution", epoch ?? null],
    path: epoch ? `/v1/live/epochs/${epoch}/distribution` : null,
    sample: () => liveDistributionSample,
    refetchInterval: 60_000,
    keepPrevious: true,
  });
}

export function useSolamiUsage() {
  return useEpochQuery<SolamiUsageResponse>({
    key: ["live", "solami"],
    path: "/v1/live/solami",
    sample: () => solamiUsageSample,
    refetchInterval: 10_000,
  });
}
