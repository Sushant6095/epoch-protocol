import {
  type AdvanceAccount,
  type FeeIndexAccount,
  juniorRatioBps,
  type LenderSharesAccount,
  mulDiv,
  type PoolAccount,
  sharePriceE9ToSol,
  sharesToAssets,
  type Tranche,
  type ValidatorPositionAccount,
  type WithdrawRequestAccount,
} from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { isoIst, round, shortKey } from '../../Lib/Stats';
import { type ProgramAccount } from '../../Sources/EpochProgramSource';
import { type Advance, type CycleStepKey, type VaultSnapshot } from '../../types/Program.types';
import { advanceNote, advanceStatus, limitRateBps } from './AdvanceView';
import { paramRows } from './PoolParamsView';
import { big, chainOrder, maxBig, payload, plural, ratioPct, sharePrice, toSol } from './ProgramFormat';
import { eventEpoch, type PoolHistoryPoint, type ProgramServiceDeps } from './ProgramSources';
import { loadValidatorNames } from './ValidatorNames';
import { requestEventsBySeq } from './WithdrawEvents';

const logger = Logger.create('VaultService');

/** Share price × 1e9 at par (1.0 SOL per UI share). */
export const PAR_PRICE_E9 = 1_000_000n;
const BPS = 10_000n;
const EVENT_LIMIT = 10_000;
const SERIES_POINTS = 128;
const ADVANCE_ROWS = 50;
const QUEUE_ROWS = 50;
const PAID_WINDOW_EPOCHS = 20;
const TOP_LENDERS = 5;
/** Without the EpochRewards sysvar, rewards count as paid once the epoch is this many slots old. */
export const REWARDS_FALLBACK_SLOT_INDEX = 4_000;
/** Two units of `share_price_e9`: one floor on each of the two prices compared. */
const PRICE_ROUNDING_E9 = 2n;

/** One point of the share-price and lent-out series. */
export interface SeriesPoint {
  epoch: number;
  seniorPriceE9: bigint;
  juniorPriceE9: bigint;
  lentOutPct: number;
}

/** An `Accrued` event, decoded. */
export interface Accrual {
  slot: number;
  epoch: number;
  seniorGain: bigint;
  juniorGain: bigint;
  seniorPriceE9: bigint;
  juniorPriceE9: bigint;
}

const SOURCE = (cluster: string): string =>
  `Epoch program on ${cluster}: Pool, ValidatorPosition, Advance, LenderShares, WithdrawRequest accounts and program events`;

/** `GET /v1/vault` (requests #8, #8c), also the WS `vault` channel's payload (called without a session). */
export class VaultService {
  constructor(private readonly deps: ProgramServiceDeps) {}

