import { Logger } from '@epoch/logger';

import { mapLimit } from '../Lib/Async';
import { type SolanaDataSource } from '../Sources/SolanaDataSource';

const logger = Logger.create('InflationRewards');

/**
 * Inflation rewards per (address, epoch), kept once read: a finished epoch's reward never changes. Shared by the
 * validator profile (vote accounts, warmed in the background by VoteRewardsWarmer) and My Stake (stake accounts).
 * "No reward" is only kept for epochs at least two behind the current one, in case the newest epoch's rewards are
 * still being paid out. On the public RPC one call (up to 32 addresses) for a past epoch takes 5–9 s.
 */
export class InflationRewards {
  private readonly entries = new Map<string, number | null>();

  constructor(
    private readonly solana: SolanaDataSource,
    private readonly capacity = 50_000,
  ) {}

  /** Lamports already read for (address, epoch): null = no reward, undefined = not read. Never calls the RPC. */
  cached(address: string, epoch: number): number | null | undefined {
    return this.entries.get(`${address}:${epoch}`);
  }

  /** Lamports per address for one finished epoch; null where the address earned nothing. */
  async get(addresses: readonly string[], epoch: number, currentEpoch: number): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    const missing: string[] = [];
    for (const address of new Set(addresses)) {
      const known = this.cached(address, epoch);
      if (known !== undefined) out.set(address, known);
      else missing.push(address);
    }
    if (missing.length === 0) return out;
    const rewards = await this.solana.getInflationReward(missing, epoch);
    missing.forEach((address, i) => {
      const amount = rewards[i]?.amount ?? null;
      out.set(address, amount);
      if (amount !== null || epoch <= currentEpoch - 2) this.remember(`${address}:${epoch}`, amount);
    });
    return out;
  }

  /**
   * Several epochs, `concurrency` at a time. Epochs whose read failed are left out of the result (and logged), so a
   * caller can say which epochs it has.
   */
  async getEpochs(
    addresses: readonly string[],
    epochs: readonly number[],
    currentEpoch: number,
    concurrency = 2,
  ): Promise<Map<number, Map<string, number | null>>> {
    const out = new Map<number, Map<string, number | null>>();
    await mapLimit(epochs, concurrency, async (epoch) => {
      try {
        out.set(epoch, await this.get(addresses, epoch, currentEpoch));
      } catch (error) {
        logger.warn('inflation rewards unavailable for an epoch', { epoch, error: String(error) });
      }
    });
    return out;
  }

  private remember(key: string, amount: number | null): void {
    this.entries.set(key, amount);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(oldest);
    }
  }
}
