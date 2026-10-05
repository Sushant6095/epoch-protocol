import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { type LaunchPoolState, type LaunchRegistryEntry, type TokenMintInfo } from '@epoch/meteora';

import { type LaunchChainReader } from './LaunchChain';
import { MemoryLaunchPriceStore } from './LaunchPriceStore';
import { LaunchPriceSampler } from './LaunchPriceSampler';
import { LaunchRegistry } from './LaunchRegistry';
import { type LaunchRevenueSource } from './LaunchRevenue';
import { LaunchService } from './LaunchService';

const KESTREL_VOTE = 'KestreLvote11111111111111111111111111111111';
const TIDE_VOTE = 'TidewaterVote111111111111111111111111111111';

const RKEST: LaunchRegistryEntry = {
  mint: 'RKESTmint1111111111111111111111111111111111',
  symbol: 'rKEST',
  name: 'Kestrel Nodes revenue token',
  validator: { name: 'Kestrel Nodes', vote: KESTREL_VOTE },
  shareBps: 500,
  termEpochs: 100,
  startEpoch: 1043,
  dbcPool: 'RKESTdbcpoo11111111111111111111111111111111',
  dbcConfig: 'RKESTconfig11111111111111111111111111111111',
  supply: 100_000,
  decimals: 6,
  cluster: 'devnet',
  avgRevenueSol: 20.8,
};
const RTIDE: LaunchRegistryEntry = {
  mint: 'TiDEmint11111111111111111111111111111111111',
  symbol: 'rTIDE',
  name: 'Tidewater Stake revenue token',
  validator: { name: 'Tidewater Stake', vote: TIDE_VOTE },
  shareBps: 1500,
  termEpochs: 60,
  startEpoch: 1046,
  opensAtEpoch: 1046,
  supply: 100_000,
  decimals: 6,
  cluster: 'devnet',
  avgRevenueSol: 8,
  raiseTargetSol: 3,
};
const ON_MAINNET: LaunchRegistryEntry = {
  ...RKEST,
  mint: 'SALTmint11111111111111111111111111111111111',
  cluster: 'mainnet',
};

const pool = (priceSol: number): LaunchPoolState =>
  ({
    dbcPool: RKEST.dbcPool,
    config: RKEST.dbcConfig,
    baseVault: 'base-vault',
    leftoverReceiver: 'treasury',
    quoteReserveSol: 3.1,
    priceSol,
    startPriceSol: 0.000624,
    migrationPriceSol: 0.000988,
    curveProgressPct: 62,
    migrationThresholdSol: 5,
    migrated: false,
    dammPool: null,
    finishCurveTime: null,
    migrationFeePct: 70,
    creatorMigrationFeeSharePct: 100,
    liquidity: { partnerLockedPct: 100, creatorLockedPct: 0, partnerPct: 0, creatorPct: 0 },
    tokenUpdateAuthority: 1,
    fees: { partnerTotalSol: 0.031 },
  }) as unknown as LaunchPoolState;

const mint = (uiSupply: number): TokenMintInfo =>
  ({ tokenProgram: 'token-program', uiSupply, decimals: 6, mintAuthority: null }) as unknown as TokenMintInfo;

function fakeReader(prices: number[] = [0.000846]) {
  let read = 0;
  return {
    epochInfo: jest.fn().mockResolvedValue({ epoch: 1044, slotIndex: 1_000, slotsInEpoch: 432_000, absoluteSlot: 1 }),
    launchPool: jest.fn(async () => pool(prices[Math.min(read++, prices.length - 1)])),
    dammPool: jest.fn().mockResolvedValue(null),
    mint: jest.fn(async (address: string) => (address === RKEST.mint ? mint(98_570) : null)),
    holders: jest.fn().mockResolvedValue({ holders: 43, holdersExcluding: 41 }),
    escrowSol: jest.fn().mockResolvedValue(0),
  } satisfies LaunchChainReader;
}

const revenue: LaunchRevenueSource = async (vote) => ({
  avgRevenueSol: vote === KESTREL_VOTE ? 20.8 : vote === TIDE_VOTE ? 8 : null,
  note: null,
});

