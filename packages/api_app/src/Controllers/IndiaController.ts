import type { Request, Response } from '@epoch/common_http_server';
import { ServiceUnavailableException } from '@epoch/exceptions';

import type { IndiaPriceQuery, IndiaRewardsQuery, IndiaValidatorQuery } from '../dto/India.dto';
import type { WalletParams } from '../dto/Wallet.dto';
import { financialYearAt, istDate } from '../Lib/IndianFy';
import { rupees } from '../Lib/Inr';
import { isoIst, round } from '../Lib/Stats';
import { getIndiaServices } from '../Services/India';
import { csvFileName, fyView, REWARDS_DISCLAIMER, rewardsCsv } from '../Services/India/IndiaRewards';
import { priceBrief } from '../Services/India/IndiaValidators';
import { LIVE_TTL_MS } from '../Services/India/InrPriceService';
import { decodeCursor, queryValidators } from '../Services/ValidatorQuery';
import type {
  IndiaPrice,
  IndiaSummary,
  IndiaValidatorList,
  IndiaValidatorRow,
  IndiaWalletRewards,
} from '../types/India.types';

const reason = (result: PromiseSettledResult<unknown>): string | undefined =>
  result.status === 'rejected'
    ? result.reason instanceof Error
      ? result.reason.message
      : String(result.reason)
    : undefined;

/** The India page (Superteam India track): SOL in rupees, validators hosted in India, a wallet's rewards per FY. */
export class IndiaController {
  /** GET /v1/india/summary: the first paint. Each section is null (with `errors`) when its source is down. */
  static async summary(_req: Request, res: Response): Promise<IndiaSummary> {
    const india = getIndiaServices();
    const [live, snapshot] = await Promise.allSettled([india.prices.live(), india.validators.snapshot()]);
    if (live.status === 'rejected' && snapshot.status === 'rejected') {
      throw new ServiceUnavailableException('India data is unavailable right now', 'INDIA_UNAVAILABLE', {
        price: reason(live),
        validators: reason(snapshot),
      });
    }
    const now = Date.now();
    const price = live.status === 'fulfilled' ? live.value : null;
    const snap = snapshot.status === 'fulfilled' ? snapshot.value : null;
    const errors: IndiaSummary['errors'] = {};
    if (!price) errors.price = reason(live);
    if (!snap) errors.validators = reason(snapshot);
    const sources = [snap?.source, price && !snap?.source.includes(price.source) ? price.source : undefined];
    res.setHeader('cache-control', price?.stale ? 'no-store' : 'public, max-age=30');
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(new Date(now)),
      source: sources.filter(Boolean).join(', '),
      note: snap?.notes.join('; ') || undefined,
      price: priceBrief(price),
      fy: fyView(financialYearAt(now), now),
      network: snap?.network ?? null,
      validators: snap
        ? {
            status: snap.status,
            india: snap.india,
            cities: snap.cities,
            top: [...snap.rows.values()].sort((a, b) => b.stakeSol - a.stakeSol).slice(0, 5),
            comparison: snap.comparison,
          }
        : null,
      prospect: snap?.prospect ?? null,
      errors,
      disclaimer: REWARDS_DISCLAIMER,
    };
  }

  /** GET /v1/india/price?days=0: live SOL/INR; `stale: true` when it is the last known price. */
  static async price(_req: Request, res: Response): Promise<IndiaPrice> {
    const { days } = res.locals.query as IndiaPriceQuery;
    const prices = getIndiaServices().prices;
    const live = await prices.live();
    let note: string | undefined;
    const history =
      days > 0
        ? await prices.recentDaily(days).catch((error: unknown) => {
            note = `daily history unavailable (${String(error)})`;
            return [];
          })
        : [];
    res.setHeader('cache-control', live.stale ? 'no-store' : 'public, max-age=15');
    const observedAt = isoIst(new Date(live.observedAtMs));
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: observedAt,
      source: live.source,
      note,
      pair: 'SOL/INR',
      inr: round(live.inr, 2),
      formatted: rupees(live.inr).formatted,
      usd: live.usd === null ? null : round(live.usd, 4),
      usdInr: live.usdInr === null ? null : round(live.usdInr, 4),
      change24hPct: live.change24hPct === null ? null : round(live.change24hPct, 2),
      observedAt,
      fetchedAt: isoIst(new Date(live.fetchedAtMs)),
      ageSeconds: Math.max(0, Math.round((Date.now() - live.observedAtMs) / 1_000)),
      stale: live.stale,
      staleReason: live.staleReason,
      refreshSeconds: LIVE_TTL_MS / 1_000,
      history: history.map((p) => ({ date: istDate(p.ms), at: isoIst(new Date(p.ms)), inr: round(p.inr, 2) })),
    };
  }

  /** GET /v1/india/validators?tab=&chips=&q=&sort=&dir=&fee=&client=&votes=&cursor=&limit= */
  static async validators(_req: Request, res: Response): Promise<IndiaValidatorList> {
    const q = res.locals.query as IndiaValidatorQuery;
    const snap = await getIndiaServices().validators.snapshot();
    const page = queryValidators(snap.tableRows, {
      tab: q.tab,
      chips: q.chips,
      q: q.q,
      sort: q.sort,
      dir: q.dir,
      fee: q.fee,
      clients: q.client,
      countries: [],
      votes: q.votes,
      offset: decodeCursor(q.cursor),
      limit: q.limit,
    });
    res.setHeader('cache-control', 'public, max-age=30');
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: snap.asOf,
      source: snap.source,
      note: snap.notes.join('; ') || undefined,
      status: snap.status,
      rows: page.rows.map((row) => snap.rows.get(row.vote)).filter((row): row is IndiaValidatorRow => !!row),
      total: page.total,
      nextCursor: page.nextCursor,
      facets: page.facets,
      india: snap.india,
      cities: snap.cities,
      price: snap.price,
    };
  }

  /** GET /v1/india/wallets/:address/rewards?fy=2026-27 — poll while `status` is `loading` or `partial`. */
  static async rewards(req: Request, res: Response): Promise<IndiaWalletRewards> {
    const { address } = res.locals.params as WalletParams;
    const { fy } = res.locals.query as IndiaRewardsQuery;
    const india = getIndiaServices();
    india.limits.rewards.consume(
      `india-rewards:${req.ip ?? 'unknown'}`,
      'Too many requests from your network; wait a minute',
    );
    const view = await india.rewards.get(address, fy, { ip: req.ip });
    res.setHeader('cache-control', view.status === 'complete' ? 'private, max-age=60' : 'no-store');
    return view;
  }

  /** GET /v1/india/wallets/:address/rewards.csv?fy=2026-27 — 503 REWARDS_LOADING until the year is read. */
  static async rewardsCsv(req: Request, res: Response): Promise<void> {
    const { address } = res.locals.params as WalletParams;
    const { fy } = res.locals.query as IndiaRewardsQuery;
    const india = getIndiaServices();
    india.limits.csv.consume(`india-csv:${req.ip ?? 'unknown'}`, 'Too many downloads from your network; wait a minute');
    const view = await india.rewards.getFinished(address, fy, { ip: req.ip });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${csvFileName(address, fy)}"`);
    res.setHeader('cache-control', 'private, max-age=60');
    res.send(rewardsCsv(view, Date.now()));
  }
}
