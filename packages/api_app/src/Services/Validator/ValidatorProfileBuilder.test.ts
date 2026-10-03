import { base58Encode } from '@epoch/epoch-sdk';

import { epochAt, parseStakewizTime } from '../../Lib/EpochTimes';
import { type JsonRpcClient } from '../../Lib/Http';
import { U64_MAX } from '../../Lib/StakeLayouts';
import { type KobeEpochRewards } from '../../Sources/ExternalSources';
import { SolanaDataSource, type VoteStakeAccount } from '../../Sources/SolanaDataSource';
import { type ValidatorRow } from '../../types/Api.types';
import { type DelegatorLabel } from '../DelegatorLabels';
import fixture from './__fixtures__/ntt-docomo.recorded.json';
import {
  buildProfile,
  creditEstimate,
  delegationFigures,
  epochList,
  MAX_STAKE_MOVES,
  type ProfileInputs,
  revenueForEpoch,
  stakeByEpoch,
  unchangedEpochs,
} from './ValidatorProfileBuilder';

// @epoch/solana pulls in web3.js, whose ESM dependencies jest cannot load; epoch-sdk's base58 does the same job.
jest.mock('@epoch/solana', () => {
  const sdk = jest.requireActual('@epoch/epoch-sdk');
  return {
    bytesToAddress: (bytes: Uint8Array) => sdk.base58Encode(bytes),
    addressToBytes: (address: string) => Buffer.from(sdk.base58Decode(address)),
  };
});

const rpcReturning = (result: unknown) => ({ call: jest.fn().mockResolvedValue(result) }) as unknown as JsonRpcClient;
const toBase58 = (key: string) => base58Encode(Buffer.from(key, 'base64'));

/** Withdraw authorities (base64) of NTT DOCOMO's two largest delegators in the recording. */
const OWNER_4ZJH = 'NNmn7K4JcZpAw05t1Y+9+BGjl36+GwEgMzvadDgwJSs=';
const JITOSOL_POOL = 'VOWeJMBRqKFKex6Xl/DhLN+nSQIWZTGVpqUSpvFmYCs=';
const JITOSOL_LABEL: DelegatorLabel = {
  name: 'JitoSOL pool',
  kind: 'Liquid staking',
  entity: 'pool:J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  address: '6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS',
};

async function recordedInputs(): Promise<ProfileInputs> {
  const voteAccount = await new SolanaDataSource(rpcReturning(fixture.voteAccount)).getVoteAccountParsed(fixture.vote);
  const stakeAccounts = await new SolanaDataSource(rpcReturning(fixture.stakeAccounts)).getStakeAccountsForVoteWithKeys(
    fixture.vote,
  );
  const starts = fixture.stakewizEpochs.map((e) => ({ epoch: e.epoch, startMs: parseStakewizTime(e.start) }));
  const newest = Math.max(...fixture.stakewizCommissionHistory.map((c) => parseStakewizTime(c.observed_at)));
  return {
    row: fixture.row as ValidatorRow,
    epoch: fixture.epoch,
    slotsInEpoch: 432_000,
    voteFeesPerEpochSol: 2.16,
    feePerBlockSol: 0.0238,
    grossYieldPerEpoch: 0.000179,
    production: [104, 104],
    blocksPerEpoch: 206,
    version: '4.3.0',
    stakewiz: fixture.stakewizRow as ProfileInputs['stakewiz'],
    voteAccount,
    stakeAccounts,
    // The kit's fixture names 4ZJh…kbPY the Solana Foundation; here it stands in for FOUNDATION_AUTHORITIES.
    labels: new Map([[JITOSOL_POOL, JITOSOL_LABEL]]),
    foundationKeys: new Set([OWNER_4ZJH]),
    toBase58,
    voteRewards: new Map(
      Object.entries(fixture.voteRewards).map(([epoch, [reward]]) => [Number(epoch), reward.amount]),
    ),
    kobeHistory: fixture.kobeHistory as KobeEpochRewards[],
    stakewizStakes: fixture.stakewizTotalStakes,
    inflationChangeEpoch: epochAt(newest, starts, { epoch: 1047, startMs: Date.now(), msPerEpoch: 1 }),
    inflationLogRead: true,
    recordedStake: undefined,
    recordedCommission: undefined,
  };
}

