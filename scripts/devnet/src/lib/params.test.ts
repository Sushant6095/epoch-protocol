import fs from 'node:fs';

import { KitError } from './errors';
import { DEFAULT_PARAMS_FILE, diffParams, loadParams, parseParams } from './params';

const raw = (): Record<string, unknown> => JSON.parse(fs.readFileSync(DEFAULT_PARAMS_FILE, 'utf8'));

describe('params', () => {
  it('loads the devnet file: senior 3 bps per epoch (request #17), planned junior lock, small vote reserve', () => {
    const p = loadParams();
    expect(p.seniorRateBpsPerEpoch).toBe(3);
    expect(p.juniorLockEpochs).toBe(10);
    expect(p.voteReserveLamports).toBe(100_000_000n);
    expect(p.minAdvanceLamports).toBe(1_000_000_000n);
  });

  it('rejects unknown fields, wrong types and out-of-range values', () => {
    expect(() => parseParams({ ...raw(), extra: 1 })).toThrow(/unknown params: extra/);
    expect(() => parseParams({ ...raw(), feeBps: '200' })).toThrow(/params.feeBps/);
    expect(() => parseParams({ ...raw(), maxPoolAssets: 5 })).toThrow(/decimal string/);
    expect(() => parseParams({ ...raw(), maxPoolAssets: '18446744073709551616' })).toThrow(KitError);
    expect(() => parseParams([])).toThrow(/object/);
    expect(() => parseParams({ ...raw(), bondMultiplier: 256 })).toThrow(/0–255/);
    expect(() => parseParams({ ...raw(), juniorLockEpochs: 65_536 })).toThrow(/0–65535/);
  });

  it("mirrors the program's PoolParams::validate", () => {
    expect(() => parseParams({ ...raw(), protocolFeeBps: 10_001 })).toThrow(/10,000/);
    expect(() => parseParams({ ...raw(), remitBps: 0 })).toThrow(/remitBps/);
    expect(() => parseParams({ ...raw(), maxUtilizationBps: 0 })).toThrow(/maxUtilizationBps/);
    expect(() => parseParams({ ...raw(), advanceBpsHedged: 2000 })).toThrow(/advanceBpsHedged/);
    expect(() => parseParams({ ...raw(), maxAdvanceLamports: '1' })).toThrow(/maxAdvanceLamports/);
    expect(() => parseParams({ ...raw(), maxAdvanceEpochs: 0 })).toThrow(/maxAdvanceEpochs/);
  });

  it('diffs field by field across number and bigint fields', () => {
    const a = loadParams();
    expect(diffParams(a, a)).toEqual([]);
    const b = { ...a, juniorLockEpochs: 2, voteReserveLamports: 1_600_000_000n };
    expect(diffParams(a, b)).toEqual([
      { field: 'juniorLockEpochs', onChain: '10', wanted: '2' },
      { field: 'voteReserveLamports', onChain: '100000000', wanted: '1600000000' },
    ]);
  });
});
