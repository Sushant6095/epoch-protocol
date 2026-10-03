import { type JsonRpcClient } from '../../Lib/Http';
import { type StakeAccountInfo, U64_MAX } from '../../Lib/StakeLayouts';
import { type InflationReward, SolanaDataSource } from '../../Sources/SolanaDataSource';
import { type ValidatorRow } from '../../types/Api.types';
import fixture from './__fixtures__/wallet-c9md.recorded.json';
import {
  ALERTS,
  buildMyStake,
  initials,
  rewardAccounts,
  rewardsSummary,
  stakeStatus,
  suggestions,
  type WalletInputs,
} from './WalletStakeBuilder';

// @epoch/solana pulls in web3.js, whose ESM dependencies jest cannot load; epoch-sdk's base58 does the same job.
jest.mock('@epoch/solana', () => {
  const sdk = jest.requireActual('@epoch/epoch-sdk');
  return {
    bytesToAddress: (bytes: Uint8Array) => sdk.base58Encode(bytes),
    addressToBytes: (address: string) => Buffer.from(sdk.base58Decode(address)),
  };
});

const JUPITER = 'CatzoSMUkTRidT5DwBxAC2pEtnwMBTpkCepHkFgZDiqb';
const HELIUS = 'he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk';
const rows = fixture.rows as ValidatorRow[];

/** getStakeAccountsByAuthority over the recorded staker / withdrawer reads. */
async function recordedAccounts(): Promise<StakeAccountInfo[]> {
  const rpc = {
    call: jest.fn((_method: string, params: [string, { filters: { memcmp?: { offset: number } }[] }]) =>
      Promise.resolve(params[1].filters[1].memcmp?.offset === 12 ? fixture.byStaker : fixture.byWithdrawer),
    ),
  } as unknown as JsonRpcClient;
  return new SolanaDataSource(rpc).getStakeAccountsByAuthority(fixture.wallet);
}

const recordedRewards = (): Map<number, Map<string, number | null>> =>
  new Map(
    Object.entries(fixture.rewards).map(([epoch, rewards]) => [
      Number(epoch),
      new Map(
        fixture.byWithdrawer.map((a, i) => [a.pubkey, (rewards[i] as InflationReward | null)?.amount ?? null] as const),
      ),
    ]),
  );

async function recordedInputs(): Promise<WalletInputs> {
  return {
    wallet: fixture.wallet,
    epoch: fixture.epoch,
    epochsPerYear: 272.7,
    hoursPerEpoch: 32.1,
    balanceLamports: fixture.balance.value,
    accounts: await recordedAccounts(),
    rows,
    standing: () => 'current',
    stakewiz: new Map(),
    rewards: recordedRewards(),
    rewardEpochs: [1042, 1043, 1044, 1045, 1046],
    scanReady: false,
  };
}