  async snapshot(sessionAddress?: string): Promise<VaultSnapshot> {
    const { program, events } = this.deps;
    const { address: poolAddress, account: pool } = await program.requirePool();
    const inPool = { pool: poolAddress };
    const [
      info,
      lenders,
      positions,
      advances,
      requests,
      feeIndex,
      names,
      rewardsActive,
      initialized,
      deposits,
      accrued,
      defaulted,
      processed,
    ] = await Promise.all([
      program.epochInfo(),
      program.lenders(),
      program.positions(),
      program.advances(),
      program.withdrawRequests(),
      program.feeIndex(),
      loadValidatorNames(this.deps.validators),
      this.deps.rewardsActive(),
      events.query({ names: ['PoolInitialized'], where: inPool, order: 'asc', limit: 1 }),
      events.query({ names: ['Deposited'], where: inPool, order: 'asc', limit: EVENT_LIMIT }),
      events.query({ names: ['Accrued'], where: inPool, order: 'asc', limit: EVENT_LIMIT }),
      events.query({ names: ['AdvanceDefaulted'], where: inPool, limit: 1_000 }),
      events.query({ names: ['WithdrawProcessed'], where: inPool, limit: 1_000 }),
    ]);
    const epoch = info.epoch;
    const params = pool.params;
    const epochsPerYear = names.epochsPerYear;

    const firstEvent = initialized[0] ?? deposits[0];
    const liveSinceEpoch = firstEvent ? await eventEpoch(program, firstEvent) : epoch;
    const positionByVote = new Map(positions.map((p) => [p.account.vote.toBase58(), p.account]));
    const defaultEvents = new Map<string, StoredProgramEvent>();
    for (const event of defaulted) defaultEvents.set(String(payload(event, 'AdvanceDefaulted').advance), event);
    const everDefaulted = new Set([
      ...defaultEvents.keys(),
      ...advances.filter((a) => a.account.state === 'defaulted').map((a) => a.address),
    ]);

    // ── Pool and tranches ──
    const trancheAssets = pool.seniorAssets + pool.juniorAssets;
    const totalAssets = trancheAssets + pool.incomeUnallocated;
    const lenderWallets = new Set(
      lenders.filter((l) => l.account.shares + l.account.pendingShares > 0n).map((l) => l.account.owner.toBase58()),
    );
    const juniorPrice = sharePrice(pool.juniorAssets, pool.juniorShares);
    const epochsLive = Math.max(1, epoch - liveSinceEpoch + 1);
    const coupon = couponRecord(
      accrued.map(toAccrual),
      params.seniorRateBpsPerEpoch,
      initialized.length > 0,
      deposits.find((d) => payload(d, 'Deposited').tranche === 'senior')?.slot ?? null,
    );
    const bondsUnderOpenAdvances = positions
      .filter((p) => p.account.openAdvance !== null)
      .reduce((total, p) => total + p.account.bondLamports, 0n);

    // ── Series: pool_snapshots when the recorder has rows, else replayed from program events ──
    let points: SeriesPoint[] = [];
    try {
      points = (await this.deps.history.recent(SERIES_POINTS)).map(fromHistory);
    } catch (error) {
      logger.warn('pool_snapshots unavailable; replaying events', { error: String(error) });
    }
    if (points.length === 0) {
      const window = await events.query({
        names: ['Accrued', 'Deposited', 'WithdrawProcessed', 'AdvanceDefaulted', 'AdvanceOpened', 'Swept'],
        where: inPool,
        limit: EVENT_LIMIT,
      });
      points = replayPoolHistory(window, pool, advances).slice(-SERIES_POINTS);
    }

    // ── Loan book ──
    const advanceRows = advances.map((a) => {
      const vote = a.account.vote.toBase58();
      const position = positionByVote.get(vote);
      const status = advanceStatus(a.account, position, everDefaulted.has(a.address));
      const hedged = position?.hedged ?? false;
      const closedEpoch = Number(a.account.closedEpoch);
      const row: Advance = {
        validator: names.nameOf(vote),
        vote,
        hedged,
        limitRatePct: limitRateBps(params, hedged) / 100,
        score: Math.round((position?.score ?? 0) / 100),
        borrowedSol: toSol(a.account.principal),
        owesSol: toSol(a.account.totalDue),
        repaidSol: toSol(a.account.repaid),
        bondSol: toSol(position?.bondLamports ?? 0n),
        epochsOpen: Math.max(0, (closedEpoch > 0 ? closedEpoch : epoch) - Number(a.account.openedEpoch)),
        status,
        lateEpochs: status === 'late' ? (position?.lateEpochs ?? 0) : null,
        note: advanceNote(status, a.account, position, defaultEvents.get(a.address)),
      };
      return { row, account: a.account, open: status === 'active' || status === 'late' || status === 'defaulted' };
    });
    advanceRows.sort(
      (x, y) =>
        Number(y.open) - Number(x.open) ||
        (x.open
          ? Number(y.account.principal - x.account.principal)
          : Number(y.account.closedEpoch - x.account.closedEpoch) ||
            Number(y.account.openedEpoch - x.account.openedEpoch)),
    );
    const stress = advances
      .filter((a) => a.account.state === 'open')
      .map((a) => {
        const vote = a.account.vote.toBase58();
        return {
          validator: names.nameOf(vote),
          outstanding: a.account.principal - a.account.principalRepaid,
          bond: positionByVote.get(vote)?.bondLamports ?? 0n,
        };
      })
      .sort((x, y) => Number(y.outstanding - x.outstanding));

    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(this.deps.now?.()),
      source: SOURCE(program.cluster),
      pool: {
        tvlSol: toSol(totalAssets),
        lenders: lenderWallets.size,
        liveSinceEpoch,
        outstandingPrincipalSol: toSol(pool.outstandingPrincipal),
        utilizationPct: ratioPct(pool.outstandingPrincipal, totalAssets),
        utilizationCapPct: params.maxUtilizationBps / 100,
        // Σ AdvanceDefaulted.principal_lost: mark_default emits the loss AFTER the bond (principal outstanding −
        // bond applied), which is what it writes off junior then senior; the Pool keeps the same sum.
        lostByLendersSol: toSol(pool.totalDefaulted),
        defaults: everDefaulted.size,
      },
      tranches: {
        senior: {
          assetsSol: toSol(pool.seniorAssets),
          sharePrice: sharePrice(pool.seniorAssets, pool.seniorShares),
          targetBpsPerEpoch: params.seniorRateBpsPerEpoch,
          apyPct: round((params.seniorRateBpsPerEpoch * epochsPerYear) / 100, 1),
          roomBeforeJuniorMustGrowSol: roomBeforeJuniorMustGrow(pool),
          couponMetEpochs: coupon.met,
          couponEpochsSinceLaunch: coupon.epochs,
        },
        junior: {
          assetsSol: toSol(pool.juniorAssets),
          sharePrice: juniorPrice,
          apySinceLaunchPct: round(((juniorPrice - 1) * epochsPerYear * 100) / epochsLive, 1),
          sharePctOfVault: ratioPct(pool.juniorAssets, trancheAssets),
          minSharePct: params.minJuniorBps / 100,
          lockEpochs: params.juniorLockEpochs,
          bondsUnderOpenAdvancesSol: toSol(bondsUnderOpenAdvances),
        },
      },
      series: seriesFromPoints(points, epochsPerYear, liveSinceEpoch),
      advances: advanceRows.slice(0, ADVANCE_ROWS).map((a) => a.row),
      openAdvancesForStressTest: stress.map((s) => ({
        validator: s.validator,
        outstandingPrincipalSol: toSol(s.outstanding),
        bondSol: toSol(s.bond),
      })),
      withdrawQueue: await this.queue(pool, poolAddress, epoch, requests, processed, sessionAddress),
      lenders: await this.lenderRows(pool, epoch, lenders, deposits, sessionAddress),
      cycle: {
        steps: cycleSteps({
          epoch,
          slotIndex: info.slotIndex,
          rewardsActive,
          positions: positions.map((p) => p.account),
          pool,
          requests: requests.map((r) => r.account),
          feeIndex: feeIndex?.account ?? null,
        }),
      },
      params: paramRows(params),
    };
  }

  /** Open requests (owner-cancelled ones excluded) and the ones paid in the last 20 epochs, newest first. */
  private async queue(
    pool: PoolAccount,
    poolAddress: string,
    epoch: number,
    requests: ProgramAccount<WithdrawRequestAccount>[],
    processed: StoredProgramEvent[],
    sessionAddress?: string,
  ): Promise<VaultSnapshot['withdrawQueue']> {
    const { program, events } = this.deps;
    const queued = requests.filter((r) => !r.account.cancelled);
    const paid = (
      await Promise.all(processed.map(async (event) => ({ event, at: await eventEpoch(program, event) })))
    ).filter((p) => p.at >= epoch - PAID_WINDOW_EPOCHS);
    const requested = await requestEventsBySeq(
      events,
      [
        ...queued.map((r) => r.account.seq.toString()),
        ...paid.map((p) => String(payload(p.event, 'WithdrawProcessed').seq)),
      ],
      { pool: poolAddress },
    );
    const mine = (owner: string): boolean => sessionAddress !== undefined && owner === sessionAddress;

    const rows: VaultSnapshot['withdrawQueue'] = queued.map((r) => {
      const [assets, shares] = trancheOf(pool, r.account.tranche);
      return {
        id: Number(r.account.seq),
        tranche: r.account.tranche,
        sol: toSol(sharesToAssets(r.account.shares, assets, shares)),
        askedEpoch: Number(r.account.requestedEpoch),
        status: 'queued',
        paidEpoch: null,
        signature: requested.get(r.account.seq.toString())?.signature ?? null,
        isMine: mine(r.account.owner.toBase58()),
      };
    });
    for (const { event, at } of paid) {
      const fields = payload(event, 'WithdrawProcessed');
      const request = requested.get(String(fields.seq));
      rows.push({
        id: Number(fields.seq),
        tranche: fields.tranche as Tranche,
        sol: toSol(big(fields.assets)),
        askedEpoch: request ? await eventEpoch(program, request) : at,
        status: 'paid',
        paidEpoch: at,
        signature: request?.signature ?? null,
        isMine: mine(String(fields.owner)),
      });
    }
    return rows.sort((a, b) => b.id - a.id).slice(0, QUEUE_ROWS);
  }

  /** The five biggest wallets per tranche, the session wallet as "You", then one row for everyone else. */
  private async lenderRows(
    pool: PoolAccount,
    epoch: number,
    lenders: ProgramAccount<LenderSharesAccount>[],
    deposits: StoredProgramEvent[],
    sessionAddress?: string,
  ): Promise<VaultSnapshot['lenders']> {
    const firstDeposit = new Map<string, StoredProgramEvent>();
    for (const event of deposits) {
      const fields = payload(event, 'Deposited');
      const key = `${String(fields.owner)}:${String(fields.tranche)}`;
      if (!firstDeposit.has(key)) firstDeposit.set(key, event);
    }
    const rows: VaultSnapshot['lenders'] = [];
    for (const tranche of ['junior', 'senior'] as const) {
      const [assets, shares] = trancheOf(pool, tranche);
      const members = await Promise.all(
        lenders
          .filter((l) => l.account.tranche === tranche && l.account.shares + l.account.pendingShares > 0n)
          .map(async (l) => {
            const owner = l.account.owner.toBase58();
            const held = l.account.shares + l.account.pendingShares;
            const first = firstDeposit.get(`${owner}:${tranche}`);
            const unlock = Number(l.account.lastDepositEpoch) + pool.params.juniorLockEpochs;
            return {
              owner,
              held,
              value: sharesToAssets(held, assets, shares),
              sinceEpoch: first ? await eventEpoch(this.deps.program, first) : Number(l.account.lastDepositEpoch),
              untilEpoch: tranche === 'junior' && unlock > epoch ? unlock : null,
            };
          }),
      );
      members.sort((a, b) => Number(b.held - a.held));
      const shown = members.slice(0, TOP_LENDERS);
      const you = members.slice(TOP_LENDERS).find((m) => m.owner === sessionAddress);
      if (you) shown.push(you);
      for (const m of shown) {
        rows.push({
          label: m.owner === sessionAddress ? 'You' : null,
          walletShort: shortKey(m.owner),
          tranche,
          sol: toSol(m.value),
          shareOfTranchePct: ratioPct(m.held, shares),
          sinceEpoch: m.sinceEpoch,
          untilEpoch: m.untilEpoch,
        });
      }
      const others = members.slice(TOP_LENDERS).filter((m) => m !== you);
      if (others.length > 0) {
        // Reductions, not Math.min(...list): a tranche can have more wallets than a call takes arguments.
        const until = others.reduce<number | null>(
          (latest, m) => (m.untilEpoch !== null && (latest === null || m.untilEpoch > latest) ? m.untilEpoch : latest),
          null,
        );
        rows.push({
          label: plural(others.length, 'other wallet'),
          walletShort: null,
          tranche,
          sol: toSol(others.reduce((total, m) => total + m.value, 0n)),
          shareOfTranchePct: ratioPct(
            others.reduce((total, m) => total + m.held, 0n),
            shares,
          ),
          sinceEpoch: others.reduce((earliest, m) => Math.min(earliest, m.sinceEpoch), others[0].sinceEpoch),
          untilEpoch: until,
        });
      }
    }
    return rows;
  }
}

