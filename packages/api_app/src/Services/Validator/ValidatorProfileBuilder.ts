import { REVENUE_WINDOW_EPOCHS } from '@epoch/common';

import { isDelegated, U64_MAX } from '../../Lib/StakeLayouts';
import { median, round, shortKey } from '../../Lib/Stats';
import { type KobeEpochRewards, type StakewizValidator } from '../../Sources/ExternalSources';
import { type ParsedVoteAccount, type VoteStakeAccount } from '../../Sources/SolanaDataSource';
import { type Meta, type ValidatorRow } from '../../types/Api.types';
import { type StakeMove, type ValidatorProfile, type ValidatorRevenue } from '../../types/Wallet.types';
import { type DelegatorLabel } from '../DelegatorLabels';
import { type MevEpochRecord, mevHistoryRows } from './MevHistory';
import { type CommissionPoint, STAKE_HISTORY_EPOCHS, type StakePoint } from './ValidatorHistory';

/**
 * The planned Pool parameters behind the credit estimate: `PoolParams.advance_bps_unhedged` / `_hedged` and
 * `bond_multiplier`, over `REVENUE_WINDOW` epochs (programs/epoch). Read them from the Pool account once it is live.
 */
export const CREDIT_PARAMS = {
  advanceBpsUnhedged: 2_500,
  advanceBpsHedged: 4_000,
  bondMultiplier: 4,
  revenueWindowEpochs: REVENUE_WINDOW_EPOCHS,
} as const;

/** Timely vote credits: a validator earns at most 16 credits per slot. */
export const MAX_CREDITS_PER_SLOT = 16;
export const MAX_STAKE_MOVES = 50;
const ORB_ADDRESS = 'https://orbmarkets.io/address/';
const FOUNDATION = 'Solana Foundation';

const sol = (lamports: bigint | number): number => Number(lamports) / 1e9;
const count = (n: number): string => n.toLocaleString('en-US');

// ── Vote credits ─────────────────────────────────────────────────────────────────────────────────

/** Credits per finished epoch (oldest first, up to 64) and the per-epoch maximum. */
export function voteCreditsByEpoch(
  account: ParsedVoteAccount | null,
  currentEpoch: number,
  slotsInEpoch: number,
): ValidatorProfile['voteCreditsByEpoch'] {
  const rows = (account?.epochCredits ?? [])
    .filter((entry) => entry.epoch < currentEpoch)
    .sort((a, b) => a.epoch - b.epoch)
    .slice(-STAKE_HISTORY_EPOCHS)
    .map((entry): [number, number] => [entry.epoch, entry.credits - entry.previousCredits]);
  return { max: slotsInEpoch * MAX_CREDITS_PER_SLOT, rows };
}

/** The last finished epoch's credits as a share of the maximum; null before the first finished epoch. */
export function voteCreditsPct(credits: ValidatorProfile['voteCreditsByEpoch']): number | null {
  const last = credits.rows.at(-1);
  return last && credits.max > 0 ? round((last[1] / credits.max) * 100, 2) : null;
}

// ── Series ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Active stake per epoch, oldest first, at most 64, ending with the live figure: Stakewiz's 30-epoch series, overlaid
 * with what Epoch's recorder saw (the chain via getVoteAccounts). Leading zeros (before the validator had stake) are
 * dropped.
 */
export function stakeByEpoch(
  current: { epoch: number; sol: number },
  stakewiz: readonly { epoch: number; stake: number }[] | null,
  recorded: readonly StakePoint[] | undefined,
): { points: [number, number][]; fromStakewiz: number; fromRecorder: number } {
  const merged = new Map<number, number>();
  let fromStakewiz = 0;
  let fromRecorder = 0;
  const ordered = [...(stakewiz ?? [])].filter((p) => Number.isFinite(p.stake)).sort((a, b) => a.epoch - b.epoch);
  const first = ordered.findIndex((p) => p.stake > 0);
  for (const point of first < 0 ? [] : ordered.slice(first)) {
    if (point.epoch >= current.epoch) continue;
    merged.set(point.epoch, Math.round(point.stake));
    fromStakewiz += 1;
  }
  for (const point of recorded ?? []) {
    if (point.epoch >= current.epoch) continue;
    if (!merged.has(point.epoch)) fromRecorder += 1;
    merged.set(point.epoch, point.sol);
  }
  merged.set(current.epoch, Math.round(current.sol));
  const points = [...merged.entries()]
    .filter(([epoch]) => epoch > current.epoch - STAKE_HISTORY_EPOCHS)
    .sort((a, b) => a[0] - b[0]);
  return { points, fromStakewiz, fromRecorder };
}

