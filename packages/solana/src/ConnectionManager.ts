import { ChainException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import { type Commitment, Connection } from '@solana/web3.js';

const logger = Logger.create('ConnectionManager');

/** Primary RPC with an optional fallback (e.g. RPC Fast primary, public RPC fallback). */
export class ConnectionManager {
  readonly primary: Connection;
  readonly fallback?: Connection;

  constructor(primaryUrl: string, fallbackUrl?: string, commitment: Commitment = 'confirmed') {
    this.primary = new Connection(primaryUrl, commitment);
    this.fallback = fallbackUrl ? new Connection(fallbackUrl, commitment) : undefined;
  }

  /** Runs `fn` on the primary connection, then on the fallback if the primary throws. */
  async withFailover<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    try {
      return await fn(this.primary);
    } catch (primaryError) {
      if (!this.fallback) {
        // Keep the original error reachable as `cause`: callers decode program errors (e.g. `Paused`) from its logs,
        // and a program error must not be mistaken for a transient RPC failure.
        const error = new ChainException('RPC call failed', { cause: String(primaryError) });
        throw Object.assign(error, { cause: primaryError });
      }
      logger.warn('primary RPC failed, using fallback', { error: String(primaryError) });
      return fn(this.fallback);
    }
  }
}
