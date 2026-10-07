import {
  type AdvanceAccount,
  bpsOf,
  creditLimit,
  PROGRAM_CONSTANTS,
  type PoolParams,
  trailingRevenue,
  type ValidatorPositionAccount,
} from '@epoch/epoch-sdk';
import { NotFoundException, ServiceUnavailableException } from '@epoch/exceptions';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { isoIst } from '../../Lib/Stats';
import { type ProgramAccount } from '../../Sources/EpochProgramSource';
import { type ValidatorRow } from '../../types/Api.types';
import { type OperatorPosition, type OperatorPositionSnapshot, type PositionMev } from '../../types/Program.types';
import { type MevEpochRecord } from '../Validator/MevHistory';
import { advanceStatus, averageRevenue, expectedRemit, limitRateBps } from './AdvanceView';
import { PLANNED_POOL_PARAMS } from './PoolParamsView';
import { big, bpsText, ceilDiv, chainOrder, minBig, payload, solText, toLamports, toSol } from './ProgramFormat';
import { type ProgramServiceDeps } from './ProgramSources';
import { loadValidatorNames, type ValidatorNames } from './ValidatorNames';

const { MIN_REVENUE_HISTORY, REVENUE_WINDOW, DEFAULT_AFTER_LATE_EPOCHS } = PROGRAM_CONSTANTS;
/** A closed advance stays on the Manage tab for this many epochs. */
const RECENT_CLOSED_EPOCHS = 10;
/** Mainnet epochs of MEV listed when the program's epochs are not mainnet's (or before onboarding). */
const MEV_EPOCHS_SHOWN = 10;
/** Most projected rows in a schedule (`epochsLeft` stays exact). */
const MAX_PROJECTED_ROWS = 60;

type Schedule = NonNullable<OperatorPosition['advance']>['schedule'];
type Activity = NonNullable<OperatorPosition['advance']>['activity'];

/** The covenants an onboarded validator accepts (the program enforces each one). */
export function covenants(params: PoolParams): string[] {
  const list = [
    'Commission is locked while money is owed',
    'Identity is locked while money is owed',
    'The bond is locked while money is owed',
    'A defaulted validator remits 100% of new revenue until the advance is recovered',
  ];
  if (params.minCommissionBps > 0) {
    list.push(`Commission can't go below ${bpsText(params.minCommissionBps)}% while onboarded`);
  }
  return list;
}

/** The three steps of the one-transaction onboarding (`onboard_validator` + `set_collectors` + `post_bond`). */
export function onboardingSteps(params: PoolParams): OperatorPosition['onboardingSteps'] {
  return [
    {
      key: 'withdraw_authority',
      title: "Hand the vote account's withdraw authority to Epoch's escrow",
      detail: 'Rewards keep flowing to you; the escrow only takes the remit while money is owed.',
    },
    {
      key: 'collectors',
      title: 'Point block-fee and tip collectors at the escrow',
      detail: 'So repayment is taken at the source every epoch.',
    },
    {
      key: 'bond',
      title: 'Post a bond',
      detail:
        params.bondMultiplier > 0
          ? `Your limit is at most ${params.bondMultiplier} × bond; it covers the first loss if you stop paying.`
          : 'It covers the first loss if you stop paying.',
    },
  ];
}

/**
 * Commission an onboarded validator would sweep each epoch, estimated from its mainnet row with the same terms as
 * `healthPerEpochSol` (ValidatorTable): inflation commission (stake × gross yield per epoch × commission) plus MEV
 * commission (the tips stakers earn per epoch × mev ÷ (1 − mev)). Block fees stay out of limits (decision 12).
 */
export function sweepableEstimate(
  row: Pick<ValidatorRow, 'stakeSol' | 'commissionPct' | 'tipsApyPct' | 'mevCommissionPct'>,
  grossYieldPerEpoch: number,
  epochsPerYear: number,
): bigint {
  const inflation = row.stakeSol * grossYieldPerEpoch * (row.commissionPct / 100);
  const tipsToStakers = epochsPerYear > 0 ? (row.stakeSol * ((row.tipsApyPct ?? 0) / 100)) / epochsPerYear : 0;
  const mev = row.mevCommissionPct;
  const tips = mev !== null && mev < 100 ? (tipsToStakers * mev) / (100 - mev) : 0;
  return toLamports(inflation + tips);
}

/** The bond that unlocks a limit: `ceil(limit ÷ bond_multiplier)`; 0 when the bond cap is off. */
const lamportsToSol = (lamports: bigint | null): number | null =>
  lamports === null ? null : Math.round(Number(lamports) / 1e5) / 1e4;

