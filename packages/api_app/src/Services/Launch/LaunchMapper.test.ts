import { type DammPoolState, type LaunchPoolState, type LaunchRegistryEntry, type TokenMintInfo } from '@epoch/meteora';

import { type LaunchChainSnapshot, type LaunchEpochInfo } from './LaunchChain';
import { buildLaunchItem, estimateEpochAt, launchRisks, launchStatus } from './LaunchMapper';

// The Launch spec's fixtures (handover launches.sample.json, launch-rkest.sample.json), read through fake chain state.
const NOW = new Date('2026-10-03T10:00:00+05:30');
const EPOCH: LaunchEpochInfo = { epoch: 1044, slotIndex: 1_000, slotsInEpoch: 432_000, absoluteSlot: 451_009_000 };

const RKEST: LaunchRegistryEntry = {
  mint: 'RKESTmint1111111111111111111111111111111111',
  symbol: 'rKEST',
  name: 'Kestrel Nodes revenue token',
  validator: { name: 'Kestrel Nodes', vote: 'KestreLvote11111111111111111111111111111111' },
  shareBps: 500,
  termEpochs: 100,
  startEpoch: 1043,
  dbcPool: 'RKESTdbcpoo11111111111111111111111111111111',
  dbcConfig: 'RKESTconfig11111111111111111111111111111111',
  escrow: 'RKESTescrow11111111111111111111111111111111',
  supply: 100_000,
  decimals: 6,
  cluster: 'devnet',
  avgRevenueSol: 20.8,
};

const curvePool = (overrides: Partial<LaunchPoolState> = {}): LaunchPoolState => ({
  dbcPool: RKEST.dbcPool as string,
  config: RKEST.dbcConfig as string,
  baseMint: RKEST.mint,
  quoteMint: 'So11111111111111111111111111111111111111112',
  baseVault: 'base-vault',
  quoteVault: 'quote-vault',
  creator: 'creator',
  partner: 'treasury',
  leftoverReceiver: 'treasury',
  baseDecimals: 6,
  quoteDecimals: 9,
  baseReserve: 96_000,
  quoteReserveSol: 3.1,
  priceSol: 0.000846,
  startPriceSol: 0.000624,
  migrationPriceSol: 0.000988,
  curveProgressPct: 62,
  migrationThresholdSol: 5,
  curveComplete: false,
  migrated: false,
  migrationProgress: 'preBondingCurve',
  dammPool: null,
  finishCurveTime: null,
  migrationFeePct: 70,
  creatorMigrationFeeSharePct: 100,
  liquidity: { partnerLockedPct: 100, creatorLockedPct: 0, partnerPct: 0, creatorPct: 0 },
  tokenUpdateAuthority: 1,
  fees: {
    tradingFeeBps: 100,
    creatorTradingFeePct: 0,
    partnerTotalSol: 0.031,
    partnerUnclaimedSol: 0.011,
    creatorTotalSol: 0,
    totalTradingSol: 0.031,
  },
  supply: { preMigration: 100_000, postMigration: 100_000 },
  activationType: 'timestamp',
  activationPoint: 1_790_000_000,
  ...overrides,
});

const mintInfo = (uiSupply: number, overrides: Partial<TokenMintInfo> = {}): TokenMintInfo => ({
  mint: RKEST.mint,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  uiSupply,
  supply: BigInt(Math.round(uiSupply * 1e6)),
  decimals: 6,
  mintAuthority: null,
  freezeAuthority: null,
  isInitialized: true,
  ...overrides,
});

const dammPool = (priceSol: number): DammPoolState => ({
  pool: 'SALTdammpoo11111111111111111111111111111111',
  baseMint: 'SALTmint11111111111111111111111111111111111',
  quoteMint: 'So11111111111111111111111111111111111111112',
  baseDecimals: 6,
  quoteDecimals: 9,
  baseIsTokenA: true,
  tokenAMint: 'SALTmint11111111111111111111111111111111111',
  tokenBMint: 'So11111111111111111111111111111111111111112',
  tokenAVault: 'damm-vault-a',
  tokenBVault: 'damm-vault-b',
  priceSol,
  baseReserve: 90_000,
  quoteReserveSol: 2.4,
  liquidity: '1',
  enabled: true,
  activationType: 'timestamp',
  activationPoint: 0,
});

const chain = (snapshot: Partial<LaunchChainSnapshot>): LaunchChainSnapshot => ({ failed: [], ...snapshot });
const revenue = (avgRevenueSol: number | null) => ({
  avgRevenueSol,
  note: avgRevenueSol === null ? 'no estimate' : null,
});

