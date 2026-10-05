import { PantaBudgetError } from './errors';

/**
 * Panta's rate-limit families and their documented defaults per account (https://docs.panta.market/guides/errors.md
 * → Rate limits, 3 Oct 2026). Limits are per ACCOUNT, so every process sharing one API key shares them: each process
 * takes only a share (`RequestBudget` `share`, PANTA_RATE_LIMIT_SHARE).
 */
export const PANTA_FAMILIES = ['read', 'positions', 'quote', 'build', 'register', 'upload'] as const;
export type PantaFamily = (typeof PANTA_FAMILIES)[number];

export interface RateLimit {
  max: number;
  windowMs: number;
}

export const PANTA_RATE_LIMITS: Readonly<Record<PantaFamily, RateLimit>> = {
  /** Account and catalog reads, trade status. */
  read: { max: 120, windowMs: 60_000 },
  /** GET /positions/. */
  positions: { max: 60, windowMs: 60_000 },
  /** Create and primary-buy quotes. */
  quote: { max: 30, windowMs: 60_000 },
  /** Create, primary-buy, win-claim and creator-fee builds. */
  build: { max: 20, windowMs: 60_000 },
  /** Register, trade report, primary submit (and verify, which the guide does not place: counted here to be safe). */
  register: { max: 40, windowMs: 60_000 },
  /** Image upload signatures. */
  upload: { max: 10, windowMs: 60_000 },
};

export interface RequestBudgetOptions {
  /** Share of each documented limit this process may use, 0 < share ≤ 1. Default 0.8 (headroom for retries and clocks). */
  share?: number;
  /** Overrides, e.g. when Panta raises a deployment's limits. */
  limits?: Partial<Record<PantaFamily, RateLimit>>;
  now?: () => number;
}

export interface FamilyBudget {
  /** Requests sent in the current window. */
  used: number;
  capacity: number;
  /** 0 when a request may go now. */
  waitMs: number;
}

/**
 * A sliding-window request log per family: at most `capacity` requests in any `windowMs`, so this process can never
 * exceed its share of Panta's per-account limit, whatever the burst. Panta's own signals (a 429's `Retry-After`,
 * `X-RateLimit-Remaining: 0` with `X-RateLimit-Reset`) block the family until the time they name.
 */
export class RequestBudget {
  private readonly sent = new Map<PantaFamily, number[]>();
  private readonly blockedUntil = new Map<PantaFamily, number>();
  private readonly limits: Record<PantaFamily, RateLimit>;
  readonly capacity: Readonly<Record<PantaFamily, number>>;
  private readonly now: () => number;

  constructor(options: RequestBudgetOptions = {}) {
    const share = options.share ?? 0.8;
    if (!(share > 0 && share <= 1)) throw new RangeError('RequestBudget share must be in (0, 1]');
    this.now = options.now ?? Date.now;
    this.limits = { ...PANTA_RATE_LIMITS, ...options.limits };
    const capacity = {} as Record<PantaFamily, number>;
    for (const family of PANTA_FAMILIES) capacity[family] = Math.max(1, Math.floor(this.limits[family].max * share));
    this.capacity = capacity;
  }

  /** Milliseconds until a request in `family` may be sent (0: now). Takes nothing. */
  waitMs(family: PantaFamily): number {
    const now = this.now();
    const times = this.prune(family, now);
    const capacity = this.capacity[family];
    const windowWait =
      times.length < capacity ? 0 : times[times.length - capacity] + this.limits[family].windowMs - now;
    const blocked = (this.blockedUntil.get(family) ?? 0) - now;
    return Math.max(0, Math.ceil(windowWait), Math.ceil(blocked));
  }

  /** Takes a slot when one is free and returns 0; otherwise returns the wait in ms and takes nothing. */
  tryTake(family: PantaFamily): number {
    const wait = this.waitMs(family);
    if (wait > 0) return wait;
    this.log(family).push(this.now());
    return 0;
  }

  /**
   * Takes a slot, waiting up to `maxWaitMs` for one. Beyond that it throws `PantaBudgetError` (with the wait in
   * seconds) without sending anything.
   */
  async take(
    family: PantaFamily,
    maxWaitMs: number,
    endpoint: string,
    sleep: (ms: number) => Promise<void>,
  ): Promise<void> {
    let left = maxWaitMs;
    for (;;) {
      const wait = this.tryTake(family);
      if (wait === 0) return;
      if (wait > left) throw new PantaBudgetError(endpoint, family, Math.max(1, Math.ceil(wait / 1_000)));
      await sleep(wait);
      left -= wait;
    }
  }

  /** Sends nothing in `family` before `untilMs` (Panta's 429 `Retry-After`, or a spent `X-RateLimit-Remaining`). */
  block(family: PantaFamily, untilMs: number): void {
    if (untilMs > (this.blockedUntil.get(family) ?? 0)) this.blockedUntil.set(family, untilMs);
  }

  snapshot(): Record<PantaFamily, FamilyBudget> {
    const out = {} as Record<PantaFamily, FamilyBudget>;
    for (const family of PANTA_FAMILIES) {
      out[family] = {
        used: this.prune(family, this.now()).length,
        capacity: this.capacity[family],
        waitMs: this.waitMs(family),
      };
    }
    return out;
  }

  private log(family: PantaFamily): number[] {
    let times = this.sent.get(family);
    if (!times) {
      times = [];
      this.sent.set(family, times);
    }
    return times;
  }

  private prune(family: PantaFamily, now: number): number[] {
    const times = this.log(family);
    const cutoff = now - this.limits[family].windowMs;
    let drop = 0;
    while (drop < times.length && times[drop] <= cutoff) drop++;
    if (drop > 0) times.splice(0, drop);
    return times;
  }
}
