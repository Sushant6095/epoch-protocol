import { vectors } from './__fixtures__/vectors';
import {
  ADVANCE_STATES,
  COMMISSION_KIND,
  POSITION_STATUSES,
  PROGRAM_CONSTANTS,
  RAW_SHARES_PER_UI_SHARE,
  rawSharesToUi,
  SEEDS,
  sharePriceE9ToSol,
  SIDES,
  TRANCHES,
  VOTE_PROGRAM_ID,
} from './constants';
import { assetsToShares, sharePriceE9, sharesToAssets } from './math';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

describe('constants mirror programs/epoch/src/constants.rs', () => {
  it('has the program seeds', () => {
    expect({ ...SEEDS }).toEqual(vectors.seeds);
  });

  it('has the program constants', () => {
    const c = vectors.constants;
    expect(PROGRAM_CONSTANTS.BPS_DENOMINATOR).toBe(c.BPS_DENOMINATOR);
    expect(PROGRAM_CONSTANTS.MAX_SCORE).toBe(c.MAX_SCORE);
    expect(PROGRAM_CONSTANTS.VIRTUAL_SHARES).toBe(BigInt(c.VIRTUAL_SHARES));
    expect(PROGRAM_CONSTANTS.VIRTUAL_ASSETS).toBe(BigInt(c.VIRTUAL_ASSETS));
    expect(PROGRAM_CONSTANTS.REVENUE_WINDOW).toBe(c.REVENUE_WINDOW);
    expect(PROGRAM_CONSTANTS.MIN_REVENUE_HISTORY).toBe(c.MIN_REVENUE_HISTORY);
    expect(PROGRAM_CONSTANTS.DEFAULT_AFTER_LATE_EPOCHS).toBe(c.DEFAULT_AFTER_LATE_EPOCHS);
    expect(PROGRAM_CONSTANTS.INDEX_HISTORY).toBe(c.INDEX_HISTORY);
    expect(VOTE_PROGRAM_ID.toBase58()).toBe(c.VOTE_PROGRAM_ID);
  });

  it('lists enum variants in Rust declaration order', () => {
    expect(TRANCHES).toEqual(['senior', 'junior']);
    expect(SIDES).toEqual(['payFixed', 'receiveFixed']);
    expect(POSITION_STATUSES).toEqual(['active', 'late', 'defaulted', 'released']);
    expect(ADVANCE_STATES).toEqual(['open', 'repaid', 'defaulted']);
    expect(COMMISSION_KIND).toEqual({ inflationRewards: 0, blockRevenue: 1 });
    expect(Object.isFrozen(TRANCHES)).toBe(true);
  });
});

describe('share units', () => {
  it('1 SOL first deposit = 1e12 raw shares = 1 UI share at par 1.0 SOL', () => {
    const shares = assetsToShares(1_000_000_000n, 0n, 0n);
    expect(shares).toBe(RAW_SHARES_PER_UI_SHARE);
    expect(rawSharesToUi(shares)).toBe(1);
    expect(sharePriceE9(0n, 0n)).toBe(1_000_000n);
    expect(sharePriceE9ToSol(sharePriceE9(0n, 0n))).toBe(1);
    expect(sharePriceE9ToSol(sharePriceE9(1_000_000_000n, shares))).toBeCloseTo(1, 9);
    expect(sharesToAssets(shares, 1_000_000_000n, shares)).toBe(1_000_000_000n);
    // One lamport of income lifts a 1-share holder's redemption by less than a lamport: rounding favours the pool.
    expect(sharesToAssets(RAW_SHARES_PER_UI_SHARE / 2n, 1_000_000_001n, shares)).toBe(500_000_000n);
  });

  it('converts exactly where the float can hold the answer', () => {
    expect(sharePriceE9ToSol(1_050_000n)).toBe(1.05);
    expect(sharePriceE9ToSol(0n)).toBe(0);
    expect(rawSharesToUi(2_500_000_000_000n)).toBe(2.5);
    expect(rawSharesToUi(1n)).toBe(1e-12);
    expect(sharePriceE9ToSol(18_446_744_073_709_551_615n)).toBeCloseTo(18_446_744_073_709.55, 2);
  });
});