/**
 * The position's MEV per mainnet epoch. On a mainnet program the list starts at onboarding and an epoch's commission
 * counts as swept at X + 1 once that sweep ran and the claim had landed (ClaimMevJob holds the sweep for it); elsewhere
 * the last 10 mainnet epochs are listed and nothing is marked swept.
 */
export function positionMev(
  records: readonly MevEpochRecord[] | undefined,
  options: { mainnet: boolean; onboardedEpoch: number | null; lastSweptEpoch: number | null },
): PositionMev | null {
  const tdas = (records ?? []).filter((r) => r.commissionBps !== null);
  if (tdas.length === 0) return null;
  const listed =
    options.mainnet && options.onboardedEpoch !== null
      ? tdas.filter((r) => r.epoch >= (options.onboardedEpoch as number))
      : tdas.slice(-MEV_EPOCHS_SHOWN);
  const epochs = listed.map((r) => {
    const swept =
      options.mainnet &&
      r.claim === 'claimed' &&
      options.lastSweptEpoch !== null &&
      options.lastSweptEpoch >= r.epoch + 1;
    return {
      epoch: r.epoch,
      tipsSol: lamportsToSol(r.tipsLamports),
      final: r.rootUploaded === true,
      validatorShareSol: lamportsToSol(r.validatorShareLamports),
      estimated: r.validatorShareEstimated,
      claimStatus: r.claim,
      sweptIn: swept ? r.epoch + 1 : null,
    };
  });
  // Not in the vote account yet (claim pending), plus on a mainnet program what was claimed but not swept yet.
  const pending = epochs
    .filter(
      (e) => e.claimStatus === 'pending' || (options.mainnet && e.claimStatus === 'claimed' && e.sweptIn === null),
    )
    .reduce((sum, e) => sum + (e.validatorShareSol ?? 0), 0);
  const newest = tdas[tdas.length - 1];
  return {
    commissionBps: newest.commissionBps,
    lastEpoch: epochs.length > 0 ? epochs[epochs.length - 1].epoch : null,
    epochs,
    pendingSol: Math.round(pending * 1e4) / 1e4,
  };
}

const bondFor = (limit: bigint, params: PoolParams): bigint =>
  params.bondMultiplier > 0 ? ceilDiv(limit, BigInt(params.bondMultiplier)) : 0n;

/** `GET /v1/validators/:vote/position` (request #8b): the Manage tab. */
export class OperatorPositionService {
  constructor(private readonly deps: ProgramServiceDeps) {}

  async position(vote: string): Promise<OperatorPositionSnapshot> {
    const { program } = this.deps;
    let pool: { address: string; params: PoolParams } | null = null;
    let position: ProgramAccount<ValidatorPositionAccount> | null = null;
    // An unconfigured program or a missing Pool never blocks the not-onboarded estimate: it uses the planned params.
    if (program.configured) {
      const [poolAccount, found] = await Promise.all([program.pool(), program.position(vote)]);
      pool = poolAccount ? { address: poolAccount.address, params: poolAccount.account.params } : null;
      position = found;
    }
    const params = pool?.params ?? PLANNED_POOL_PARAMS;
    const names = await loadValidatorNames(this.deps.validators);
    const why = program.configured
      ? `the Epoch Pool isn't initialized on ${program.cluster} yet`
      : "the Epoch program isn't configured on this API (EPOCH_PROGRAM_ID)";
    const meta = {
      schemaVersion: 1 as const,
      kind: pool ? ('real' as const) : ('sample' as const),
      asOf: isoIst(this.deps.now?.()),
      ...(pool ? {} : { note: `Limits use the planned Pool parameters: ${why}.` }),
    };

    if (!position) {
      const row = names.row(vote);
      if (!row) {
        if (!names.available) {
          throw new ServiceUnavailableException(
            "Mainnet validator data isn't available right now",
            'VALIDATORS_UNAVAILABLE',
          );
        }
        throw new NotFoundException('No mainnet validator or Epoch position has this vote account', { vote });
      }
      return {
        ...meta,
        source: `Mainnet RPC, Stakewiz and Jito (the estimate) and the Epoch Pool parameters on ${program.cluster}${pool ? '' : ' (planned)'}`,
        ...this.notOnboarded(vote, row, names, params),
      };
    }
    return {
      ...meta,
      source: `Epoch program on ${program.cluster}: ValidatorPosition, Advance and Pool accounts and program events`,
      ...(await this.onboarded(vote, position.account, params, pool?.address, names)),
    };
  }