// ── Pure parts, exported for tests ──────────────────────────────────────────────────────────────

const trancheOf = (pool: PoolAccount, tranche: Tranche): [bigint, bigint] =>
  tranche === 'senior' ? [pool.seniorAssets, pool.seniorShares] : [pool.juniorAssets, pool.juniorShares];

function toAccrual(event: StoredProgramEvent): Accrual {
  const fields = payload(event, 'Accrued');
  return {
    slot: event.slot,
    epoch: Number(fields.epoch),
    seniorGain: big(fields.seniorGain),
    juniorGain: big(fields.juniorGain),
    seniorPriceE9: big(fields.seniorPriceE9),
    juniorPriceE9: big(fields.juniorPriceE9),
  };
}

const fromHistory = (point: PoolHistoryPoint): SeriesPoint => ({
  epoch: point.epoch,
  seniorPriceE9: point.seniorPriceE9,
  juniorPriceE9: point.juniorPriceE9,
  lentOutPct: round(point.utilizationBps / 100, 2),
});

/**
 * Senior SOL that can still come in before junior must grow: the program accepts a senior deposit while
 * `junior × 10,000 ÷ (senior + junior) ≥ min_junior_bps` (`junior_floor_holds`), i.e. up to
 * `junior × (10,000 − min) ÷ min` of senior. Null when the floor is off (`min_junior_bps` = 0).
 */
