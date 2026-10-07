import { type VoteStake } from '../Chain/EpochChain';

/** What `update_stake_info` posts for one vote account. */
export interface StakeRank {
  activatedStake: bigint;
  /** 1 = the largest stake. */
  rank: number;
  superminority: boolean;
}

/**
 * Rank and superminority for every vote account, from the program cluster's stakes. Superminority is the same rule
 * as `superminority()` in ScoreInputs (and api_app): the smallest set of the largest stakes that together hold more
 * than a third. Ties rank by vote address so every keeper posts the same numbers.
 */
export function stakeRanks(stakes: readonly VoteStake[]): Map<string, StakeRank> {
  const sorted = [...stakes].sort((a, b) =>
    a.activatedStake === b.activatedStake ? a.vote.localeCompare(b.vote) : a.activatedStake > b.activatedStake ? -1 : 1,
  );
  const total = sorted.reduce((sum, s) => sum + s.activatedStake, 0n);
  const out = new Map<string, StakeRank>();
  let held = 0n;
  sorted.forEach((s, i) => {
    const superminority = s.activatedStake > 0n && held * 3n <= total;
    if (superminority) held += s.activatedStake;
    out.set(s.vote, { activatedStake: s.activatedStake, rank: i + 1, superminority });
  });
  return out;
}

/** A vote account the cluster does not list: no stake, ranked after everyone. */
export function unrankedStake(stakes: readonly VoteStake[]): StakeRank {
  return { activatedStake: 0n, rank: stakes.length + 1, superminority: false };
}
