/**
 * A validator's revenue per epoch from mainnet RPC, the input of the revenue-anchored curve (plan F13: "10-epoch
 * average × share × term"). Three parts, each shown separately so the launch plan can print the math:
 *
 * - **Inflation commission** — exact: `getInflationReward` for the vote account, one call per epoch.
 * - **Block revenue** — estimated: the identity's leader slots from `getLeaderSchedule`, a few of them read with
 *   `getBlock` (rewards only) for the leader's fee reward and skips, then leader slots × (1 − skip rate) × mean fee.
 *   With SIMD-0232 collectors pointed at Epoch's escrow this revenue is swept too.
 * - **MEV commission** — optional, from a caller-supplied history (Jito Kobe `mev_rewards × mev_commission_bps`).
 *
 * The public mainnet RPC refuses `getBlockProduction` over past epochs, hence the leader schedule and the sample.
 */
import { type Connection, PublicKey } from '@solana/web3.js';

import { LAMPORTS_PER_SOL } from './constants';

/** One finished epoch of a validator's revenue, SOL. A null part was not read (or not asked for). */
export interface EpochRevenue {
  epoch: number;
  inflationCommissionSol: number | null;
  blockRevenueSol: number | null;
  mevCommissionSol: number | null;
  /** How the block revenue was estimated. */
  blocks?: { leaderSlots: number; sampled: number; skipped: number; meanFeeSol: number };
}

export interface RevenueSummary {
  epochs: number[];
  /** Mean per epoch of each part over the epochs it was read for, SOL. */
  inflationCommissionSol: number;
  blockRevenueSol: number;
  mevCommissionSol: number;
  /** The sum of the included parts: the curve's `avgRevenueSol`. */
  avgRevenueSol: number;
  included: { inflation: boolean; blocks: boolean; mev: boolean };
}

/** Mean of the epochs that have a value: an epoch a part could not be read for is left out of that part's average. */
const mean = (values: readonly (number | null)[]): number => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? 0 : known.reduce((sum, value) => sum + value, 0) / known.length;
};

/** Averages a revenue history (pure). Parts that were never read are left out of `avgRevenueSol`. */
export function summarizeRevenue(
  rows: readonly EpochRevenue[],
  include: { inflation?: boolean; blocks?: boolean; mev?: boolean } = {},
): RevenueSummary {
  const has = (key: 'inflationCommissionSol' | 'blockRevenueSol' | 'mevCommissionSol') =>
    rows.some((row) => row[key] !== null);
  const included = {
    inflation: (include.inflation ?? true) && has('inflationCommissionSol'),
    blocks: (include.blocks ?? true) && has('blockRevenueSol'),
    mev: (include.mev ?? true) && has('mevCommissionSol'),
  };
  const inflationCommissionSol = mean(rows.map((row) => row.inflationCommissionSol));
  const blockRevenueSol = mean(rows.map((row) => row.blockRevenueSol));
  const mevCommissionSol = mean(rows.map((row) => row.mevCommissionSol));
  return {
    epochs: rows.map((row) => row.epoch),
    inflationCommissionSol,
    blockRevenueSol,
    mevCommissionSol,
    avgRevenueSol:
      (included.inflation ? inflationCommissionSol : 0) +
      (included.blocks ? blockRevenueSol : 0) +
      (included.mev ? mevCommissionSol : 0),
    included,
  };
}

/** Block revenue from a sample of leader slots (pure): slots × (1 − skip rate) × mean fee of the produced blocks. */
export function estimateBlockRevenue(input: {
  leaderSlots: number;
  /** Leader fee reward of each sampled block, lamports; null for a skipped slot. */
  samples: readonly (number | null)[];
}): { blockRevenueSol: number; sampled: number; skipped: number; meanFeeSol: number } {
  const produced = input.samples.filter((fee): fee is number => fee !== null);
  const skipped = input.samples.length - produced.length;
  const meanFee = produced.length ? produced.reduce((sum, fee) => sum + fee, 0) / produced.length : 0;
  const produceRate = input.samples.length ? produced.length / input.samples.length : 0;
  return {
    blockRevenueSol: (input.leaderSlots * produceRate * meanFee) / LAMPORTS_PER_SOL,
    sampled: input.samples.length,
    skipped,
    meanFeeSol: meanFee / LAMPORTS_PER_SOL,
  };
}

/** Picks `count` slots spread evenly over a sorted list (pure). */
export function spreadSample<T>(items: readonly T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (items.length <= count) return [...items];
  return Array.from({ length: count }, (_, i) => items[Math.floor(((i + 0.5) * items.length) / count)]);
}

/** The node identity of a vote account (bytes 4–36 in every vote state version). Null when the account is missing. */
export async function readVoteIdentity(connection: Connection, vote: PublicKey | string): Promise<string | null> {
  const info = await connection.getAccountInfo(new PublicKey(vote), {
    commitment: 'confirmed',
    dataSlice: { offset: 4, length: 32 },
  });
  return info && info.data.length === 32 ? new PublicKey(info.data).toBase58() : null;
}

const SKIPPED_SLOT = /skipped|not available|was not confirmed|cleaned up|-32007|-32009|-32004/i;
const RATE_LIMITED = /429|too many requests|rate limit/i;

