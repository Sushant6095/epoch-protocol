import {
  HISTORY_SCORE_FLAGS,
  HISTORY_SOURCES,
  type HistoryEntry,
  type ScoreConfigAccount,
  type ValidatorHistoryAccount,
  type ValidatorPositionAccount,
} from '@epoch/epoch-sdk';
import { NotFoundException } from '@epoch/exceptions';

import { isoIst } from '../../Lib/Stats';
import { type ProgramAccount } from '../../Sources/EpochProgramSource';
import {
  type HistoryFreshness,
  type HistorySource,
  type OnChainHistory,
  type OnChainHistoryEntry,
  type OnChainHistorySnapshot,
  type OperatorScoreBreakdown,
  type ScoreBreakdown,
} from '../../types/Program.types';
import { toSol } from './ProgramFormat';
import { type ProgramServiceDeps } from './ProgramSources';
import { loadValidatorNames } from './ValidatorNames';

const SOURCE_NAMES: [number, HistorySource][] = [
  [HISTORY_SOURCES.vote, 'vote'],
  [HISTORY_SOURCES.credits, 'credits'],
  [HISTORY_SOURCES.tip, 'tip'],
  [HISTORY_SOURCES.priorityFee, 'priorityFee'],
  [HISTORY_SOURCES.stake, 'stake'],
];

const pct = (bps: number | null): number | null => (bps === null ? null : bps / 100);
const solOrNull = (lamports: bigint | null): number | null => (lamports === null ? null : toSol(lamports));
const numOrNull = (value: bigint | null): number | null => (value === null ? null : Number(value));
const has = (entry: HistoryEntry | undefined, source: number): boolean => !!entry && (entry.sources & source) !== 0;
const entryAt = (history: ValidatorHistoryAccount, epoch: number): HistoryEntry | undefined =>
  history.entries.find((e) => e.epoch === BigInt(epoch));

/** One decoded entry in the API's units. */
export function entryView(entry: HistoryEntry): OnChainHistoryEntry {
  const { epochCredits: credits, maxCredits } = entry;
  return {
    epoch: Number(entry.epoch),
    credits: numOrNull(credits),
    maxCredits: numOrNull(maxCredits),
    creditsOfMaxPct:
      credits !== null && maxCredits !== null && maxCredits > 0n
        ? Number((credits * 1_000_000n) / maxCredits) / 10_000
        : null,
    inflationCommissionPct: pct(entry.inflationCommissionBps),
    blockCommissionPct: pct(entry.blockCommissionBps),
    mevCommissionPct: pct(entry.mevCommissionBps),
    priorityFeeCommissionPct: pct(entry.priorityFeeCommissionBps),
    mevEarnedSol: solOrNull(entry.mevEarnedLamports),
    priorityFeesSol: solOrNull(entry.priorityFeesLamports),
    voteAccountSol: solOrNull(entry.voteLamports),
    revenueSol: solOrNull(entry.revenueLamports),
    activatedStakeSol: solOrNull(entry.activatedStakeLamports),
    stakeRank: entry.rank,
    superminority: entry.superminority,
    lastVotedSlot: numOrNull(entry.lastVotedSlot),
    updatedSlot: numOrNull(entry.updatedSlot),
    sources: SOURCE_NAMES.filter(([bit]) => (entry.sources & bit) !== 0).map(([, name]) => name),
  };
}

/**
 * The history's freshness at `epoch`, by the program's rules: "fresh" when it holds a vote copy from `epoch` (what makes
 * `update_score` refuse), "stale" when the newest copy is older, "empty" before the first copy.
 */
export function historyFreshness(
  history: ValidatorHistoryAccount,
  epoch: number,
): { status: HistoryFreshness; lastVoteCopyEpoch: number | null } {
  const copied = history.entries.filter((e) => has(e, HISTORY_SOURCES.vote));
  const newest = copied.length > 0 ? Number(copied[copied.length - 1].epoch) : null;
  if (newest === null) return { status: 'empty', lastVoteCopyEpoch: null };
  return { status: newest === epoch ? 'fresh' : 'stale', lastVoteCopyEpoch: newest };
}

