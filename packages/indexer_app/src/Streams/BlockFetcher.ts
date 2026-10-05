import { sleep } from '@epoch/common';

import { type DecodedBlock } from '../Blocks/BlockFees';
import { decodeRpcBlock } from '../Blocks/RpcBlockDecoder';
import { BLOCK_NOT_AVAILABLE, RpcError, SKIPPED_SLOT_CODES, type SolanaRpc } from '../Rpc/SolanaRpc';

export type FetchResult = { kind: 'block'; block: DecodedBlock } | { kind: 'skipped'; slot: number };

/** Spaces calls to at most `perSecond`, with at most `concurrency` in flight. */
export class RateLimiter {
  private nextAt = 0;
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly perSecond: number,
    private readonly concurrency: number,
    private readonly now: () => number = Date.now,
  ) {}

  get inFlight(): number {
    return this.active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      const at = Math.max(this.now(), this.nextAt);
      this.nextAt = at + 1_000 / this.perSecond;
      const wait = at - this.now();
      if (wait > 0) await sleep(wait);
      return await task();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

/**
 * Blocks over RPC getBlock for gap fill and for the `hybrid` and `rpc` sources. A slot without a block (-32007 skipped,
 * -32009 skipped in long-term storage) comes back as `skipped`; "not available yet" (-32004, or a null result) is
 * retried a few times, then reported as an error so the caller tries again later.
 */
export class BlockFetcher {
  constructor(
    private readonly rpc: Pick<SolanaRpc, 'getBlock'>,
    private readonly limiter: RateLimiter,
    private readonly notAvailableRetries = 5,
    private readonly notAvailableDelayMs = 400,
  ) {}

  fetch(slot: number): Promise<FetchResult> {
    return this.limiter.run(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const block = await this.rpc.getBlock(slot);
          if (block === null) throw new RpcError(BLOCK_NOT_AVAILABLE, `no block for slot ${slot} yet`);
          return { kind: 'block', block: decodeRpcBlock(slot, block) };
        } catch (error) {
          if (error instanceof RpcError && SKIPPED_SLOT_CODES.has(error.code)) return { kind: 'skipped', slot };
          if (error instanceof RpcError && error.code === BLOCK_NOT_AVAILABLE && attempt < this.notAvailableRetries) {
            await sleep(this.notAvailableDelayMs * (attempt + 1));
            continue;
          }
          throw error;
        }
      }
    });
  }
}
