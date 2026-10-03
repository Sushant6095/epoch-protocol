import { Logger } from '@epoch/logger';
import { Connection, type PublicKey } from '@solana/web3.js';

import { redactUrl } from '../Lib/Http';

const logger = Logger.create('ProgramLogsSource');

/** A getSignaturesForAddress entry (the RPC returns them newest first). */
export interface SignatureInfo {
  signature: string;
  slot: number;
  /** Set when the transaction failed. */
  err: unknown;
  /** Unix seconds. */
  blockTime?: number | null;
}

/** The parts of a getTransaction answer the ingester reads. */
export interface TransactionLogs {
  slot: number;
  /** Unix seconds. */
  blockTime?: number | null;
  meta: { err: unknown; logMessages?: string[] | null } | null;
}

/** A logsSubscribe notification. */
export interface LogsNotification {
  signature: string;
  err: unknown;
  logs: string[];
}

export type LogsListener = (notification: LogsNotification, context: { slot: number }) => void;

/** The RPC surface ProgramEventIngester needs: `Web3IngestRpc` in production, fakes in tests. */
export interface IngestRpc {
  getSignaturesForAddress(
    address: PublicKey,
    options: { before?: string; until?: string; limit: number },
  ): Promise<SignatureInfo[]>;
  /** Null when the node doesn't have it (yet); throws RpcAnswerError when the node answers with an error about it. */
  getTransaction(signature: string): Promise<TransactionLogs | null>;
  /** logsSubscribe (mentions = address) at `confirmed`; returns the subscription id. */
  onLogs(address: PublicKey, listener: LogsListener): number;
  removeOnLogsListener(id: number): Promise<void>;
  /** Optional: replace the websocket (the next onLogs opens a new one), for a feed that went quiet. */
  reconnect?(): void;
}

/** True for an HTTP 429 (web3.js with `disableRetryOnRateLimit` and `postJsonRpc` report "429 Too Many Requests…"). */
export const isRateLimited = (error: unknown): boolean =>
  /\b429\b|too many requests/i.test(error instanceof Error ? error.message : String(error));

/** The node answered with a JSON-RPC error about this request (not a transport failure or a 429). */
export class RpcAnswerError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcAnswerError';
  }
}

/** One JSON-RPC call, no retries (the ingester backs off itself). HTTP errors throw "<status> <text>". */
async function postJsonRpc<T>(url: string, method: string, params: unknown[], timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${redactUrl(url)}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new RpcAnswerError(body.error.code, body.error.message);
  return body.result as T;
}

/** JSON-RPC -32015: the transaction's version is newer than the request allowed; the message names the one to ask for. */
const UNSUPPORTED_VERSION = -32015;

interface RawTransaction {
  slot: number;
  blockTime?: number | null;
  meta: { err: unknown; logMessages?: string[] | null } | null;
}

/**
 * getTransaction for its logs, whatever the transaction version. web3.js v1 accepts only legacy and v0 answers, and
 * devnet already carries version-1 transactions (`-32015 … "maxSupportedTransactionVersion": 1`), so this asks over
 * plain JSON-RPC for base64 (the message is never decoded, only `meta`), with version 1, and once more with the version
 * the node names when a transaction is newer still.
 */
export async function fetchTransactionLogs(url: string, signature: string): Promise<TransactionLogs | null> {
  const request = (version: number) =>
    postJsonRpc<RawTransaction | null>(url, 'getTransaction', [
      signature,
      { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: version },
    ]);
  let tx: RawTransaction | null;
  try {
    tx = await request(1);
  } catch (error) {
    const named =
      error instanceof RpcAnswerError && error.code === UNSUPPORTED_VERSION
        ? /"maxSupportedTransactionVersion":\s*(\d+)/.exec(error.message)
        : null;
    if (!named || Number(named[1]) <= 1) throw error;
    tx = await request(Number(named[1]));
  }
  if (!tx) return null;
  return {
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    meta: tx.meta ? { err: tx.meta.err, logMessages: tx.meta.logMessages ?? null } : null,
  };
}

export interface Web3IngestRpcOptions {
  /** EPOCH_RPC_URL. */
  url: string;
  /** EPOCH_RPC_WS_URL, or EPOCH_RPC_URL as wss://. */
  wsUrl: string;
  /** EPOCH_RPC_FALLBACK_URL: HTTP reads go there when the primary fails (not on a 429). */
  fallbackUrl?: string;
}

/**
 * The ingester's RPC: a dedicated web3.js Connection for logsSubscribe (its own websocket) and signatures, with
 * `disableRetryOnRateLimit` so the ingester's own backoff handles 429s; transactions over plain JSON-RPC
 * (`fetchTransactionLogs`). HTTP reads fall back to `fallbackUrl` on other errors.
 */
export class Web3IngestRpc implements IngestRpc {
  private connection: Connection;
  private readonly fallback?: Connection;

  constructor(private readonly options: Web3IngestRpcOptions) {
    this.connection = this.connect();
    this.fallback = options.fallbackUrl
      ? new Connection(options.fallbackUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true })
      : undefined;
  }

  getSignaturesForAddress(
    address: PublicKey,
    options: { before?: string; until?: string; limit: number },
  ): Promise<SignatureInfo[]> {
    const fallback = this.fallback;
    return this.withFallback(
      () => this.connection.getSignaturesForAddress(address, options, 'confirmed'),
      fallback ? () => fallback.getSignaturesForAddress(address, options, 'confirmed') : undefined,
    );
  }

  getTransaction(signature: string): Promise<TransactionLogs | null> {
    const { url, fallbackUrl } = this.options;
    return this.withFallback(
      () => fetchTransactionLogs(url, signature),
      fallbackUrl ? () => fetchTransactionLogs(fallbackUrl, signature) : undefined,
    );
  }

  onLogs(address: PublicKey, listener: LogsListener): number {
    return this.connection.onLogs(
      address,
      (logs, context) =>
        listener({ signature: logs.signature, err: logs.err, logs: logs.logs }, { slot: context.slot }),
      'confirmed',
    );
  }

  removeOnLogsListener(id: number): Promise<void> {
    return this.connection.removeOnLogsListener(id);
  }

  reconnect(): void {
    // web3.js closes a websocket once it has no subscriptions left; the new Connection opens its own.
    this.connection = this.connect();
  }

  private connect(): Connection {
    return new Connection(this.options.url, {
      commitment: 'confirmed',
      wsEndpoint: this.options.wsUrl,
      disableRetryOnRateLimit: true,
    });
  }

  private async withFallback<T>(primary: () => Promise<T>, fallback?: () => Promise<T>): Promise<T> {
    try {
      return await primary();
    } catch (error) {
      if (!fallback || isRateLimited(error)) throw error;
      logger.warn('program RPC failed, using the fallback', { error: String(error) });
      return fallback();
    }
  }
}
