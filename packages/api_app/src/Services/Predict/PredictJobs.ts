import { Logger } from '@epoch/logger';
import { type EpochDb, predictCalls, predictMarkets } from '@epoch/pg_models';
import { and, asc, eq, lt, sql } from 'drizzle-orm';

import { PeriodicJob } from '../../Lib/PeriodicJob';
import { type FeeIndexOracle } from './FeeIndexOracle';
import {
  answerFor,
  type CallToSettle,
  marketId,
  marketLabel,
  marketQuestion,
  settleParimutuel,
  thresholdFor,
} from './PredictMath';

const logger = Logger.create('Predict');

/**
 * Opens Fee Index markets (request #11): at start and every 10 minutes, for each epoch from current + 1 to current +
 * PREDICT_MARKETS_AHEAD that has no market yet, "Will epoch E's Fee Index close above X µL/CU?" with X the latest final
 * value rounded to the nearest 50. Nothing is opened before the first final value.
 */
export class PredictMarketMaker {
  private readonly job: PeriodicJob;

  constructor(
    private readonly db: () => EpochDb,
    private readonly oracle: FeeIndexOracle,
    private readonly marketsAhead: number,
    intervalMs = 10 * 60_000,
  ) {
    this.job = new PeriodicJob('predict-market-maker', intervalMs, () => this.runOnce());
  }

  start(): void {
    this.job.start();
  }

  stop(): Promise<void> {
    return this.job.stop();
  }

  /** Returns the ids of the markets it opened. */
  async runOnce(): Promise<string[]> {
    const current = await this.oracle.currentEpoch();
    const latest = await this.oracle.latestFinal();
    if (!latest) {
      logger.debug('no final Fee Index yet: no market opened', { current });
      return [];
    }
    const threshold = thresholdFor(latest.value);
    const created: string[] = [];
    for (let epoch = current + 1; epoch <= current + this.marketsAhead; epoch++) {
      const id = await this.db().transaction(async (tx) => {
        // Two API processes must not open two markets for one epoch.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`predict-market:${epoch}`}))`);
        const [existing] = await tx
          .select({ id: predictMarkets.id })
          .from(predictMarkets)
          .where(eq(predictMarkets.epoch, epoch))
          .limit(1);
        if (existing) return null;
        const row = {
          id: marketId(epoch, threshold),
          epoch,
          kind: 'above',
          threshold,
          question: marketQuestion(epoch, threshold),
          label: marketLabel(epoch, threshold),
          status: 'open',
        };
        const inserted = await tx
          .insert(predictMarkets)
          .values(row)
          .onConflictDoNothing()
          .returning({ id: predictMarkets.id });
        return inserted[0]?.id ?? null;
      });
      if (id) created.push(id);
    }
    if (created.length > 0) logger.info('markets opened', { created, threshold, fromFinalEpoch: latest.epoch });
    return created;
  }
}

export interface SettledMarket {
  marketId: string;
  value: number;
  outcome: 'yes' | 'no' | 'refunded';
  calls: number;
  winningPoints: number;
  losingPoints: number;
}

/**
 * Settles markets (request #11): every 5 minutes, each open market whose epoch is over and whose FINAL Fee Index value
 * is known gets its outcome and every call its payout, in one transaction. A market waits while its value is only
 * proposed or was vetoed (decision 23). Idempotent: a settled market is never touched again.
 */
export class PredictResolver {
  private readonly job: PeriodicJob;

  constructor(
    private readonly db: () => EpochDb,
    private readonly oracle: FeeIndexOracle,
    intervalMs = 5 * 60_000,
  ) {
    this.job = new PeriodicJob('predict-resolver', intervalMs, () => this.runOnce(), 15_000);
  }

  start(): void {
    this.job.start();
  }

  stop(): Promise<void> {
    return this.job.stop();
  }

  async runOnce(): Promise<SettledMarket[]> {
    const current = await this.oracle.currentEpoch();
    const due = await this.db()
      .select({ id: predictMarkets.id, epoch: predictMarkets.epoch })
      .from(predictMarkets)
      .where(and(eq(predictMarkets.status, 'open'), lt(predictMarkets.epoch, current)))
      .orderBy(asc(predictMarkets.epoch));
    const settled: SettledMarket[] = [];
    for (const market of due) {
      const value = await this.oracle.finalValue(market.epoch);
      if (value === null) continue;
      const result = await this.settle(market.id, value);
      if (result) settled.push(result);
    }
    if (settled.length > 0) logger.info('markets settled', { settled });
    return settled;
  }

  /** Settles one market from its final value; null when it is unknown or already settled. */
  async settle(id: string, value: number): Promise<SettledMarket | null> {
    return this.db().transaction(async (tx) => {
      const [market] = await tx.select().from(predictMarkets).where(eq(predictMarkets.id, id)).for('update');
      if (!market || market.status !== 'open') return null;
      const calls: CallToSettle[] = await tx
        .select({ id: predictCalls.id, side: predictCalls.side, points: predictCalls.points })
        .from(predictCalls)
        .where(eq(predictCalls.marketId, id));
      const settlement = settleParimutuel(calls, answerFor(value, market.threshold));
      if (calls.length > 0) {
        const payouts = JSON.stringify([...settlement.payouts].map(([callId, payout]) => ({ id: callId, payout })));
        await tx.execute(sql`
          UPDATE ${predictCalls} AS c
          SET payout_points = (p->>'payout')::int
          FROM jsonb_array_elements(${payouts}::jsonb) AS p
          WHERE c.id = (p->>'id')::bigint AND c.market_id = ${id}`);
      }
      await tx
        .update(predictMarkets)
        .set({ status: 'settled', outcome: settlement.outcome, resolvedValue: value, resolvedAt: sql`now()` })
        .where(eq(predictMarkets.id, id));
      return {
        marketId: id,
        value,
        outcome: settlement.outcome,
        calls: calls.length,
        winningPoints: settlement.winningPoints,
        losingPoints: settlement.losingPoints,
      };
    });
  }
}
