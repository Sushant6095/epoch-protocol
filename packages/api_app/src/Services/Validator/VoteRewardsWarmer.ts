import { GracefulShutdown, REVENUE_WINDOW_EPOCHS } from '@epoch/common';
import { Logger } from '@epoch/logger';

import { type InflationRewards } from '../InflationRewards';
import { type MarketData } from '../MarketData';

const logger = Logger.create('VoteRewardsWarmer');

const CHECK_EVERY_MS = 10 * 60_000;
/** getInflationReward's limit on the public RPC; the call costs the same for 1 or 32 addresses. */
const BATCH = 32;

/**
 * Reads every staked vote account's inflation reward (its inflation commission) for the last 10 finished epochs into
 * the shared InflationRewards cache: newest epoch first, 32 vote accounts per call, one call at a time (about 22
 * calls an epoch for 700 validators, 5–9 s each on the public RPC). Then it looks for a newly finished epoch every
 * 10 minutes. Validator profiles read this cache instead of waiting on getInflationReward. Needs no database.
 */
export class VoteRewardsWarmer {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly market: MarketData,
    private readonly rewards: InflationRewards,
    private readonly intervalMs = CHECK_EVERY_MS,
  ) {}

  start(): void {
    const run = () => {
      this.run().catch((error: unknown) => logger.warn('vote rewards warm-up failed', { error: String(error) }));
    };
    setTimeout(run, 3_000).unref();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref();
    GracefulShutdown.register('vote-rewards', async () => this.stop());
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const [info, accounts] = await Promise.all([this.market.epochInfo.get(), this.market.voteAccounts.get()]);
      const votes = [...accounts.current, ...accounts.delinquent]
        .filter((v) => v.activatedStake > 0)
        .map((v) => v.votePubkey);
      for (let epoch = info.epoch - 1; epoch >= info.epoch - REVENUE_WINDOW_EPOCHS; epoch--) {
        const missing = votes.filter((vote) => this.rewards.cached(vote, epoch) === undefined);
        for (let start = 0; start < missing.length; start += BATCH) {
          await this.rewards.get(missing.slice(start, start + BATCH), epoch, info.epoch);
        }
        if (missing.length > 0) logger.info('vote rewards read', { epoch, validators: missing.length });
      }
    } finally {
      this.running = false;
    }
  }
}