export function roomBeforeJuniorMustGrow(pool: PoolAccount): number | null {
  const min = BigInt(pool.params.minJuniorBps);
  if (min === 0n) return null;
  return toSol(maxBig(0n, (pool.juniorAssets * (BPS - min)) / min - pool.seniorAssets));
}

/**
 * How many epochs paid the senior target in full. `distribute_income` pays senior `min(net income, coupon)` with
 * coupon = `bps_of(senior_assets, rate) × epochs since the last accrual`, and junior the rest, so an accrual met the
 * target when junior gained anything, or when the senior share price grew by at least `rate × Δepochs` (minus two
 * units of `share_price_e9` rounding) since the previous accrual (par before the first). Epochs, not accruals, are
 * counted: an accrual that covers two epochs counts twice. Accruals before the first senior deposit are skipped; when
 * the stored events don't reach back to `PoolInitialized`, the oldest stored accrual is only the baseline. The rate
 * is today's `senior_rate_bps_per_epoch`.
 */
export function couponRecord(
  accruals: readonly Accrual[],
  rateBps: number,
  completeHistory: boolean,
  firstSeniorDepositSlot: number | null,
): { met: number; epochs: number } {
  let met = 0;
  let epochs = 0;
  let previous: Accrual | undefined;
  const ordered = [...accruals].sort((a, b) => a.slot - b.slot);
  for (const [index, accrual] of ordered.entries()) {
    const baselineOnly = !completeHistory && index === 0;
    const afterSenior = completeHistory
      ? firstSeniorDepositSlot !== null && accrual.slot > firstSeniorDepositSlot
      : true;
    if (!baselineOnly && afterSenior) {
      const span = previous ? accrual.epoch - previous.epoch : 1;
      const before = previous?.seniorPriceE9 ?? PAR_PRICE_E9;
      const needed = (before * BigInt(rateBps) * BigInt(span)) / BPS;
      const paid = accrual.juniorGain > 0n || accrual.seniorPriceE9 - before >= needed - PRICE_ROUNDING_E9;
      epochs += span;
      if (paid) met += span;
    }
    previous = accrual;
  }
  return { met, epochs };
}

