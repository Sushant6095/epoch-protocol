import { round } from '../../Lib/Stats';
import { type FeeIndexIntelligence } from '../../types/Panta.types';
import { type IndexReads } from './PantaStores';
import { TimedCache } from './TimedCache';

// ── Geo ─────────────────────────────────────────────────────────────────────────────────────────────

/** Cloudflare's code for Tor exits. */
const TOR = 'T1';

/**
 * The visitor's country from the first of `headers` a TRUSTED proxy sets (Cloudflare `cf-ipcountry`, Vercel
 * `x-vercel-ip-country`), upper-case alpha-2, or null. `XX` (unknown) is null; `T1` (Tor) is kept.
 */
export function countryOf(
  requestHeaders: Record<string, string | string[] | undefined>,
  headers: string[],
): string | null {
  for (const name of headers) {
    const raw = requestHeaders[name.toLowerCase()];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
    if (!value || value === 'XX') continue;
    if (/^[A-Z]{2}$/.test(value) || value === TOR) return value;
  }
  return null;
}

/**
 * On the blocklist; with any blocklist set, Tor exits (`T1`, no country to check) count as blocked too. An unknown
 * country (no trusted header) is blocked only with PANTA_GEO_FAIL_CLOSED.
 */
export function isGeoBlocked(country: string | null, blocked: readonly string[], failClosed = false): boolean {
  if (!country) return failClosed;
  if (blocked.length === 0) return false;
  return country === TOR || blocked.includes(country);
}

// ── Fee Index intelligence (informational) ──────────────────────────────────────────────────────────

/** The newest final value from the Epoch program (FeeIndexService), or null. */
export interface FinalIndexReader {
  latestFinal(): Promise<{ epoch: number; value: number } | null>;
}

export interface IndexSnapshot {
  /** Finished epochs, newest first. */
  history: { epoch: number; value: number }[];
  last: { epoch: number; value: number; status: 'final' | 'computed' } | null;
  running: { epoch: number; value: number; slots: number } | null;
}

export const INTELLIGENCE_NOTE =
  'Informational only, not advice. The model is the share of recent finished epochs whose Fee Index was strictly ' +
  'above the threshold; the implied probability is the market’s YES price. Past fees do not predict future fees.';

/** Pure: the intelligence block of one market from an index snapshot and the market's YES price. */
export function intelligenceFor(
  snapshot: IndexSnapshot,
  threshold: number,
  yesPrice: number | null,
  lookback: number,
): FeeIndexIntelligence {
  const sample = snapshot.history.slice(0, lookback).map((point) => point.value);
  const above = sample.filter((value) => value > threshold).length;
  const model = sample.length > 0 ? round(above / sample.length, 4) : null;
  const implied = yesPrice !== null && yesPrice >= 0 && yesPrice <= 1 ? round(yesPrice, 4) : null;
  return {
    label: 'informational',
    note: INTELLIGENCE_NOTE,
    impliedProbability: implied,
    modelProbability: model,
    model: {
      method: 'empirical share of recent finished epochs above the threshold',
      lookbackEpochs: lookback,
      above,
      sample: sample.length,
    },
    gapPct: implied !== null && model !== null ? round((implied - model) * 100, 1) : null,
    index: { unit: 'µL/CU', last: snapshot.last, running: snapshot.running },
  };
}

/** Reads the index snapshot (history, last value, running epoch) at most once a minute. */
export class IndexSnapshotSource {
  private readonly cache: TimedCache<IndexSnapshot>;

  constructor(
    private readonly reads: IndexReads | null,
    private readonly finals: FinalIndexReader | null,
    private readonly lookback: number,
    now: () => number = Date.now,
  ) {
    this.cache = new TimedCache<IndexSnapshot>(60_000, 30 * 60_000, 1, now);
  }

  async get(): Promise<IndexSnapshot> {
    return (await this.cache.get('index', () => this.load())).value;
  }

  private async load(): Promise<IndexSnapshot> {
    const [history, final, running] = await Promise.all([
      this.reads ? this.reads.history(this.lookback) : Promise.resolve([]),
      this.finals ? this.finals.latestFinal().catch(() => null) : Promise.resolve(null),
      this.reads ? this.reads.running().catch(() => null) : Promise.resolve(null),
    ]);
    const newest = history[0];
    const last = final
      ? { ...final, status: 'final' as const }
      : newest
        ? { epoch: newest.epoch, value: newest.value, status: 'computed' as const }
        : null;
    // The slot medians' newest epoch is "running" only while the indexer has not rolled it up yet.
    const live = running && (!newest || running.epoch > newest.epoch) ? running : null;
    return { history, last, running: live };
  }
}