describe('LaunchService', () => {
  let dir: string;
  let path: string;
  let clock: number;
  const now = () => clock;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'launch-service-'));
    path = join(dir, 'launches.json');
    writeFileSync(path, JSON.stringify([RKEST, RTIDE, ON_MAINNET]));
    clock = Date.parse('2026-10-03T04:30:00Z');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const service = (reader: LaunchChainReader, prices = new MemoryLaunchPriceStore(), registryPath = path) =>
    new LaunchService({
      registry: new LaunchRegistry(registryPath),
      reader,
      revenue,
      prices,
      network: 'devnet',
      cacheMs: 60_000,
      holdersCacheMs: 600_000,
      now,
    });

  it('lists the network’s launches as real data', async () => {
    const list = await service(fakeReader()).list();
    expect(list).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      network: 'devnet',
      asOf: '2026-10-03T10:00:00+05:30',
    });
    expect(list.launches.map((launch) => [launch.symbol, launch.status])).toEqual([
      ['rKEST', 'curve'],
      ['rTIDE', 'upcoming'],
    ]);
    expect(list.launches[0]).toMatchObject({
      raise: { targetSol: 5, raisedSol: 3.1, progressPct: 62, buyers: 41 },
      marketCapSol: 83.3902,
      impliedYieldPctPerEpoch: 1.25,
      backingRatio: 1.23,
    });
    expect(list.note).toContain('Buybacks: GET /v1/launches/:mint/buybacks');
    expect(list.note).toContain("a registered token's terms are the program's");
    expect(list.source).toMatch(/Meteora DBC and DAMM v2 pools on devnet/);
  });

  it('serves a launch by mint or by symbol, and 404 for anything else', async () => {
    const launches = service(fakeReader());
    const detail = await launches.detail(RKEST.mint);
    expect(detail).toMatchObject({
      kind: 'real',
      network: 'devnet',
      launch: { symbol: 'rKEST', status: 'curve' },
      token: { supply: 100_000, burned: 1_430, holders: 43 },
      curve: { valuePerTokenSol: 0.00104, migrationThresholdSol: 5, creatorMigrationFeePct: 70 },
      escrow: { slicesPerEpoch: 12, mode: 'buyback' },
      partnerFeesToSeniorSol: 0.031,
      upfrontToValidatorSol: null,
      priceSeries: [],
      buybacks: [],
    });
    expect(detail.risks).toHaveLength(4);
    expect((await launches.detail('rkest')).launch.mint).toBe(RKEST.mint);
    await expect(launches.detail('rSALT')).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('reads the chain once per cache period', async () => {
    const reader = fakeReader();
    const launches = service(reader);
    await launches.list();
    await launches.detail('rKEST');
    await launches.list();
    expect(reader.launchPool).toHaveBeenCalledTimes(1);
    expect(reader.epochInfo).toHaveBeenCalledTimes(1);
  });

  it('samples prices for the chart, oldest first in IST', async () => {
    const store = new MemoryLaunchPriceStore();
    const launches = service(fakeReader([0.000846, 0.00086]), store);
    const sampler = new LaunchPriceSampler(launches, store, 60_000);
    expect(await sampler.tick()).toBe(1);
    clock += 61_000;
    expect(await sampler.tick()).toBe(1);
    clock += 61_000;
    const detail = await launches.detail('rKEST');
    expect(detail.priceSeries).toEqual([
      { t: '2026-10-03T10:00:00+05:30', epoch: 1044, priceSol: 0.000846 },
      { t: '2026-10-03T10:01:01+05:30', epoch: 1044, priceSol: 0.00086 },
    ]);
  });

  it('answers an empty list with a note when LAUNCHES_PATH is not set', async () => {
    const launches = new LaunchService({
      registry: new LaunchRegistry(undefined),
      reader: fakeReader(),
      revenue,
      prices: null,
      network: 'devnet',
      cacheMs: 60_000,
      holdersCacheMs: 600_000,
      now,
    });
    expect(await launches.list()).toMatchObject({
      kind: 'sample',
      launches: [],
      note: 'No launches yet: set LAUNCHES_PATH to the launch registry (the launch script writes it).',
    });
    await expect(launches.detail('rKEST')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('marks the data as sample when a read fails, and says which', async () => {
    const reader = fakeReader();
    reader.launchPool.mockRejectedValueOnce(new Error('429 Too Many Requests'));
    const list = await service(reader).list();
    expect(list.kind).toBe('sample');
    expect(list.note).toContain('rKEST: could not read curve pool.');
  });

  it('answers 503 LAUNCH_REGISTRY_INVALID for a broken registry', async () => {
    writeFileSync(path, '[{"mint": "nope"}]');
    await expect(service(fakeReader()).list()).rejects.toMatchObject({
      statusCode: 503,
      code: 'LAUNCH_REGISTRY_INVALID',
    });
  });

  it('says the price series needs Postgres when there is none', async () => {
    const launches = new LaunchService({
      registry: new LaunchRegistry(path),
      reader: fakeReader(),
      revenue,
      prices: null,
      network: 'devnet',
      cacheMs: 60_000,
      holdersCacheMs: 600_000,
      now,
    });
    const detail = await launches.detail('rKEST');
    expect(detail.priceSeries).toEqual([]);
    expect(detail.note).toContain('The price series needs Postgres (DATABASE_URL).');
  });
});
