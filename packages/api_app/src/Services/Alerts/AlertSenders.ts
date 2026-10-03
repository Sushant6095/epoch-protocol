import { type AlertMessage } from './AlertRules';
import { type TelegramClient } from './TelegramClient';

export type AlertChannel = 'email' | 'telegram';
export const ALERT_CHANNELS: readonly AlertChannel[] = ['email', 'telegram'];

/** One delivery channel. `configured` is false when the API has no credentials for it: the channel is skipped. */
export interface AlertSender {
  readonly channel: AlertChannel;
  readonly configured: boolean;
  /** `to`: an email address or a Telegram chat id. Throws on failure, with no secret in the message. */
  send(to: string, message: AlertMessage): Promise<void>;
}

export type AlertSenders = Record<AlertChannel, AlertSender>;

/** The subset of a nodemailer transport the email sender uses (injectable for tests). */
export interface MailTransport {
  sendMail(mail: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** Title, then the body (unless it already starts with the title), then the link. */
export function plainText(message: AlertMessage): string {
  const head = message.body.startsWith(message.title) ? message.body : `${message.title}\n${message.body}`;
  return `${head}\n${message.link}`;
}

/** Telegram `sendMessage` to the chat linked through the bot (plain text, no parse mode to escape). */
export class TelegramAlertSender implements AlertSender {
  readonly channel = 'telegram' as const;

  constructor(private readonly client: TelegramClient | undefined) {}

  get configured(): boolean {
    return this.client !== undefined;
  }

  async send(to: string, message: AlertMessage): Promise<void> {
    if (!this.client) throw new Error('Telegram is not configured (TELEGRAM_BOT_TOKEN)');
    await this.client.sendMessage(to, plainText(message));
  }
}

/** Email through nodemailer `createTransport(SMTP_URL)`, from ALERTS_EMAIL_FROM. */
export class EmailAlertSender implements AlertSender {
  readonly channel = 'email' as const;

  constructor(
    private readonly transport: MailTransport | undefined,
    private readonly from: string,
    private readonly settingsUrl: string,
    /** Strings that must never appear in an error (the SMTP password). */
    private readonly secrets: string[] = [],
  ) {}

  get configured(): boolean {
    return this.transport !== undefined;
  }

  async send(to: string, message: AlertMessage): Promise<void> {
    if (!this.transport) throw new Error('Email is not configured (SMTP_URL)');
    const text = `${plainText(message)}\n\nYou get this because alerts are on for your wallet in Epoch. Change them at ${this.settingsUrl}`;
    try {
      await this.transport.sendMail({ from: this.from, to, subject: `Epoch: ${message.title}`, text });
    } catch (error) {
      let reason = error instanceof Error ? error.message : String(error);
      for (const secret of this.secrets) if (secret) reason = reason.split(secret).join('<secret>');
      throw new Error(`email failed: ${reason}`);
    }
  }
}
