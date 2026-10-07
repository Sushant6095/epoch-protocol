import { SnapshotCache } from '../../Lib/SnapshotCache';
import { type VoteAccount } from '../../Sources/SolanaDataSource';
import { type MarketData } from '../MarketData';
import { ValidatorTable } from '../ValidatorTable';
import { chainMev, type MevEpochRecord, MevHistoryLoader, type MevHistoryStore, mevHistoryRows } from './MevHistory';

// Figures from mainnet (7 Oct 2026): 3N7s9z… at 0 bps (epoch 1050 root: 164.41 SOL of tips; epoch 1051 in progress:
// 32.92 SOL so far), and the 700-bps validator of epoch 1050 whose node was claimed for exactly ⌊tips × 7 %⌋.
const V0 = '3N7s9zXMZ4QqvHQR15t5GNHyqc89KduzMP7423eWiD5g';
const V700 = 'CcaHc2L43ZWjwCHART3oZoJvHLAe9hzT2DJNUpBzoTN1';
const V_KOBE = 'KobeOnLy11111111111111111111111111111111111';

const record = (epoch: number, patch: Partial<MevEpochRecord> = {}): MevEpochRecord => ({
  epoch,
  commissionBps: 0,
  tipsLamports: 164_413_744_343n,
  rootUploaded: true,
  validatorShareLamports: 0n,
  validatorShareEstimated: false,
  claim: 'none',
  claimedSlot: null,
  pfCommissionBps: null,
  pfTransferredLamports: null,
  pfClaim: null,
  ...patch,
});

const v0Records = [record(1050), record(1051, { rootUploaded: false, tipsLamports: 32_920_331_764n })];
const v700Records = [
  record(1050, {
    commissionBps: 700,
    tipsLamports: 106_700_426_062n,
    validatorShareLamports: 7_469_029_824n,
    claim: 'claimed',
    claimedSlot: 454_050_628,
  }),
];

describe('chainMev', () => {
  it("takes the newest TDA's commission (this or last epoch) and the last finished epoch's tips with a root", () => {
    expect(chainMev(v0Records, 1051)).toEqual({ commissionBps: 0, tipsSol: 164.414, tipsEpoch: 1050 });
    expect(chainMev(v700Records, 1051)).toEqual({ commissionBps: 700, tipsSol: 106.7, tipsEpoch: 1050 });
    // A TDA older than last epoch says nothing about today's commission; its tips still count.
    expect(chainMev(v700Records, 1053)).toEqual({ commissionBps: null, tipsSol: 106.7, tipsEpoch: 1050 });
    // Before the root: no finished tips yet.
    expect(chainMev([record(1051, { rootUploaded: false })], 1051)).toEqual({
      commissionBps: 0,
      tipsSol: null,
      tipsEpoch: null,
    });
    expect(chainMev(undefined, 1051)).toEqual({ commissionBps: null, tipsSol: null, tipsEpoch: null });
  });
});

describe('mevHistoryRows', () => {
  it('lists chain epochs with claims and Kobe for older epochs, oldest first, each with its source', () => {
    const rows = mevHistoryRows(v700Records, [
      { epoch: 1049, mev_commission_bps: 700, mev_rewards: 100_000_000_000 },
      { epoch: 1050, mev_commission_bps: 800, mev_rewards: 1 },
    ]);
    expect(rows).toEqual([
      {
        epoch: 1049,
        source: 'kobe',
        commissionBps: 700,
        tipsSol: 100,
        final: true,
        validatorShareSol: 7,
        estimated: true,
        claimStatus: null,
        claimedSlot: null,
        pfCommissionBps: null,
        pfTransferredSol: null,
        pfClaimStatus: null,
      },
      {
        epoch: 1050,
        source: 'chain',
        commissionBps: 700,
        tipsSol: 106.7004,
        final: true,
        validatorShareSol: 7.469,
        estimated: false,
        claimStatus: 'claimed',
        claimedSlot: 454_050_628,
        pfCommissionBps: null,
        pfTransferredSol: null,
        pfClaimStatus: null,
      },
    ]);
    // The epoch in progress: tips so far, not final; a 0 % validator's node is `none`, never a missed claim.
    expect(mevHistoryRows(v0Records, null).map((r) => [r.epoch, r.tipsSol, r.final, r.claimStatus])).toEqual([
      [1050, 164.4137, true, 'none'],
      [1051, 32.9203, false, 'none'],
    ]);
  });
});

describe('MevHistoryLoader', () => {
  it('loads the last epochs by vote and bumps its version only when the rows change', async () => {
    let rows = [
      ...v0Records.map((r) => ({ ...r, vote: V0, scannedAt: new Date(1_000) })),
      ...v700Records.map((r) => ({ ...r, vote: V700, scannedAt: new Date(2_000) })),
    ];
    const load = jest.fn<ReturnType<MevHistoryStore['load']>, [number]>(async () => rows);
    const loader = new MevHistoryLoader({ load }, async () => 1051);
    const first = await loader.refresh();
    expect(load).toHaveBeenCalledWith(1032);
    expect(first?.version).toBe(1);
    expect(first?.newestEpoch).toBe(1051);
    expect(first?.byVote.get(V0)?.map((r) => r.epoch)).toEqual([1050, 1051]);
    expect((await loader.refresh())?.version).toBe(1);
    rows = rows.map((r) => ({ ...r, scannedAt: new Date(3_000) }));
    expect((await loader.refresh())?.version).toBe(2);
    expect(await new MevHistoryLoader(undefined, async () => 1051).refresh()).toBeUndefined();
  });
});

