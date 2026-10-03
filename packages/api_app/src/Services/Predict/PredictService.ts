import { type PredictConfig } from '@epoch/config-sdk';
import { EpochException, NotFoundException } from '@epoch/exceptions';
import { type EpochDb, predictCalls, predictMarkets } from '@epoch/pg_models';
import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';

import { type PredictCallEvent } from '../../Lib/EventBus';
import { isoIst, round, shortKey } from '../../Lib/Stats';
import {
  type PredictCallRequest,
  type PredictLeaderboard,
  type PredictLeaderboardRow,
  type PredictMarket,
  type PredictSnapshot,
} from '../../types/Account.types';
import { type FeeIndexOracle } from './FeeIndexOracle';
import {
  ANSWER_SOURCE,
  CALL_SIZES_POINTS,
  marketNowNote,
  marketStatus,
  myCallView,
  PAYOUT_FORMULA,
  type PoolTotals,
} from './PredictMath';

export const PREDICT_SOURCE = 'api_app Predict in points mode';
/** Settled markets stay on the page for this many epochs. */
const SETTLED_EPOCHS_SHOWN = 3;
const MAX_MARKETS = 50;
/** "Your calls" covers this many epochs. */
const MY_CALLS_EPOCHS = 30;
const MAX_MY_CALLS = 100;
const LEADERBOARD_IN_SNAPSHOT = 10;
export const LEADERBOARD_MAX_ROWS = 50;

export interface PredictServiceDeps {
  db: () => EpochDb;
  oracle: FeeIndexOracle;
  config: Pick<PredictConfig, 'PREDICT_POINTS_PER_EPOCH' | 'PREDICT_LEADERBOARD_EPOCHS' | 'PREDICT_REGIONS'>;
  /** The activity feed (bus.emit('predictCall', …)). */
  emit?: (event: PredictCallEvent) => void;
}

type MarketRow = typeof predictMarkets.$inferSelect;

/**
 * Predict in points mode (request #11; decisions 2, 3 and 23): the markets page, calls against the per-epoch points
 * budget, and the leaderboard. Markets are opened by PredictMarketMaker and settled by PredictResolver.
 */
export class PredictService {
  constructor(private readonly deps: PredictServiceDeps) {}