describe('buildProfile (NTT DOCOMO GLOBAL, recorded in epoch 1047)', () => {
  it('reads vote credits for 63 finished epochs against the 6,912,000 maximum', async () => {
    const { profile } = buildProfile(await recordedInputs());
    expect(profile.voteCreditsByEpoch.max).toBe(6_912_000);
    expect(profile.voteCreditsByEpoch.rows).toHaveLength(63);
    expect(profile.voteCreditsByEpoch.rows.at(-1)).toEqual([1046, 6_900_039]);
    expect(profile.gauges).toEqual({ epochScore: 85, voteCreditsPct: 99.83, skippedBlocksPct: 0, uptime30dPct: 100 });
  });

  it("splits delegators by source and lists this and last epoch's stake moves", async () => {
    const { profile } = buildProfile(await recordedInputs());
    // The recording keeps 61 of 2,025 stake accounts (30 of 1,972 wallets), so the split is of that subset.
    expect(profile.delegatorSplit).toEqual([
      { source: 'Solana Foundation', pct: 60.2, sol: 82_913 },
      { source: 'Liquid-staking pools', pct: 23.4, sol: 32_165 },
      { source: '28 other wallets', pct: 16.4, sol: 22_616 },
    ]);
    expect(profile.tiles).toMatchObject({
      delegators: 30,
      biggestDelegatorSharePct: 60.2,
      stakeChangeThisEpochSol: 13.82,
    });
    expect(profile.ifBiggestDelegatorLeftSol).toBe(54_780);
    expect(profile.medianWalletSol).toBe(2.73);
    // Every account that moved in epochs 1046-1047 is in the recording: these match the live profile.
    expect(profile.thisEpoch).toEqual({ arrivingSol: 66.25, leavingSol: 52.44, netSol: 13.82 });
    expect(profile.stakeMoves).toHaveLength(31);
    expect(profile.stakeMoves[0]).toEqual({
      epoch: 1047,
      direction: 'in',
      sol: 61.75,
      from: 'Solana Foundation',
      wallet: '4ZJh…kbPY',
      stakeAccountShort: 'EbS8…aWNb',
      stakeAccount: 'EbS8QivMvwh8gMZ9fpckUKHD37Xp3Z4MP83CY4ZCaWNb',
      orb: 'https://orbmarkets.io/address/EbS8QivMvwh8gMZ9fpckUKHD37Xp3Z4MP83CY4ZCaWNb',
    });
    expect(profile.stakeMoves.find((m) => m.from === 'JitoSOL pool')).toMatchObject({ direction: 'out', sol: 11.7 });
    const epochs = profile.stakeMoves.map((m) => m.epoch);
    expect(epochs).toEqual([...epochs].sort((a, b) => b - a));
  });

  it('prices the last finished epoch from its inflation reward and Jito tips', async () => {
    const { profile, notes } = buildProfile(await recordedInputs());
    expect(profile.revenueEpoch).toBe(1046);
    expect(profile.revenueLastEpochSol).toEqual({
      inflationCommission: 1.7494,
      tipsCommission: 0.0877,
      blockFeesEstimate: 4.9028,
      voteFees: -2.16,
      netEstimate: 4.5799,
    });
    expect(profile.creditEstimate).toMatchObject({
      sweepablePerEpochSol: 1.8371,
      sweepableLast10EpochsSol: 18.6944,
      limitUnhedgedSol: 4.6736,
      limitHedgedSol: 7.4777,
    });
    expect(notes.some((n) => n.includes('estimated'))).toBe(false);
  });

  it('reproduces the kit fixture revenue for epoch 1043 (1.74 inflation + 0.15 tips commission)', () => {
    const revenue = revenueForEpoch({
      inflationCommissionSol: fixture.voteRewards['1043'][0].amount / 1e9,
      tips: fixture.kobeHistory.find((r) => r.epoch === 1043),
      blocksPerEpoch: 0,
      feePerBlockSol: 0,
      voteFeesPerEpochSol: 2.16,
    });
    expect(revenue.inflationCommission).toBeCloseTo(1.74, 2);
    expect(revenue.tipsCommission).toBeCloseTo(0.15, 2);
  });

  it('dates the commission and builds the series', async () => {
    const inputs = await recordedInputs();
    // Stakewiz saw 5% from 22 Feb (epoch 930); Kobe shows the MEV commission at 10% from epoch 1007.
    expect(inputs.inflationChangeEpoch).toBe(930);
    const { profile } = buildProfile(inputs);
    expect(profile.commission).toEqual({ inflationPct: 5, jitoTipsPct: 10, unchangedEpochs: 40 });
    expect(profile.stakeByEpoch).toHaveLength(30);
    expect(profile.stakeByEpoch[0]).toEqual([1018, 190_429]);
    expect(profile.stakeByEpoch.at(-1)).toEqual([1047, 196_542]);
    expect(profile.jitoTipsTotalByEpochSol).toHaveLength(45);
    expect(profile.jitoTipsTotalByEpochSol.at(-1)).toEqual([1046, 0.8773]);
    expect(profile.tags).toEqual([
      'Agave 4.3.0',
      'Frankfurt am Main, Germany',
      'UAB Cherry Servers',
      'Jito tips · 10% fee',
      'Foundation-backed',
      '171 epochs active',
    ]);
  });

  it('estimates epochs whose inflation reward has not been read yet, and says so', async () => {
    const inputs = await recordedInputs();
    const { profile, notes } = buildProfile({
      ...inputs,
      voteRewards: new Map([...inputs.voteRewards].filter(([epoch]) => epoch >= 1044)),
    });
    // Epochs 1037–1043: Stakewiz's stake that epoch × 0.000179 × 5% (≈ 1.69 SOL each against ≈ 1.72 read).
    expect(profile.creditEstimate.sweepableLast10EpochsSol).toBe(18.6524);
    expect(notes.find((n) => n.includes('estimated'))).toContain('epochs 1037–1043');
  });
});

