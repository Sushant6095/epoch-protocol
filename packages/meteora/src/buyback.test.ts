import { type PoolState as DammPoolAccount } from '@meteora-ag/cp-amm-sdk';
import { type PoolConfig, SwapMode, type VirtualPool } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

import {
  buybackGraduation,
  type BuybackVenueAccounts,
  buybackMinimumOut,
  buybackVenueState,
  quoteBuyback,
} from './buyback';
import { NATIVE_MINT } from './constants';
import { revenueCurveConfig } from './curve';
import { cpAmmClient, dbcClient } from './pools';

// No request is ever sent: the connection only backs the SDK clients, whose quote functions are stubbed below.
const connection = new Connection('http://127.0.0.1:1');
const address = new PublicKey(new Uint8Array(32).fill(7));
const curve = revenueCurveConfig({ bandLowSol: 0.00002, bandHighSol: 0.00004, supply: 1_000_000, decimals: 6 });

const dbcAccounts = (overrides: Partial<VirtualPool['poolState']> = {}): BuybackVenueAccounts => ({
  kind: 'dbc',
  address,
  pool: {
    poolState: {
      sqrtPrice: curve.config.sqrtStartPrice,
      quoteReserve: new BN(0),
      isMigrated: 0,
      baseMint: address,
      ...overrides,
    },
  } as unknown as VirtualPool,
  // On chain the config also holds the migration price (the curve's last point); the parameters do not.
  config: {
    ...curve.config,
    activationType: 1,
    migrationSqrtPrice: curve.sqrtPrices[curve.sqrtPrices.length - 1],
  } as unknown as PoolConfig,
});

const dammPool = {
  sqrtPrice: new BN('18446744073709551616'),
  liquidity: new BN(1_000_000_000).shln(65),
  sqrtMaxPrice: new BN('79226673521066979257578248091'),
  collectFeeMode: 1,
  tokenAAmount: new BN(5),
  tokenBAmount: new BN(6),
  poolStatus: 0,
  activationType: 1,
  tokenAMint: address,
} as unknown as DammPoolAccount;

describe('buybackMinimumOut', () => {
  it('takes the slippage off and rounds down', () => {
    expect(buybackMinimumOut(1_000n, 100)).toBe(990n);
    expect(buybackMinimumOut(999n, 100)).toBe(989n); // 989.01
    expect(buybackMinimumOut(5n, 0)).toBe(5n);
  });

  it('rejects slippage outside 0–9,999 bps', () => {
    expect(() => buybackMinimumOut(1n, 10_000)).toThrow(RangeError);
    expect(() => buybackMinimumOut(1n, -1)).toThrow(RangeError);
    expect(() => buybackMinimumOut(1n, 1.5)).toThrow(RangeError);
  });
});

describe('buybackVenueState', () => {
  it('maps a DBC pool and config to the raw fields execute_buyback reads, the curve up to its first empty point', () => {
    const state = buybackVenueState(dbcAccounts({ quoteReserve: new BN(123), isMigrated: 1 }));
    if (state.kind !== 'dbc') throw new Error('expected dbc');
    expect(state.sqrtPrice).toBe(BigInt(curve.config.sqrtStartPrice.toString()));
    expect(state.quoteReserve).toBe(123n);
    expect(state.isMigrated).toBe(true);
    expect(state.migrationQuoteThreshold).toBe(BigInt(curve.config.migrationQuoteThreshold.toString()));
    expect(state.migrationSqrtPrice).toBe(BigInt(curve.sqrtPrices[curve.sqrtPrices.length - 1].toString()));
    // Two sqrt-price points = one segment (on chain the curve is padded to 20 points with empty ones).
    expect(state.curve).toHaveLength(1);
    expect(state.curve[0].sqrtPrice).toBe(state.migrationSqrtPrice);
    expect(state.curve[0].liquidity > 0n).toBe(true);
  });

  it('stops the curve at its first empty point, like the program', () => {
    const padded = dbcAccounts();
    if (padded.kind !== 'dbc') throw new Error('expected dbc');
    const empty = { sqrtPrice: new BN(0), liquidity: new BN(0) };
    const point = padded.config.curve[0];
    const config = { ...padded.config, curve: [point, empty, point] } as unknown as PoolConfig;
    const state = buybackVenueState({ ...padded, config });
    expect(state.kind === 'dbc' && state.curve).toHaveLength(1);
  });

  it('maps a DAMM v2 pool', () => {
    expect(buybackVenueState({ kind: 'dammV2', address, pool: dammPool })).toEqual({
      kind: 'dammV2',
      sqrtPrice: 1n << 64n,
      liquidity: 1_000_000_000n << 65n,
      sqrtMaxPrice: 79226673521066979257578248091n,
      collectFeeMode: 1,
      tokenAAmount: 5n,
      tokenBAmount: 6n,
      poolStatus: 0,
    });
  });
});

