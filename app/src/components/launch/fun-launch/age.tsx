"use client";
// Adapted from Meteora's fun-launch scaffold (MIT, Copyright (c) 2025 Meteora; see app/THIRD-PARTY-NOTICES.md):
// `lib/format/date.ts` formatAge, `components/TokenTable/TxnsTab/CurrentAge.tsx` and the shared clock of
// `lib/environment/date.ts` (one timer for every age on the page). Changed: no jotai (a tiny external store),
// a frozen clock for sample data, Epoch's DASH.

import { useSyncExternalStore } from "react";

import { DASH } from "@/lib/format";

/** "12s", "4m", "2h", "3d": the scaffold's compact age. */
export function formatAge(date: Date | undefined | null, now: Date): string {
  if (date === undefined || date === null || Number.isNaN(date.getTime())) return DASH;
  const secondsDiff = Math.abs(Math.floor((date.getTime() - now.getTime()) / 1000));
  if (secondsDiff < 60) return `${secondsDiff}s`;
  const minutesDiff = Math.floor(secondsDiff / 60);
  if (minutesDiff < 60) return `${minutesDiff}m`;
  const hoursDiff = Math.floor(minutesDiff / 60);
  if (hoursDiff < 24) return `${hoursDiff}h`;
  return `${Math.floor(hoursDiff / 24)}d`;
}

// One shared 1 s clock for every age on the page.
let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useCurrentDate(frozenAt?: number): Date {
  const t = useSyncExternalStore(subscribe, () => now, () => 0);
  return new Date(frozenAt ?? t);
}

export function CurrentAge({ date, frozenAt }: { date: Date; frozenAt?: number }) {
  const current = useCurrentDate(frozenAt);
  return <>{formatAge(date, current)}</>;
}
