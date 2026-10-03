import { Logger } from '@epoch/logger';
import { alertPrefs, type EpochDb, telegramLinks } from '@epoch/pg_models';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import { shortKey } from '../../Lib/Stats';
import { DEFAULT_ALERT_RULES } from './AlertRules';
import { type TelegramClient, type TelegramUpdate } from './TelegramClient';

const logger = Logger.create('TelegramLinker');

/** `/start`, `/start <code>` or `/start@bot <code>`. */
const START = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/;

export const LINKED_TEXT = (address: string): string =>
  `Connected: Epoch alerts for ${shortKey(address)} will arrive here.`;
export const LINK_EXPIRED_TEXT =
  'This link has expired or was already used. In Epoch, open My Stake → Alerts and connect Telegram again.';
export const START_HELP_TEXT = 'To get Epoch alerts here, open My Stake → Alerts in Epoch and choose Telegram.';

export interface TelegramLinkerOptions {
  /** getUpdates long-poll timeout. */
  pollSeconds: number;
  /** Wait after a failed poll (network down, 409 because another process polls the same bot). */
  retryDelayMs: number;
}

const DEFAULTS: TelegramLinkerOptions = { pollSeconds: 50, retryDelayMs: 15_000 };

/**
 * Long-polls the bot's getUpdates (only when TELEGRAM_BOT_TOKEN is set) and binds a chat to a wallet when someone
 * presses Start on a link from POST /v1/me/alerts/telegram-link: `/start <code>` → alert_prefs.telegram = chat id.
 * Telegram allows one getUpdates consumer per bot: run the linker in one API process only.
 */
export class TelegramLinker {
  private offset?: number;
  private running = false;
  private abort?: AbortController;
  private loop?: Promise<void>;

  constructor(
    private readonly client: TelegramClient,
    private readonly db: () => EpochDb,
    private readonly options: TelegramLinkerOptions = DEFAULTS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    logger.info('telegram linker started');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop;
  }

  /** One getUpdates round: handles each update and moves the offset past it. Returns how many it saw. */
  async pollOnce(timeoutSeconds = this.options.pollSeconds): Promise<number> {
    this.abort = new AbortController();
    const updates = await this.client.getUpdates(this.offset, timeoutSeconds, this.abort.signal);
    for (const update of updates) {
      this.offset = Math.max(this.offset ?? 0, update.update_id + 1);
      try {
        await this.handle(update);
      } catch (error) {
        logger.warn('telegram update failed', { update: update.update_id, error: this.client.redact(String(error)) });
      }
    }
    return updates.length;
  }

  /** Answers `/start <code>`: binds the chat to the code's wallet, or explains why not. Other messages are ignored. */
  async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const match = message?.text ? START.exec(message.text.trim()) : null;
    if (!message || !match) return;
    const chatId = String(message.chat.id);
    const code = match[1];
    if (!code) {
      await this.client.sendMessage(chatId, START_HELP_TEXT);
      return;
    }
    const db = this.db();
    const [link] = await db
      .update(telegramLinks)
      .set({ usedAt: sql`now()` })
      .where(and(eq(telegramLinks.code, code), isNull(telegramLinks.usedAt), gt(telegramLinks.expiresAt, sql`now()`)))
      .returning({ address: telegramLinks.address });
    if (!link) {
      await this.client.sendMessage(chatId, LINK_EXPIRED_TEXT);
      return;
    }
    await db
      .insert(alertPrefs)
      .values({ address: link.address, rules: DEFAULT_ALERT_RULES, telegram: chatId, reminders: [], state: {} })
      .onConflictDoUpdate({ target: alertPrefs.address, set: { telegram: chatId, updatedAt: sql`now()` } });
    logger.info('telegram chat linked', { wallet: shortKey(link.address) });
    await this.client.sendMessage(chatId, LINKED_TEXT(link.address));
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.running) break;
        logger.warn('telegram getUpdates failed; retrying', { error: this.client.redact(String(error)) });
        await this.pause(this.options.retryDelayMs);
      }
    }
  }

  /** A sleep that stop() cuts short. */
  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      this.abort?.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