/**
 * The share-price and lent-out series, oldest first. Junior yield per point is its price growth since the previous
 * point, per epoch, times epochs a year (the first point: growth from par over the epochs since launch).
 */
export function seriesFromPoints(
  points: readonly SeriesPoint[],
  epochsPerYear: number,
  liveSinceEpoch: number,
): VaultSnapshot['series'] {
  const series: VaultSnapshot['series'] = {
    epochs: [],
    seniorSharePrice: [],
    juniorSharePrice: [],
    juniorYieldPctPerYear: [],
    lentOutPct: [],
  };
  let previous: SeriesPoint | undefined;
  for (const point of points) {
    const before = previous?.juniorPriceE9 ?? PAR_PRICE_E9;
    const span = previous ? point.epoch - previous.epoch : point.epoch - liveSinceEpoch + 1;
    const growth = before > 0n ? Number(point.juniorPriceE9) / Number(before) - 1 : 0;
    series.epochs.push(point.epoch);
    series.seniorSharePrice.push(sharePriceE9ToSol(point.seniorPriceE9));
    series.juniorSharePrice.push(sharePriceE9ToSol(point.juniorPriceE9));
    series.juniorYieldPctPerYear.push(span > 0 ? round(((growth * epochsPerYear) / span) * 100, 1) : 0);
    series.lentOutPct.push(point.lentOutPct);
    previous = point;
  }
  return series;
}

