import { Logger } from '@epoch/logger';
import { alertDeliveries, alertPrefs, type AlertReminder, type EpochDb } from '@epoch/pg_models';
import { eq, isNotNull, or, sql } from 'drizzle-orm';

import { PeriodicJob } from '../../Lib/PeriodicJob';
import { type StakeAccountInfo, U64_MAX } from '../../Lib/StakeLayouts';
import { shortKey } from '../../Lib/Stats';
import { type InflationReward } from '../../Sources/SolanaDataSource';
import {
  type AlertMessage,
  type AlertState,
  evaluateWalletAlerts,
  readAlertState,
  rewardsAlert,
  trackDelinquency,
  type ValidatorFacts,
} from './AlertRules';
import { ALERT_CHANNELS, type AlertChannel, type AlertSenders } from './AlertSenders';

const logger = Logger.create('AlertJob');

/** Rewards are paid in the first blocks of an epoch; wait this far in before reading them (≈ 7 minutes). */
export const REWARDS_SETTLE_SLOTS = 1_000;
const STAKE_CACHE_MS = 30 * 60_000;
const WALLET_CONCURRENCY = 4;

/** Everything the job reads from outside the database (getServices() in production, fakes in tests). */
export interface AlertJobDeps {
  db: () => EpochDb;
  /** Mainnet validator rows and the epoch they describe (ValidatorTable). */
  validators: () => Promise<{ epoch: { epoch: number; slotIndex: number }; rows: ValidatorFacts[] }>;
  /** A wallet's mainnet stake accounts (staker or withdrawer). */
  stakeAccounts: (address: string) => Promise<StakeAccountInfo[]>;
  /** getInflationReward for these stake accounts in `epoch`. */
  inflationRewards: (addresses: string[], epoch: number) => Promise<(InflationReward | null)[]>;
  senders: AlertSenders;
  appUrl: string;
  /** ALERTS_CHECK_MINUTES. */
  intervalMs: number;
  now?: () => number;
}

export type DeliveryStatus = 'sent' | 'failed' | 'duplicate' | 'skipped';

export interface AlertRunSummary {
  epoch: number;
  wallets: number;
  sent: number;
  failed: number;
  duplicates: number;
}

type PrefsRow = typeof alertPrefs.$inferSelect;

/** Accounts still earning or on their way out (deactivation not finished before this epoch). */
const activeVotes = (accounts: readonly StakeAccountInfo[], epoch: number): string[] =>
  accounts
    .filter(
      (account) =>
        account.state === 'delegated' &&
        account.voter !== null &&
        (account.deactivationEpoch === null ||
          account.deactivationEpoch === U64_MAX ||
          account.deactivationEpoch >= BigInt(epoch)),
    )
    .map((account) => account.voter as string);

/**
 * Sends alerts (request #15): every ALERTS_CHECK_MINUTES, for each wallet with a channel the API can send to (email
 * needs SMTP_URL, Telegram TELEGRAM_BOT_TOKEN) and a rule or reminder on,
 * reads its mainnet stake accounts (cached 30 min), applies the rules in AlertRules to the validators it stakes with,
 * checks rewards once per new epoch and sends due move reminders. Each delivery inserts its alert_deliveries row first
 * (unique per wallet, dedupe key and channel), so a rerun or a second process never sends the same alert twice.
 */
export class AlertJob {
  private firstSeenDelinquent = new Map<string, number>();
  private readonly stakeCache = new Map<string, { at: number; accounts: StakeAccountInfo[] }>();
  private readonly now: () => number;
  private readonly job: PeriodicJob;

  constructor(private readonly deps: AlertJobDeps) {
    this.now = deps.now ?? Date.now;
    this.job = new PeriodicJob('alerts', deps.intervalMs, () => this.runOnce(), 30_000);
  }

  start(): void {
    this.job.start();
  }

  stop(): Promise<void> {
    return this.job.stop();
  }

  async runOnce(): Promise<AlertRunSummary> {
    const table = await this.deps.validators();
    const epoch = table.epoch.epoch;
    const tracked = trackDelinquency(
      this.firstSeenDelinquent,
      table.rows.filter((row) => row.delinquent).map((row) => row.vote),
      this.now(),
    );
    this.firstSeenDelinquent = tracked.firstSeen;
    const validators = new Map(table.rows.map((row) => [row.vote, row]));

    const rows = await this.deps
      .db()
      .select()
      .from(alertPrefs)
      .where(or(isNotNull(alertPrefs.email), isNotNull(alertPrefs.telegram)));
    const summary: AlertRunSummary = { epoch, wallets: 0, sent: 0, failed: 0, duplicates: 0 };
    const { senders } = this.deps;
    // Only wallets with a rule or reminder on and a channel this API can send to (no stake reads for the rest).
    const queue = rows.filter(
      (row) =>
        ((row.email && senders.email.configured) || (row.telegram && senders.telegram.configured)) &&
        (Object.values(row.rules ?? {}).some(Boolean) || (Array.isArray(row.reminders) && row.reminders.length > 0)),
    );
    summary.wallets = queue.length;

    const worker = async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        try {
          const statuses = await this.runWallet(row, epoch, table.epoch.slotIndex, validators, tracked.offline);
          for (const status of statuses) {
            if (status === 'sent') summary.sent++;
            else if (status === 'failed') summary.failed++;
            else if (status === 'duplicate') summary.duplicates++;
          }
        } catch (error) {
          logger.warn('alerts for one wallet failed; next run retries', {
            wallet: shortKey(row.address),
            error: String(error),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: WALLET_CONCURRENCY }, worker));
    if (summary.sent || summary.failed) logger.info('alerts run', { ...summary });
    return summary;
  }

