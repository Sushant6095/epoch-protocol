import { type PoolState as DammPoolAccount } from '@meteora-ag/cp-amm-sdk';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  type PoolConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

import { NATIVE_MINT } from './constants';
import { priceToSqrtPriceX64 } from './curve';
import { graduatedDammPool, mapDammPool, mapLaunchPool } from './pools';
import { toBN } from './units';

const key = (seed: number): PublicKey => new PublicKey(new Uint8Array(32).fill(seed));
const MINT = key(1);
const CONFIG = key(2);
const PARTNER = key(3);
const CREATOR = key(4);
const POOL = key(5).toBase58();

const sqrt = (price: number, baseDecimals = 6, quoteDecimals = 9): BN =>
  toBN(priceToSqrtPriceX64(price, baseDecimals, quoteDecimals));

// rKEST on the curve: 3.1 of 5 SOL raised at 0.000846 SOL, 0.031 SOL of trading fees.
const config = {
  quoteMint: NATIVE_MINT,
  feeClaimer: PARTNER,
  leftoverReceiver: PARTNER,
  tokenDecimal: 6,
  migrationQuoteThreshold: new BN(5_000_000_000),
  sqrtStartPrice: sqrt(0.000624),
  migrationSqrtPrice: sqrt(0.000988),
  creatorTradingFeePercentage: 0,
  migrationFeeOption: 2,
  migrationFeePercentage: 70,
  creatorMigrationFeePercentage: 100,
  partnerPermanentLockedLiquidityPercentage: 100,
  creatorPermanentLockedLiquidityPercentage: 0,
  partnerLiquidityPercentage: 0,
  creatorLiquidityPercentage: 0,
  tokenUpdateAuthority: 1,
  poolFees: { baseFee: { cliffFeeNumerator: new BN(10_000_000) } },
  fixedTokenSupplyFlag: 1,
  preMigrationTokenSupply: new BN('100000000000'),
  postMigrationTokenSupply: new BN('100000000000'),
  activationType: 1,
} as unknown as PoolConfig;

const virtualPool = (overrides: Record<string, unknown> = {}): VirtualPool =>
  ({
    poolState: {
      config: CONFIG,
      creator: CREATOR,
      baseMint: MINT,
      baseVault: key(6),
      quoteVault: key(7),
      baseReserve: new BN('96000000000'),
      quoteReserve: new BN(3_100_000_000),
      sqrtPrice: sqrt(0.000846),
      isMigrated: 0,
      migrationProgress: 0,
      partnerQuoteFee: new BN(11_000_000),
      metrics: { totalTradingQuoteFee: new BN(31_000_000) },
      finishCurveTimestamp: new BN(0),
      activationPoint: new BN(1_790_000_000),
      ...overrides,
    },
  }) as unknown as VirtualPool;

describe('mapLaunchPool', () => {
  it('reads a curve in progress', () => {
    const state = mapLaunchPool(POOL, virtualPool(), config);
    expect(state).toMatchObject({
      dbcPool: POOL,
      config: CONFIG.toBase58(),
      baseMint: MINT.toBase58(),
      quoteMint: NATIVE_MINT.toBase58(),
      partner: PARTNER.toBase58(),
      creator: CREATOR.toBase58(),
      baseDecimals: 6,
      quoteDecimals: 9,
      baseReserve: 96_000,
      quoteReserveSol: 3.1,
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
      supply: { preMigration: 100_000, postMigration: 100_000 },
      activationType: 'timestamp',
      activationPoint: 1_790_000_000,
    });
    expect(state.curveProgressPct).toBeCloseTo(62, 6);
    expect(state.priceSol).toBeCloseTo(0.000846, 12);
    expect(state.startPriceSol).toBeCloseTo(0.000624, 12);
    expect(state.migrationPriceSol).toBeCloseTo(0.000988, 12);
    expect(state.fees.tradingFeeBps).toBeCloseTo(100, 9);
    expect(state.fees.partnerTotalSol).toBeCloseTo(0.031, 12);
    expect(state.fees.partnerUnclaimedSol).toBeCloseTo(0.011, 12);
    expect(state.fees.creatorTotalSol).toBe(0);
  });

  it('derives the DAMM v2 pool once migrated, as migrateToDammV2 does', () => {
    const migrated = virtualPool({
      isMigrated: 1,
      migrationProgress: 3,
      quoteReserve: new BN(5_000_000_000),
      finishCurveTimestamp: new BN(1_790_500_000),
    });
    const expected = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[2], MINT, NATIVE_MINT);
    const state = mapLaunchPool(POOL, migrated, config);
    expect(state.dammPool).toBe(expected.toBase58());
    expect(graduatedDammPool(migrated, config)?.equals(expected)).toBe(true);
    expect(state).toMatchObject({
      migrated: true,
      curveComplete: true,
      migrationProgress: 'createdPool',
      curveProgressPct: 100,
      finishCurveTime: 1_790_500_000,
    });
  });

  it('marks a full curve that has not migrated yet as complete, with no DAMM v2 pool', () => {
    const full = mapLaunchPool(POOL, virtualPool({ quoteReserve: new BN(5_000_000_001) }), config);
    expect(full).toMatchObject({ curveComplete: true, migrated: false, dammPool: null, curveProgressPct: 100 });
  });
});

describe('mapDammPool', () => {
  const dammAccount = (tokenAMint: PublicKey, tokenBMint: PublicKey, sqrtPrice: BN): DammPoolAccount =>
    ({
      tokenAMint,
      tokenBMint,
      tokenAVault: key(8),
      tokenBVault: key(9),
      sqrtPrice,
      liquidity: new BN('123456789'),
      poolStatus: 0,
      activationType: 1,
      activationPoint: new BN(0),
    }) as unknown as DammPoolAccount;

  it('orients a graduated pool as token (A) against SOL (B)', () => {
    const state = mapDammPool('damm', dammAccount(MINT, NATIVE_MINT, sqrt(0.00215)), {
      vaultA: 95_860_000_000n,
      vaultB: 1_500_000_000n,
      decimalsA: 6,
      decimalsB: 9,
    });
    expect(state).toMatchObject({
      pool: 'damm',
      baseMint: MINT.toBase58(),
      quoteMint: NATIVE_MINT.toBase58(),
      baseIsTokenA: true,
      baseReserve: 95_860,
      quoteReserveSol: 1.5,
      enabled: true,
      activationType: 'timestamp',
      liquidity: '123456789',
    });
    expect(state.priceSol).toBeCloseTo(0.00215, 12);
  });

  it('inverts the price when SOL is token A', () => {
    // Token A = SOL (9 decimals), B = the revenue token (6): price of A in B is tokens per SOL.
    const state = mapDammPool('damm', dammAccount(NATIVE_MINT, MINT, sqrt(1 / 0.00215, 9, 6)), {
      vaultA: 1_500_000_000n,
      vaultB: 95_860_000_000n,
      decimalsA: 9,
      decimalsB: 6,
    });
    expect(state.baseIsTokenA).toBe(false);
    expect(state.baseMint).toBe(MINT.toBase58());
    expect(state.priceSol).toBeCloseTo(0.00215, 12);
    expect(state.baseReserve).toBe(95_860);
    expect(state.quoteReserveSol).toBe(1.5);
  });
});