  private notOnboarded(vote: string, row: ValidatorRow, names: ValidatorNames, params: PoolParams): OperatorPosition {
    const sweepable = sweepableEstimate(row, names.grossYieldPerEpoch, names.epochsPerYear);
    // What 10 swept epochs at this rate would allow with enough bond: the bond cap is what the bond fixes.
    const limitAt = (bps: number): bigint =>
      creditLimit({
        trailingRevenue: sweepable * BigInt(REVENUE_WINDOW),
        historyEpochs: REVENUE_WINDOW,
        advanceBps: bps,
        bondLamports: 0n,
        bondMultiplier: 0,
        capLamports: params.maxAdvanceLamports,
      });
    const unhedged = limitAt(params.advanceBpsUnhedged);
    const hedged = limitAt(params.advanceBpsHedged);
    return {
      vote,
      name: row.name,
      state: 'not_onboarded',
      score: row.epochScore,
      sweptEpochs: 0,
      bondSol: 0,
      limit: {
        unhedgedSol: toSol(unhedged),
        hedgedSol: toSol(hedged),
        bondForFullUnhedgedSol: toSol(bondFor(unhedged, params)),
        bondForFullHedgedSol: toSol(bondFor(hedged, params)),
        sweepablePerEpochSol: toSol(sweepable),
      },
      onboardingSteps: onboardingSteps(params),
      creditStartsAfterEpochs: MIN_REVENUE_HISTORY,
      advance: null,
      covenants: covenants(params),
      mev: positionMev(this.deps.mev?.(vote), { mainnet: false, onboardedEpoch: null, lastSweptEpoch: null }),
    };
  }

  private async onboarded(
    vote: string,
    position: ValidatorPositionAccount,
    params: PoolParams,
    poolAddress: string | undefined,
    names: ValidatorNames,
  ): Promise<OperatorPosition> {
    const { program, events } = this.deps;
    const byVote: Record<string, string> = poolAddress ? { pool: poolAddress, vote } : { vote };
    const [info, advances, opened, swept, repaid, defaulted] = await Promise.all([
      program.epochInfo(),
      program.advances(),
      events.query({ names: ['AdvanceOpened'], where: byVote, limit: 1_000 }),
      events.query({ names: ['Swept'], where: byVote, limit: 10_000 }),
      events.query({ names: ['AdvanceRepaid'], where: { vote }, limit: 1_000 }),
      events.query({ names: ['AdvanceDefaulted'], where: byVote, limit: 1_000 }),
    ]);
    const epoch = info.epoch;
    const mine = advances.filter((a) => a.account.vote.toBase58() === vote);
    const openAddress = position.openAdvance?.toBase58() ?? null;
    const open = openAddress ? mine.find((a) => a.address === openAddress) : undefined;
    const recentClosed = mine
      .filter((a) => a.address !== openAddress && a.account.state !== 'open' && a.account.closedEpoch > 0n)
      .filter((a) => Number(a.account.closedEpoch) >= epoch - RECENT_CLOSED_EPOCHS)
      .sort((a, b) => Number(b.account.seq - a.account.seq))[0];

    const trailing = trailingRevenue(position);
    const limitAt = (bps: number): bigint =>
      creditLimit({
        trailingRevenue: trailing,
        historyEpochs: position.revenueCount,
        advanceBps: bps,
        bondLamports: position.bondLamports,
        bondMultiplier: params.bondMultiplier,
        capLamports: params.maxAdvanceLamports,
      });
    const fullAt = (bps: number): bigint => bondFor(minBig(bpsOf(trailing, bps), params.maxAdvanceLamports), params);

    let state: OperatorPosition['state'] = 'onboarded';
    if (position.status === 'defaulted') state = 'defaulted';
    else if (openAddress && (!open || open.account.state === 'open')) state = 'advance_open';

    const chosen = open ?? recentClosed;
    return {
      vote,
      name: names.nameOf(vote),
      state,
      score: Math.round(position.score / 100),
      sweptEpochs: Math.max(position.revenueCount, swept.length),
      bondSol: toSol(position.bondLamports),
      limit: {
        unhedgedSol: toSol(limitAt(params.advanceBpsUnhedged)),
        hedgedSol: toSol(limitAt(params.advanceBpsHedged)),
        bondForFullUnhedgedSol: toSol(fullAt(params.advanceBpsUnhedged)),
        bondForFullHedgedSol: toSol(fullAt(params.advanceBpsHedged)),
        sweepablePerEpochSol: toSol(averageRevenue(position)),
      },
      onboardingSteps: [],
      creditStartsAfterEpochs: Math.max(0, MIN_REVENUE_HISTORY - position.revenueCount),
      advance: chosen
        ? advanceView(chosen, position, params, epoch, {
            opened: opened.find((e) => String(payload(e, 'AdvanceOpened').advance) === chosen.address),
            defaulted: defaulted.find((e) => String(payload(e, 'AdvanceDefaulted').advance) === chosen.address),
            repaid: repaid.find((e) => String(payload(e, 'AdvanceRepaid').advance) === chosen.address),
            swept,
          })
        : null,
      covenants: covenants(params),
      mev: positionMev(this.deps.mev?.(vote), {
        mainnet: program.cluster === 'mainnet',
        onboardedEpoch: Number(position.onboardedEpoch),
        lastSweptEpoch: position.lastSweptEpoch > 0n ? Number(position.lastSweptEpoch) : null,
      }),
    };
  }
}