/** Jito tips earned per finished epoch (before commission), oldest first, at most 64. */
export function tipsByEpoch(history: readonly KobeEpochRewards[] | null): [number, number][] {
  return (history ?? [])
    .filter((row) => row.mev_rewards !== null && row.mev_rewards !== undefined)
    .sort((a, b) => a.epoch - b.epoch)
    .slice(-STAKE_HISTORY_EPOCHS)
    .map((row): [number, number] => [row.epoch, round(sol(row.mev_rewards ?? 0), 4)]);
}

/** The validator's share of an epoch's tips (Kobe: tips × MEV commission). */
export const tipsCommissionSol = (row: KobeEpochRewards | undefined): number =>
  row && row.mev_rewards !== null && row.mev_commission_bps !== null
    ? sol(row.mev_rewards) * (row.mev_commission_bps / 10_000)
    : 0;

// ── Delegators ───────────────────────────────────────────────────────────────────────────────────

export interface DelegationFigures {
  delegators: number;
  totalSol: number;
  biggestDelegatorSharePct: number;
  /** Null without configured Foundation authorities. */
  foundationSharePct: number | null;
  split: ValidatorProfile['delegatorSplit'];
  ifBiggestDelegatorLeftSol: number;
  medianWalletSol: number;
  thisEpoch: ValidatorProfile['thisEpoch'];
  moves: StakeMove[];
}

/**
 * Everything the Delegators tab and the stake moves need, from one read of the validator's stake accounts. A delegator
 * is a withdraw authority with stake that is active or activating (not deactivating), as in the delegator scan.
 * Owners are grouped as the Foundation (`FOUNDATION_AUTHORITIES`, or a label of kind Foundation), liquid-staking pools
 * (stake-pool withdraw authorities), other named wallets (labels file) and everyone else.
 */
