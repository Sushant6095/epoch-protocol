import { type HistoryEntry } from '@epoch/epoch-sdk';

import { fakeDeps, validatorRow } from '../../__fixtures__/ProgramFakes';
import { key, ProgramSim, sol } from '../../__fixtures__/ProgramSim';
import { entryView, OnChainHistoryService } from './OnChainHistoryService';
import { OperatorPositionService } from './OperatorPositionService';

const W = (label: string): string => key(label).toBase58();
const VOTE = W('vote');
const OPERATOR = W('operator');

async function world(epoch = 1100) {
  const sim = new ProgramSim(epoch);
  sim.marketMaker = key('maker');
  sim.initialize();
  sim.onboard(VOTE, OPERATOR, { bond: sol(5), score: 6_000 });
  const deps = async () =>
    fakeDeps(sim, await sim.store(), { rows: [validatorRow({ name: 'Kestrel Nodes', vote: VOTE })] });
  return {
    sim,
    history: async () => new OnChainHistoryService(await deps()).history(VOTE),
    position: async () => new OperatorPositionService(await deps()).position(VOTE),
  };
}

describe('entryView', () => {
  const unknown: HistoryEntry = {
    epoch: 1099n,
    epochCredits: null,
    maxCredits: null,
    voteLamports: null,
    revenueLamports: null,
    mevEarnedLamports: null,
    priorityFeesLamports: null,
    activatedStakeLamports: null,
    lastVotedSlot: null,
    updatedSlot: null,
    rank: null,
    inflationCommissionBps: null,
    blockCommissionBps: null,
    mevCommissionBps: null,
    priorityFeeCommissionBps: null,
    superminority: null,
    sources: 0,
  };

  it('keeps unknown fields null and names no source', () => {
    expect(entryView(unknown)).toEqual({
      epoch: 1099,
      credits: null,
      maxCredits: null,
      creditsOfMaxPct: null,
      inflationCommissionPct: null,
      blockCommissionPct: null,
      mevCommissionPct: null,
      priorityFeeCommissionPct: null,
      mevEarnedSol: null,
      priorityFeesSol: null,
      voteAccountSol: null,
      revenueSol: null,
      activatedStakeSol: null,
      stakeRank: null,
      superminority: null,
      lastVotedSlot: null,
      updatedSlot: null,
      sources: [],
    });
  });

  it('converts lamports to SOL, bps to percent, credits to a share of the maximum, and names the sources', () => {
    expect(
      entryView({
        ...unknown,
        epochCredits: 6_881_664n,
        maxCredits: 6_912_000n,
        mevEarnedLamports: sol(12.5),
        priorityFeesLamports: sol(0.25),
        activatedStakeLamports: sol(1_200_000),
        rank: 42,
        inflationCommissionBps: 500,
        blockCommissionBps: 10_000,
        mevCommissionBps: 800,
        priorityFeeCommissionBps: 5_000,
        superminority: false,
        lastVotedSlot: 475_000_000n,
        sources: 1 | 2 | 4 | 8 | 16,
      }),
    ).toMatchObject({
      credits: 6_881_664,
      maxCredits: 6_912_000,
      creditsOfMaxPct: 99.5611,
      inflationCommissionPct: 5,
      blockCommissionPct: 100,
      mevCommissionPct: 8,
      priorityFeeCommissionPct: 50,
      mevEarnedSol: 12.5,
      priorityFeesSol: 0.25,
      activatedStakeSol: 1_200_000,
      stakeRank: 42,
      superminority: false,
      lastVotedSlot: 475_000_000,
      sources: ['vote', 'credits', 'tip', 'priorityFee', 'stake'],
    });
  });
});

