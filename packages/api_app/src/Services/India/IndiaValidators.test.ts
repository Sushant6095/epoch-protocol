import { indiaProfile, indiaRows, indiaStakewiz, indiaTable, livePrice, VOTES } from '../../__fixtures__/IndiaFakes';
import { type ValidatorProfile } from '../../types/Wallet.types';
import {
  cityBreakdown,
  comparison,
  countryName,
  indianRows,
  indiaShare,
  IndiaValidatorService,
  prospect,
  revenueAndCredit,
} from './IndiaValidators';
import { PriceBook } from './InrPriceService';

const LISTED = new Set([VOTES.listed]);

describe('India filtering and shares', () => {
  const rows = indiaRows();

  it('takes validators Stakewiz places in India, then operator-declared ones', () => {
    expect(indianRows(rows, LISTED).map(({ row, by }) => [row.name, by])).toEqual([
      ['Mumbai One', 'ip-geolocation'],
      ['Listed Indian Operator', 'listed'],
      ['Bengaluru Two', 'ip-geolocation'],
      ['Chennai Three', 'ip-geolocation'],
    ]);
    expect(indianRows(rows, new Set())).toHaveLength(3);
  });

  it("gives India's share by IP geolocation, its rank and the peers", () => {
    expect(indiaShare(rows, 'available', 1, 10_000)).toEqual({
      countryData: 'available',
      validators: 3,
      listed: 1,
      stakeSol: 260_000,
      stakeValueInr: { inr: 2_600_000_000, formatted: '₹2,60,00,00,000.00', compact: '₹260.00 Cr' },
      stakeSharePct: 12.121,
      validatorSharePct: 37.5,
      rank: 4,
      countriesWithValidators: 4,
    });
    const c = comparison(rows);
    expect(c.top.map((s) => [s.countryCode, s.rank, s.validators])).toEqual([
      ['DE', 1, 1],
      ['US', 2, 1],
      ['SG', 3, 2],
      ['IN', 4, 3],
    ]);
    expect(c.india).toMatchObject({ country: 'India', stakeSol: 260_000, rank: 4 });
    expect(c.peers.map((p) => [p.countryCode, p.country, p.rank])).toEqual([
      ['SG', 'Singapore', 3],
      ['AE', 'United Arab Emirates', null],
      ['HK', 'Hong Kong', null],
      ['JP', 'Japan', null],
    ]);
    expect(c.unknown).toEqual({ validators: 1, stakeSol: 5_000 });
  });

  it('reports India as unknown, not zero, without country data', () => {
    const share = indiaShare(rows, 'unknown', 0, 10_000);
    expect(share).toMatchObject({
      countryData: 'unknown',
      validators: null,
      stakeSol: null,
      stakeSharePct: null,
      rank: null,
    });
    expect(share.stakeValueInr.formatted).toBe('—');
    // With no Indian validator, India is 0% and unranked.
    const none = indiaShare(
      rows.filter((r) => r.countryCode !== 'IN'),
      'available',
      0,
      null,
    );
    expect(none).toMatchObject({ validators: 0, stakeSol: 0, stakeSharePct: 0, rank: null });
    expect(countryName('XX', 'Unknown')).toBe('Unknown');
    expect(countryName('IN', 'India')).toBe('India');
  });

  it('breaks India down by hosting city, Unknown when Stakewiz has none', () => {
    const geolocated = rows.filter((r) => r.countryCode === 'IN');
    expect(cityBreakdown(geolocated, indiaStakewiz())).toEqual([
      { city: 'Mumbai', validators: 1, stakeSol: 200_000, sharePct: 76.9 },
      { city: 'Bengaluru', validators: 1, stakeSol: 50_000, sharePct: 19.2 },
      { city: 'Unknown', validators: 1, stakeSol: 10_000, sharePct: 3.8 },
    ]);
  });
});

