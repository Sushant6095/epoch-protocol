import { type AlertReminder, type AlertRules } from '@epoch/pg_models';

import { round, shortKey } from '../../Lib/Stats';

// Pure alert logic for the sender job (request #15): which alerts a wallet gets this run and with what words. The job
// (AlertJob) does the I/O around it. Titles and descriptions follow the My Stake alerts card (my-stake.demo.json).

/** alert_deliveries.kind: the My Stake alert keys, plus the move reminder and the test message. */
export type AlertKind = 'offline' | 'fee' | 'breakeven' | 'rewards' | 'reminder' | 'test';

export interface AlertMessage {
  kind: AlertKind;
  /** Unique per wallet and channel in alert_deliveries: a rerun never sends the same alert twice. */
  dedupeKey: string;
  title: string;
  body: string;
  /** Where to act on it in the app (APP_PUBLIC_URL + /me or /validators/<vote>). */
  link: string;
}

/** The validator fields the rules read (a ValidatorTable row). */
export interface ValidatorFacts {
  vote: string;
  name: string;
  commissionPct: number;
  /** null: not running Jito. */
  mevCommissionPct: number | null;
  /** SOL kept per epoch after vote fees; negative = losing money. */
  healthPerEpochSol: number;
  delinquent: boolean;
}

/** alert_prefs.state: the job's memory for one wallet. */
export interface AlertState {
  /** Commission and MEV commission last seen per vote (feeUp compares against them). */
  fees?: Record<string, { commissionPct: number; mevCommissionPct: number | null }>;
  /** The mainnet epoch whose rewards check is done (rewardsLanded). */
  rewardsEpoch?: number;
}

export const DEFAULT_ALERT_RULES: AlertRules = { offline: true, feeUp: true, losingMoney: true, rewardsLanded: false };

/** "Delinquent for more than 10 minutes" (my-stake.demo.json). */
export const OFFLINE_AFTER_MS = 10 * 60_000;

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reads alert_prefs.state defensively (it is jsonb): unknown or malformed parts are dropped. */
export function readAlertState(raw: unknown): AlertState {
  const out: AlertState = {};
  if (!raw || typeof raw !== 'object') return out;
  const { fees, rewardsEpoch } = raw as Record<string, unknown>;
  if (isNumber(rewardsEpoch)) out.rewardsEpoch = rewardsEpoch;
  if (fees && typeof fees === 'object') {
    out.fees = {};
    for (const [vote, value] of Object.entries(fees as Record<string, unknown>)) {
      const fee = value as { commissionPct?: unknown; mevCommissionPct?: unknown } | null;
      if (!fee || !isNumber(fee.commissionPct)) continue;
      out.fees[vote] = {
        commissionPct: fee.commissionPct,
        mevCommissionPct: isNumber(fee.mevCommissionPct) ? fee.mevCommissionPct : null,
      };
    }
  }
  return out;
}

/**
 * Offline needs two checks at least `minMs` apart that both saw the vote delinquent. `firstSeen` maps vote → when it
 * was first seen delinquent in the current streak; votes that vote again drop out of it.
 */
export function trackDelinquency(
  firstSeen: ReadonlyMap<string, number>,
  delinquentVotes: Iterable<string>,
  now: number,
  minMs = OFFLINE_AFTER_MS,
): { firstSeen: Map<string, number>; offline: Set<string> } {
  const next = new Map<string, number>();
  const offline = new Set<string>();
  for (const vote of delinquentVotes) {
    const since = firstSeen.get(vote) ?? now;
    next.set(vote, since);
    if (now - since >= minMs) offline.add(vote);
  }
  return { firstSeen: next, offline };
}

const pct = (value: number): string => `${round(value, 2)}%`;