interface AdvanceEvents {
  opened?: StoredProgramEvent;
  defaulted?: StoredProgramEvent;
  repaid?: StoredProgramEvent;
  /** Every Swept event of the validator. */
  swept: readonly StoredProgramEvent[];
}

/** The sweeps that belonged to this advance: after it opened and up to the sweep that repaid it. */
function sweepsOf(advance: AdvanceAccount, events: AdvanceEvents): StoredProgramEvent[] {
  const opened = Number(advance.openedEpoch);
  const closed = Number(advance.closedEpoch);
  return [...events.swept].sort(chainOrder).filter((event) => {
    const fields = payload(event, 'Swept');
    const at = Number(fields.epoch);
    const afterOpen = events.opened
      ? event.slot > events.opened.slot
      : at > opened || (at === opened && big(fields.remitted) > 0n);
    const beforeClose = events.repaid ? event.slot <= events.repaid.slot : closed === 0 || at <= closed;
    return afterOpen && beforeClose;
  });
}

/**
 * The advance card: amounts, the remit schedule and the activity list.
 *
 * Schedule: one row per past sweep (`paid`, or `late` when it found no revenue) with the balance after it, then — while
 * money is owed — the `due` row (this epoch, or the next one when this epoch's sweep already ran) and `upcoming` rows,
 * each remitting `min(owed, expected remit)` with expected remit = `remit_bps` of the average swept revenue (all of it
 * once defaulted), until repaid. `epochsLeft` = ceil(owed ÷ expected remit), the number of due and upcoming rows. With
 * no revenue in the window there is nothing to project: the due row remits 0 and `epochsLeft` is the epochs until the
 * advance may be written off for age (`opened + max_advance_epochs − now`, at least 0).
 */
