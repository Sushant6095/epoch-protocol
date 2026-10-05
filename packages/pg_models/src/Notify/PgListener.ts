import { Logger } from '@epoch/logger';
import { Client, type ClientConfig } from 'pg';

const logger = Logger.create('PgListener');

/** The parts of a pg Client the listener uses (a fake in tests). */
export interface ListenClient {
  connect(): Promise<void>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: 'notification', listener: (message: { channel: string; payload?: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  removeAllListeners(): unknown;
}

export interface PgListenerOptions {
  /** A LISTEN channel name: lowercase letters, digits and underscores. */
  channel: string;
  onNotification: (payload: string | undefined) => void;
  /** Called with true once listening, false when the connection drops (before the reconnect). */
  onState?: (listening: boolean) => void;
  connectionString?: string;
  /** For tests. */
  createClient?: () => ListenClient;
  /** Reconnect backoff: 1 s doubling to this (default 30 s). */
  maxBackoffMs?: number;
  /** A `SELECT 1` this often notices a silently dead connection (default 30 s). */
  healthCheckMs?: number;
}

/**
 * LISTEN on a dedicated connection (not a pool client: a pool would hand the connection back), reconnecting with
 * backoff whenever it fails. Notifications sent while it is reconnecting are lost; the caller re-reads current state
 * from the tables when `onState(true)` fires again.
 */
export class PgListener {
  private client?: ListenClient;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private healthTimer?: NodeJS.Timeout;
  private listening = false;

  constructor(private readonly options: PgListenerOptions) {
    if (!/^[a-z_][a-z0-9_]*$/.test(options.channel)) throw new Error(`invalid LISTEN channel: ${options.channel}`);
  }

  get isListening(): boolean {
    return this.listening;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.healthTimer);
    const client = this.client;
    this.client = undefined;
    this.setListening(false);
    if (client) {
      client.removeAllListeners();
      await client.end().catch(() => undefined);
    }
  }

  private newClient(): ListenClient {
    if (this.options.createClient) return this.options.createClient();
    const config: ClientConfig = {
      connectionString: this.options.connectionString ?? process.env.DATABASE_URL,
      keepAlive: true,
      application_name: `epoch-listen-${this.options.channel}`,
    };
    return new Client(config) as unknown as ListenClient;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = this.newClient();
    this.client = client;
    let failed = false;
    const fail = (reason: string) => {
      if (failed || this.client !== client) return;
      failed = true;
      this.drop(client, reason);
    };
    client.on('error', (error) => fail(error.message));
    client.on('end', () => fail('connection ended'));
    client.on('notification', (message) => {
      if (message.channel === this.options.channel) this.options.onNotification(message.payload);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${this.options.channel}`);
      if (this.client !== client) return;
      this.attempt = 0;
      this.setListening(true);
      clearInterval(this.healthTimer);
      this.healthTimer = setInterval(() => {
        client.query('SELECT 1').catch((error: unknown) => fail(String(error)));
      }, this.options.healthCheckMs ?? 30_000);
      this.healthTimer.unref();
      logger.info('listening', { channel: this.options.channel });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  private drop(client: ListenClient, reason: string): void {
    clearInterval(this.healthTimer);
    client.removeAllListeners();
    // A late 'error' from a half-closed socket must not crash the process.
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    if (this.client === client) this.client = undefined;
    this.setListening(false);
    if (this.stopped) return;
    const delay = Math.min(this.options.maxBackoffMs ?? 30_000, 1_000 * 2 ** Math.min(this.attempt, 5));
    this.attempt++;
    logger.warn('LISTEN connection lost; reconnecting', { channel: this.options.channel, reason, retryInMs: delay });
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    this.reconnectTimer.unref();
  }

  private setListening(listening: boolean): void {
    if (this.listening === listening) return;
    this.listening = listening;
    this.options.onState?.(listening);
  }
}
