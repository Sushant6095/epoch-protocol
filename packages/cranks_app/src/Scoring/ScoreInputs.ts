import { type ScoreInput } from '@epoch/epoch-sdk';
import { type VoteState } from '@epoch/solana';
import { type VoteAccountInfo } from '@solana/web3.js';

import { type VoterSnapshot } from '../Chain/MainnetData';

/** Figures about the whole data cluster that every validator's inputs are measured against. */
export interface ClusterStats {
  /** The last finished epoch: credits are compared there. */
  lastEpoch: number;
  /** Mean credits earned in `lastEpoch` by voting validators that earned any. */
  averageCredits: number;
  delinquent: Set<string>;
  superminority: Set<string>;
  byVote: Map<string, VoteAccountInfo>;
}

const U16_MAX = 65_535;
const clampU16 = (value: number): number => Math.min(U16_MAX, Math.max(0, Math.floor(value)));

/** Credits a vote account earned in `epoch`, from getVoteAccounts' `epochCredits` ([epoch, credits, prevCredits]). */
export function creditsIn(account: Pick<VoteAccountInfo, 'epochCredits'>, epoch: number): number {
  const entry = account.epochCredits.find(([e]) => e === epoch);
  return entry ? entry[1] - entry[2] : 0;
}

/**
 * The smallest set of the largest stakes that together hold MORE than a third of all stake (enough to halt the
 * chain). Same rule as api_app's `superminority()` so the site and the scorer agree.
 */
export function superminority(
  accounts: readonly Pick<VoteAccountInfo, 'votePubkey' | 'activatedStake'>[],
): Set<string> {
  const staked = accounts.filter((a) => a.activatedStake > 0).sort((a, b) => b.activatedStake - a.activatedStake);
  const total = staked.reduce((sum, a) => sum + a.activatedStake, 0);
  const members = new Set<string>();
  let held = 0;
  for (const account of staked) {
    if (held * 3 > total) break;
    members.add(account.votePubkey);
    held += account.activatedStake;
  }
  return members;
}

export function clusterStats(snapshot: VoterSnapshot): ClusterStats {
  const lastEpoch = snapshot.epoch - 1;
  const earned = snapshot.current.map((v) => creditsIn(v, lastEpoch)).filter((c) => c > 0);
  const all = [...snapshot.current, ...snapshot.delinquent];
  return {
    lastEpoch,
    averageCredits: earned.length ? earned.reduce((sum, c) => sum + c, 0) / earned.length : 0,
    delinquent: new Set(snapshot.delinquent.map((v) => v.votePubkey)),
    superminority: superminority(all),
    byVote: new Map(all.map((v) => [v.votePubkey, v])),
  };
}

/**
 * The scorer's inputs for one vote account (everything in `ScoreUpdate` except `hedged`), or null when the vote
 * account is not on the data cluster at all (wrong DATA_RPC_URL, or a devnet-only test validator).
 *
 * - credits ratio: credits earned in the last finished epoch ÷ the cluster average, in bps (10,000 = average);
 * - commission: the higher of the inflation commission (from the vote account; getVoteAccounts' percent as a
 *   fallback) and the Jito MEV commission (Kobe), as `update_score.rs` documents;
 * - epochs active: epochs with credits in the vote account's history (up to 64; the score's tenure part is full
 *   at 30), or getVoteAccounts' five-epoch history when the account could not be read;
 * - delinquent / superminority: from getVoteAccounts and stake.
 */
export function scoreInputs(
  vote: string,
  stats: ClusterStats,
  voteState: VoteState | null,
  mevCommissionBps: number | null,
): ScoreInput | null {
  const account = stats.byVote.get(vote);
  if (!account) return null;
  const credits = creditsIn(account, stats.lastEpoch);
  const creditsRatioBps = stats.averageCredits > 0 ? clampU16((credits / stats.averageCredits) * 10_000) : 10_000;
  const inflationBps = voteState ? voteState.inflationRewardsCommissionBps : account.commission * 100;
  const commissionBps = Math.min(10_000, Math.max(inflationBps, mevCommissionBps ?? 0));
  const epochsActive = voteState
    ? voteState.epochCredits.filter((e) => e.credits > e.prevCredits).length
    : account.epochCredits.length;
  return {
    creditsRatioBps,
    commissionBps: clampU16(commissionBps),
    epochsActive: clampU16(epochsActive),
    delinquent: stats.delinquent.has(vote),
    superminority: stats.superminority.has(vote),
  };
}
