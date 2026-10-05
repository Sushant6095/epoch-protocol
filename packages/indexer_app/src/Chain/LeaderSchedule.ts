import { Logger } from '@epoch/logger';

import { type SolanaRpc } from '../Rpc/SolanaRpc';

const logger = Logger.create('LeaderSchedule');

/** getSlotLeaders allows 5,000 per call; 4,000-slot chunks (≈ 27 minutes) keep calls rare and aligned. */
export const LEADER_CHUNK = 4_000;
const MAX_CHUNKS = 128;
const RETRY_AFTER_MS = 5_000;

/**
 * The slot leader of every slot, from the cluster's leader schedule (getSlotLeaders over Solami RPC), fetched in
 * aligned chunks and cached. The schedule names the identity that was allowed to produce the slot, which is what the
 * leader-paid exclusion needs; it is the primary source. The block's Fee reward is the fallback (LeaderResolver).
 */
export class LeaderSchedule {
  private readonly chunks = new Map<number, string[]>();
  private readonly inflight = new Map<number, Promise<string[] | undefined>>();
  private readonly failedAt = new Map<number, number>();

  constructor(
    private readonly rpc: Pick<SolanaRpc, 'getSlotLeaders'>,
    private readonly now: () => number = Date.now,
  ) {}

  /** The cached leader, or undefined (and the chunk is fetched in the background). Never waits. */
  leaderOf(slot: number): string | undefined {
    const start = slot - (slot % LEADER_CHUNK);
    const chunk = this.chunks.get(start);
    if (chunk) {
      // Fetch the next chunk before it is needed.
      if (slot - start > LEADER_CHUNK * 0.75) void this.load(start + LEADER_CHUNK);
      return chunk[slot - start];
    }
    void this.load(start);
    return undefined;
  }

  /** The leader, fetching its chunk if needed (gap fill); undefined when the RPC cannot say. */
  async ensure(slot: number): Promise<string | undefined> {
    const start = slot - (slot % LEADER_CHUNK);
    const chunk = this.chunks.get(start) ?? (await this.load(start, true));
    return chunk?.[slot - start];
  }

  private load(start: number, force = false): Promise<string[] | undefined> {
    const running = this.inflight.get(start);
    if (running) return running;
    const failed = this.failedAt.get(start);
    if (!force && failed !== undefined && this.now() - failed < RETRY_AFTER_MS) return Promise.resolve(undefined);
    const promise = this.rpc
      .getSlotLeaders(start, LEADER_CHUNK)
      .then((leaders) => {
        if (leaders.length !== LEADER_CHUNK) throw new Error(`getSlotLeaders returned ${leaders.length} leaders`);
        this.chunks.set(start, leaders);
        this.failedAt.delete(start);
        while (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value as number);
        return leaders;
      })
      .catch((error: unknown) => {
        this.failedAt.set(start, this.now());
        logger.warn('leader schedule unavailable for this chunk; using block rewards', {
          startSlot: start,
          error: String(error),
        });
        return undefined;
      })
      .finally(() => this.inflight.delete(start));
    this.inflight.set(start, promise);
    return promise;
  }
}

/**
 * Leader identity for a block: the schedule first; else the block's Fee reward pubkey, mapped from a vote account to
 * its identity when the validator redirected its block revenue to the vote account (SIMD-0232).
 */
export class LeaderResolver {
  /** Blocks whose leader came from the reward because the schedule had no answer. */
  fromRewards = 0;
  /** Blocks where the reward pubkey was not the scheduled leader (a redirected collector). */
  rewardMismatches = 0;

  constructor(
    private readonly schedule: Pick<LeaderSchedule, 'leaderOf' | 'ensure'>,
    private readonly voteToIdentity: () => ReadonlyMap<string, string>,
  ) {}

  /** Without waiting (live blocks). */
  now(slot: number, rewardPubkey: string | null): string | undefined {
    return this.pick(this.schedule.leaderOf(slot), rewardPubkey);
  }

  /** Waiting for the schedule if needed (gap fill, or a live block whose chunk is still loading). */
  async resolve(slot: number, rewardPubkey: string | null): Promise<string | undefined> {
    return this.pick(this.schedule.leaderOf(slot) ?? (await this.schedule.ensure(slot)), rewardPubkey);
  }

  private pick(scheduled: string | undefined, rewardPubkey: string | null): string | undefined {
    if (scheduled) {
      if (rewardPubkey && rewardPubkey !== scheduled && this.voteToIdentity().get(rewardPubkey) !== scheduled) {
        this.rewardMismatches++;
      }
      return scheduled;
    }
    if (!rewardPubkey) return undefined;
    this.fromRewards++;
    return this.voteToIdentity().get(rewardPubkey) ?? rewardPubkey;
  }
}