  /** GET /v1/predict/markets; `address` (the session wallet) adds its points left and its calls. */
  async snapshot(address?: string): Promise<PredictSnapshot> {
    const db = this.deps.db();
    const { config, oracle } = this.deps;
    const current = await oracle.currentEpoch();

    const markets = await db
      .select()
      .from(predictMarkets)
      .where(
        or(
          eq(predictMarkets.status, 'open'),
          and(eq(predictMarkets.status, 'settled'), gte(predictMarkets.epoch, current - SETTLED_EPOCHS_SHOWN)),
        ),
      )
      .orderBy(desc(predictMarkets.epoch), asc(predictMarkets.id))
      .limit(MAX_MARKETS);

    const mine = address
      ? await db
          .select({ call: predictCalls, market: predictMarkets })
          .from(predictCalls)
          .innerJoin(predictMarkets, eq(predictMarkets.id, predictCalls.marketId))
          .where(and(eq(predictCalls.address, address), gte(predictCalls.epoch, current - MY_CALLS_EPOCHS)))
          .orderBy(desc(predictCalls.id))
          .limit(MAX_MY_CALLS)
      : [];
    const pointsLeft = address ? await this.pointsLeft(db, address, current) : null;

    const pools = await this.pools(db, [...markets.map((m) => m.id), ...mine.map((row) => row.market.id)]);
    const cards = await Promise.all(markets.map((market) => this.card(market, current, pools)));
    const myCalls = mine.map(({ call, market }) =>
      myCallView(call, market, current, pools.get(market.id) ?? { yes: 0, no: 0 }),
    );
    const leaderboard = await this.leaderboardRows(
      db,
      current,
      config.PREDICT_LEADERBOARD_EPOCHS,
      LEADERBOARD_IN_SNAPSHOT,
    );

    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(),
      source: PREDICT_SOURCE,
      note: this.note(),
      rules: {
        mode: 'points',
        pointsPerEpoch: config.PREDICT_POINTS_PER_EPOCH,
        callSizesPoints: [...CALL_SIZES_POINTS],
        pointsLeftThisEpoch: pointsLeft,
        feeBps: 0,
        leaderboardEpochs: config.PREDICT_LEADERBOARD_EPOCHS,
        ageGate: '18+',
        regions: config.PREDICT_REGIONS,
      },
      payoutFormula: PAYOUT_FORMULA,
      markets: cards,
      myCalls,
      leaderboard,
    };
  }

  /**
   * POST /v1/predict/calls: one call against this epoch's budget. Runs under a per-wallet advisory lock, so parallel
   * calls from one wallet can never spend more than its points. 404 unknown market, 409 MARKET_CLOSED once its epoch has
   * started, 409 NOT_ENOUGH_POINTS (details.pointsLeft). Returns the fresh snapshot for the wallet.
   */
  async call(address: string, request: PredictCallRequest): Promise<PredictSnapshot> {
    const current = await this.deps.oracle.currentEpoch();
    const { call, market } = await this.deps.db().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`predict-call:${address}`}))`);
      const [market] = await tx
        .select()
        .from(predictMarkets)
        .where(eq(predictMarkets.id, request.marketId))
        .for('share');
      if (!market) throw new NotFoundException('No such market', { marketId: request.marketId });
      if (market.status !== 'open' || current >= market.epoch) {
        throw new EpochException('This market just closed', 'MARKET_CLOSED', 409, {
          marketId: market.id,
          closesAtEpoch: market.epoch,
          currentEpoch: current,
        });
      }
      const pointsLeft = await this.pointsLeft(tx, address, current);
      if (request.points > pointsLeft) {
        throw new EpochException(`You have ${pointsLeft} points left this epoch`, 'NOT_ENOUGH_POINTS', 409, {
          pointsLeft,
        });
      }
      const [call] = await tx
        .insert(predictCalls)
        .values({ marketId: market.id, address, side: request.side, points: request.points, epoch: current })
        .returning();
      return { call, market };
    });
    this.deps.emit?.({
      id: call.id,
      marketId: market.id,
      label: market.label,
      address,
      side: request.side,
      points: request.points,
      createdAt: isoIst(call.createdAt),
    });
    return this.snapshot(address);
  }

  /** GET /v1/predict/leaderboard?epochs=30: the top 50 wallets by net points on markets settled in that window. */
  async leaderboard(epochs: number): Promise<PredictLeaderboard> {
    const current = await this.deps.oracle.currentEpoch();
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(),
      source: PREDICT_SOURCE,
      epochs,
      rows: await this.leaderboardRows(this.deps.db(), current, epochs, LEADERBOARD_MAX_ROWS),
    };
  }

  private async card(
    market: MarketRow,
    current: number,
    pools: ReadonlyMap<string, PoolTotals & { players: number }>,
  ): Promise<PredictMarket> {
    const pool = pools.get(market.id) ?? { yes: 0, no: 0, players: 0 };
    const total = pool.yes + pool.no;
    const status = marketStatus(market, current);
    const unsettledPast = market.status !== 'settled' && current > market.epoch;
    // A failed index read only turns this card's line into "Waiting for…"; the page still loads.
    const read = (value: Promise<number | null>) => value.catch(() => null);
    const index = unsettledPast
      ? {
          final: await read(this.deps.oracle.finalValue(market.epoch)),
          proposed: await read(this.deps.oracle.proposedValue(market.epoch)),
        }
      : { final: null, proposed: null };
    return {
      id: market.id,
      question: market.question,
      yesShare: total > 0 ? round(pool.yes / total, 4) : 0.5,
      poolPoints: total,
      players: pool.players,
      closesAtEpoch: market.epoch,
      status,
      nowNote: marketNowNote(market, current, index),
      answerSource: ANSWER_SOURCE,
    };
  }

  private async pointsLeft(db: Pick<EpochDb, 'select'>, address: string, epoch: number): Promise<number> {
    const [row] = await db
      .select({ used: sql<number>`coalesce(sum(${predictCalls.points}), 0)`.mapWith(Number) })
      .from(predictCalls)
      .where(and(eq(predictCalls.address, address), eq(predictCalls.epoch, epoch)));
    return Math.max(0, this.deps.config.PREDICT_POINTS_PER_EPOCH - (row?.used ?? 0));
  }

  /** Points on each side and distinct wallets, per market. */
  private async pools(db: EpochDb, ids: string[]): Promise<Map<string, PoolTotals & { players: number }>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, PoolTotals & { players: number }>();
    if (unique.length === 0) return out;
    const rows = await db
      .select({
        marketId: predictCalls.marketId,
        yes: sql<number>`coalesce(sum(${predictCalls.points}) filter (where ${predictCalls.side} = 'yes'), 0)`.mapWith(
          Number,
        ),
        no: sql<number>`coalesce(sum(${predictCalls.points}) filter (where ${predictCalls.side} = 'no'), 0)`.mapWith(
          Number,
        ),
        players: sql<number>`count(distinct ${predictCalls.address})`.mapWith(Number),
      })
      .from(predictCalls)
      .where(inArray(predictCalls.marketId, unique))
      .groupBy(predictCalls.marketId);
    for (const row of rows) out.set(row.marketId, { yes: row.yes, no: row.no, players: row.players });
    return out;
  }

  /**
   * Net points (payout − points; 0 for refunded calls), hit rate (won ÷ (won + lost); refunded calls count in `calls`
   * only) per wallet, over markets settled with an epoch ≥ current − epochs.
   */
  private async leaderboardRows(
    db: EpochDb,
    current: number,
    epochs: number,
    limit: number,
  ): Promise<PredictLeaderboardRow[]> {
    const result = await db.execute<{ address: string; net: string; won: string; lost: string; calls: string }>(sql`
      SELECT c.address,
        coalesce(sum(CASE WHEN m.outcome = 'refunded' THEN 0 ELSE coalesce(c.payout_points, 0) - c.points END), 0) AS net,
        count(*) FILTER (WHERE m.outcome <> 'refunded' AND c.side = m.outcome) AS won,
        count(*) FILTER (WHERE m.outcome <> 'refunded' AND c.side <> m.outcome) AS lost,
        count(*) AS calls
      FROM ${predictCalls} c
      JOIN ${predictMarkets} m ON m.id = c.market_id
      WHERE m.status = 'settled' AND m.epoch >= ${current - epochs}
      GROUP BY c.address
      ORDER BY net DESC,
        (count(*) FILTER (WHERE m.outcome <> 'refunded' AND c.side = m.outcome))::float
          / nullif(count(*) FILTER (WHERE m.outcome <> 'refunded'), 0) DESC NULLS LAST,
        calls DESC,
        c.address ASC
      LIMIT ${limit}`);
    return result.rows.map((row, index) => {
      const won = Number(row.won);
      const lost = Number(row.lost);
      return {
        rank: index + 1,
        walletShort: shortKey(row.address),
        netPoints: Number(row.net),
        hitPct: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0,
        calls: Number(row.calls),
      };
    });
  }

  private note(): string {
    const { config, oracle } = this.deps;
    return (
      `Points mode (decisions 2 and 3, 1 Oct 2026): Fee Index markets only, no SOL, no fee, no wallet transaction. ` +
      `Every signed-in wallet gets ${config.PREDICT_POINTS_PER_EPOCH} points each epoch (unused points do not carry ` +
      `over); a call is 10, 25, 50 or 100 points; when the final Fee Index resolves a market, the losing side's points ` +
      `are shared among the winners in proportion to their calls, and if nobody called the winning side every call is ` +
      `refunded; the leaderboard ranks net points won over the last ${config.PREDICT_LEADERBOARD_EPOCHS} epochs. ` +
      `Points have no cash value and cannot be bought, sold or transferred. Epoch numbers follow ${oracle.epochSource}.`
    );
  }
}
