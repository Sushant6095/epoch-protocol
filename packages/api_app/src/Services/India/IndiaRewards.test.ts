import { financialYear } from '../../Lib/IndianFy';
import chart from './__fixtures__/coingecko-market-chart.recorded.json';
import recorded from './__fixtures__/rewards-c9md.recorded.json';
import stakewiz from './__fixtures__/stakewiz-epochs.recorded.json';
import { buildEpochSpans, type EpochSpan, epochsEndingIn } from './EpochCalendar';
import {
  BOM,
  CSV_HEADER,
  csvField,
  csvFileName,
  REWARDS_DISCLAIMER,
  rewardsCsv,
  walletRewards,
  type WalletRewardsInput,
} from './IndiaRewards';
import { PriceBook, SOURCE_COINGECKO } from './InrPriceService';

const HOUR = 3_600_000;
const WALLET = recorded.wallet;
const NOW = Date.parse('2026-10-03T18:15:00+05:30');
const coingecko = new PriceBook(chart.body.prices.map(([ms, inr]) => ({ ms, inr, source: SOURCE_COINGECKO })));
const live = {
  inr: 11496.63,
  formatted: '₹11,496.63',
  change24hPct: -2.11,
  source: SOURCE_COINGECKO,
  asOf: '2026-10-03T18:05:10+05:30',
  stale: false,
  staleReason: null,
};

/** Lamports per epoch from the recorded getInflationReward answers (five stake accounts). */
const recordedLamports = new Map(
  Object.entries(recorded.byEpoch).map(([epoch, rows]) => [
    Number(epoch),
    rows.reduce((sum, row) => sum + (row?.amount ?? 0), 0),
  ]),
);

function input(over: Partial<WalletRewardsInput> & Pick<WalletRewardsInput, 'fy' | 'targets'>): WalletRewardsInput {
  return {
    wallet: WALLET,
    now: NOW,
    status: 'complete',
    stage: 'done',
    lamports: recordedLamports,
    failed: new Set(),
    stakeAccounts: 5,
    book: coingecko,
    live,
    notes: [],
    sources: ['Solana mainnet RPC'],
    retryAfterSeconds: null,
    ...over,
  };
}

describe('Rewards by Indian financial year', () => {
  const at = (epoch: number, iso: string): EpochSpan => ({
    epoch,
    startMs: Date.parse(iso) - 32 * HOUR,
    endMs: Date.parse(iso),
  });
  // Two epochs a minute apart around midnight IST on 31 March: 18:29 and 18:30 UTC, both still 31 March in UTC.
  const boundary = new Map([
    [100, at(100, '2026-03-31T23:59:00+05:30')],
    [101, at(101, '2026-04-01T00:00:00+05:30')],
  ]);

  it('buckets an epoch by the IST time it ended: 31 Mar 23:59 IST vs 1 Apr 00:00 IST', () => {
    const fy2526 = financialYear(2025);
    const fy2627 = financialYear(2026);
    expect(epochsEndingIn(boundary, fy2526.startMs, fy2526.endMs).map((s) => s.epoch)).toEqual([100]);
    expect(epochsEndingIn(boundary, fy2627.startMs, fy2627.endMs).map((s) => s.epoch)).toEqual([101]);

    const lamports = new Map([
      [100, 1_000_000_000],
      [101, 2_000_000_000],
    ]);
    const book = new PriceBook([{ ms: Date.parse('2026-03-31T00:00:00Z'), inr: 7707.45, source: SOURCE_COINGECKO }]);
    const before = walletRewards(
      input({ fy: fy2526, targets: epochsEndingIn(boundary, fy2526.startMs, fy2526.endMs), lamports, book }),
    );
    const after = walletRewards(
      input({ fy: fy2627, targets: epochsEndingIn(boundary, fy2627.startMs, fy2627.endMs), lamports, book }),
    );
    expect(before.epochs).toEqual([
      expect.objectContaining({ epoch: 100, endedAt: '2026-03-31T23:59:00+05:30', date: '2026-03-31', rewardSol: 1 }),
    ]);
    expect(before.months.at(-1)).toMatchObject({ month: '2026-03', label: 'Mar 2026', rewardSol: 1, epochs: 1 });
    expect(before.months).toHaveLength(12);
    expect(after.epochs).toEqual([
      expect.objectContaining({ epoch: 101, endedAt: '2026-04-01T00:00:00+05:30', date: '2026-04-01', rewardSol: 2 }),
    ]);
    expect(after.months[0]).toMatchObject({ month: '2026-04', rewardSol: 2, epochs: 1 });
    expect(after.months.map((m) => m.month).at(-1)).toBe('2026-10');
  });

  it('prices real rewards at the daily SOL/INR nearest each epoch end (recorded mainnet, epochs 946–951)', () => {
    const spans = buildEpochSpans(stakewiz.body, 1048);
    const fy2526 = financialYear(2025);
    const fy2627 = financialYear(2026);
    const last = walletRewards(input({ fy: fy2526, targets: [946, 947, 948].map((e) => spans.get(e) as EpochSpan) }));
    expect(last.fy).toEqual({
      label: '2025-26',
      name: 'FY 2025-26',
      assessmentYear: 'AY 2026-27',
      startsAt: '2025-04-01T00:00:00+05:30',
      endsAt: '2026-03-31T23:59:59+05:30',
      current: false,
    });
    expect(last.epochs.map((e) => [e.epoch, e.rewardSol, e.priceDate])).toEqual([
      [946, 0.041146969, '2026-03-27'],
      [947, 0.040838681, '2026-03-29'],
      [948, 0.040812681, '2026-03-31'],
    ]);
    expect(last.totals.rewardSol).toBe(0.122798331);

    const current = walletRewards(
      input({ fy: fy2627, targets: epochsEndingIn(spans, fy2627.startMs, fy2627.endMs).filter((s) => s.epoch < 952) }),
    );
    expect(current.fy.current).toBe(true);
    const [e949, e950, e951] = current.epochs;
    expect(e949).toEqual({
      epoch: 949,
      endedAt: '2026-04-02T03:41:01+05:30',
      date: '2026-04-02',
      rewardSol: 0.04094709,
      priceInr: 7550.59,
      priceDate: '2026-04-02',
      priceSource: SOURCE_COINGECKO,
      rewardInr: { inr: 309.17, formatted: '₹309.17', compact: '₹309' },
    });
    expect(e950.rewardInr.inr).toBe(308.06);
    expect(e951.priceDate).toBe('2026-04-06');
    expect(current.totals.rewardInr.inr).toBeCloseTo(
      [e949, e950, e951].reduce((s, e) => s + (e.rewardInr.inr ?? 0), 0),
      6,
    );
    expect(current.totals.valueTodayInr.inr).toBe(Math.round(current.totals.rewardSol * live.inr * 100) / 100);
    expect(current.coverage).toEqual({
      epochsInYear: 3,
      epochsRead: 3,
      epochsPending: 0,
      epochsFailed: 0,
      failedEpochs: [],
      firstEpoch: 949,
      lastEpoch: 951,
      stakeAccounts: 5,
    });
    expect(current.csvPath).toBe(`/v1/india/wallets/${WALLET}/rewards.csv?fy=2026-27`);
    expect(current.disclaimer).toBe(REWARDS_DISCLAIMER);
    expect(current.disclaimer).toMatch(/not tax advice/);
  });

  it('reports what is still loading, what failed and which epochs had no price', () => {
    const spans = buildEpochSpans(stakewiz.body, 1048);
    const fy = financialYear(2026);
    const targets = [949, 950, 951, 952].map((e) => spans.get(e) as EpochSpan);
    const partial = walletRewards(
      input({
        fy,
        targets,
        status: 'partial',
        lamports: new Map([[951, 41_103_517]]),
        failed: new Set([950]),
        retryAfterSeconds: 4,
      }),
    );
    expect(partial.coverage).toMatchObject({ epochsInYear: 4, epochsRead: 1, epochsPending: 2, epochsFailed: 1 });
    expect(partial.retryAfterSeconds).toBe(4);

    const noPrice = walletRewards(input({ fy, targets, book: new PriceBook([]) }));
    expect(noPrice.totals).toMatchObject({
      rewardInr: { inr: null, formatted: '—' },
      epochsWithRewards: 3,
      epochsWithoutPrice: 3,
    });
    expect(noPrice.epochs[0]).toMatchObject({ priceInr: null, priceDate: null, rewardInr: { inr: null } });

    const nothing = walletRewards(input({ fy, targets, lamports: new Map(targets.map((s) => [s.epoch, 0])) }));
    expect(nothing.totals).toMatchObject({
      rewardSol: 0,
      rewardInr: { inr: 0, formatted: '₹0.00' },
      epochsWithRewards: 0,
    });
    expect(nothing.epochs).toEqual([]);
  });
});

