import { PublicKey } from '@solana/web3.js';

import vectors from './__fixtures__/vote-states.json';
import { creditsEarnedIn, parseVoteState } from './VoteState';

/**
 * `__fixtures__/vote-states.json` holds four vote accounts serialized by `solana-vote-interface` 7.1's own bincode
 * serializer (`VoteStateVersions`), padded to the 3,762-byte account size: a small Rust program built offline against
 * the repository's Cargo.lock. The states it serialized are restated below.
 */
const key = (n: number): string => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
const bytes = (name: keyof typeof vectors): Uint8Array => Uint8Array.from(Buffer.from(vectors[name], 'base64'));

/** The generator's epoch-credit history: `n` epochs from `start`, cumulative credits from 1,000. */
function credits(n: number, start: number): { epoch: bigint; credits: bigint; prevCredits: bigint }[] {
  const out = [];
  let total = 1_000n;
  for (let i = 0; i < n; i++) {
    const prev = total;
    total += 400_000n + BigInt(i) * 7n;
    out.push({ epoch: BigInt(start + i), credits: total, prevCredits: prev });
  }
  return out;
}

describe('parseVoteState', () => {
  it('reads a V1_14_11 account (lockouts without latency, prior voters)', () => {
    const state = parseVoteState(bytes('v1_14_11'));
    expect(state).toEqual({
      version: 'v1_14_11',
      nodePubkey: key(1),
      authorizedWithdrawer: key(2),
      inflationRewardsCollector: null,
      blockRevenueCollector: null,
      inflationRewardsCommissionBps: 700,
      blockRevenueCommissionBps: 10_000,
      pendingDelegatorRewards: 0n,
      rootSlot: 999n,
      epochCredits: credits(5, 796),
      lastTimestamp: { slot: 1_001n, timestamp: 1_700_000_000n },
    });
  });

  it('reads a V3 account with a full tower and 64 epochs of credits', () => {
    const state = parseVoteState(bytes('v3'));
    expect(state.version).toBe('v3');
    expect(state.nodePubkey).toBe(key(3));
    expect(state.authorizedWithdrawer).toBe(key(4));
    expect(state.inflationRewardsCommissionBps).toBe(1_000);
    expect(state.rootSlot).toBeNull();
    expect(state.epochCredits).toEqual(credits(64, 737));
    expect(state.lastTimestamp).toEqual({ slot: 5_030n, timestamp: 1_700_000_500n });
  });

  it('reads a V4 account: collectors, both commissions, pending delegator rewards, BLS key skipped', () => {
    const state = parseVoteState(bytes('v4'));
    expect(state).toEqual({
      version: 'v4',
      nodePubkey: key(5),
      authorizedWithdrawer: key(6),
      inflationRewardsCollector: key(7),
      blockRevenueCollector: key(8),
      inflationRewardsCommissionBps: 550,
      blockRevenueCommissionBps: 9_000,
      pendingDelegatorRewards: 123_456_789n,
      rootSlot: 8_999n,
      epochCredits: credits(40, 761),
      lastTimestamp: { slot: 9_002n, timestamp: 1_700_001_000n },
    });
  });

  it('reads a V4 account without a BLS key, votes or credits', () => {
    const state = parseVoteState(bytes('v4Empty'));
    expect(state.nodePubkey).toBe(key(12));
    expect(state.inflationRewardsCollector).toBe(key(14));
    expect(state.blockRevenueCommissionBps).toBe(10_000);
    expect(state.epochCredits).toEqual([]);
    expect(state.rootSlot).toBeNull();
  });

  it('rejects uninitialized, unknown, truncated and corrupt data', () => {
    expect(() => parseVoteState(new Uint8Array(3_762))).toThrow('unsupported vote state version 0');
    const unknown = bytes('v4');
    unknown[0] = 9;
    expect(() => parseVoteState(unknown)).toThrow('unsupported vote state version 9');
    expect(() => parseVoteState(bytes('v3').subarray(0, 200))).toThrow(/truncated|exceeds/);
    // V4 votes length (after the 48-byte BLS key) set to 2^40: must fail fast, not loop.
    const corrupt = bytes('v4');
    const votesLengthAt = 4 + 32 * 4 + 2 + 2 + 8 + 1 + 48;
    new DataView(corrupt.buffer).setBigUint64(votesLengthAt, 1n << 40n, true);
    expect(() => parseVoteState(corrupt)).toThrow('votes length');
  });
});

describe('creditsEarnedIn', () => {
  it('returns the credits earned in one epoch, 0 when absent', () => {
    const state = parseVoteState(bytes('v4'));
    expect(creditsEarnedIn(state, 761n)).toBe(400_000n);
    expect(creditsEarnedIn(state, 800n)).toBe(400_000n + 39n * 7n);
    expect(creditsEarnedIn(state, 900n)).toBe(0n);
  });
});
