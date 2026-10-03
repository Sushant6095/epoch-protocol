import { EpochException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';

import { type Role } from '../../Lib/Session';
import { shortKey } from '../../Lib/Stats';

const logger = Logger.create('RoleResolver');

/** One chain read per role; each answers whether `address` has it. */
export type RoleLookups = Record<Role, (address: string) => Promise<boolean>>;

export interface RoleResolverOptions {
  ttlMs: number;
  /** Shorter cache when a lookup failed, so the role comes back soon after the RPC does. */
  failureTtlMs: number;
  /** A lookup slower than this counts as failed, so sign-in never hangs on a slow RPC. */
  timeoutMs: number;
  maxCached: number;
}

const DEFAULTS: RoleResolverOptions = { ttlMs: 60_000, failureTtlMs: 10_000, timeoutMs: 8_000, maxCached: 20_000 };
export const ROLE_ORDER: readonly Role[] = ['delegator', 'lender', 'operator'];

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const describeError = (error: unknown): string => (error instanceof EpochException ? error.code : String(error));

/**
 * A wallet's roles from chain (request #7), cached 60 s per address. A role whose lookup fails (RPC down, the program
 * not configured: 503 PROGRAM_NOT_CONFIGURED) is left out with a warning; sign-in never fails because of it.
 */
export class RoleResolver {
  private readonly cache = new Map<string, { roles: Role[]; until: number }>();
  private readonly inflight = new Map<string, Promise<Role[]>>();

  constructor(
    private readonly lookups: RoleLookups,
    private readonly options: RoleResolverOptions = DEFAULTS,
    private readonly now: () => number = Date.now,
  ) {}

  async rolesOf(address: string): Promise<Role[]> {
    const cached = this.cache.get(address);
    if (cached && cached.until > this.now()) return cached.roles;
    let pending = this.inflight.get(address);
    if (!pending) {
      pending = this.resolve(address).finally(() => this.inflight.delete(address));
      this.inflight.set(address, pending);
    }
    return pending;
  }

  /** Forgets a wallet's roles (e.g. right after it deposits or onboards). */
  forget(address: string): void {
    this.cache.delete(address);
  }

  private async resolve(address: string): Promise<Role[]> {
    const answers = await Promise.all(ROLE_ORDER.map((role) => this.check(role, address)));
    const roles = ROLE_ORDER.filter((_, index) => answers[index] === true);
    const failed = answers.some((answer) => answer === null);
    if (this.cache.size >= this.options.maxCached) this.cache.clear();
    this.cache.set(address, {
      roles,
      until: this.now() + (failed ? this.options.failureTtlMs : this.options.ttlMs),
    });
    return roles;
  }

  /** true / false, or null when the lookup failed. */
  private async check(role: Role, address: string): Promise<boolean | null> {
    try {
      return await withTimeout(this.lookups[role](address), this.options.timeoutMs);
    } catch (error) {
      logger.warn('role lookup failed; leaving the role out', {
        role,
        wallet: shortKey(address),
        error: describeError(error),
      });
      return null;
    }
  }
}