/** SOL with up to 6 decimals below 1 SOL, 3 above, trailing zeros dropped. */
export function formatSol(value: number): string {
  const fixed = value.toFixed(Math.abs(value) >= 1 ? 3 : 6);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

const appLink = (appUrl: string, path: string): string => `${appUrl.replace(/\/+$/, '')}${path}`;

export interface WalletAlertInput {
  /** Mainnet epoch now (dedupe keys are per epoch). */
  epoch: number;
  rules: AlertRules;
  /** Validators the wallet's active stake accounts delegate to. */
  votes: readonly string[];
  validators: ReadonlyMap<string, ValidatorFacts>;
  /** Votes delinquent in two checks at least 10 minutes apart (trackDelinquency). */
  offline: ReadonlySet<string>;
  state: AlertState;
  reminders: readonly AlertReminder[];
  appUrl: string;
}

export interface WalletAlertResult {
  alerts: AlertMessage[];
  /** `state` with this run's commissions recorded; the rewards epoch is left to the caller. */
  state: AlertState;
  /** Reminders whose epoch has come; each has its alert in `alerts`. */
  dueReminders: AlertReminder[];
}

/**
 * The validator rules (offline, fee up, losing money) and due move reminders for one wallet. Commissions are recorded
 * whether or not feeUp is on, so turning it on later compares against fresh values; the first sight of a validator
 * only records.
 */
export function evaluateWalletAlerts(input: WalletAlertInput): WalletAlertResult {
  const { epoch, rules, appUrl } = input;
  const alerts: AlertMessage[] = [];
  const fees: NonNullable<AlertState['fees']> = {};

  for (const vote of new Set(input.votes)) {
    const validator = input.validators.get(vote);
    if (!validator) continue;
    const link = appLink(appUrl, `/validators/${vote}`);

    if (rules.offline && input.offline.has(vote)) {
      alerts.push({
        kind: 'offline',
        dedupeKey: `offline:${vote}:${epoch}`,
        title: 'Validator goes offline',
        body: `${validator.name} has been delinquent for more than 10 minutes: it is not voting, so your stake there earns nothing until it is back.`,
        link,
      });
    }

    const before = input.state.fees?.[vote];
    const now = { commissionPct: validator.commissionPct, mevCommissionPct: validator.mevCommissionPct };
    fees[vote] = now;
    if (rules.feeUp && before) {
      const raised: string[] = [];
      if (now.commissionPct > before.commissionPct) {
        raised.push(`its commission from ${pct(before.commissionPct)} to ${pct(now.commissionPct)}`);
      }
      if (now.mevCommissionPct !== null && before.mevCommissionPct !== null) {
        if (now.mevCommissionPct > before.mevCommissionPct) {
          raised.push(`its MEV fee from ${pct(before.mevCommissionPct)} to ${pct(now.mevCommissionPct)}`);
        }
      }
      if (raised.length > 0) {
        alerts.push({
          kind: 'fee',
          dedupeKey: `fee:${vote}:${epoch}`,
          title: 'Fee goes up',
          body: `${validator.name} raised ${raised.join(' and ')}. You keep less of what your stake earns there.`,
          link,
        });
      }
    }

    if (rules.losingMoney && validator.healthPerEpochSol < 0) {
      alerts.push({
        kind: 'breakeven',
        dedupeKey: `breakeven:${vote}:${epoch}`,
        title: 'Validator starts losing money',
        body: `${validator.name} earns less than its vote fees (${formatSol(validator.healthPerEpochSol)} SOL kept per epoch). Validators below break-even often raise fees or shut down.`,
        link,
      });
    }
  }

  const dueReminders = input.reminders.filter((reminder) => reminder.epoch <= epoch);
  for (const reminder of dueReminders) {
    alerts.push({
      kind: 'reminder',
      dedupeKey: `reminder:${reminder.stakeAccount}:${reminder.epoch}`,
      title: 'Step 2 of your stake move',
      body: `Step 2 of your stake move: epoch ${reminder.epoch} has started, so stake account ${shortKey(reminder.stakeAccount)} has finished deactivating. Delegate it to its new validator (or withdraw it) on My Stake.`,
      link: appLink(appUrl, '/me'),
    });
  }

  return { alerts, state: { ...input.state, fees }, dueReminders };
}

/** "Rewards landed: X SOL for epoch N", or null when nothing landed. */
export function rewardsAlert(rewardEpoch: number, lamports: number, appUrl: string): AlertMessage | null {
  if (!(lamports > 0)) return null;
  return {
    kind: 'rewards',
    dedupeKey: `rewards:${rewardEpoch}`,
    title: 'Rewards landed',
    body: `Rewards landed: ${formatSol(lamports / 1e9)} SOL for epoch ${rewardEpoch}.`,
    link: appLink(appUrl, '/me'),
  };
}

/** The message POST /v1/me/alerts/test sends. */
export function testAlert(address: string, appUrl: string, now: number): AlertMessage {
  return {
    kind: 'test',
    dedupeKey: `test:${now}`,
    title: 'Test alert from Epoch',
    body: `Alerts for ${shortKey(address)} will arrive here.`,
    link: appLink(appUrl, '/me#alerts'),
  };
}
