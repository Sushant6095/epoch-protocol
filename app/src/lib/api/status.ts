"use client";
// Is the Epoch API reachable? One small store the whole app reads:
//   checking → the first probe has not answered (hooks wait, skeletons show)
//   online   → hooks read the API and the socket connects
//   offline  → hooks read the fixtures in src/fixtures (sample mode, labelled "Sample"); the probe retries
//   sample   → sample mode forced with NEXT_PUBLIC_EPOCH_DATA=sample or ?sample=1 in the URL
// The probe goes through the app's own /api/probe route, so a missing API never fills the browser console with
// failed requests; any hook that still meets a network error flips the store to offline.

import { create } from "zustand";

import { env } from "@/lib/env";

export type ApiMode = "checking" | "online" | "offline" | "sample";

interface ProbeAnswer {
  reachable: boolean;
  status?: number;
  ms?: number;
  checkedAt: string;
}

interface ApiStatusState {
  mode: ApiMode;
  checkedAt: string | null;
  latencyMs: number | null;
  /** Why the app is in sample mode, for the footer and the Sample badge tooltip. */
  reason: string | null;
  probe: () => Promise<void>;
  markOffline: (reason: string) => void;
}

const forcedSample = (): boolean => {
  if (env.forceSample) return true;
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search);
  return q.get("sample") === "1" || q.get("data") === "sample";
};

export const useApiStatus = create<ApiStatusState>((set, get) => ({
  mode: "checking",
  checkedAt: null,
  latencyMs: null,
  reason: null,
  probe: async () => {
    if (forcedSample()) {
      set({ mode: "sample", reason: "Sample mode is switched on for this page.", checkedAt: new Date().toISOString() });
      return;
    }
    try {
      const res = await fetch("/api/probe", { cache: "no-store" });
      const answer = (await res.json()) as ProbeAnswer;
      if (answer.reachable) {
        set({ mode: "online", reason: null, checkedAt: answer.checkedAt, latencyMs: answer.ms ?? null });
      } else {
        set({
          mode: "offline",
          reason: "The Epoch API can't be reached, so this page shows sample data.",
          checkedAt: answer.checkedAt,
          latencyMs: null,
        });
      }
    } catch {
      // The app's own route failed (static hosting without the route handler): fall back to sample mode.
      if (get().mode === "checking") {
        set({ mode: "offline", reason: "The API status could not be checked, so this page shows sample data.", checkedAt: new Date().toISOString() });
      }
    }
  },
  markOffline: (reason) => {
    if (get().mode === "online" || get().mode === "checking") {
      set({ mode: "offline", reason, checkedAt: new Date().toISOString() });
    }
  },
}));

/** True when hooks should read fixtures. */
export const isSampleMode = (mode: ApiMode) => mode === "offline" || mode === "sample";