/**
 * Rebuilds the series from program events when `pool_snapshots` has no rows: prices come from each `Accrued` event;
 * lent out = outstanding principal ÷ tranche assets right after that accrual (income_unallocated is 0 then), found by
 * walking back from today's Pool and undoing every later event. The program changes tranche assets only in
 * `deposit` (+), `process_withdrawal` (−), `accrue` (+ gains) and `mark_default` (− the loss after the bond), and
 * outstanding principal only in `request_advance` (+), `sweep` (− the principal part of a remittance) and
 * `mark_default` (− principal outstanding = loss + bond applied). A remittance's principal part is split pro rata
 * from the advance's principal and fee (exact to a lamport or two); recoveries after a default are income.
 * The walk is exact for every accrual inside the stored event window, which always reaches today.
 */
export function replayPoolHistory(
  events: readonly StoredProgramEvent[],
  pool: PoolAccount,
  advances: readonly ProgramAccount<AdvanceAccount>[],
): SeriesPoint[] {
  const ordered = [...events].sort(chainOrder);
  const advanceByAddress = new Map(advances.map((a) => [a.address, a.account]));
  // Which advance each remittance paid and whether it was already written off.
  const owedBy = new Map<string, { advance?: AdvanceAccount; recovering: boolean }>();
  const paying = new Map<StoredProgramEvent, { advance?: AdvanceAccount; recovering: boolean }>();
  for (const event of ordered) {
    if (event.name === 'AdvanceOpened') {
      const fields = payload(event, 'AdvanceOpened');
      owedBy.set(String(fields.vote), { advance: advanceByAddress.get(String(fields.advance)), recovering: false });
    } else if (event.name === 'AdvanceDefaulted') {
      const fields = payload(event, 'AdvanceDefaulted');
      owedBy.set(String(fields.vote), { advance: advanceByAddress.get(String(fields.advance)), recovering: true });
    } else if (event.name === 'Swept') {
      const fields = payload(event, 'Swept');
      const vote = String(fields.vote);
      paying.set(event, owedBy.get(vote) ?? openedBefore(advances, vote, Number(fields.epoch)));
    }
  }

  let assets = pool.seniorAssets + pool.juniorAssets;
  let outstanding = pool.outstandingPrincipal;
  const points: SeriesPoint[] = [];
  for (const event of ordered.reverse()) {
    switch (event.name) {
      case 'Accrued': {
        const fields = payload(event, 'Accrued');
        points.push({
          epoch: Number(fields.epoch),
          seniorPriceE9: big(fields.seniorPriceE9),
          juniorPriceE9: big(fields.juniorPriceE9),
          lentOutPct: Math.min(100, ratioPct(outstanding, assets)),
        });
        assets -= big(fields.seniorGain) + big(fields.juniorGain);
        break;
      }
      case 'Deposited':
        assets -= big(payload(event, 'Deposited').assets);
        break;
      case 'WithdrawProcessed':
        assets += big(payload(event, 'WithdrawProcessed').assets);
        break;
      case 'AdvanceDefaulted': {
        const fields = payload(event, 'AdvanceDefaulted');
        assets += big(fields.principalLost);
        outstanding += big(fields.principalLost) + big(fields.bondApplied);
        break;
      }
      case 'AdvanceOpened':
        outstanding -= big(payload(event, 'AdvanceOpened').principal);
        break;
      case 'Swept': {
        const remitted = big(payload(event, 'Swept').remitted);
        const paid = paying.get(event);
        if (remitted > 0n && paid?.advance && !paid.recovering) {
          const { principal, fee } = paid.advance;
          outstanding += principal + fee > 0n ? remitted - mulDiv(remitted, fee, principal + fee) : 0n;
        }
        break;
      }
      default:
        break;
    }
    if (assets < 0n) assets = 0n;
    if (outstanding < 0n) outstanding = 0n;
  }
  return points.reverse();
}

