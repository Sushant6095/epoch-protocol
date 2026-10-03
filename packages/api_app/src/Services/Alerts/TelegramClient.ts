/** The parts of a Telegram Bot API update the linker reads. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    text?: string;
  };
}

/** A Bot API call that failed. The message never contains the bot token. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    description: string,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramError';
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Minimal Telegram Bot API client over fetch (injectable for tests). The token only ever appears in the request URL;
 * errors are rewritten so it never reaches a log line or the alert_deliveries table.
 */
export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly baseUrl = 'https://api.telegram.org',
  ) {}

  /** Long-polls for updates after `offset` (Telegram confirms everything before it). */
  getUpdates(offset: number | undefined, timeoutSeconds: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message'] },
      (timeoutSeconds + 15) * 1_000,
      signal,
    );
  }

  async sendMessage(chatId: string | number, text: string): Promise<void> {
    await this.call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }, 15_000);
  }

  /** Replaces the token in any text that might carry it (defence in depth for logs). */
  redact(text: string): string {
    return this.token ? text.split(this.token).join('<token>') : text;
  }

  private async call<T>(method: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      throw new TelegramError(method, 0, this.redact(reason));
    }
    let json: { ok?: boolean; result?: T; description?: string; error_code?: number } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      // not JSON: report the HTTP status below
    }
    if (!res.ok || !json.ok) {
      throw new TelegramError(
        method,
        json.error_code ?? res.status,
        this.redact(json.description ?? `HTTP ${res.status}`),
      );
    }
    return json.result as T;
  }
}