describe('OnChainHistoryService', () => {
  it('answers 404 before init_validator_history and 503 when the program is not configured', async () => {
    const { sim, history } = await world();
    await expect(history()).rejects.toMatchObject({ statusCode: 404 });
    sim.configured = false;
    await expect(history()).rejects.toMatchObject({ code: 'PROGRAM_NOT_CONFIGURED' });
  });

  it('follows freshness from empty to fresh to stale, and is refresh-ready only with stake info and scoring', async () => {
    const { sim, history } = await world();
    sim.initHistory(VOTE);
    expect(await history()).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      vote: VOTE,
      name: 'Kestrel Nodes',
      address: `history:${VOTE}`,
      createdEpoch: 1100,
      currentEpoch: 1100,
      freshness: {
        status: 'empty',
        lastVoteCopyEpoch: null,
        lastVoteCopySlot: null,
        slotsSinceVoteCopy: null,
        maxCopyAgeSlots: null,
        stakeInfoPosted: false,
        refreshReady: false,
      },
      lastRefresh: null,
      scoring: null,
      entries: [],
    });

    sim.copyVoteAccount(VOTE, { backfill: 10 });
    const copied = await history();
    expect(copied.freshness).toMatchObject({ status: 'fresh', lastVoteCopyEpoch: 1100, refreshReady: false });
    expect(copied.entries.map((e) => e.epoch)).toEqual([...Array(11).keys()].map((i) => 1090 + i));
    expect(copied.entries[0]).toMatchObject({ creditsOfMaxPct: 100, sources: ['credits'] });
    expect(copied.entries[10]).toMatchObject({ inflationCommissionPct: 5, sources: ['vote', 'credits'] });

    sim.configureScoring();
    sim.postStakeInfo(VOTE, 7, false);
    const ready = await history();
    expect(ready.freshness).toMatchObject({ stakeInfoPosted: true, maxCopyAgeSlots: 9_000, refreshReady: true });
    expect(ready.scoring).toEqual({
      creditsWindowEpochs: 10,
      creditsReferencePct: 99.5,
      countBlockCommission: false,
      maxCopyAgeSlots: 9_000,
      marketMaker: key('maker').toBase58(),
    });
    expect(ready.entries[10]).toMatchObject({ stakeRank: 7, superminority: false, activatedStakeSol: 250_000 });

    // The copy ages past max_copy_age_slots: still this epoch's copy, but refresh_score would refuse it.
    sim.slot += 9_001;
    expect((await history()).freshness).toMatchObject({ status: 'fresh', refreshReady: false });

    sim.nextEpoch();
    expect((await history()).freshness).toMatchObject({
      status: 'stale',
      lastVoteCopyEpoch: 1100,
      stakeInfoPosted: false,
      refreshReady: false,
    });
  });

  it('shows the last refresh_score breakdown from the history header', async () => {
    const { sim, history } = await world();
    sim.configureScoring();
    sim.initHistory(VOTE);
    sim.copyVoteAccount(VOTE);
    sim.postStakeInfo(VOTE, 3, true);
    const refreshedAt = sim.slot;
    sim.refreshScore(VOTE, {
      score: 5_000,
      creditsRatioBps: 10_025,
      creditsRatioRawBps: 9_975,
      commissionBps: 800,
      epochsActive: 30,
      superminority: true,
      hedged: true,
      hedgeRequiredNotional: sol(1.5),
    });
    expect((await history()).lastRefresh).toEqual({
      epoch: 1100,
      slot: refreshedAt,
      score: 50,
      creditsOfMaxPct: 99.75,
      creditsVsClusterPct: 100.25,
      commissionPct: 8,
      epochsActive: 30,
      delinquent: false,
      superminority: true,
      hedged: true,
      hedgeRequiredSol: 1.5,
    });
  });
});

describe('GET /v1/validators/:vote/position: scoreBreakdown', () => {
  it('is "scorer" without history, "history" after refresh_score and "scorer" again after a fallback', async () => {
    const { sim, position } = await world();
    expect((await position()).scoreBreakdown).toEqual({
      source: 'scorer',
      epoch: 1100,
      inputs: null,
      history: null,
    });

    sim.configureScoring();
    sim.initHistory(VOTE);
    sim.copyVoteAccount(VOTE);
    sim.postStakeInfo(VOTE, 12, false);
    sim.refreshScore(VOTE, {
      score: 8_700,
      creditsRatioBps: 9_990,
      creditsRatioRawBps: 9_940,
      commissionBps: 500,
      epochsActive: 11,
      hedgeRequiredNotional: sol(0.25),
    });
    const refreshed = await position();
    expect(refreshed.score).toBe(87);
    expect(refreshed.scoreBreakdown).toEqual({
      source: 'history',
      epoch: 1100,
      inputs: {
        score: 87,
        creditsOfMaxPct: 99.4,
        creditsVsClusterPct: 99.9,
        commissionPct: 5,
        epochsActive: 11,
        delinquent: false,
        superminority: false,
        hedged: false,
        hedgeRequiredSol: 0.25,
      },
      history: { address: `history:${VOTE}`, freshness: 'fresh', lastVoteCopyEpoch: 1100 },
    });

    // Next epoch, no copy yet: the scorer's update_score is the fallback and the breakdown says so.
    sim.nextEpoch();
    sim.setScore(VOTE, 8_000, false);
    expect((await position()).scoreBreakdown).toEqual({
      source: 'scorer',
      epoch: 1101,
      inputs: null,
      history: { address: `history:${VOTE}`, freshness: 'stale', lastVoteCopyEpoch: 1100 },
    });
  });

  it('is null for a validator that is not onboarded', async () => {
    const sim = new ProgramSim(1100);
    sim.initialize();
    const other = W('mainnet-only');
    const deps = fakeDeps(sim, await sim.store(), { rows: [validatorRow({ name: 'Mainnet', vote: other })] });
    expect((await new OperatorPositionService(deps).position(other)).scoreBreakdown).toBeNull();
  });
});
