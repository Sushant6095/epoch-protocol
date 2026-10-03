import { type StakeAccountInfo, U64_MAX } from '../../Lib/StakeLayouts';
import { round, shortKey } from '../../Lib/Stats';
import { type StakewizValidator } from '../../Sources/ExternalSources';
import { type HealthStatus, type Meta, type ValidatorRow } from '../../types/Api.types';
import {
  type MyStake,
  type MyStakeAccount,
  type MyStakeSuggestion,
  type StakeAccountStatus,
} from '../../types/Wallet.types';

/** Finished epochs of rewards read per wallet (getInflationReward, one call per 32 stake accounts per epoch). */
export const REWARD_EPOCHS = 5;
/** Rewards are read for this many of a wallet's largest stake accounts. */
export const MAX_REWARD_ACCOUNTS = 100;
/** Stake accounts listed per wallet, largest first. */
export const MAX_LISTED_ACCOUNTS = 500;

/** Where to move stake (My Stake → Healthier homes): every rule must hold. */
export const SUGGESTION_RULES = {
  maxCommissionPct: 5,
  maxMevCommissionPct: 10,
  minUptimePct: 99,
  minDelegators: 100,
  maxBiggestDelegatorSharePct: 30,
  count: 3,
} as const;

/** The alert switches on My Stake (request #15 sends them). */
export const ALERTS: MyStake['alerts'] = [
  { key: 'offline', title: 'Validator goes offline', description: 'delinquent for more than 10 minutes' },
  { key: 'fee', title: 'Fee goes up', description: 'commission or MEV fee raised' },
  { key: 'breakeven', title: 'Validator starts losing money', description: 'earns less than its vote fees' },
  { key: 'rewards', title: 'Rewards landed', description: 'once per epoch, with the amount' },
];

const sol = (lamports: bigint | number): number => Number(lamports) / 1e9;

/** null for an undelegated (initialized) account. */
export function stakeStatus(account: StakeAccountInfo, epoch: number): StakeAccountStatus | null {
  const { activationEpoch: activation, deactivationEpoch: deactivation } = account;
  if (account.state !== 'delegated' || activation === null || deactivation === null) return null;
  const current = BigInt(epoch);
  if (deactivation !== U64_MAX) return deactivation < current ? 'inactive' : 'deactivating';
  if (activation !== U64_MAX && activation >= current) return 'activating';
  return 'active';
}

/** Two letters for the avatar: the first letters of the first two words, or the first two of a single word. */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return (words[0] ?? '?').slice(0, 2).toUpperCase();
}

/** How the validator behind an account without a row in the table stands. */
export type VoteStanding = 'current' | 'delinquent' | 'missing';

function accountRow(
  account: StakeAccountInfo,
  status: StakeAccountStatus,
  row: ValidatorRow | undefined,
  standing: VoteStanding,
): MyStakeAccount {
  const vote = account.voter ?? '';
  const name = row?.name ?? shortKey(vote);
  let health: HealthStatus = row?.health ?? 'offline';
  let reasons = row?.healthReasons ?? [];
  if (!row) {
    if (standing === 'current') [health, reasons] = ['watch', ['no active stake yet']];
    else if (standing === 'delinquent') reasons = ['not voting'];
    else reasons = ['vote account not found'];
  }
  const activation = account.activationEpoch ?? 0n;
  return {
    validator: name,
    initials: initials(name),
    vote,
    stakeAccountShort: shortKey(account.pubkey),
    stakeAccount: account.pubkey,
    status,
    sinceEpoch: activation === U64_MAX ? 0 : Number(activation),
    sol: round(sol(status === 'inactive' ? account.lamports : account.stakeLamports), 6),
    apyPct: row?.apyPct ?? null,
    stakingApyPct: row?.stakingApyPct ?? null,
    tipsApyPct: row?.tipsApyPct ?? null,
    commissionPct: row?.commissionPct ?? null,
    health,
    healthReasons: reasons,
  };
}

/**
 * Rewards per finished epoch from `byEpoch` (epoch → stake account → lamports or null). Epochs missing from the map
 * were not read. Month = the average over the epochs read in which the wallet had earning stake × epochs in 30 days;
 * year = the last epoch × epochs a year.
 */