/** The last `refresh_score` from the history header; null before the first. */
export function lastRefreshOf(history: ValidatorHistoryAccount): ScoreBreakdown | null {
  const flags = history.scoreFlags;
  if ((flags & HISTORY_SCORE_FLAGS.scored) === 0) return null;
  return {
    score: Math.round(history.score / 100),
    creditsOfMaxPct: history.creditsRatioRawBps / 100,
    creditsVsClusterPct: history.creditsRatioBps / 100,
    commissionPct: history.commissionBps / 100,
    epochsActive: history.epochsActive,
    delinquent: (flags & HISTORY_SCORE_FLAGS.delinquent) !== 0,
    superminority: (flags & HISTORY_SCORE_FLAGS.superminority) !== 0,
    hedged: (flags & HISTORY_SCORE_FLAGS.hedged) !== 0,
    hedgeRequiredSol: toSol(history.hedgeRequiredNotional),
  };
}

/**
 * The position endpoint's breakdown. The score came from `refresh_score` when the history's last refresh is the
 * position's last score write (same epoch: `update_score` refuses once the epoch's copy exists, so it cannot have
 * written after a refresh in the same epoch); otherwise from the scorer's `update_score`.
 */
export function scoreBreakdownOf(
  position: ValidatorPositionAccount,
  history: ProgramAccount<ValidatorHistoryAccount> | null,
  epoch: number,
): OperatorScoreBreakdown {
  const refresh = history ? lastRefreshOf(history.account) : null;
  const fromHistory = !!history && refresh !== null && history.account.refreshedEpoch === position.lastScoredEpoch;
  const freshness = history ? historyFreshness(history.account, epoch) : null;
  return {
    source: fromHistory ? 'history' : 'scorer',
    epoch: Number(position.lastScoredEpoch),
    inputs: fromHistory ? refresh : null,
    history:
      history && freshness
        ? { address: history.address, freshness: freshness.status, lastVoteCopyEpoch: freshness.lastVoteCopyEpoch }
        : null,
  };
}

function scoringView(config: ScoreConfigAccount): NonNullable<OnChainHistory['scoring']> {
  return {
    creditsWindowEpochs: config.creditsWindowEpochs,
    creditsReferencePct: config.creditsReferenceBps / 100,
    countBlockCommission: config.countBlockCommission,
    maxCopyAgeSlots: config.maxCopyAgeSlots,
    marketMaker: config.marketMaker?.toBase58() ?? null,
  };
}

/** `GET /v1/validators/:vote/history`: the validator's ValidatorHistory account, decoded, with its freshness. */
export class OnChainHistoryService {
  constructor(private readonly deps: ProgramServiceDeps) {}

  async history(vote: string): Promise<OnChainHistorySnapshot> {
    const { program } = this.deps;
    const [found, info, config, names] = await Promise.all([
      program.validatorHistory(vote),
      program.epochInfo(),
      program.scoreConfig(),
      loadValidatorNames(this.deps.validators),
    ]);
    if (!found) {
      throw new NotFoundException(
        'This vote account has no on-chain history yet: anyone can create it with init_validator_history',
        { vote },
      );
    }
    const history = found.account;
    const epoch = info.epoch;
    const slot = info.absoluteSlot;
    const { status, lastVoteCopyEpoch } = historyFreshness(history, epoch);
    const copySlot = history.lastVoteCopySlot > 0n ? Number(history.lastVoteCopySlot) : null;
    const slotsSince = copySlot === null ? null : Math.max(0, slot - copySlot);
    const maxAge = config?.account.maxCopyAgeSlots ?? null;
    const stakeInfoPosted = (entryAt(history, epoch)?.superminority ?? null) !== null;
    const refresh = lastRefreshOf(history);
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(this.deps.now?.()),
      source: `Epoch program on ${program.cluster}: the ValidatorHistory account (vote account, Jito and scorer copies)`,
      vote,
      name: names.nameOf(vote),
      address: found.address,
      createdEpoch: Number(history.createdEpoch),
      currentEpoch: epoch,
      currentSlot: slot,
      freshness: {
        status,
        lastVoteCopyEpoch,
        lastVoteCopySlot: copySlot,
        slotsSinceVoteCopy: slotsSince,
        maxCopyAgeSlots: maxAge,
        stakeInfoPosted,
        refreshReady:
          status === 'fresh' && maxAge !== null && slotsSince !== null && slotsSince <= maxAge && stakeInfoPosted,
      },
      lastRefresh: refresh
        ? { ...refresh, epoch: Number(history.refreshedEpoch), slot: Number(history.refreshedSlot) }
        : null,
      scoring: config ? scoringView(config.account) : null,
      entries: history.entries.map(entryView),
    };
  }
}