  private async runWallet(
    row: PrefsRow,
    epoch: number,
    slotIndex: number,
    validators: ReadonlyMap<string, ValidatorFacts>,
    offline: ReadonlySet<string>,
  ): Promise<DeliveryStatus[]> {
    const rules = row.rules;
    const reminders: AlertReminder[] = Array.isArray(row.reminders) ? row.reminders : [];
    const needsStake = rules.offline || rules.feeUp || rules.losingMoney || rules.rewardsLanded;
    const accounts = needsStake ? await this.stakeAccountsOf(row.address) : [];
    const before = readAlertState(row.state);
    const result = evaluateWalletAlerts({
      epoch,
      rules,
      votes: activeVotes(accounts, epoch),
      validators,
      offline,
      state: before,
      reminders,
      appUrl: this.deps.appUrl,
    });
    const alerts = [...result.alerts];
    const state: AlertState = { ...result.state };

    // Rewards: once per new epoch. First sight, or the rule off, only records the epoch.
    if (!rules.rewardsLanded || before.rewardsEpoch === undefined) {
      state.rewardsEpoch = epoch;
    } else if (before.rewardsEpoch < epoch && slotIndex >= REWARDS_SETTLE_SLOTS) {
      const rewardEpoch = epoch - 1;
      const rewards = accounts.length
        ? await this.deps.inflationRewards(
            accounts.map((account) => account.pubkey),
            rewardEpoch,
          )
        : [];
      const lamports = rewards.reduce((total, reward) => total + (reward?.amount ?? 0), 0);
      const alert = rewardsAlert(rewardEpoch, lamports, this.deps.appUrl);
      if (alert) alerts.push(alert);
      state.rewardsEpoch = epoch;
    }

    const statuses: DeliveryStatus[] = [];
    const delivered = new Set<string>();
    for (const alert of alerts) {
      for (const channel of ALERT_CHANNELS) {
        const status = await this.deliver(row, alert, channel);
        statuses.push(status);
        if (status !== 'skipped') delivered.add(alert.dedupeKey);
      }
    }

    const db = this.deps.db();
    // Merge only the keys this job owns, so anything else kept in state survives.
    const patch: AlertState = { fees: state.fees ?? {}, rewardsEpoch: state.rewardsEpoch };
    await db
      .update(alertPrefs)
      .set({ state: sql`coalesce(${alertPrefs.state}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(alertPrefs.address, row.address));
    // Remove each due reminder that reached a channel, in place, so a PUT that added one meanwhile is kept.
    for (const reminder of result.dueReminders) {
      if (!delivered.has(`reminder:${reminder.stakeAccount}:${reminder.epoch}`)) continue;
      await db.execute(sql`
        UPDATE ${alertPrefs}
        SET reminders = coalesce((
          SELECT jsonb_agg(item ORDER BY position)
          FROM jsonb_array_elements(${alertPrefs.reminders}) WITH ORDINALITY AS r(item, position)
          WHERE NOT (item->>'stakeAccount' = ${reminder.stakeAccount} AND (item->>'epoch')::bigint = ${reminder.epoch})
        ), '[]'::jsonb)
        WHERE ${alertPrefs.address} = ${row.address}`);
    }
    return statuses;
  }

  /** Inserts the delivery row first (ON CONFLICT DO NOTHING), sends, then records sent or failed with the reason. */
  private async deliver(row: PrefsRow, alert: AlertMessage, channel: AlertChannel): Promise<DeliveryStatus> {
    const to = channel === 'email' ? row.email : row.telegram;
    const sender = this.deps.senders[channel];
    if (!to || !sender.configured) return 'skipped';
    const db = this.deps.db();
    const [claimed] = await db
      .insert(alertDeliveries)
      .values({ address: row.address, dedupeKey: alert.dedupeKey, kind: alert.kind, channel, status: 'sending' })
      .onConflictDoNothing()
      .returning({ id: alertDeliveries.id });
    if (!claimed) return 'duplicate';
    try {
      await sender.send(to, alert);
      await db.update(alertDeliveries).set({ status: 'sent' }).where(eq(alertDeliveries.id, claimed.id));
      return 'sent';
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await db
        .update(alertDeliveries)
        .set({ status: 'failed', error: reason })
        .where(eq(alertDeliveries.id, claimed.id));
      logger.warn('alert delivery failed', { wallet: shortKey(row.address), kind: alert.kind, channel, error: reason });
      return 'failed';
    }
  }

  private async stakeAccountsOf(address: string): Promise<StakeAccountInfo[]> {
    const now = this.now();
    const cached = this.stakeCache.get(address);
    if (cached && now - cached.at < STAKE_CACHE_MS) return cached.accounts;
    const accounts = await this.deps.stakeAccounts(address);
    if (this.stakeCache.size > 10_000) this.stakeCache.clear();
    this.stakeCache.set(address, { at: now, accounts });
    return accounts;
  }
}