export function rewardsSummary(
  byEpoch: ReadonlyMap<number, ReadonlyMap<string, number | null>>,
  lastEpoch: number,
  epochsPerYear: number,
  hoursPerEpoch: number,
  earningIn: (epoch: number) => boolean = () => true,
): Pick<MyStake, 'perEpochSol' | 'monthSol' | 'yearSol' | 'lifetimeSol' | 'rewardsByEpoch'> {
  const rewardsByEpoch = [...byEpoch.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([epoch, rewards]) => ({
      epoch,
      sol: round(sol([...rewards.values()].reduce<number>((s, lamports) => s + (lamports ?? 0), 0)), 9),
    }));
  if (rewardsByEpoch.length === 0) {
    return { perEpochSol: null, monthSol: null, yearSol: null, lifetimeSol: null, rewardsByEpoch };
  }
  const total = rewardsByEpoch.reduce((s, e) => s + e.sol, 0);
  const last = rewardsByEpoch.find((e) => e.epoch === lastEpoch)?.sol ?? null;
  const earning = rewardsByEpoch.filter((e) => earningIn(e.epoch));
  const average = earning.length > 0 ? earning.reduce((s, e) => s + e.sol, 0) / earning.length : 0;
  const epochsPerMonth = hoursPerEpoch > 0 ? (30 * 24) / hoursPerEpoch : 0;
  return {
    perEpochSol: last === null ? null : round(last, 6),
    monthSol: round(average * epochsPerMonth, 6),
    yearSol: last === null ? null : round(last * epochsPerYear, 6),
    lifetimeSol: round(total, 6),
    rewardsByEpoch,
  };
}

/**
 * Three healthy validators to move to, highest APY first (ties: higher score, then smaller stake), leaving out the
 * wallet's own. Before the delegator scan has finished, the two delegator rules cannot be checked and are skipped.
 */
export function suggestions(
  rows: readonly ValidatorRow[],
  stakewiz: ReadonlyMap<string, StakewizValidator>,
  epoch: number,
  exclude: ReadonlySet<string>,
  scanReady: boolean,
): MyStakeSuggestion[] {
  const r = SUGGESTION_RULES;
  return rows
    .filter(
      (row) =>
        !exclude.has(row.vote) &&
        !row.top18 &&
        !row.delinquent &&
        row.health === 'healthy' &&
        row.apyPct !== null &&
        row.commissionPct <= r.maxCommissionPct &&
        (row.mevCommissionPct === null || row.mevCommissionPct <= r.maxMevCommissionPct) &&
        row.uptimePct !== null &&
        row.uptimePct >= r.minUptimePct &&
        (!scanReady ||
          ((row.delegators ?? 0) >= r.minDelegators &&
            row.biggestDelegatorSharePct !== null &&
            row.biggestDelegatorSharePct <= r.maxBiggestDelegatorSharePct)),
    )
    .sort((a, b) => (b.apyPct ?? 0) - (a.apyPct ?? 0) || b.epochScore - a.epochScore || a.stakeSol - b.stakeSol)
    .slice(0, r.count)
    .map((row) => {
      const sw = stakewiz.get(row.vote);
      const first = sw?.first_epoch_with_stake;
      return {
        name: row.name,
        vote: row.vote,
        city: sw?.ip_city ?? '',
        country: row.countryCode === 'XX' ? '' : row.countryCode,
        epochsActive: first === null || first === undefined ? null : Math.max(0, epoch - first),
        apyPct: row.apyPct ?? 0,
        delegators: row.delegators,
        biggestDelegatorSharePct: row.biggestDelegatorSharePct,
        healthPerEpochSol: row.healthPerEpochSol,
      };
    });
}

export interface WalletInputs {
  wallet: string;
  epoch: number;
  epochsPerYear: number;
  hoursPerEpoch: number;
  balanceLamports: number;
  /** Every stake account the wallet is staker or withdrawer of. */
  accounts: readonly StakeAccountInfo[];
  rows: readonly ValidatorRow[];
  standing: (vote: string) => VoteStanding;
  stakewiz: ReadonlyMap<string, StakewizValidator>;
  /** Rewards per finished epoch read (see `rewardAccounts`). */
  rewards: ReadonlyMap<number, ReadonlyMap<string, number | null>>;
  /** The epochs asked for, oldest first. */
  rewardEpochs: readonly number[];
  scanReady: boolean;
}

