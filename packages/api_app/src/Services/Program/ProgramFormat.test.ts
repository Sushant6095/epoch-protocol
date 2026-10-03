import { type PoolParams } from '@epoch/epoch-sdk';
import { type Connection } from '@solana/web3.js';

import { PLANNED_POOL_PARAMS, paramRows } from './PoolParamsView';
import { bpsText, ceilDiv, plural, ratioPct, sharePrice, solText, toSol } from './ProgramFormat';
import {
  EPOCH_REWARDS_ACTIVE_OFFSET,
  EPOCH_REWARDS_SYSVAR,
  parseEpochRewardsActive,
  readEpochRewardsActive,
} from './ProgramSources';

describe('ProgramFormat', () => {
  it('converts lamports to SOL exactly, large and negative amounts included', () => {
    expect(toSol(122_400_000_000n)).toBe(122.4);
    expect(toSol(-117_187_500n)).toBe(-0.1171875);
    expect(toSol(1n)).toBe(1e-9);
    expect(toSol(123_456_789_123_456_789n)).toBe(123_456_789.12345679);
    expect(0.1 + 0.2).not.toBe(0.3); // why every amount stays in lamports until the end
    expect(toSol(100_000_000n + 200_000_000n)).toBe(0.3);
  });

  it('writes amounts and rates without float noise', () => {
    expect([solText(5_000_000_000_000n), solText(2_400_000_000n), solText(1n)]).toEqual([
      '5,000',
      '2.4',
      '0.000000001',
    ]);
    expect([bpsText(3), bpsText(200), bpsText(1_250), bpsText(7)]).toEqual(['0.03', '2', '12.5', '0.07']);
    expect(plural(1_284, 'other wallet')).toBe('1,284 other wallets');
    expect(plural(1, 'other wallet')).toBe('1 other wallet');
  });

  it('computes ratios, ceilings and share prices on bigint amounts', () => {
    expect(ratioPct(1n, 3n)).toBe(33.33);
    expect(ratioPct(5n, 0n)).toBe(0);
    expect(ceilDiv(7n, 2n)).toBe(4n);
    expect(ceilDiv(8n, 2n)).toBe(4n);
    expect(sharePrice(0n, 0n)).toBe(1); // par, the program's virtual offsets
    // (assets + 1) ÷ (shares + 1,000) × 1e9, floored: the program's price with its virtual offsets.
    expect(sharePrice(1_003_599_999n, 999_999_999_000n)).toBe(1.0036);
    expect(sharePrice(1_003_600_000n, 1_000_000_000_000n)).toBe(1.003599);
  });
});

describe('paramRows', () => {
  it('lists every PoolParams field with display strings from the values', () => {
    const rows = paramRows({ ...PLANNED_POOL_PARAMS });
    expect(rows.map((r) => [r.field, r.display])).toEqual([
      ['senior_rate_bps_per_epoch', '0.03% / epoch'],
      ['fee_bps', '2% flat'],
      ['remit_bps', '50% of sweep'],
      ['advance_bps_unhedged / _hedged', '25% · 40% hedged'],
      ['bond_multiplier', '4× bond'],
      ['protocol_fee_bps', '10% of income'],
      ['max_utilization_bps', '60%'],
      ['min_junior_bps', '20% of vault'],
      ['junior_lock_epochs', '10 epochs'],
      ['max_advance_epochs', '3 late epochs or 20 open'],
      ['min_score', '60 / 100'],
      ['score_ttl_epochs', '3 epochs'],
      ['min_advance_lamports', '1 SOL'],
      ['max_advance_lamports', '500 SOL'],
      ['max_pool_assets', '5,000 SOL'],
      ['vote_reserve_lamports', '1.6 SOL'],
      ['min_commission_bps', '0%'],
    ]);
    expect(rows.find((r) => r.field === 'min_advance_lamports')?.value).toBe(1_000_000_000);
  });

  it('says "off" and "uncapped" for the zero values that disable a rule', () => {
    const params: PoolParams = { ...PLANNED_POOL_PARAMS, bondMultiplier: 0, maxPoolAssets: 0n, minJuniorBps: 0 };
    const display = Object.fromEntries(paramRows(params).map((r) => [r.field, r.display]));
    expect(display).toMatchObject({ bond_multiplier: 'off', max_pool_assets: 'uncapped', min_junior_bps: 'off' });
  });
});

describe('EpochRewards sysvar', () => {
  const data = (active: boolean) => {
    const bytes = new Uint8Array(EPOCH_REWARDS_ACTIVE_OFFSET + 1);
    bytes[EPOCH_REWARDS_ACTIVE_OFFSET] = active ? 1 : 0;
    return bytes;
  };

  it('reads `active` at byte 80 of the 81-byte account', () => {
    expect(EPOCH_REWARDS_ACTIVE_OFFSET).toBe(80);
    expect(parseEpochRewardsActive(data(true))).toBe(true);
    expect(parseEpochRewardsActive(data(false))).toBe(false);
    expect(parseEpochRewardsActive(new Uint8Array(10))).toBeNull();
  });

  it('reads the sysvar through the program connection and answers null when it fails', async () => {
    const connection = (info: unknown) => ({
      withFailover: async <T>(fn: (c: Connection) => Promise<T>) =>
        fn({
          getAccountInfo: async (address: { toBase58(): string }) => {
            expect(address.toBase58()).toBe(EPOCH_REWARDS_SYSVAR.toBase58());
            if (info instanceof Error) throw info;
            return info;
          },
        } as unknown as Connection),
    });
    expect(await readEpochRewardsActive(connection({ data: Buffer.from(data(true)) }))).toBe(true);
    expect(await readEpochRewardsActive(connection(null))).toBeNull();
    expect(await readEpochRewardsActive(connection(new Error('429')))).toBeNull();
  });
});