const account = (pubkey: string, owner: number, sol: number, activation: bigint, deactivation = U64_MAX) =>
  ({
    pubkey,
    withdrawerKey: Buffer.alloc(32, owner).toString('base64'),
    stakeLamports: BigInt(Math.round(sol * 1e9)),
    activationEpoch: activation,
    deactivationEpoch: deactivation,
  }) as VoteStakeAccount;

describe('delegationFigures', () => {
  const figures = (accounts: VoteStakeAccount[], labels = new Map<string, DelegatorLabel>()) =>
    delegationFigures(accounts, 100, labels, new Set(), (key) => `wallet-${Buffer.from(key, 'base64')[0]}-xyz`);

  it('counts owners of active and activating stake, not leaving or genesis stake', () => {
    const f = figures([
      account('a1', 1, 10, 50n),
      account('a2', 1, 5, 100n),
      account('a3', 2, 20, 60n, 100n),
      account('a4', 3, 1_000, U64_MAX),
    ]);
    expect(f.delegators).toBe(1);
    expect(f.totalSol).toBe(15);
    expect(f.thisEpoch).toEqual({ arrivingSol: 5, leavingSol: 20, netSol: -15 });
    expect(f.foundationSharePct).toBeNull();
    expect(f.split).toEqual([{ source: '1 wallet', pct: 100, sol: 15 }]);
  });

  it('skips stake activated and deactivated in the same epoch and records both moves of a round trip', () => {
    const f = figures([account('same', 1, 7, 100n, 100n), account('trip', 2, 3, 99n, 100n)]);
    expect(f.moves.map((m) => [m.stakeAccount, m.epoch, m.direction])).toEqual([
      ['trip', 100, 'out'],
      ['trip', 99, 'in'],
    ]);
    expect(f.thisEpoch.leavingSol).toBe(3);
  });

  it('keeps the 50 newest, largest moves', () => {
    const many = Array.from({ length: 60 }, (_, i) => account(`m${i}`, i % 5, i + 1, i % 2 === 0 ? 100n : 99n));
    const f = figures(many);
    expect(f.moves).toHaveLength(MAX_STAKE_MOVES);
    expect(f.moves[0]).toMatchObject({ epoch: 100, sol: 59 });
    expect(f.moves.every((m, i) => i === 0 || m.epoch < f.moves[i - 1].epoch || m.sol <= f.moves[i - 1].sol)).toBe(
      true,
    );
  });

  it('names other labelled wallets one by one and groups every pool', () => {
    const labels = new Map<string, DelegatorLabel>([
      [
        Buffer.alloc(32, 1).toString('base64'),
        { name: 'Pool A', kind: 'Liquid staking', entity: 'pool:a', address: 'A' },
      ],
      [
        Buffer.alloc(32, 2).toString('base64'),
        { name: 'Pool B', kind: 'Liquid staking', entity: 'pool:b', address: 'B' },
      ],
      [Buffer.alloc(32, 3).toString('base64'), { name: 'Binance', kind: 'Exchange', entity: 'binance', address: 'C' }],
    ]);
    const f = figures(
      [account('p1', 1, 10, 50n), account('p2', 2, 30, 50n), account('x', 3, 20, 50n), account('w', 4, 40, 50n)],
      labels,
    );
    expect(f.split).toEqual([
      { source: 'Liquid-staking pools', pct: 40, sol: 40 },
      { source: 'Binance', pct: 20, sol: 20 },
      { source: '1 other wallet', pct: 40, sol: 40 },
    ]);
  });
});

