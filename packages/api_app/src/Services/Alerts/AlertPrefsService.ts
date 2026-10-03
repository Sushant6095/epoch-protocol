import { randomBytes } from 'crypto';

import { ServiceUnavailableException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import { type AlertReminder, alertPrefs, type AlertRules, type EpochDb, telegramLinks } from '@epoch/pg_models';
import { eq, sql } from 'drizzle-orm';

import { RateLimiter } from '../../Lib/RateLimiter';
import { isoIst, shortKey } from '../../Lib/Stats';
import {
  type AlertPrefs,
  type AlertTestResult,
  type AlertTestStatus,
  type TelegramLink,
} from '../../types/Account.types';
import { DEFAULT_ALERT_RULES, testAlert } from './AlertRules';
import { ALERT_CHANNELS, type AlertSenders } from './AlertSenders';

const logger = Logger.create('AlertPrefsService');

export const TELEGRAM_LINK_TTL_MS = 15 * 60_000;

/** PUT /v1/me/alerts body after validation. Absent `channels.email` / `channels.telegram` / `reminders` keep theirs. */
export interface AlertPrefsInput {
  rules: AlertRules;
  channels?: { email?: string | null; telegram?: string | null };
  reminders?: AlertReminder[];
}

export interface AlertPrefsServiceDeps {
  db: () => EpochDb;
  senders: AlertSenders;
  /** The bot's @username for t.me links; links answer 503 TELEGRAM_NOT_CONFIGURED without it and the token. */
  telegramBotUsername?: string;
  appUrl: string;
  now?: () => number;
}

type PrefsRow = typeof alertPrefs.$inferSelect;

const toView = (row: Pick<PrefsRow, 'rules' | 'email' | 'telegram' | 'reminders'> | undefined): AlertPrefs => ({
  rules: { ...DEFAULT_ALERT_RULES, ...(row?.rules ?? {}) },
  channels: { email: row?.email ?? null, telegram: row?.telegram ?? null },
  reminders: Array.isArray(row?.reminders) ? row.reminders : [],
});

/** A wallet's alert rules, channels and move reminders (request #15), the Telegram link codes and the test send. */
export class AlertPrefsService {
  private readonly now: () => number;
  private readonly linkLimiter: RateLimiter;
  private readonly testLimiter: RateLimiter;

  constructor(private readonly deps: AlertPrefsServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.linkLimiter = new RateLimiter(10, 10 * 60_000, this.now);
    this.testLimiter = new RateLimiter(5, 10 * 60_000, this.now);
  }

  /** The defaults when the wallet never saved any: offline, fee up and losing money on, rewards off, no channel. */
  async get(address: string): Promise<AlertPrefs> {
    const [row] = await this.deps.db().select().from(alertPrefs).where(eq(alertPrefs.address, address));
    return toView(row);
  }

  /** Saves rules, channels and reminders; `state` (the sender job's memory) is kept. */
  async put(address: string, input: AlertPrefsInput): Promise<AlertPrefs> {
    return this.deps.db().transaction(async (tx) => {
      const [existing] = await tx.select().from(alertPrefs).where(eq(alertPrefs.address, address)).for('update');
      const channels = input.channels ?? {};
      const next = {
        rules: { ...input.rules },
        email: 'email' in channels ? (channels.email ?? null) : (existing?.email ?? null),
        telegram: 'telegram' in channels ? (channels.telegram ?? null) : (existing?.telegram ?? null),
        reminders: input.reminders ?? (Array.isArray(existing?.reminders) ? existing.reminders : []),
      };
      await tx
        .insert(alertPrefs)
        .values({ address, ...next, state: {} })
        .onConflictDoUpdate({ target: alertPrefs.address, set: { ...next, updatedAt: sql`now()` } });
      return toView(next);
    });
  }

  /** POST /v1/me/alerts/telegram-link: a one-time code (15 min) the bot binds to this wallet on `/start <code>`. */
  async createTelegramLink(address: string): Promise<TelegramLink> {
    const username = this.deps.telegramBotUsername?.replace(/^@/, '');
    if (!this.deps.senders.telegram.configured || !username) {
      throw new ServiceUnavailableException(
        'Telegram alerts are not set up on this API: set TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME',
        'TELEGRAM_NOT_CONFIGURED',
      );
    }
    this.linkLimiter.consume(`link:${address}`, 'Too many Telegram links for this wallet; wait a few minutes');
    // 18 random bytes → 24 base64url characters, inside Telegram's start-parameter alphabet [A-Za-z0-9_-].
    const code = randomBytes(18).toString('base64url');
    const expiresAt = new Date(this.now() + TELEGRAM_LINK_TTL_MS);
    await this.deps.db().insert(telegramLinks).values({ code, address, expiresAt });
    return { url: `https://t.me/${username}?start=${code}`, code, expiresAt: isoIst(expiresAt) };
  }

  /** POST /v1/me/alerts/test: "Test alert from Epoch" to each channel the wallet set and the API can send to. */
  async sendTest(address: string): Promise<AlertTestResult> {
    this.testLimiter.consume(`test:${address}`, 'Too many test alerts for this wallet; wait a few minutes');
    const prefs = await this.get(address);
    const message = testAlert(address, this.deps.appUrl, this.now());
    const result: AlertTestResult = { email: 'skipped', telegram: 'skipped' };
    await Promise.all(
      ALERT_CHANNELS.map(async (channel) => {
        const to = prefs.channels[channel];
        const sender = this.deps.senders[channel];
        let status: AlertTestStatus = 'skipped';
        if (to && sender.configured) {
          try {
            await sender.send(to, message);
            status = 'sent';
          } catch (error) {
            logger.warn('test alert failed', { channel, wallet: shortKey(address), error: String(error) });
            status = 'failed';
          }
        }
        result[channel] = status;
      }),
    );
    return result;
  }
}