describe('Rewards CSV', () => {
  const spans = buildEpochSpans(stakewiz.body, 1048);
  const view = walletRewards(
    input({ fy: financialYear(2026), targets: [949, 950, 951].map((e) => spans.get(e) as EpochSpan) }),
  );
  const csv = rewardsCsv(view, NOW);
  const lines = csv.slice(1).split('\r\n');

  it('starts with a UTF-8 BOM and the header, CRLF line ends', () => {
    expect(csv.startsWith(BOM)).toBe(true);
    expect(Buffer.from(csv, 'utf8').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(lines[0]).toBe(CSV_HEADER.map(csvField).join(','));
    expect(lines[0]).toBe(
      'Epoch,Credited at (IST),Date (IST),Financial year,Reward (SOL),SOL price (₹),Price date (IST),Price source,Reward (₹),"Reward (₹, formatted)"',
    );
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replace(/\r\n/g, '')).not.toMatch(/\n/);
  });

  it('writes one row per epoch, then the total, the wallet and the disclaimer', () => {
    expect(lines[1]).toBe(
      '949,2026-04-02 03:41:01,2026-04-02,2026-27,0.040947090,7550.59,2026-04-02,CoinGecko,309.17,₹309.17',
    );
    expect(lines[4]).toBe(
      `Total,,,2026-27,${view.totals.rewardSol.toFixed(9)},,,,${view.totals.rewardInr.inr?.toFixed(2)},${csvField(view.totals.rewardInr.formatted)}`,
    );
    expect(lines[5]).toBe('');
    expect(lines[6]).toBe(`Wallet,${WALLET}`);
    expect(lines).toContain('Status,complete: 3 of 3 epochs read');
    expect(lines).toContain('Generated (IST),2026-10-03 18:15:00');
    expect(lines.at(-2)).toBe(`Disclaimer,${csvField(REWARDS_DISCLAIMER)}`);
  });

  it('quotes fields with commas or quotes, and names the file in ASCII', () => {
    expect(csvField('₹1,23,456.78')).toBe('"₹1,23,456.78"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField(null)).toBe('');
    expect(csvField(12.5)).toBe('12.5');
    expect(csvFileName(WALLET, financialYear(2026))).toBe('epoch-staking-rewards-FY2026-27-C9MD-PDdd.csv');
  });
});