describe('buildLaunchItem', () => {
  it('reproduces rKEST on the curve: 62% of 5 SOL, 83.4 SOL fully diluted, 1.25% per epoch, backing 1.23×', () => {
    const item = buildLaunchItem({
      entry: RKEST,
      chain: chain({
        pool: curvePool(),
        mint: mintInfo(98_570),
        holders: { holders: 43, holdersExcluding: 41 },
        escrowSol: 0,
      }),
      epoch: EPOCH,
      revenue: revenue(20.8),
      network: 'devnet',
      now: NOW,
    });
    expect(item.real).toBe(true);
    expect(item.summary).toEqual({
      mint: RKEST.mint,
      symbol: 'rKEST',
      name: 'Kestrel Nodes revenue token',
      validator: { name: 'Kestrel Nodes', vote: RKEST.validator.vote },
      shareBps: 500,
      termEpochs: 100,
      startEpoch: 1043,
      endEpoch: 1142,
      status: 'curve',
      opensAtEpoch: null,
      raise: { targetSol: 5, raisedSol: 3.1, progressPct: 62, buyers: 41 },
      priceSol: 0.000846,
      bandLowSol: 0.000624,
      bandHighSol: 0.000988,
      marketCapSol: 83.3902,
      shareRevenuePerEpochSol: 1.04,
      impliedYieldPctPerEpoch: 1.25,
      backingRatio: 1.23,
    });
    expect(item.detail).toEqual({
      token: { supply: 100_000, burned: 1_430, holders: 43, decimals: 6, mintAuthority: null, metadataImmutable: true },
      curve: {
        dbcPool: RKEST.dbcPool,
        config: RKEST.dbcConfig,
        bandLowSol: 0.000624,
        bandHighSol: 0.000988,
        valuePerTokenSol: 0.00104,
        migrationThresholdSol: 5,
        creatorMigrationFeePct: 70,
        lockedLiquidityPct: 100,
        dammPool: null,
        graduatedEpoch: null,
      },
      escrow: { address: RKEST.escrow, balanceSol: 0, slicesPerEpoch: 12, mode: 'buyback' },
      partnerFeesToSeniorSol: 0.031,
      upfrontToValidatorSol: null,
      buybacks: [],
      risks: launchRisks(RKEST, 'devnet'),
    });
    expect(item.notes).toEqual([]);
  });

  it('reproduces rSALT graduated to DAMM v2: price from the pool, 1.43% per epoch, backing 0.94×, 3.5 SOL upfront', () => {
    const salt: LaunchRegistryEntry = {
      ...RKEST,
      mint: 'SALTmint11111111111111111111111111111111111',
      symbol: 'rSALT',
      name: 'Saltmarsh Nodes revenue token',
      validator: { name: 'Saltmarsh Nodes', vote: null },
      shareBps: 1000,
      termEpochs: 80,
      startEpoch: 1030,
      avgRevenueSol: 29.4,
    };
    const finished = NOW.getTime() / 1000 - 3 * 86_400; // three days ago: 1.5 epochs of 0.4 s slots back
    const item = buildLaunchItem({
      entry: salt,
      chain: chain({
        pool: curvePool({
          migrated: true,
          curveComplete: true,
          migrationProgress: 'createdPool',
          quoteReserveSol: 5,
          curveProgressPct: 100,
          dammPool: 'SALTdammpoo11111111111111111111111111111111',
          startPriceSol: 0.001411,
          migrationPriceSol: 0.002234,
          finishCurveTime: finished,
        }),
        damm: dammPool(0.00215),
        mint: mintInfo(95_860),
        holders: { holders: 90, holdersExcluding: 87 },
      }),
      epoch: EPOCH,
      revenue: revenue(29.4),
      network: 'devnet',
      now: NOW,
    });
    expect(item.summary).toMatchObject({
      status: 'graduated',
      raise: { targetSol: 5, raisedSol: 5, progressPct: 100, buyers: 87 },
      priceSol: 0.00215,
      bandLowSol: 0.001411,
      bandHighSol: 0.002234,
      marketCapSol: 206.099,
      shareRevenuePerEpochSol: 2.94,
      impliedYieldPctPerEpoch: 1.43,
      backingRatio: 0.94,
    });
    expect(item.detail.upfrontToValidatorSol).toBe(3.5);
    expect(item.detail.token.burned).toBe(4_140);
    expect(item.detail.curve.dammPool).toBe('SALTdammpoo11111111111111111111111111111111');
    expect(item.detail.curve.graduatedEpoch).toBe(1042);
  });

  it('reproduces rTIDE upcoming: the band from its revenue, no price, opens in epoch 1046', () => {
    const tide: LaunchRegistryEntry = {
      ...RKEST,
      mint: 'TiDEmint11111111111111111111111111111111111',
      symbol: 'rTIDE',
      name: 'Tidewater Stake revenue token',
      validator: { name: 'Tidewater Stake', vote: null },
      shareBps: 1500,
      termEpochs: 60,
      startEpoch: 1046,
      opensAtEpoch: 1046,
      dbcPool: null,
      escrow: null,
      avgRevenueSol: 8,
      raiseTargetSol: 3,
    };
    const item = buildLaunchItem({
      entry: tide,
      chain: chain({ mint: null }),
      epoch: EPOCH,
      revenue: revenue(8),
      network: 'devnet',
      now: NOW,
    });
    expect(item.summary).toMatchObject({
      status: 'upcoming',
      opensAtEpoch: 1046,
      endEpoch: 1105,
      raise: { targetSol: 3, raisedSol: 0, progressPct: 0, buyers: 0 },
      priceSol: null,
      bandLowSol: 0.000432,
      bandHighSol: 0.000684,
      marketCapSol: null,
      shareRevenuePerEpochSol: 1.2,
      impliedYieldPctPerEpoch: null,
      backingRatio: null,
    });
    expect(item.detail.curve.valuePerTokenSol).toBe(0.00072);
    expect(item.detail.token).toMatchObject({ burned: 0, holders: 0, metadataImmutable: false });
  });

  it('ends after the term, keeping the last price', () => {
    const item = buildLaunchItem({
      entry: RKEST,
      chain: chain({ pool: curvePool(), mint: mintInfo(90_000) }),
      epoch: { ...EPOCH, epoch: 1143 },
      revenue: revenue(20.8),
      network: 'devnet',
      now: NOW,
    });
    expect(item.summary.status).toBe('ended');
    expect(item.summary.priceSol).toBe(0.000846);
    expect(item.summary.backingRatio).toBe(0);
  });

  it('marks a failed read as sample data and keeps the registry status', () => {
    const item = buildLaunchItem({
      entry: RKEST,
      chain: chain({ failed: ['curve pool'], mint: mintInfo(100_000) }),
      epoch: EPOCH,
      revenue: revenue(20.8),
      network: 'devnet',
      now: NOW,
    });
    expect(item.real).toBe(false);
    expect(item.summary).toMatchObject({ status: 'curve', priceSol: null, marketCapSol: null, bandLowSol: 0.000624 });
    expect(item.notes).toContain('rKEST: could not read curve pool.');
  });

  it('is upcoming while the registered pool is not on chain', () => {
    const item = buildLaunchItem({
      entry: RKEST,
      chain: chain({ pool: null, mint: null }),
      epoch: EPOCH,
      revenue: revenue(20.8),
      network: 'devnet',
      now: NOW,
    });
    expect(item.summary.status).toBe('upcoming');
    expect(item.notes).toContain('rKEST: the curve pool is not on devnet yet.');
    expect(item.detail.token.burned).toBe(0);
  });

  it('serves 0 share revenue and no yield or backing while the revenue is unknown', () => {
    const item = buildLaunchItem({
      entry: RKEST,
      chain: chain({ pool: curvePool(), mint: mintInfo(98_570, { mintAuthority: 'someone' }) }),
      epoch: EPOCH,
      revenue: revenue(null),
      network: 'devnet',
      now: NOW,
    });
    expect(item.summary).toMatchObject({
      shareRevenuePerEpochSol: 0,
      impliedYieldPctPerEpoch: null,
      backingRatio: null,
      marketCapSol: 83.3902,
    });
    expect(item.notes).toEqual([
      'rKEST: share revenue is 0 until it is known (no estimate).',
      'rKEST: the mint still has a mint authority.',
    ]);
  });
});

