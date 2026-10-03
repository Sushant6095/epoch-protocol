import { type VoteAccount } from '../../Sources/SolanaDataSource';

/** Epochs of commission history on every validator row (a raise in them puts the validator on Watch). */
export const COMMISSION_HISTORY_EPOCHS = 10;
/** Epochs of stake history on every validator row and in the profile chart. */
export const STAKE_HISTORY_EPOCHS = 64;

/** One validator in one epoch, as `validator_epoch_stats` keeps it. A missing field is not known (yet). */
export interface ValidatorEpochStat {
  vote: string;
  epoch: number;
  /** Inflation commission in force during the epoch (the last value seen), bps. */
  commissionBps?: number | null;
  mevCommissionBps?: number | null;
  activeStakeLamports?: bigint | null;
  /** Vote credits earned in the epoch (so far, for the current one). */
  credits?: number | null;
}

export interface CommissionPoint {
  epoch: number;
  commissionPct: number;
}

export interface StakePoint {
  epoch: number;
  sol: number;
}

/** The recorded history the validator table and the profile read, rebuilt after every write. */
export interface ValidatorHistorySnapshot {
  /** Changes on every reload, so cached tables know to rebuild. */
  version: number;
  /** The epoch the snapshot was loaded in. */
  epoch: number;
  /** Inflation commission for the last 10 epochs, oldest first. */
  commission: Map<string, CommissionPoint[]>;
  /** Active stake for up to 64 epochs, oldest first, whole SOL. */
  stake: Map<string, StakePoint[]>;
}

const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

export function buildHistorySnapshot(
  rows: readonly ValidatorEpochStat[],
  currentEpoch: number,
  version: number,
): ValidatorHistorySnapshot {
  const commission = new Map<string, CommissionPoint[]>();
  const stake = new Map<string, StakePoint[]>();
  for (const row of [...rows].sort((a, b) => a.epoch - b.epoch)) {
    if (row.epoch > currentEpoch) continue;
    if (row.commissionBps !== null && row.commissionBps !== undefined) {
      if (row.epoch > currentEpoch - COMMISSION_HISTORY_EPOCHS) {
        push(commission, row.vote, { epoch: row.epoch, commissionPct: row.commissionBps / 100 });
      }
    }
    if (row.activeStakeLamports !== null && row.activeStakeLamports !== undefined) {
      if (row.epoch > currentEpoch - STAKE_HISTORY_EPOCHS) {
        push(stake, row.vote, { epoch: row.epoch, sol: Math.round(Number(row.activeStakeLamports) / 1e9) });
      }
    }
  }
  return { version, epoch: currentEpoch, commission, stake };
}

/** The newest commission raise in a series (oldest first), or null: the health rule "commission raised". */
export function lastCommissionRaise(
  history: readonly CommissionPoint[],
): { epoch: number; fromPct: number; toPct: number } | null {
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].commissionPct > history[i - 1].commissionPct) {
      return { epoch: history[i].epoch, fromPct: history[i - 1].commissionPct, toPct: history[i].commissionPct };
    }
  }
  return null;
}

/**
 * One recorder pass: this epoch's commission, MEV commission, active stake and credits so far for every staked
 * validator, plus the final credits of the earlier epochs getVoteAccounts still lists (four of them).
 */
export function recordedStats(
  accounts: readonly VoteAccount[],
  epoch: number,
  mevCommissionBps: (vote: string) => number | null,
): ValidatorEpochStat[] {
  const out: ValidatorEpochStat[] = [];
  for (const account of accounts) {
    if (account.activatedStake <= 0) continue;
    const creditsIn = new Map(account.epochCredits.map(([e, credits, previous]) => [e, credits - previous]));
    out.push({
      vote: account.votePubkey,
      epoch,
      commissionBps: account.inflationRewardsCommissionBps ?? account.commission * 100,
      mevCommissionBps: mevCommissionBps(account.votePubkey),
      activeStakeLamports: BigInt(Math.round(account.activatedStake)),
      credits: creditsIn.get(epoch) ?? 0,
    });
    for (const [e, credits] of creditsIn) {
      if (e < epoch) out.push({ vote: account.votePubkey, epoch: e, credits });
    }
  }
  return out;
}

/**
 * The inflation commission in force at the end of each epoch, from a change log (any order): the newest value
 * observed before the epoch ended. Epochs before the first observation are left out.
 */
export function commissionAtEpochEnds(
  changes: readonly { bps: number; atMs: number }[],
  epochs: readonly number[],
  endMs: (epoch: number) => number,
): Map<number, number> {
  const ordered = changes.filter((c) => Number.isFinite(c.atMs)).sort((a, b) => b.atMs - a.atMs);
  const out = new Map<number, number>();
  for (const epoch of epochs) {
    const end = endMs(epoch);
    const inForce = ordered.find((change) => change.atMs < end);
    if (inForce) out.set(epoch, inForce.bps);
  }
  return out;
}

/**
 * Stake per epoch from Stakewiz's series (SOL, any order) for epochs before `beforeEpoch`, from the first epoch with
 * stake on (Stakewiz answers zeros for epochs it has no stake for).
 */
export function stakeStatsFromSeries(
  vote: string,
  series: readonly { epoch: number; stake: number }[],
  beforeEpoch: number,
): ValidatorEpochStat[] {
  const ordered = series
    .filter((point) => point.epoch < beforeEpoch && Number.isFinite(point.stake))
    .sort((a, b) => a.epoch - b.epoch);
  const first = ordered.findIndex((point) => point.stake > 0);
  if (first < 0) return [];
  return ordered.slice(first).map((point) => ({
    vote,
    epoch: point.epoch,
    activeStakeLamports: BigInt(Math.round(point.stake * 1e9)),
  }));
}