export function advanceView(
  chosen: ProgramAccount<AdvanceAccount>,
  position: ValidatorPositionAccount,
  params: PoolParams,
  epoch: number,
  events: AdvanceEvents,
): NonNullable<OperatorPosition['advance']> {
  const advance = chosen.account;
  const everDefaulted = advance.state === 'defaulted' || events.defaulted !== undefined;
  const status = advanceStatus(advance, position, everDefaulted);
  const owed = advance.totalDue > advance.repaid ? advance.totalDue - advance.repaid : 0n;
  const recovering = advance.state === 'defaulted';
  const sweeps = sweepsOf(advance, events);
  const defaultSlot = events.defaulted?.slot ?? null;
  const bondApplied = events.defaulted ? big(payload(events.defaulted, 'AdvanceDefaulted').bondApplied) : 0n;

  // Past rows, balances walked back from today's balance (the bond applied at default counts between two sweeps).
  const past: Schedule = [];
  let after = owed;
  let bondCounted = false;
  for (const event of [...sweeps].reverse()) {
    if (defaultSlot !== null && !bondCounted && event.slot < defaultSlot) {
      after += bondApplied;
      bondCounted = true;
    }
    const fields = payload(event, 'Swept');
    const remitted = big(fields.remitted);
    past.unshift({
      epoch: Number(fields.epoch),
      remitSol: toSol(remitted),
      endingSol: toSol(after),
      status: big(fields.gross) === 0n ? 'late' : 'paid',
    });
    after += remitted;
  }

  // Projection while money is owed.
  const projected: Schedule = [];
  let epochsLeft = 0;
  if (owed > 0n && (status === 'active' || status === 'late' || status === 'defaulted')) {
    const perEpoch = expectedRemit(advance, position);
    const due = Number(position.lastSweptEpoch) >= epoch ? epoch + 1 : epoch;
    if (perEpoch === 0n) {
      projected.push({ epoch: due, remitSol: 0, endingSol: toSol(owed), status: 'due' });
      epochsLeft = Math.max(0, Number(advance.openedEpoch) + params.maxAdvanceEpochs - epoch);
    } else {
      epochsLeft = Number(ceilDiv(owed, perEpoch));
      let left = owed;
      for (let i = 0; left > 0n && i < MAX_PROJECTED_ROWS; i++) {
        const remit = minBig(left, perEpoch);
        left -= remit;
        projected.push({
          epoch: due + i,
          remitSol: toSol(remit),
          endingSol: toSol(left),
          status: i === 0 ? 'due' : 'upcoming',
        });
      }
    }
  }

  // Activity, in chain order.
  const remitPct = advance.remitBps / 100;
  const activity: { slot: number; entry: Activity[number] }[] = [
    {
      slot: events.opened?.slot ?? -1,
      entry: {
        epoch: Number(advance.openedEpoch),
        kind: 'advance',
        text: `Drew ${solText(advance.principal)} SOL (${solText(advance.fee)} SOL fee)`,
        amountSol: toSol(advance.principal),
        signature: events.opened?.signature ?? null,
      },
    },
  ];
  let lateRun = 0;
  for (const event of sweeps) {
    const fields = payload(event, 'Swept');
    const gross = big(fields.gross);
    const remitted = big(fields.remitted);
    const afterDefault = defaultSlot !== null && event.slot > defaultSlot;
    let entry: Activity[number];
    if (gross === 0n) {
      lateRun = afterDefault ? 0 : lateRun + 1;
      entry = {
        epoch: Number(fields.epoch),
        kind: 'late',
        text: afterDefault
          ? 'No revenue to sweep'
          : `No revenue to sweep: late ${lateRun} of ${DEFAULT_AFTER_LATE_EPOCHS}`,
        amountSol: 0,
        signature: event.signature,
      };
    } else {
      lateRun = 0;
      let text = `Remitted at the source (${remitPct}% of ${solText(gross)} SOL)`;
      if (afterDefault) text = `Recovered at the source (100% of ${solText(gross)} SOL)`;
      else if (remitted < bpsOf(gross, advance.remitBps)) {
        text = `Last remittance at the source (${solText(remitted)} SOL of ${solText(gross)} SOL)`;
      }
      entry = {
        epoch: Number(fields.epoch),
        kind: 'sweep',
        text,
        amountSol: toSol(remitted),
        signature: event.signature,
      };
    }
    activity.push({ slot: event.slot, entry });
  }
  if (events.defaulted) {
    const fields = payload(events.defaulted, 'AdvanceDefaulted');
    const lost = big(fields.principalLost);
    activity.push({
      slot: events.defaulted.slot,
      entry: {
        epoch: Number(fields.epoch),
        kind: 'late',
        text:
          bondApplied > 0n
            ? `Defaulted: bond applied (${solText(bondApplied)} SOL), ${solText(lost)} SOL written off`
            : `Defaulted: ${solText(lost)} SOL written off`,
        amountSol: toSol(bondApplied),
        signature: events.defaulted.signature,
      },
    });
  }
  if (advance.state === 'repaid') {
    activity.push({
      slot: events.repaid?.slot ?? Number.MAX_SAFE_INTEGER,
      entry: {
        epoch: events.repaid ? Number(payload(events.repaid, 'AdvanceRepaid').epoch) : Number(advance.closedEpoch),
        kind: 'repaid',
        text: everDefaulted ? 'Recovered in full' : 'Repaid in full',
        amountSol: toSol(advance.repaid),
        signature: events.repaid?.signature ?? null,
      },
    });
  }
  activity.sort((a, b) => a.slot - b.slot);

  const hedged = position.hedged;
  return {
    openedEpoch: Number(advance.openedEpoch),
    hedged,
    limitRatePct: limitRateBps(params, hedged) / 100,
    borrowedSol: toSol(advance.principal),
    feeSol: toSol(advance.fee),
    owesSol: toSol(advance.totalDue),
    repaidSol: toSol(advance.repaid),
    remainingSol: toSol(owed),
    remitPct: recovering ? 100 : remitPct,
    status,
    epochsLeft,
    schedule: [...past, ...projected],
    activity: activity.map((a) => a.entry),
  };
}