describe('launchStatus', () => {
  const base = { currentEpoch: 1044, endEpoch: 1142, opensAtEpoch: null, live: true, graduated: false };
  it('follows the term, the opening epoch and the pools', () => {
    expect(launchStatus(base)).toBe('curve');
    expect(launchStatus({ ...base, graduated: true })).toBe('graduated');
    expect(launchStatus({ ...base, live: false })).toBe('upcoming');
    expect(launchStatus({ ...base, opensAtEpoch: 1046 })).toBe('upcoming');
    expect(launchStatus({ ...base, currentEpoch: 1143, graduated: true })).toBe('ended');
    expect(launchStatus({ ...base, currentEpoch: null })).toBe('curve');
  });
});

describe('estimateEpochAt', () => {
  it('places a past time in its epoch', () => {
    const now = new Date(1_790_000_000_000);
    expect(estimateEpochAt(1_790_000_000 - 100, EPOCH, now)).toBe(1044);
    expect(estimateEpochAt(1_790_000_000 - 3_600, EPOCH, now)).toBe(1043);
    expect(estimateEpochAt(1_790_000_000 - 2 * 172_800, EPOCH, now)).toBe(1042);
  });
});

describe('launchRisks', () => {
  it('names the validator and the last epoch of the term, as the fixture words them', () => {
    expect(launchRisks(RKEST, 'devnet')).toEqual([
      'Revenue tokens can count as securities in many countries. This is a devnet demo with no real value, and nothing here is an offer.',
      "Buybacks follow Kestrel Nodes' real commission revenue: if its stake or fees fall, so does the buyback.",
      "Kestrel Nodes can't leave Epoch or lower its commission until its term ends, after epoch 1142's sweep: both need the withdraw authority the program holds.",
      "If the DAMM v2 buyback isn't ready, holders can also redeem tokens for their share of the escrow (same backing, no market buy); trading on the pool goes on.",
    ]);
    expect(launchRisks(RKEST, 'mainnet')[0]).not.toMatch(/devnet/);
    expect(launchRisks({ ...RKEST, validator: { name: 'Aurora', vote: null } }, 'devnet')[1]).toMatch(
      /^Buybacks follow Aurora's real/,
    );
  });
});