describe('series and estimates', () => {
  it('overlays recorded stake on Stakewiz and ends with the live figure', () => {
    const { points, fromStakewiz, fromRecorder } = stakeByEpoch(
      { epoch: 10, sol: 105.4 },
      [
        { epoch: 6, stake: 0 },
        { epoch: 7, stake: 100 },
        { epoch: 8, stake: 101 },
        { epoch: 10, stake: 999 },
      ],
      [
        { epoch: 8, sol: 102 },
        { epoch: 9, sol: 103 },
      ],
    );
    expect(points).toEqual([
      [7, 100],
      [8, 102],
      [9, 103],
      [10, 105],
    ]);
    expect([fromStakewiz, fromRecorder]).toEqual([2, 1]);
  });

  it('applies the planned rates to the window', () => {
    const estimate = creditEstimate(
      [
        { epoch: 1, inflationSol: 1, tipsSol: 0.5 },
        { epoch: 2, inflationSol: 2, tipsSol: 0.5 },
      ],
      2,
    );
    expect(estimate).toMatchObject({
      sweepablePerEpochSol: 2.5,
      sweepableLast10EpochsSol: 4,
      limitUnhedgedSol: 1,
      limitHedgedSol: 1.6,
    });
  });

  it('counts epochs since the newer of the inflation and MEV commission changes', () => {
    const base = { epoch: 50, inflationLogRead: true, recordedCommission: undefined, mevSeries: null };
    const mev = [
      { epoch: 50, bps: 1_000 },
      { epoch: 49, bps: 1_000 },
      { epoch: 48, bps: 500 },
    ];
    expect(unchangedEpochs({ ...base, inflationChangeEpoch: 30, mevSeries: mev })).toBe(1);
    expect(unchangedEpochs({ ...base, inflationChangeEpoch: 30 })).toBe(20);
    // A change the recorder saw counts even when Stakewiz's newest entry is older.
    const recorded = [
      { epoch: 41, commissionPct: 7 },
      { epoch: 42, commissionPct: 5 },
      { epoch: 50, commissionPct: 5 },
    ];
    expect(unchangedEpochs({ ...base, inflationChangeEpoch: 30, recordedCommission: recorded })).toBe(8);
  });

  it('reads an empty Stakewiz log as no change seen, and the recorder alone as a lower bound', () => {
    const flat = [
      { epoch: 41, commissionPct: 8 },
      { epoch: 50, commissionPct: 8 },
    ];
    const emptyLog = { epoch: 50, inflationChangeEpoch: null, inflationLogRead: true, recordedCommission: flat };
    expect(unchangedEpochs({ ...emptyLog, mevSeries: null })).toBeNull();
    expect(unchangedEpochs({ ...emptyLog, mevSeries: [{ epoch: 20, bps: 0 }] })).toBe(30);
    expect(unchangedEpochs({ ...emptyLog, inflationLogRead: false, mevSeries: null })).toBe(9);
    expect(unchangedEpochs({ ...emptyLog, inflationLogRead: false, recordedCommission: [], mevSeries: [] })).toBeNull();
  });

  it('prints epoch ranges', () => {
    expect(epochList([1043, 1037, 1038, 1039, 1041])).toBe('1037–1039, 1041, 1043');
  });
});