/** Retries a call the RPC rate-limited (HTTP 429), waiting 5 s, 10 s, 20 s… (public RPCs limit some methods hard). */
export async function retryRateLimited<T>(call: () => Promise<T>, attempts = 5, firstWaitMs = 5_000): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= attempts || !RATE_LIMITED.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, firstWaitMs * 2 ** (attempt - 1)));
    }
  }
}

export interface RevenueHistoryOptions {
  connection: Connection;
  vote: PublicKey | string;
  /** Finished epochs to read (default 10). */
  epochs?: number;
  /** Block revenue: leader slots read with getBlock per epoch (default 6; 0 skips block revenue). */
  blockSamples?: number;
  /** MEV commission per epoch in lamports, e.g. from Jito Kobe; omitted epochs stay null. */
  mevCommissionLamports?: ReadonlyMap<number, number>;
  /** Pause between RPC calls, ms (default 150, gentle on the public RPC). */
  delayMs?: number;
  /** The epoch to count back from (default: the cluster's current epoch). */
  currentEpoch?: number;
  onProgress?: (message: string) => void;
}

/**
 * The last `epochs` finished epochs of a validator's revenue from RPC (oldest first). About 2 + epochs × (2 +
 * blockSamples) calls; run it from a script, not a page.
 */
export async function readRevenueHistory(options: RevenueHistoryOptions): Promise<EpochRevenue[]> {
  const { connection } = options;
  const vote = new PublicKey(options.vote);
  const count = options.epochs ?? 10;
  const samplesPerEpoch = options.blockSamples ?? 6;
  const delay = () => new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 150));
  const current = options.currentEpoch ?? (await retryRateLimited(() => connection.getEpochInfo('confirmed'))).epoch;
  const epochs = Array.from({ length: count }, (_, i) => current - count + i);
  const schedule = await retryRateLimited(() => connection.getEpochSchedule());
  const identity = samplesPerEpoch > 0 ? await retryRateLimited(() => readVoteIdentity(connection, vote)) : null;
  const rows: EpochRevenue[] = [];
  for (const epoch of epochs) {
    const [reward] = await retryRateLimited(() => connection.getInflationReward([vote], epoch, 'confirmed'));
    await delay();
    const row: EpochRevenue = {
      epoch,
      inflationCommissionSol: reward ? reward.amount / LAMPORTS_PER_SOL : 0,
      blockRevenueSol: null,
      mevCommissionSol: options.mevCommissionLamports?.has(epoch)
        ? (options.mevCommissionLamports.get(epoch) as number) / LAMPORTS_PER_SOL
        : null,
    };
    if (identity && samplesPerEpoch > 0) {
      const firstSlot = schedule.getFirstSlotInEpoch(epoch);
      const slots = await retryRateLimited(() => leaderSlots(connection, firstSlot, identity));
      await delay();
      if (slots === null) {
        // The RPC no longer keeps this epoch's leader schedule: leave its block revenue unknown.
        options.onProgress?.(`epoch ${epoch}: leader schedule not available`);
        rows.push(row);
        continue;
      }
      const samples: (number | null)[] = [];
      for (const offset of spreadSample(slots, samplesPerEpoch)) {
        samples.push(await retryRateLimited(() => leaderFee(connection, firstSlot + offset, identity)));
        await delay();
      }
      const estimate = estimateBlockRevenue({ leaderSlots: slots.length, samples });
      row.blockRevenueSol = estimate.blockRevenueSol;
      row.blocks = {
        leaderSlots: slots.length,
        sampled: estimate.sampled,
        skipped: estimate.skipped,
        meanFeeSol: estimate.meanFeeSol,
      };
    }
    options.onProgress?.(`epoch ${epoch} read`);
    rows.push(row);
  }
  return rows;
}

/**
 * The identity's leader slots in the epoch starting at `firstSlot`, as offsets into the epoch; null when the RPC no
 * longer has that epoch's schedule (it keeps a few epochs).
 */
async function leaderSlots(connection: Connection, firstSlot: number, identity: string): Promise<number[] | null> {
  // web3.js's getLeaderSchedule takes no arguments; call the RPC method with a slot and an identity filter.
  const http = await fetch(connection.rpcEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getLeaderSchedule',
      params: [firstSlot, { identity, commitment: 'confirmed' }],
    }),
  });
  if (!http.ok) throw new Error(`getLeaderSchedule: HTTP ${http.status}`);
  const response = (await http.json()) as { result?: Record<string, number[]> | null; error?: { message: string } };
  if (response.error) throw new Error(`getLeaderSchedule: ${response.error.message}`);
  if (!response.result) return null;
  return [...(response.result[identity] ?? [])].sort((a, b) => a - b);
}

/** The leader's fee reward for one block, lamports; null when the slot was skipped. */
async function leaderFee(connection: Connection, slot: number, identity: string): Promise<number | null> {
  try {
    const block = await connection.getBlock(slot, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
      rewards: true,
      transactionDetails: 'none',
    });
    if (!block) return null;
    const fee = block.rewards?.find((reward) => reward.pubkey === identity && reward.rewardType === 'Fee');
    return fee?.lamports ?? 0;
  } catch (error) {
    if (SKIPPED_SLOT.test(String(error))) return null;
    throw error;
  }
}