describe('buybackGraduation', () => {
  it('is null on the curve and names the DAMM v2 config and pool once migrated', () => {
    const onCurve = dbcAccounts();
    if (onCurve.kind !== 'dbc') throw new Error('expected dbc');
    expect(buybackGraduation(onCurve)).toBeNull();
    const migrated = dbcAccounts({ isMigrated: 1 });
    if (migrated.kind !== 'dbc') throw new Error('expected dbc');
    const config = { ...migrated.config, migrationFeeOption: 2, quoteMint: NATIVE_MINT } as unknown as PoolConfig;
    const graduation = buybackGraduation({ ...migrated, config });
    expect(graduation?.dammConfig.toBase58()).toBe('Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp');
    // ["pool", config, max(mint, wsol), min(mint, wsol)] under DAMM v2.
    const [hi, lo] =
      Buffer.compare(address.toBuffer(), NATIVE_MINT.toBuffer()) > 0 ? [address, NATIVE_MINT] : [NATIVE_MINT, address];
    const [expected] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), graduation!.dammConfig.toBuffer(), hi.toBuffer(), lo.toBuffer()],
      new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'),
    );
    expect(graduation?.dammPool.toBase58()).toBe(expected.toBase58());
  });
});

describe('quoteBuyback', () => {
  afterEach(() => jest.restoreAllMocks());

  it('quotes DBC in partial-fill mode, SOL in, and applies the slippage itself', async () => {
    const swapQuote2 = jest.spyOn(dbcClient(connection).pool, 'swapQuote2').mockReturnValue({
      includedFeeInputAmount: new BN(1_000_000),
      excludedFeeInputAmount: new BN(990_000),
      outputAmount: new BN(40_000_000),
      minimumAmountOut: new BN(1),
      tradingFee: new BN(9_000),
      protocolFee: new BN(1_000),
      referralFee: new BN(0),
    } as unknown as ReturnType<typeof swapQuote2>);
    const quote = await quoteBuyback({
      connection,
      accounts: dbcAccounts(),
      lamportsIn: 1_000_000n,
      slippageBps: 100,
      tokenDecimals: 6,
      currentPoint: new BN(1),
    });
    expect(quote).toEqual({
      kind: 'dbc',
      lamportsIn: 1_000_000n,
      amountOut: 40_000_000n,
      minimumOut: 39_600_000n,
      fee: 10_000n,
    });
    const args = swapQuote2.mock.calls[0][0];
    expect(args).toMatchObject({ swapBaseForQuote: false, hasReferral: false, swapMode: SwapMode.PartialFill });
    expect('amountIn' in args && args.amountIn.toString()).toBe('1000000');
  });

  it('quotes DAMM v2 exact-in with wrapped SOL as the input', async () => {
    const getQuote2 = jest.spyOn(cpAmmClient(connection), 'getQuote2').mockReturnValue({
      includedFeeInputAmount: new BN(2_000_000),
      excludedFeeInputAmount: new BN(1_980_000),
      outputAmount: new BN(77_000),
      claimingFee: new BN(15_000),
      compoundingFee: new BN(0),
      protocolFee: new BN(5_000),
      referralFee: new BN(0),
    } as unknown as ReturnType<typeof getQuote2>);
    const quote = await quoteBuyback({
      connection,
      accounts: { kind: 'dammV2', address, pool: dammPool },
      lamportsIn: 2_000_000n,
      slippageBps: 50,
      tokenDecimals: 6,
      currentPoint: new BN(1),
    });
    expect(quote).toEqual({
      kind: 'dammV2',
      lamportsIn: 2_000_000n,
      amountOut: 77_000n,
      minimumOut: 76_615n,
      fee: 20_000n,
    });
    const args = getQuote2.mock.calls[0][0];
    expect(args.inputTokenMint.toBase58()).toBe('So11111111111111111111111111111111111111112');
    expect(args).toMatchObject({ tokenADecimal: 6, tokenBDecimal: 9, hasReferral: false });
  });

  it('refuses a zero amount', async () => {
    await expect(
      quoteBuyback({ connection, accounts: dbcAccounts(), lamportsIn: 0n, slippageBps: 100, tokenDecimals: 6 }),
    ).rejects.toThrow(RangeError);
  });
});
