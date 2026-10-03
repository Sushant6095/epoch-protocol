import { median, round } from '../Lib/Stats';
import { type DelegatedStake, isDelegated, U64_MAX } from '../Lib/StakeLayouts';

/** A wallet holding less than this in total is retail. */
export const RETAIL_MAX_SOL = 1_000;
/** A wallet holding at least this in total is an allocator (pools, foundations, exchanges, funds). */
export const ALLOCATOR_MIN_SOL = 100_000;

export interface VoteDelegationStats {
  /** Distinct wallets (withdraw authorities) delegating to this vote account. */
  delegators: number;
  delegatedSol: number;
  biggestDelegatorSharePct: number;
  /** Null when no Foundation authorities are configured. */
  foundationSharePct: number | null;
  /** Wallets with under RETAIL_MAX_SOL in total, across every validator. */
  retailWallets: number;
}

export interface OwnerTotal {
  /** Withdraw authority, base64 of its 32 bytes. */
  key: string;
  stakeSol: number;
  validators: number;
}

export interface DelegationSnapshot {
  epoch: number;
  votes: number;
  stakeAccounts: number;
  perVote: Map<string, VoteDelegationStats>;
  network: {
    wallets: number;
    medianWalletSol: number;
    retail: { wallets: number; sharePct: number };
    midSize: { wallets: number; sharePct: number };
    allocators: { holders: number; sharePct: number };
    activatingSol: number;
    deactivatingSol: number;
  };
  /** The largest owners by total delegated stake, biggest first. */
  topOwners: OwnerTotal[];
}

interface VoteRecord {
  vote: string;
  owners: Int32Array;
  stakes: Float64Array;
}

/**
 * Collects every delegated stake account, one vote account at a time, in compact arrays (owner keys are
 * interned to integers), then derives per-validator and network figures once all votes are in. 1.4M stake
 * accounts fit in a few tens of MB this way.
 */
export class DelegationAccumulator {
  private readonly ownerIds = new Map<string, number>();
  private readonly ownerKeys: string[] = [];
  private readonly records: VoteRecord[] = [];
  private stakeAccounts = 0;
  private activatingLamports = 0n;
  private deactivatingLamports = 0n;

  constructor(
    private readonly epoch: number,
    private readonly foundationKeys: ReadonlySet<string> = new Set(),
  ) {}

  add(vote: string, stakes: readonly DelegatedStake[]): void {
    const current = BigInt(this.epoch);
    const perOwner = new Map<number, number>();
    for (const stake of stakes) {
      if (stake.activationEpoch === current) this.activatingLamports += stake.stakeLamports;
      if (stake.deactivationEpoch === current) this.deactivatingLamports += stake.stakeLamports;
      if (!isDelegated(stake) || stake.activationEpoch === U64_MAX) continue;
      this.stakeAccounts++;
      const id = this.intern(stake.withdrawerKey);
      perOwner.set(id, (perOwner.get(id) ?? 0) + Number(stake.stakeLamports) / 1e9);
    }
    const owners = new Int32Array(perOwner.size);
    const amounts = new Float64Array(perOwner.size);
    let i = 0;
    for (const [id, sol] of perOwner) {
      owners[i] = id;
      amounts[i] = sol;
      i++;
    }
    this.records.push({ vote, owners, stakes: amounts });
  }

  finish(topOwnersLimit = 200): DelegationSnapshot {
    const totals = new Float64Array(this.ownerKeys.length);
    const validatorsPerOwner = new Int32Array(this.ownerKeys.length);
    for (const record of this.records) {
      for (let i = 0; i < record.owners.length; i++) {
        totals[record.owners[i]] += record.stakes[i];
        validatorsPerOwner[record.owners[i]]++;
      }
    }

    const foundationIds = new Set<number>();
    for (const key of this.foundationKeys) {
      const id = this.ownerIds.get(key);
      if (id !== undefined) foundationIds.add(id);
    }
    const hasFoundation = this.foundationKeys.size > 0;

    const perVote = new Map<string, VoteDelegationStats>();
    for (const record of this.records) {
      let delegated = 0;
      let biggest = 0;
      let foundation = 0;
      let retail = 0;
      for (let i = 0; i < record.owners.length; i++) {
        const sol = record.stakes[i];
        delegated += sol;
        if (sol > biggest) biggest = sol;
        if (foundationIds.has(record.owners[i])) foundation += sol;
        if (totals[record.owners[i]] < RETAIL_MAX_SOL) retail++;
      }
      perVote.set(record.vote, {
        delegators: record.owners.length,
        delegatedSol: round(delegated, 2),
        biggestDelegatorSharePct: delegated > 0 ? round((biggest / delegated) * 100, 1) : 0,
        foundationSharePct: hasFoundation ? (delegated > 0 ? round((foundation / delegated) * 100, 1) : 0) : null,
        retailWallets: retail,
      });
    }

    let grand = 0;
    let retailSol = 0;
    let midSol = 0;
    let allocatorSol = 0;
    let retailWallets = 0;
    let midWallets = 0;
    let allocators = 0;
    const walletTotals: number[] = [];
    for (let id = 0; id < totals.length; id++) {
      const sol = totals[id];
      if (sol <= 0) continue;
      walletTotals.push(sol);
      grand += sol;
      if (sol < RETAIL_MAX_SOL) {
        retailWallets++;
        retailSol += sol;
      } else if (sol < ALLOCATOR_MIN_SOL) {
        midWallets++;
        midSol += sol;
      } else {
        allocators++;
        allocatorSol += sol;
      }
    }
    const share = (part: number): number => (grand > 0 ? round((part / grand) * 100, 1) : 0);

    const topOwners = Array.from(totals, (stakeSol, id) => ({ id, stakeSol }))
      .sort((a, b) => b.stakeSol - a.stakeSol)
      .slice(0, topOwnersLimit)
      .map(({ id, stakeSol }) => ({
        key: this.ownerKeys[id],
        stakeSol: round(stakeSol, 2),
        validators: validatorsPerOwner[id],
      }));

    return {
      epoch: this.epoch,
      votes: this.records.length,
      stakeAccounts: this.stakeAccounts,
      perVote,
      network: {
        wallets: walletTotals.length,
        medianWalletSol: round(median(walletTotals), 2),
        retail: { wallets: retailWallets, sharePct: share(retailSol) },
        midSize: { wallets: midWallets, sharePct: share(midSol) },
        allocators: { holders: allocators, sharePct: share(allocatorSol) },
        activatingSol: round(Number(this.activatingLamports) / 1e9),
        deactivatingSol: round(Number(this.deactivatingLamports) / 1e9),
      },
      topOwners,
    };
  }

  private intern(key: string): number {
    let id = this.ownerIds.get(key);
    if (id === undefined) {
      id = this.ownerKeys.length;
      this.ownerIds.set(key, id);
      this.ownerKeys.push(key);
    }
    return id;
  }
}
