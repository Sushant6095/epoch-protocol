"use client";
// The one data primitive every hook in src/lib/data uses: TanStack Query over the Epoch API, with sample mode.
// When the API is unreachable (or sample mode is forced) the hook returns the page's fixture instead, tagged
// `source: "sample"` so the UI labels it. Fixtures are never shown as live: components check `source` (and the
// payload's own `kind`, `live`, `stale` and `freshness` fields) before they show a live badge or animate.

import { useQuery } from "@tanstack/react-query";

import { ApiError, ApiUnreachableError, apiGet } from "@/lib/api/client";
import { isSampleMode, useApiStatus } from "@/lib/api/status";

export type DataSource = "api" | "sample";

/** The cache key of an API-backed query (what useEpochQuery builds), for setQueryData from socket frames. */
export const apiKey = (...key: unknown[]) => ["epoch", "api", ...key];

export interface Sourced<T> {
  data: T;
  source: DataSource;
  /** When this copy arrived in the browser (ms since epoch). */
  receivedAt: number;
}

export interface EpochQueryOptions<T> {
  /** Cache key, without the source (added here so sample and API data never mix). */
  key: readonly unknown[];
  /** API path; null disables the query (missing input). */
  path: string | null;
  /** The fixture for sample mode. Return null when there is no sample for this input. */
  sample: () => T;
  refetchInterval?: number | false;
  enabled?: boolean;
  /** Keep the previous answer while a new key loads (paging, pickers). */
  keepPrevious?: boolean;
}

/** Codes that mean "this part of the backend is not set up": retrying won't help, the page shows its own state. */
const NOT_CONFIGURED = new Set([
  "DATABASE_NOT_CONFIGURED",
  "PROGRAM_NOT_CONFIGURED",
  "PANTA_NOT_CONFIGURED",
  "PANTA_TRADING_DISABLED",
  "NOT_READY",
  "NOT_FOUND",
  "BAD_REQUEST",
  "NOT_LAUNCHED",
]);

export function useEpochQuery<T>({ key, path, sample, refetchInterval, enabled = true, keepPrevious }: EpochQueryOptions<T>) {
  const mode = useApiStatus((s) => s.mode);
  const markOffline = useApiStatus((s) => s.markOffline);
  const sampleMode = isSampleMode(mode);

  return useQuery<Sourced<T>, Error>({
    queryKey: ["epoch", sampleMode ? "sample" : "api", ...key],
    enabled: enabled && mode !== "checking" && (sampleMode || path !== null),
    queryFn: async ({ signal }) => {
      if (sampleMode) return { data: sample(), source: "sample", receivedAt: Date.now() };
      try {
        const data = await apiGet<T>(path as string, { signal });
        return { data, source: "api", receivedAt: Date.now() };
      } catch (error) {
        if (error instanceof ApiUnreachableError) {
          markOffline(error.message);
          return { data: sample(), source: "sample", receivedAt: Date.now() };
        }
        throw error;
      }
    },
    refetchInterval: sampleMode ? false : refetchInterval,
    // Nothing to refresh in sample mode; live data keeps its own cadence.
    staleTime: sampleMode ? Infinity : 0,
    retry: (count, error) => {
      if (error instanceof ApiError) {
        if (NOT_CONFIGURED.has(error.code) || error.status < 500) return false;
        // The API could not read the chain: one retry, then the block's own refetch interval.
        if (error.code === "CHAIN_ERROR") return count < 1;
        return count < 2;
      }
      return count < 1;
    },
    placeholderData: keepPrevious ? (previous) => previous : undefined,
  });
}

/** True when a payload (or the copy we hold) must not be presented as live data. */
export function isSampleKind(kind: string | null | undefined): boolean {
  return kind === "sample" || kind === "demo";
}