/** The advance a validator was repaying in `epoch`, from the accounts (when its AdvanceOpened event is too old). */
function openedBefore(
  advances: readonly ProgramAccount<AdvanceAccount>[],
  vote: string,
  epoch: number,
): { advance?: AdvanceAccount; recovering: boolean } {
  const candidates = advances
    .map((a) => a.account)
    .filter(
      (a) =>
        a.vote.toBase58() === vote &&
        Number(a.openedEpoch) <= epoch &&
        (a.closedEpoch === 0n || epoch <= Number(a.closedEpoch)),
    )
    // Closed by this very sweep beats one opened later in the same epoch.
    .sort((a, b) => Number(a.closedEpoch === BigInt(epoch)) - Number(b.closedEpoch === BigInt(epoch)));
  const advance = candidates.at(-1);
  return { advance, recovering: advance?.state === 'defaulted' };
}

export interface CycleInput {
  epoch: number;
  slotIndex: number;
  rewardsActive: boolean | null;
  positions: readonly ValidatorPositionAccount[];
  pool: PoolAccount;
  requests: readonly WithdrawRequestAccount[];
  feeIndex: FeeIndexAccount | null;
}

const CYCLE_LABELS: Record<CycleStepKey, string> = {
  collecting: 'Collecting',
  rewards: 'Rewards finish',
  sweeps: 'Sweeps',
  accrue: 'Accrue',
  withdrawals: 'Withdrawals paid',
  index: 'Fee Index posted',
};

/**
 * True when the queue has nothing the crank could process now: it is empty, or its head waits for cash
 * (`process_withdrawal` pays whole-or-nothing). A cancelled head or one the junior floor would bounce is processable.
 */
export function withdrawalsDone(pool: PoolAccount, requests: readonly WithdrawRequestAccount[]): boolean {
  if (pool.withdrawHead >= pool.withdrawTail) return true;
  const head = requests.find((r) => r.seq === pool.withdrawHead);
  if (!head || head.cancelled) return false;
  const [assets, shares] = trancheOf(pool, head.tranche);
  const value = sharesToAssets(head.shares, assets, shares);
  if (head.tranche === 'junior' && pool.params.minJuniorBps > 0 && pool.seniorAssets > 0n) {
    const junior = pool.juniorAssets > value ? pool.juniorAssets - value : 0n;
    if (juniorRatioBps(pool.seniorAssets, junior) < BigInt(pool.params.minJuniorBps)) return false;
  }
  return pool.cash < value;
}

/**
 * This epoch's crank cycle (request #8c): collecting → rewards finish → sweeps → accrue → withdrawals paid → Fee
 * Index posted. The first boundary step not done yet is `running`, the ones after it `next`; once every boundary
 * step is done, the epoch is collecting again.
 */
export function cycleSteps(
  input: CycleInput,
): { key: CycleStepKey; label: string; status: 'done' | 'running' | 'next' }[] {
  const { epoch, pool, feeIndex } = input;
  const current = BigInt(epoch);
  const previous = BigInt(Math.max(0, epoch - 1));
  const done: Record<Exclude<CycleStepKey, 'collecting'>, boolean> = {
    rewards:
      input.rewardsActive === null ? input.slotIndex > REWARDS_FALLBACK_SLOT_INDEX : input.rewardsActive === false,
    sweeps: input.positions.filter((p) => p.status !== 'released').every((p) => p.lastSweptEpoch >= current),
    accrue: pool.lastAccruedEpoch >= current,
    withdrawals: withdrawalsDone(pool, input.requests),
    index:
      feeIndex !== null &&
      ((feeIndex.finalizedSlot > 0n && feeIndex.epoch >= previous) ||
        (feeIndex.hasProposal && feeIndex.proposedEpoch >= previous)),
  };
  const boundary = ['rewards', 'sweeps', 'accrue', 'withdrawals', 'index'] as const;
  const running = boundary.findIndex((key) => !done[key]);
  return [
    { key: 'collecting', label: CYCLE_LABELS.collecting, status: running === -1 ? 'running' : 'done' },
    ...boundary.map((key, index) => ({
      key,
      label: CYCLE_LABELS[key],
      status: (running === -1 || index < running ? 'done' : index === running ? 'running' : 'next') as
        'done' | 'running' | 'next',
    })),
  ];
}