describe('buildMyStake (a public wallet, recorded in epoch 1047)', () => {
  it('lists its five stake accounts with the validator, full key, health and APY', async () => {
    const { body } = buildMyStake(await recordedInputs());
    expect(body.wallet).toBe(fixture.wallet);
    expect(body.idleSol).toBe(0.002253);
    expect(body.stakeAccounts.map((a) => [a.validator, a.initials, a.sol])).toEqual([
      ['Jupiter', 'JU', 44.750786],
      ['Helius', 'HE', 31.971386],
      ['Helius', 'HE', 25.314964],
      ['Helius', 'HE', 22.731692],
      ['Helius', 'HE', 8.619687],
    ]);
    expect(body.stakeAccounts[0]).toEqual({
      validator: 'Jupiter',
      initials: 'JU',
      vote: JUPITER,
      stakeAccountShort: 'Kr9x…UX6U',
      stakeAccount: 'Kr9xcEYkJpTzBy6mTqqBtzfKtbY2wHnapH1isthUX6U',
      status: 'active',
      sinceEpoch: 839,
      sol: 44.750786,
      apyPct: 4.92,
      stakingApyPct: 4.76,
      tipsApyPct: 0.16,
      commissionPct: 5,
      health: 'healthy',
      healthReasons: [],
    });
    expect(body.blendedApyPct).toBe(5.11);
    expect(body.alerts).toEqual(ALERTS);
  });

  it('sums getInflationReward per epoch into per epoch, month, year and the five-epoch lifetime', async () => {
    const { body, notes } = buildMyStake(await recordedInputs());
    expect(body.rewardsByEpoch).toEqual([
      { epoch: 1042, sol: 0.023464573 },
      { epoch: 1043, sol: 0.023632027 },
      { epoch: 1044, sol: 0.023432408 },
      { epoch: 1045, sol: 0.023411627 },
      { epoch: 1046, sol: 0.023443413 },
    ]);
    expect(body).toMatchObject({ perEpochSol: 0.023443, monthSol: 0.526583, yearSol: 6.393019, lifetimeSol: 0.117384 });
    expect(notes[0]).toBe('rewards from getInflationReward for epochs 1042–1046; lifetimeSol sums those 5 epochs only');
  });

  it('suggests the three best healthy validators outside the top 18, leaving out its own', async () => {
    const { body, notes } = buildMyStake(await recordedInputs());
    // All at 5.2% APY and score 100: the smaller validators come first.
    expect(body.suggestions.map((s) => s.name)).toEqual(['Gate Earn', 'Solana Mobile Validator', 'DqbR…PDMK']);
    expect(body.suggestions[0]).toMatchObject({ vote: '2HQ5YHuw8cR1erRYZmemDmQVpfEMCjAvwU7V4fgdemJB', country: 'US' });
    expect(body.suggestions.some((s) => s.vote === HELIUS || s.vote === JUPITER)).toBe(false);
    expect(notes).toContain('suggestions skip the delegator checks until the stake-account scan finishes');
  });

  it('says which reward epochs could not be read and leaves the totals unknown without any', async () => {
    const inputs = await recordedInputs();
    const partial = new Map([...inputs.rewards].filter(([epoch]) => epoch !== 1043));
    expect(buildMyStake({ ...inputs, rewards: partial }).notes).toContain('rewards for epochs 1043 could not be read');
    const { body } = buildMyStake({ ...inputs, rewards: new Map() });
    expect(body).toMatchObject({ perEpochSol: null, monthSol: null, yearSol: null, lifetimeSol: null });
    expect(body.rewardsByEpoch).toEqual([]);
  });
});

const stakeAccount = (overrides: Partial<StakeAccountInfo>): StakeAccountInfo => ({
  pubkey: 'S1111111111111111111111111111111111111111111',
  lamports: 10_002_282_880n,
  state: 'delegated',
  rentExemptReserve: 2_282_880n,
  staker: 'W',
  withdrawer: 'W',
  lockupUnixTimestamp: 0n,
  lockupEpoch: 0n,
  custodian: 'C',
  voter: HELIUS,
  stakeLamports: 10_000_000_000n,
  activationEpoch: 900n,
  deactivationEpoch: U64_MAX,
  creditsObserved: 0n,
  ...overrides,
});