export function delegationFigures(
  accounts: readonly VoteStakeAccount[],
  epoch: number,
  labels: ReadonlyMap<string, DelegatorLabel>,
  foundationKeys: ReadonlySet<string>,
  toBase58: (key: string) => string,
): DelegationFigures {
  const current = BigInt(epoch);
  const previous = current - 1n;
  const owners = new Map<string, number>();
  let arriving = 0;
  let leaving = 0;
  const moves: StakeMove[] = [];
  const sourceOf = (key: string): string => {
    const label = labels.get(key);
    if (foundationKeys.has(key) || label?.kind === 'Foundation') return FOUNDATION;
    return label?.name ?? 'Wallet';
  };
  const move = (account: VoteStakeAccount, moveEpoch: bigint, direction: StakeMove['direction']): StakeMove => ({
    epoch: Number(moveEpoch),
    direction,
    sol: round(sol(account.stakeLamports), 2),
    from: sourceOf(account.withdrawerKey),
    wallet: shortKey(toBase58(account.withdrawerKey)),
    stakeAccountShort: shortKey(account.pubkey),
    stakeAccount: account.pubkey,
    orb: `${ORB_ADDRESS}${account.pubkey}`,
  });

  for (const account of accounts) {
    const { activationEpoch: activation, deactivationEpoch: deactivation } = account;
    const amount = sol(account.stakeLamports);
    // Activated and deactivated in the same epoch: never effective, no move.
    const neverEffective = activation === deactivation;
    if (isDelegated(account) && activation !== U64_MAX) {
      owners.set(account.withdrawerKey, (owners.get(account.withdrawerKey) ?? 0) + amount);
    }
    if (!neverEffective && activation === current) arriving += amount;
    if (!neverEffective && deactivation === current) leaving += amount;
    if (!neverEffective && (activation === current || activation === previous))
      moves.push(move(account, activation, 'in'));
    if (!neverEffective && (deactivation === current || deactivation === previous)) {
      moves.push(move(account, deactivation, 'out'));
    }
  }

  const totals = [...owners.values()];
  const totalSol = totals.reduce((s, x) => s + x, 0);
  const biggest = totals.reduce((max, x) => (x > max ? x : max), 0);
  const pct = (part: number): number => (totalSol > 0 ? round((part / totalSol) * 100, 1) : 0);

  // Group owners by source: the Foundation, liquid-staking pools, each other named entity, then the rest.
  const named = new Map<string, { source: string; sol: number }>();
  let foundation = 0;
  let others = 0;
  let otherWallets = 0;
  for (const [key, amount] of owners) {
    const label = labels.get(key);
    if (foundationKeys.has(key) || label?.kind === 'Foundation') {
      foundation += amount;
    } else if (label) {
      const group = label.kind === 'Liquid staking' ? 'Liquid-staking pools' : label.name;
      const entity = label.kind === 'Liquid staking' ? 'pools' : label.entity;
      const row = named.get(entity) ?? { source: group, sol: 0 };
      row.sol += amount;
      named.set(entity, row);
    } else {
      others += amount;
      otherWallets += 1;
    }
  }
  const groups = [...named.values()];
  if (foundation > 0) groups.push({ source: FOUNDATION, sol: foundation });
  groups.sort((a, b) => b.sol - a.sol);
  const split = groups.map((g) => ({ source: g.source, pct: pct(g.sol), sol: Math.round(g.sol) }));
  if (otherWallets > 0) {
    const noun = otherWallets === 1 ? 'wallet' : 'wallets';
    const source = groups.length > 0 ? `${count(otherWallets)} other ${noun}` : `${count(otherWallets)} ${noun}`;
    split.push({ source, pct: pct(others), sol: Math.round(others) });
  }

  moves.sort((a, b) => b.epoch - a.epoch || b.sol - a.sol);
  return {
    delegators: owners.size,
    totalSol,
    biggestDelegatorSharePct: pct(biggest),
    foundationSharePct: foundationKeys.size > 0 ? pct(foundation) : null,
    split,
    ifBiggestDelegatorLeftSol: Math.round(totalSol - biggest),
    medianWalletSol: round(median(totals), 2),
    thisEpoch: { arrivingSol: round(arriving, 2), leavingSol: round(leaving, 2), netSol: round(arriving - leaving, 2) },
    moves: moves.slice(0, MAX_STAKE_MOVES),
  };
}

// ── Revenue and credit ───────────────────────────────────────────────────────────────────────────

/**
 * What the validator kept in one finished epoch. The inflation commission is exact when the vote account's reward was
 * read (`exact`); otherwise it is estimated as stake × gross staking yield × commission.
 */
export function revenueForEpoch(input: {
  inflationCommissionSol: number;
  tips: KobeEpochRewards | undefined;
  blocksPerEpoch: number;
  feePerBlockSol: number;
  voteFeesPerEpochSol: number;
}): ValidatorRevenue {
  const tipsCommission = tipsCommissionSol(input.tips);
  const blockFees = input.blocksPerEpoch * input.feePerBlockSol;
  const net = input.inflationCommissionSol + tipsCommission + blockFees - input.voteFeesPerEpochSol;
  return {
    inflationCommission: round(input.inflationCommissionSol, 4),
    tipsCommission: round(tipsCommission, 4),
    blockFeesEstimate: round(blockFees, 4),
    voteFees: -round(input.voteFeesPerEpochSol, 4),
    netEstimate: round(net, 4),
  };
}

/**
 * What a credit line could be before onboarding: the revenue the escrow would sweep (inflation commission + tips
 * commission) in the last finished epoch and over the window (the last 10), and the limit the planned rates give on
 * that alone (the bond and cap rules apply once onboarded).
 */