describe('Revenue and credit estimate', () => {
  const table = indiaTable();
  const mumbai = table.rows.find((r) => r.vote === VOTES.mumbai);
  if (!mumbai) throw new Error('fixture');

  it("estimates from the table's rates when the profile is not ready", () => {
    const live = livePrice();
    const { revenue, credit } = revenueAndCredit({
      row: mumbai,
      table,
      profile: null,
      endedAtMs: Date.parse('2026-10-03T03:20:01+05:30'),
      epochPrice: { inr: 11_400.26, source: 'CoinGecko' },
      live,
    });
    // 200,000 SOL × 0.0001786 × 5%; tips: 200,000 × 0.2% ÷ 273.9 epochs × 5/95; blocks: 400 a day × 32/24 × 0.0125.
    const inflation = 200_000 * 0.000_178_6 * 0.05;
    const tips = ((200_000 * 0.002) / 273.9) * (500 / 9_500);
    const blocks = 400 * (32 / 24) * 0.0125;
    expect(revenue).toMatchObject({
      epoch: 1047,
      endedAt: '2026-10-03T03:20:01+05:30',
      basis: 'table-estimate',
      sol: {
        inflationCommission: 1.786,
        tipsCommission: Math.round(tips * 1e4) / 1e4,
        blockFeesEstimate: 6.6667,
        voteFees: -2.16,
        net: Math.round((inflation + tips + blocks - 2.16) * 1e4) / 1e4,
      },
      priceInr: 11_400.26,
      priceSource: 'CoinGecko',
    });
    expect(revenue.netInr.inr).toBe(Math.round(revenue.sol.net * 11_400.26 * 100) / 100);
    const window = (inflation + tips) * 10;
    expect(credit).toMatchObject({
      estimate: true,
      basis: 'table-estimate',
      sweepableLast10EpochsSol: Math.round(window * 1e4) / 1e4,
      limitUnhedgedSol: Math.round(window * 0.25 * 1e4) / 1e4,
      limitHedgedSol: Math.round(window * 0.4 * 1e4) / 1e4,
    });
    expect(credit.limitUnhedgedInr.inr).toBe(Math.round(credit.limitUnhedgedSol * live.inr * 100) / 100);
    expect(credit.note).toMatch(/planned Pool parameters; estimated from today's stake/);
  });

  it("uses the validator profile's figures when it answered, priced live when the epoch's day has no price", () => {
    const { revenue, credit } = revenueAndCredit({
      row: mumbai,
      table,
      profile: indiaProfile(VOTES.mumbai),
      endedAtMs: null,
      epochPrice: null,
      live: livePrice(),
    });
    expect(revenue).toEqual({
      epoch: 1047,
      endedAt: null,
      basis: 'validator-profile',
      sol: { inflationCommission: 1.8, tipsCommission: 0.25, blockFeesEstimate: 1.6, voteFees: -2.16, net: 1.49 },
      netInr: { inr: 17_129.98, formatted: '₹17,129.98', compact: '₹17,130' },
      priceInr: 11_496.63,
      priceSource: 'CoinGecko (live)',
    });
    expect(credit).toMatchObject({
      basis: 'validator-profile',
      limitUnhedgedSol: 5.1,
      limitHedgedSol: 8.16,
      limitUnhedgedInr: { inr: 58_632.81, formatted: '₹58,632.81' },
    });
  });

  it('estimates a new Indian validator at three stake sizes, with the break-even stake', () => {
    const real = indiaTable({ totalStakeSol: 444_000_000 });
    const p = prospect(real, 10_000);
    expect(p.assumptions).toMatchObject({
      commissionPct: 5,
      mevCommissionPct: 5,
      tipsApyPct: 0.14,
      epochsPerMonth: 22.5,
    });
    // Median commission 5%: 2.16 SOL of vote fees ÷ (0.0001786 × 5% + 432,000 × 0.0125 ÷ 444M) per SOL.
    expect(p.breakEvenStakeSol).toBe(102_000);
    expect(p.tiers.map((t) => t.stakeSol)).toEqual([50_000, 150_000, 500_000]);
    expect(p.tiers[0].revenuePerEpochSol).toBeLessThan(0);
    expect(p.tiers[2].revenuePerEpochSol).toBeGreaterThan(0);
    const [small] = p.tiers;
    const sweepable = 50_000 * 0.000_178_6 * 0.05 + ((50_000 * 0.0014) / 273.9) * (500 / 9_500);
    expect(small.creditLimitUnhedgedSol).toBe(Math.round(sweepable * 10 * 0.25 * 100) / 100);
    expect(small.creditLimitHedgedInr.inr).toBe(Math.round(sweepable * 10 * 0.4 * 10_000 * 100) / 100);
    expect(small.revenuePerMonthSol).toBeCloseTo(small.revenuePerEpochSol * 22.5, 1);
    expect(p.note).toMatch(/not an offer/);
  });
});

describe('IndiaValidatorService', () => {
  function service(over: { table?: ReturnType<typeof indiaTable>; price?: boolean; listed?: Set<string> } = {}) {
    const profile = jest.fn((vote: string) =>
      vote === VOTES.mumbai ? Promise.resolve(indiaProfile(vote)) : new Promise<ValidatorProfile>(() => undefined),
    );
    const endMs = Date.parse('2026-10-03T03:20:01+05:30');
    return new IndiaValidatorService({
      table: async () => over.table ?? indiaTable(),
      stakewiz: async () => indiaStakewiz(),
      profile,
      prices: {
        live: async () => {
          if (over.price === false) throw new Error('PRICE_UNAVAILABLE');
          return livePrice();
        },
        history: async () => ({ book: new PriceBook([{ ms: endMs, inr: 11_400.26, source: 'CoinGecko' }]), notes: [] }),
      },
      calendar: { spans: async () => new Map([[1047, { epoch: 1047, startMs: endMs - 32 * 3_600_000, endMs }]]) },
      listedVotes: over.listed ?? LISTED,
      profileTimeoutMs: 20,
    });
  }

  it('lists Indian validators with revenue in SOL and rupees, the profile where it answered', async () => {
    const snap = await service().snapshot();
    expect(snap.status).toBe('ok');
    expect(snap.tableRows.map((r) => r.name)).toEqual([
      'Mumbai One',
      'Listed Indian Operator',
      'Bengaluru Two',
      'Chennai Three',
    ]);
    const mumbai = snap.rows.get(VOTES.mumbai);
    expect(mumbai).toMatchObject({
      inIndiaBy: 'ip-geolocation',
      city: 'Mumbai',
      country: 'India',
      hostingOrg: 'Equinix India',
      stakeValueInr: { inr: 2_299_326_000, compact: '₹229.93 Cr' },
      revenue: { basis: 'validator-profile', priceInr: 11_400.26, priceSource: 'CoinGecko' },
      credit: { basis: 'validator-profile', limitUnhedgedSol: 5.1 },
    });
    expect(snap.rows.get(VOTES.listed)).toMatchObject({ inIndiaBy: 'listed', city: 'Singapore', countryCode: 'SG' });
    expect(snap.rows.get(VOTES.chennai)).toMatchObject({ city: 'Unknown', revenue: { basis: 'table-estimate' } });
    expect(snap.notes.join(' ')).toMatch(/estimated from the table's rates for Listed Indian Operator, Bengaluru Two/);
    expect(snap.india).toMatchObject({ validators: 3, listed: 1, rank: 4 });
    expect(snap.cities.map((c) => c.city)).toEqual(['Mumbai', 'Bengaluru', 'Unknown']);
    expect(snap.price).toMatchObject({ inr: 11_496.63, formatted: '₹11,496.63', stale: false });
    expect(snap.network).toMatchObject({ epoch: 1048, validators: 8, stakeSol: 2_145_000 });
  });

  it('is empty, not unknown, when Stakewiz places no validator in India (as on 3 Oct 2026)', async () => {
    const table = indiaTable({ rows: indiaRows().filter((r) => r.countryCode !== 'IN') });
    const snap = await service({ table, listed: new Set() }).snapshot();
    expect(snap.status).toBe('empty');
    expect(snap.rows.size).toBe(0);
    expect(snap.india).toMatchObject({ countryData: 'available', validators: 0, stakeSharePct: 0, rank: null });
    expect(snap.comparison.india.rank).toBeNull();
    expect(snap.prospect.tiers).toHaveLength(3);
  });

  it('is unknown when the table has no Stakewiz data, and never prices without a price', async () => {
    const table = indiaTable({
      rows: indiaRows().map((r) => ({ ...r, country: 'Unknown', countryCode: 'XX' })),
      sources: ['Solana mainnet RPC'],
    });
    const snap = await service({ table, listed: new Set(), price: false }).snapshot();
    expect(snap.status).toBe('unknown');
    expect(snap.india).toMatchObject({ countryData: 'unknown', validators: null, stakeSharePct: null });
    expect(snap.notes[0]).toMatch(/no country data/);
    expect(snap.price).toBeNull();
    expect(snap.network.stakeValueInr).toEqual({ inr: null, formatted: '—', compact: '—' });
  });
});