describe('stake account status and idle SOL', () => {
  it('tells activating, active, deactivating and inactive apart', () => {
    expect(stakeStatus(stakeAccount({ activationEpoch: 1047n }), 1047)).toBe('activating');
    expect(stakeStatus(stakeAccount({}), 1047)).toBe('active');
    expect(stakeStatus(stakeAccount({ activationEpoch: U64_MAX }), 1047)).toBe('active');
    expect(stakeStatus(stakeAccount({ deactivationEpoch: 1047n }), 1047)).toBe('deactivating');
    expect(stakeStatus(stakeAccount({ deactivationEpoch: 1040n }), 1047)).toBe('inactive');
    expect(stakeStatus(stakeAccount({ state: 'initialized', voter: null }), 1047)).toBeNull();
  });

  it('counts undelegated accounts as idle, lists inactive ones at their balance and keeps them out of the APY', async () => {
    const inputs = await recordedInputs();
    const { body, notes } = buildMyStake({
      ...inputs,
      accounts: [
        stakeAccount({ pubkey: 'Active1111111111111111111111111111111111111' }),
        stakeAccount({ pubkey: 'Cooled111111111111111111111111111111111111', deactivationEpoch: 1000n }),
        stakeAccount({ pubkey: 'Undeleg11111111111111111111111111111111111', state: 'initialized', voter: null }),
      ],
      balanceLamports: 1_000_000_000,
    });
    expect(body.idleSol).toBe(11.002283);
    expect(body.stakeAccounts.map((a) => [a.status, a.sol])).toEqual([
      ['inactive', 10.002283],
      ['active', 10],
    ]);
    expect(body.blendedApyPct).toBe(5.2);
    expect(notes).toContain('undelegated stake accounts count as idle SOL');
  });

  it('describes a validator that is not in the table', async () => {
    const inputs = await recordedInputs();
    const missing = 'Gone111111111111111111111111111111111111111';
    const accounts = [stakeAccount({ voter: missing })];
    const health = (standing: 'current' | 'delinquent' | 'missing') =>
      buildMyStake({ ...inputs, accounts, standing: () => standing }).body.stakeAccounts[0];
    expect(health('current')).toMatchObject({ health: 'watch', healthReasons: ['no active stake yet'], apyPct: null });
    expect(health('delinquent')).toMatchObject({ health: 'offline', healthReasons: ['not voting'] });
    expect(health('missing')).toMatchObject({ health: 'offline', healthReasons: ['vote account not found'] });
    expect(health('missing').validator).toBe('Gone…1111');
  });

  it('reads rewards for the largest delegated accounts only', () => {
    const accounts = [
      stakeAccount({ pubkey: 'small', stakeLamports: 1n }),
      stakeAccount({ pubkey: 'big', stakeLamports: 5n }),
      stakeAccount({ pubkey: 'none', state: 'initialized' }),
    ];
    expect(rewardAccounts(accounts)).toEqual(['big', 'small']);
  });
});

describe('rewards, suggestions and initials', () => {
  it('averages the month over epochs with earning stake only', () => {
    const byEpoch = new Map([
      [8, new Map([['a', null]])],
      [9, new Map([['a', 1e9]])],
    ]);
    const summary = rewardsSummary(byEpoch, 9, 100, 24, (epoch) => epoch === 9);
    expect(summary).toMatchObject({ perEpochSol: 1, monthSol: 30, yearSol: 100, lifetimeSol: 1 });
  });

  it('applies the delegator rules once the scan has finished', () => {
    const base = rows.find((r) => r.name === 'Gate Earn') as ValidatorRow;
    const candidates: ValidatorRow[] = [
      { ...base, vote: 'few', delegators: 99, biggestDelegatorSharePct: 10 },
      { ...base, vote: 'concentrated', delegators: 500, biggestDelegatorSharePct: 31 },
      { ...base, vote: 'fine', delegators: 500, biggestDelegatorSharePct: 30 },
      { ...base, vote: 'fee', commissionPct: 6, delegators: 500, biggestDelegatorSharePct: 1 },
      { ...base, vote: 'mev', mevCommissionPct: 11, delegators: 500, biggestDelegatorSharePct: 1 },
      { ...base, vote: 'flaky', uptimePct: 98.9, delegators: 500, biggestDelegatorSharePct: 1 },
    ];
    expect(suggestions(candidates, new Map(), 1047, new Set(), true).map((s) => s.vote)).toEqual(['fine']);
    expect(suggestions(candidates, new Map(), 1047, new Set(), false).map((s) => s.vote)).toEqual([
      'few',
      'concentrated',
      'fine',
    ]);
  });

  it('makes two-letter initials', () => {
    expect(initials('NTT DOCOMO GLOBAL')).toBe('ND');
    expect(initials('Project 0 Horizon')).toBe('P0');
    expect(initials('Helius')).toBe('HE');
    expect(initials('')).toBe('?');
  });
});