export function creditEstimate(
  epochs: readonly { epoch: number; inflationSol: number; tipsSol: number }[],
  lastEpoch: number,
): ValidatorProfile['creditEstimate'] {
  const swept = (e: (typeof epochs)[number]) => e.inflationSol + e.tipsSol;
  const last = epochs.find((e) => e.epoch === lastEpoch);
  const window = epochs.reduce((s, e) => s + swept(e), 0);
  const { advanceBpsUnhedged, advanceBpsHedged, bondMultiplier, revenueWindowEpochs } = CREDIT_PARAMS;
  return {
    sweepablePerEpochSol: round(last ? swept(last) : 0, 4),
    sweepableLast10EpochsSol: round(window, 4),
    limitUnhedgedSol: round((window * advanceBpsUnhedged) / 10_000, 4),
    limitHedgedSol: round((window * advanceBpsHedged) / 10_000, 4),
    note:
      `limit = min(${advanceBpsUnhedged / 100}% or ${advanceBpsHedged / 100}% hedged of ${revenueWindowEpochs} ` +
      `epochs' swept revenue, ${bondMultiplier} x bond, cap); swept revenue = inflation commission + tips ` +
      'commission; planned Pool parameters',
  };
}

/** `1037–1040, 1042` */
export function epochList(epochs: readonly number[]): string {
  const sorted = [...new Set(epochs)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(i === j ? `${sorted[i]}` : `${sorted[i]}–${sorted[j]}`);
    i = j;
  }
  return runs.join(', ');
}

/**
 * Epochs since the inflation or the MEV commission last changed, whichever is more recent. Inflation: the epoch of
 * Stakewiz's newest commission entry (an empty log adds nothing: Stakewiz never saw a change) and any change in the
 * recorded history; when Stakewiz did not answer, the recorded history alone, as a lower bound. MEV: Kobe's commission
 * per epoch with the live value on top, counted from its oldest epoch when it never changed (a lower bound).
 */
export function unchangedEpochs(input: {
  epoch: number;
  inflationChangeEpoch: number | null;
  /** Stakewiz answered (an empty log included). */
  inflationLogRead: boolean;
  recordedCommission: readonly CommissionPoint[] | undefined;
  mevSeries: readonly { epoch: number; bps: number | null }[] | null;
}): number | null {
  const changes: number[] = [];
  if (input.inflationChangeEpoch !== null) changes.push(input.inflationChangeEpoch);
  const recorded = [...(input.recordedCommission ?? [])].sort((a, b) => a.epoch - b.epoch);
  if (recorded.length > 0) {
    const since = sinceLastChange(recorded.map((p) => ({ epoch: p.epoch, value: p.commissionPct })));
    if (since > recorded[0].epoch || !input.inflationLogRead) changes.push(since);
  }
  if (input.mevSeries && input.mevSeries.length > 0) {
    changes.push(sinceLastChange(input.mevSeries.map((p) => ({ epoch: p.epoch, value: p.bps }))));
  }
  if (changes.length === 0) return null;
  return Math.max(0, input.epoch - Math.max(...changes));
}

/** The first epoch of the newest run of equal values (any order in, by epoch). */
function sinceLastChange(series: readonly { epoch: number; value: number | null }[]): number {
  const ordered = [...series].sort((a, b) => b.epoch - a.epoch);
  let since = ordered[0].epoch;
  for (const point of ordered.slice(1)) {
    if (point.value !== ordered[0].value) break;
    since = point.epoch;
  }
  return since;
}

// ── Tags ─────────────────────────────────────────────────────────────────────────────────────────

