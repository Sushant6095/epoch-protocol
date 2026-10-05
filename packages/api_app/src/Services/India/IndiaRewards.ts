import { rupees } from '../../Lib/Inr';
import {
  assessmentYear,
  type FinancialYear,
  financialYearAt,
  financialYearMonths,
  financialYearsUpTo,
  istDate,
  istDateTime,
  istMonth,
  monthLabel,
} from '../../Lib/IndianFy';
import { isoIst, round } from '../../Lib/Stats';
import {
  type IndiaFinancialYear,
  type IndiaPriceBrief,
  type IndiaRewardEpoch,
  type IndiaRewardMonth,
  type IndiaRewardsStage,
  type IndiaRewardsStatus,
  type IndiaWalletRewards,
} from '../../types/India.types';
import { type EpochSpan } from './EpochCalendar';
import { type PriceBook } from './InrPriceService';

export const REWARDS_DISCLAIMER =
  "Informational only, not tax advice. Covers the protocol staking rewards of this wallet's current stake accounts " +
  '(getInflationReward), credited when each epoch ends; Jito MEV tips, liquid-staking tokens and stake accounts ' +
  'closed before today are not included. Rupee values use the daily SOL/INR price nearest each credit (CoinGecko; ' +
  "days it cannot serve: Binance SOL/USDT × the ECB's USD/INR). Check the figures with a chartered accountant " +
  'before you file.';

/** The financial year's dates and names. */
export function fyView(fy: FinancialYear, now: number): IndiaFinancialYear {
  return {
    label: fy.label,
    name: `FY ${fy.label}`,
    assessmentYear: assessmentYear(fy),
    startsAt: isoIst(new Date(fy.startMs)),
    endsAt: isoIst(new Date(fy.endMs - 1_000)),
    current: financialYearAt(now).label === fy.label,
  };
}

/** One finished epoch of the year with the wallet's reward read (lamports; 0 when it earned nothing). */
export interface EpochReward {
  span: EpochSpan;
  lamports: number;
}

/** Epochs with a reward, oldest first, each priced at the daily SOL/INR nearest its end. */
export function rewardEpochs(
  rewards: readonly EpochReward[],
  book: PriceBook,
): (IndiaRewardEpoch & { endMs: number })[] {
  return rewards
    .filter((r) => r.lamports > 0)
    .sort((a, b) => a.span.epoch - b.span.epoch)
    .map(({ span, lamports }) => {
      const rewardSol = round(lamports / 1e9, 9);
      const price = book.at(span.endMs);
      return {
        epoch: span.epoch,
        endMs: span.endMs,
        endedAt: isoIst(new Date(span.endMs)),
        date: istDate(span.endMs),
        rewardSol,
        priceInr: price ? round(price.inr, 2) : null,
        priceDate: price ? istDate(price.ms) : null,
        priceSource: price?.source ?? null,
        rewardInr: rupees(price ? rewardSol * price.inr : null),
      };
    });
}

/** The year's months in order, up to the current one (IST); a past year has all twelve. */
export function monthly(
  epochs: readonly (IndiaRewardEpoch & { endMs: number })[],
  fy: FinancialYear,
  now: number,
): IndiaRewardMonth[] {
  const current = istMonth(Math.min(now, fy.endMs - 1));
  return financialYearMonths(fy)
    .filter((month) => month <= current)
    .map((month) => {
      const inMonth = epochs.filter((e) => istMonth(e.endMs) === month);
      const priced = inMonth.filter((e) => e.rewardInr.inr !== null);
      return {
        month,
        label: monthLabel(month),
        rewardSol: round(
          inMonth.reduce((s, e) => s + e.rewardSol, 0),
          9,
        ),
        rewardInr: rupees(
          priced.length > 0 ? priced.reduce((s, e) => s + (e.rewardInr.inr ?? 0), 0) : inMonth.length ? null : 0,
        ),
        epochs: inMonth.length,
      };
    });
}

export interface WalletRewardsInput {
  wallet: string;
  fy: FinancialYear;
  now: number;
  status: IndiaRewardsStatus;
  stage: IndiaRewardsStage;
  /** Finished epochs that ended in the year (null until known). */
  targets: readonly EpochSpan[] | null;
  /** Lamports per epoch read. */
  lamports: ReadonlyMap<number, number>;
  failed: ReadonlySet<number>;
  /** Stake accounts read; null until listed. */
  stakeAccounts: number | null;
  book: PriceBook;
  live: IndiaPriceBrief | null;
  notes: string[];
  sources: string[];
  retryAfterSeconds: number | null;
}