/** The stake accounts whose rewards are read: the largest delegated ones, at most MAX_REWARD_ACCOUNTS. */
export function rewardAccounts(accounts: readonly StakeAccountInfo[]): string[] {
  return accounts
    .filter((account) => account.state === 'delegated')
    .sort((a, b) => Number(b.stakeLamports - a.stakeLamports))
    .slice(0, MAX_REWARD_ACCOUNTS)
    .map((account) => account.pubkey);
}

export function buildMyStake(input: WalletInputs): { body: Omit<MyStake, keyof Meta>; notes: string[] } {
  const notes: string[] = [];
  const byVote = new Map(input.rows.map((row) => [row.vote, row]));
  const listed: MyStakeAccount[] = [];
  let undelegatedLamports = 0;
  for (const account of input.accounts) {
    const status = stakeStatus(account, input.epoch);
    if (status === null) {
      undelegatedLamports += Number(account.lamports);
      continue;
    }
    const vote = account.voter ?? '';
    listed.push(accountRow(account, status, byVote.get(vote), input.standing(vote)));
  }
  listed.sort((a, b) => b.sol - a.sol);
  if (listed.length > MAX_LISTED_ACCOUNTS) {
    notes.push(`the ${MAX_LISTED_ACCOUNTS} largest of ${listed.length} stake accounts are listed`);
  }

  const earning = listed.filter((a) => a.status === 'active' || a.status === 'activating');
  const weighted = earning.filter((a) => a.apyPct !== null);
  const weight = weighted.reduce((s, a) => s + a.sol, 0);
  const blendedApyPct =
    weight > 0 ? round(weighted.reduce((s, a) => s + a.sol * (a.apyPct ?? 0), 0) / weight, 2) : null;

  // An epoch counts toward the monthly average when some account was fully active in it.
  const earningIn = (e: number) =>
    input.accounts.some((a) => {
      if (a.state !== 'delegated' || a.activationEpoch === null || a.deactivationEpoch === null) return false;
      const epoch = BigInt(e);
      const active = a.activationEpoch === U64_MAX || a.activationEpoch < epoch;
      return active && (a.deactivationEpoch === U64_MAX || a.deactivationEpoch >= epoch);
    });
  const rewards = rewardsSummary(input.rewards, input.epoch - 1, input.epochsPerYear, input.hoursPerEpoch, earningIn);
  const read = input.rewardEpochs.filter((e) => input.rewards.has(e));
  if (read.length > 0) {
    notes.push(
      `rewards from getInflationReward for epochs ${read[0]}–${read.at(-1)}; lifetimeSol sums those ${read.length} ` +
        'epochs only',
    );
  }
  if (read.length < input.rewardEpochs.length) {
    const missing = input.rewardEpochs.filter((e) => !input.rewards.has(e));
    notes.push(`rewards for epochs ${missing.join(', ')} could not be read`);
  }
  const delegated = input.accounts.filter((a) => a.state === 'delegated').length;
  if (delegated > MAX_REWARD_ACCOUNTS) {
    notes.push(`rewards cover the ${MAX_REWARD_ACCOUNTS} largest of ${delegated} stake accounts`);
  }
  if (undelegatedLamports > 0) notes.push('undelegated stake accounts count as idle SOL');
  if (!input.scanReady) notes.push('suggestions skip the delegator checks until the stake-account scan finishes');

  const own = new Set(earning.map((a) => a.vote));
  return {
    body: {
      wallet: input.wallet,
      idleSol: round(sol(input.balanceLamports + undelegatedLamports), 6),
      stakeAccounts: listed.slice(0, MAX_LISTED_ACCOUNTS),
      ...rewards,
      blendedApyPct,
      suggestions: suggestions(input.rows, input.stakewiz, input.epoch, own, input.scanReady),
      alerts: ALERTS,
    },
    notes,
  };
}