export function profileTags(input: {
  row: ValidatorRow;
  version: string | null;
  stakewiz: StakewizValidator | undefined;
  epoch: number;
  foundationSharePct: number | null;
}): string[] {
  const { row, stakewiz } = input;
  const tags: string[] = [];
  const client = row.client === 'Unknown' ? null : row.client;
  const build = [client, input.version].filter(Boolean).join(' ');
  if (build) tags.push(build);
  const place = [stakewiz?.ip_city, stakewiz?.ip_country].filter(Boolean).join(', ');
  if (place) tags.push(place);
  if (stakewiz?.ip_org) tags.push(stakewiz.ip_org);
  if (row.mevCommissionPct !== null) tags.push(`Jito tips · ${row.mevCommissionPct}% fee`);
  if ((input.foundationSharePct ?? row.foundationSharePct ?? 0) > 0) tags.push('Foundation-backed');
  const first = stakewiz?.first_epoch_with_stake;
  if (first !== null && first !== undefined) tags.push(`${count(Math.max(0, input.epoch - first))} epochs active`);
  if (row.top18) tags.push('Top-18');
  return tags;
}

// ── The whole profile ────────────────────────────────────────────────────────────────────────────

export interface ProfileInputs {
  row: ValidatorRow;
  epoch: number;
  slotsInEpoch: number;
  voteFeesPerEpochSol: number;
  feePerBlockSol: number;
  grossYieldPerEpoch: number;
  /** This epoch so far: [leader slots, blocks produced]. */
  production: [number, number] | null;
  /** Blocks per epoch at this epoch's rate. */
  blocksPerEpoch: number;
  version: string | null;
  stakewiz: StakewizValidator | undefined;
  voteAccount: ParsedVoteAccount | null;
  stakeAccounts: readonly VoteStakeAccount[];
  labels: ReadonlyMap<string, DelegatorLabel>;
  foundationKeys: ReadonlySet<string>;
  toBase58: (key: string) => string;
  /** The vote account's inflation reward (lamports, null = none) per finished epoch read; others are estimated. */
  voteRewards: ReadonlyMap<number, number | null>;
  kobeHistory: KobeEpochRewards[] | null;
  stakewizStakes: { epoch: number; stake: number }[] | null;
  /** The epoch of Stakewiz's newest commission entry; null when its log is empty or it did not answer. */
  inflationChangeEpoch: number | null;
  /** Stakewiz's commission log answered (possibly empty). */
  inflationLogRead: boolean;
  recordedStake: StakePoint[] | undefined;
  recordedCommission: CommissionPoint[] | undefined;
  /** indexer_app's MEV scan for this validator (mainnet TDAs and claims), oldest first; absent without Postgres. */
  mevRecords?: readonly MevEpochRecord[];
}

export type ProfileBody = Omit<ValidatorProfile, keyof Meta>;