/** GET /v1/india/wallets/:address/rewards from what a wallet read has so far. */
export function walletRewards(input: WalletRewardsInput): IndiaWalletRewards {
  const targets = input.targets ?? [];
  const read = targets.filter((s) => input.lamports.has(s.epoch));
  const epochs = rewardEpochs(
    read.map((span) => ({ span, lamports: input.lamports.get(span.epoch) ?? 0 })),
    input.book,
  );
  const rewardSol = round(
    epochs.reduce((s, e) => s + e.rewardSol, 0),
    9,
  );
  const priced = epochs.filter((e) => e.rewardInr.inr !== null);
  const rewardInr =
    priced.length > 0 ? priced.reduce((s, e) => s + (e.rewardInr.inr ?? 0), 0) : epochs.length ? null : 0;
  const failed = targets.filter((s) => input.failed.has(s.epoch)).map((s) => s.epoch);
  return {
    schemaVersion: 1,
    kind: 'real',
    asOf: isoIst(new Date(input.now)),
    source: input.sources.join(', '),
    note: input.notes.join('; ') || undefined,
    wallet: input.wallet,
    fy: fyView(input.fy, input.now),
    availableFys: financialYearsUpTo(input.now).map((fy) => fy.label),
    status: input.status,
    stage: input.stage,
    retryAfterSeconds: input.retryAfterSeconds,
    coverage: {
      epochsInYear: targets.length,
      epochsRead: read.length,
      epochsPending:
        input.status === 'loading' || input.status === 'partial' ? targets.length - read.length - failed.length : 0,
      epochsFailed: failed.length,
      failedEpochs: failed,
      firstEpoch: targets[0]?.epoch ?? null,
      lastEpoch: targets.at(-1)?.epoch ?? null,
      stakeAccounts: input.stakeAccounts ?? 0,
    },
    totals: {
      rewardSol,
      rewardInr: rupees(rewardInr),
      valueTodayInr: rupees(input.live ? rewardSol * input.live.inr : null),
      epochsWithRewards: epochs.length,
      epochsWithoutPrice: epochs.length - priced.length,
    },
    months: monthly(epochs, input.fy, input.now),
    epochs: epochs.map(({ endMs: _endMs, ...epoch }) => epoch),
    livePrice: input.live,
    csvPath: `/v1/india/wallets/${input.wallet}/rewards.csv?fy=${input.fy.label}`,
    disclaimer: REWARDS_DISCLAIMER,
  };
}

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────────

/** RFC 4180: quote a field holding a comma, quote or line break; double the quotes inside. */
export function csvField(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvLine = (fields: (string | number | null)[]): string => fields.map(csvField).join(',');

/** UTF-8 byte-order mark: Excel then reads the file as UTF-8 (₹). */
export const BOM = '\uFEFF';

export const CSV_HEADER = [
  'Epoch',
  'Credited at (IST)',
  'Date (IST)',
  'Financial year',
  'Reward (SOL)',
  'SOL price (₹)',
  'Price date (IST)',
  'Price source',
  'Reward (₹)',
  'Reward (₹, formatted)',
];

/**
 * The year's rewards as a spreadsheet: a UTF-8 byte-order mark (so Excel reads ₹ correctly), one row per epoch with a
 * reward, a total row, then the wallet, year, status and the disclaimer. CRLF line ends.
 */
export function rewardsCsv(view: IndiaWalletRewards, now: number): string {
  const lines = [csvLine(CSV_HEADER)];
  for (const e of view.epochs) {
    lines.push(
      csvLine([
        e.epoch,
        istDateTime(Date.parse(e.endedAt)),
        e.date,
        view.fy.label,
        e.rewardSol.toFixed(9),
        e.priceInr === null ? null : e.priceInr.toFixed(2),
        e.priceDate,
        e.priceSource,
        e.rewardInr.inr === null ? null : e.rewardInr.inr.toFixed(2),
        e.rewardInr.formatted,
      ]),
    );
  }
  const total = view.totals.rewardInr;
  lines.push(
    csvLine([
      'Total',
      null,
      null,
      view.fy.label,
      view.totals.rewardSol.toFixed(9),
      null,
      null,
      null,
      total.inr === null ? null : total.inr.toFixed(2),
      total.formatted,
    ]),
  );
  lines.push('');
  lines.push(csvLine(['Wallet', view.wallet]));
  lines.push(
    csvLine([
      'Financial year',
      `${view.fy.name} (${view.fy.assessmentYear}), ${view.fy.startsAt} to ${view.fy.endsAt}`,
    ]),
  );
  lines.push(
    csvLine(['Status', `${view.status}: ${view.coverage.epochsRead} of ${view.coverage.epochsInYear} epochs read`]),
  );
  if (view.coverage.epochsFailed > 0) lines.push(csvLine(['Epochs not read', view.coverage.failedEpochs.join(' ')]));
  lines.push(csvLine(['Generated (IST)', istDateTime(now)]));
  if (view.note) lines.push(csvLine(['Notes', view.note]));
  lines.push(csvLine(['Disclaimer', view.disclaimer]));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** `epoch-staking-rewards-FY2026-27-C9MD-PDdd.csv`: ASCII only, for Content-Disposition. */
export const csvFileName = (wallet: string, fy: FinancialYear): string =>
  `epoch-staking-rewards-FY${fy.label}-${wallet.slice(0, 4)}-${wallet.slice(-4)}.csv`;
