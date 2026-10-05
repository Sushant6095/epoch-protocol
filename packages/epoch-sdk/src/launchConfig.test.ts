import { PublicKey } from '@solana/web3.js';

import { fromHex, vectors } from './__fixtures__/vectors';
import {
  checkLaunchConfig,
  DBC_POOL_CONFIG_LEN,
  DBC_VIRTUAL_POOL_DISCRIMINATOR,
  DBC_VIRTUAL_POOL_LEN,
  decodeDbcLaunchConfig,
  decodeDbcPoolHead,
} from './launchConfig';

// web3.js loads its websocket client at import time; the SDK never opens one.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

describe('checkLaunchConfig mirrors register_revenue_token', () => {
  const cases = (
    vectors as unknown as {
      launchConfigs: { label: string; treasury: string; data: string; result: Record<string, unknown> }[];
    }
  ).launchConfigs;

  it('covers passing configs and every refusal', () => {
    const errors = new Set(cases.map((c) => c.result.error).filter(Boolean));
    expect(errors).toEqual(
      new Set(['InvalidDbcConfig', 'NotTreasuryLeftoverReceiver', 'LiquidityNotLocked', 'UnsupportedVenueFee']),
    );
    expect(cases.filter((c) => c.result.error === undefined).length).toBeGreaterThan(4);
  });

  it.each(cases.map((c) => [c.label, c] as const))('%s: same result as the program', (_label, c) => {
    const config = decodeDbcLaunchConfig(fromHex(c.data));
    const got = checkLaunchConfig(config, new PublicKey(c.treasury));
    if (c.result.error) {
      expect(got.ok ? null : got.error).toBe(c.result.error);
    } else {
      expect(got).toEqual({ ok: true, feeFloorBps: c.result.feeFloorBps, maxImpactBound: c.result.maxImpactBound });
    }
  });

  it('reads a DBC pool head at the program offsets', () => {
    const data = new Uint8Array(DBC_VIRTUAL_POOL_LEN);
    data.set(DBC_VIRTUAL_POOL_DISCRIMINATOR, 0);
    for (const [at, fill] of [
      [72, 1],
      [104, 2],
      [136, 3],
      [168, 4],
      [200, 5],
    ] as const)
      data.fill(fill, at, at + 32);
    data[304] = 0;
    data[308] = 3;
    const head = decodeDbcPoolHead(data);
    expect(
      [head.config, head.creator, head.baseMint, head.baseVault, head.quoteVault].map((k) => k.toBytes()[0]),
    ).toEqual([1, 2, 3, 4, 5]);
    expect([head.poolType, head.migrationProgress]).toEqual([0, 3]);
    expect(() => decodeDbcPoolHead(data.subarray(0, 400))).toThrow(/VirtualPool/);
  });

  it('refuses other accounts', () => {
    expect(() => decodeDbcLaunchConfig(new Uint8Array(DBC_POOL_CONFIG_LEN))).toThrow(/PoolConfig/);
    expect(() => decodeDbcLaunchConfig(fromHex(cases[0].data).subarray(0, 1_000))).toThrow(/PoolConfig/);
  });

  it('explains a refusal', () => {
    const config = decodeDbcLaunchConfig(fromHex(cases[0].data));
    const other = new PublicKey(new Uint8Array(32).fill(9));
    const got = checkLaunchConfig(
      { ...config, liquidity: { ...config.liquidity, partnerPermanentLocked: 50, creatorUnlocked: 50 } },
      new PublicKey(cases[0].treasury),
    );
    expect(got).toEqual({ ok: false, error: 'LiquidityNotLocked', reason: 'only 50% is locked forever' });
    expect(checkLaunchConfig(config, other)).toMatchObject({ ok: false, error: 'InvalidDbcConfig' });
  });
});