export function buildProfile(input: ProfileInputs): { profile: ProfileBody; notes: string[] } {
  const { row, epoch } = input;
  const lastEpoch = epoch - 1;
  const notes: string[] = [];

  const credits = voteCreditsByEpoch(input.voteAccount, epoch, input.slotsInEpoch);
  const stake = stakeByEpoch({ epoch, sol: row.stakeSol }, input.stakewizStakes, input.recordedStake);
  if (stake.points.length < STAKE_HISTORY_EPOCHS) {
    notes.push(
      `stakeByEpoch has ${stake.points.length} epochs (Stakewiz ${stake.fromStakewiz}, Epoch's recorder ` +
        `${stake.fromRecorder}, live 1); it grows to 64 as the recorder runs`,
    );
  }
  const delegation = delegationFigures(input.stakeAccounts, epoch, input.labels, input.foundationKeys, input.toBase58);

  // The vote account's inflation reward IS its inflation commission. An epoch not read yet is estimated as that
  // epoch's stake × today's gross staking yield × the commission then.
  const kobeByEpoch = new Map((input.kobeHistory ?? []).map((r) => [r.epoch, r]));
  const stakeAt = new Map(stake.points);
  const commissionAt = new Map((input.recordedCommission ?? []).map((p) => [p.epoch, p.commissionPct]));
  const estimated: number[] = [];
  const inflationFor = (e: number): number => {
    if (input.voteRewards.has(e)) return sol(input.voteRewards.get(e) ?? 0);
    estimated.push(e);
    const commissionPct = commissionAt.get(e) ?? row.commissionPct;
    return (stakeAt.get(e) ?? row.stakeSol) * input.grossYieldPerEpoch * (commissionPct / 100);
  };
  const window = Array.from({ length: REVENUE_WINDOW_EPOCHS }, (_, i) => lastEpoch - REVENUE_WINDOW_EPOCHS + 1 + i);
  const perEpoch = window.map((e) => ({
    epoch: e,
    inflationSol: inflationFor(e),
    tipsSol: tipsCommissionSol(kobeByEpoch.get(e)),
  }));
  const credit = creditEstimate(perEpoch, lastEpoch);
  const revenue = revenueForEpoch({
    inflationCommissionSol: perEpoch.find((e) => e.epoch === lastEpoch)?.inflationSol ?? 0,
    tips: kobeByEpoch.get(lastEpoch),
    blocksPerEpoch: input.blocksPerEpoch,
    feePerBlockSol: input.feePerBlockSol,
    voteFeesPerEpochSol: input.voteFeesPerEpochSol,
  });
  if (estimated.length > 0) {
    notes.push(
      `inflation commission estimated for epochs ${epochList(estimated)} (stake × gross yield × commission) until ` +
        'their getInflationReward is read',
    );
  }
  notes.push("blockFeesEstimate uses this epoch's block rate and the average fee per block in recent blocks");

  // Skipped blocks this epoch from getBlockProduction; Stakewiz's figure (also %) before the first leader slot.
  const [leaderSlots, produced] = input.production ?? [0, 0];
  const stakewizSkip = input.stakewiz?.skip_rate;
  let skipped: number | null = null;
  if (leaderSlots > 0) skipped = round(((leaderSlots - produced) / leaderSlots) * 100, 2);
  else if (stakewizSkip !== null && stakewizSkip !== undefined) skipped = round(stakewizSkip, 2);
  const mevSeries =
    input.kobeHistory && input.kobeHistory.length > 0
      ? [
          { epoch, bps: row.mevCommissionPct === null ? null : Math.round(row.mevCommissionPct * 100) },
          ...input.kobeHistory.map((r) => ({ epoch: r.epoch, bps: r.mev_commission_bps })),
        ]
      : null;

  return {
    profile: {
      name: row.name,
      vote: row.vote,
      identity: row.identity,
      tags: profileTags({
        row,
        version: input.version,
        stakewiz: input.stakewiz,
        epoch,
        foundationSharePct: delegation.foundationSharePct,
      }),
      gauges: {
        epochScore: row.epochScore,
        voteCreditsPct: voteCreditsPct(credits),
        skippedBlocksPct: skipped,
        uptime30dPct: row.uptimePct,
      },
      tiles: {
        activeStakeSol: row.stakeSol,
        stakeChangeThisEpochSol: delegation.thisEpoch.netSol,
        apyPct: row.apyPct,
        stakingApyPct: row.stakingApyPct,
        tipsApyPct: row.tipsApyPct,
        delegators: delegation.delegators,
        biggestDelegatorSharePct: delegation.biggestDelegatorSharePct,
        blocksPerDay: row.blocksPerDay,
      },
      commission: {
        inflationPct: row.commissionPct,
        jitoTipsPct: row.mevCommissionPct,
        unchangedEpochs: unchangedEpochs({
          epoch,
          inflationChangeEpoch: input.inflationChangeEpoch,
          inflationLogRead: input.inflationLogRead,
          recordedCommission: input.recordedCommission,
          mevSeries,
        }),
      },
      stakeByEpoch: stake.points,
      voteCreditsByEpoch: credits,
      jitoTipsTotalByEpochSol: tipsByEpoch(input.kobeHistory),
      mevHistory: mevHistoryRows(input.mevRecords, input.kobeHistory),
      revenueEpoch: lastEpoch,
      revenueLastEpochSol: revenue,
      delegatorSplit: delegation.split,
      ifBiggestDelegatorLeftSol: delegation.ifBiggestDelegatorLeftSol,
      medianWalletSol: delegation.medianWalletSol,
      thisEpoch: delegation.thisEpoch,
      creditEstimate: credit,
      stakeMoves: delegation.moves,
    },
    notes,
  };
}