describe('ValidatorTable with the MEV scan (request #5b)', () => {
  const cache = <T>(name: string, value: T) => new SnapshotCache(name, 60_000, async () => value);
  const account = (votePubkey: string, stakeSol: number): VoteAccount => ({
    votePubkey,
    nodePubkey: `${votePubkey.slice(0, 8)}-node`,
    activatedStake: stakeSol * 1e9,
    commission: 5,
    inflationRewardsCommissionBps: 500,
    epochVoteAccount: true,
    epochCredits: [[1050, 9_000_000, 2_000_000]],
    lastVote: 0,
  });
  const market = {
    epochInfo: cache('epochInfo', {
      epoch: 1051,
      slotIndex: 200_000,
      slotsInEpoch: 432_000,
      absoluteSlot: 454_232_000,
    }),
    voteAccounts: cache('voteAccounts', {
      current: [account(V0, 900_000), account(V700, 500_000), account(V_KOBE, 100_000), account('NoJito', 50_000)],
      delinquent: [],
    }),
    secondsPerSlot: async () => 0.4,
    inflation: cache('inflation', { validator: 0.04 }),
    supplySol: cache('supplySol', 600_000_000),
    clusterNodes: cache('clusterNodes', []),
    blockProduction: cache('blockProduction', { byIdentity: {}, range: { firstSlot: 0, lastSlot: 0 } }),
    feePerBlockSol: cache('feePerBlockSol', 0.01),
    stakewiz: cache('stakewiz', new Map()),
    kobe: cache(
      'kobe',
      new Map([
        [V0, { vote_account: V0, mev_commission_bps: 800, running_jito: true }],
        [V_KOBE, { vote_account: V_KOBE, mev_commission_bps: 500, running_jito: true }],
      ]),
    ),
  } as unknown as MarketData;

  it('puts the chain first, then Kobe, and says which; adds last epoch tips; rebuilds when the scan changes', async () => {
    let snapshot = { version: 1, byVote: new Map([[V0, v0Records]]), newestEpoch: 1051 };
    const table = new ValidatorTable(
      market,
      () => undefined,
      () => undefined,
      () => snapshot,
    );
    const byVote = async () => new Map((await table.get()).rows.map((r) => [r.vote, r]));
    let rows = await byVote();
    expect(rows.get(V0)).toMatchObject({
      mevCommissionPct: 0,
      mevSource: 'chain',
      mevTipsSol: 164.414,
      mevTipsEpoch: 1050,
    });
    expect(rows.get(V_KOBE)).toMatchObject({ mevCommissionPct: 5, mevSource: 'kobe', mevTipsSol: null });
    expect(rows.get('NoJito')).toMatchObject({ mevCommissionPct: null, mevSource: null, mevTipsSol: null });
    expect(rows.get(V700)).toMatchObject({ mevCommissionPct: null, mevSource: null });
    expect((await table.get()).sources).toContain('Jito tip distribution accounts (mainnet)');

    snapshot = { version: 2, byVote: new Map([...snapshot.byVote, [V700, v700Records]]), newestEpoch: 1051 };
    rows = await byVote();
    expect(rows.get(V700)).toMatchObject({ mevCommissionPct: 7, mevSource: 'chain', mevTipsSol: 106.7 });
  });

  it("carries request #5b's other row fields: delinquent, foundationSharePct, commission and stake history", async () => {
    const delinquentMarket = {
      ...market,
      voteAccounts: cache('voteAccounts', { current: [account(V0, 900_000)], delinquent: [account(V700, 500_000)] }),
    } as unknown as MarketData;
    const history = {
      version: 1,
      epoch: 1051,
      commission: new Map([[V0, [{ epoch: 1050, commissionPct: 5 }]]]),
      stake: new Map([
        [
          V0,
          [
            { epoch: 1050, sol: 899_000 },
            { epoch: 1051, sol: 900_000 },
          ],
        ],
      ]),
    };
    const table = new ValidatorTable(
      delinquentMarket,
      () => undefined,
      () => history,
    );
    const rows = new Map((await table.get()).rows.map((r) => [r.vote, r]));
    expect(rows.get(V0)).toMatchObject({
      delinquent: false,
      foundationSharePct: null, // before the delegator scan
      commissionHistory: [{ epoch: 1050, commissionPct: 5 }],
      stakeHistorySol: [899_000, 900_000],
    });
    expect(rows.get(V700)).toMatchObject({ delinquent: true, health: 'offline' });
    expect(rows.get(V700)).not.toHaveProperty('commissionHistory');
  });
});
