import { sleep } from '@epoch/common';
import { Logger } from '@epoch/logger';

const logger = Logger.create('SolanaRpc');

/** A JSON-RPC error from the node, with Solana's code (e.g. -32007 slot skipped, -32005 Solami rate limit). */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RpcError';
  }
}

/** getBlock answers that mean "there is no block for this slot". */
export const SKIPPED_SLOT_CODES: ReadonlySet<number> = new Set([-32007, -32009]);
/** "Block not available for slot": not yet (or not here); worth asking again. */
export const BLOCK_NOT_AVAILABLE = -32004;
/** Solami's rate limit, returned with HTTP 200. */
export const RATE_LIMITED = -32005;

/** Hides keys: an RPC URL is only ever logged by host. */
export const rpcHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
};

/** Removes any api_key value (or the whole URL's query) from text that may echo a request URL. */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text.replace(/([?&](api[_-]?key|token)=)[^&\s"']+/gi, '$1***');
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('***');
  return out;
}

export interface RpcBlockTransaction {
  transaction: [string, string];
  meta: { err: unknown; fee?: number } | null;
  version?: 'legacy' | number;
}

export interface RpcBlock {
  blockhash: string;
  previousBlockhash: string;
  parentSlot: number;
  blockTime: number | null;
  blockHeight: number | null;
  rewards?: { pubkey: string; lamports: number; rewardType: string | null }[];
  transactions: RpcBlockTransaction[];
}

export interface RpcVoteAccount {
  votePubkey: string;
  nodePubkey: string;
  activatedStake: number;
}

export interface RpcEpochInfo {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
}

export interface RpcEpochSchedule {
  slotsPerEpoch: number;
  firstNormalEpoch: number;
  firstNormalSlot: number;
}

type Fetch = typeof fetch;

export interface SolanaRpcOptions {
  /** Per request. Default 30 s (a full block is a few MB). */
  timeoutMs?: number;
  /** Retries for network errors, HTTP 5xx/429 and rate limits. Default 3. */
  retries?: number;
  fetchFn?: Fetch;
}

/**
 * Minimal Solana JSON-RPC over fetch, for the indexer: it needs `getBlock` with `maxSupportedTransactionVersion: 1`
 * (SIMD-0385 v1 transactions are live on mainnet, and web3.js 1.x cannot decode them) and Solami's error conventions
 * (rate limits come back as HTTP 200 with -32005). The URL may carry the key (`?api_key=`); it is never logged.
 */
export class SolanaRpc {
  private nextId = 1;

  constructor(
    readonly url: string,
    private readonly options: SolanaRpcOptions = {},
  ) {}

  get host(): string {
    return rpcHost(this.url);
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const retries = this.options.retries ?? 3;
    const fetchFn = this.options.fetchFn ?? fetch;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchFn(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
        });
        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('retry-after'));
          throw Object.assign(new Error(`HTTP ${res.status}`), {
            retryable: true,
            waitMs: retryAfter > 0 ? retryAfter * 1_000 : undefined,
          });
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${this.host}`);
        const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
        if (body.error) {
          const error = new RpcError(body.error.code, redact(body.error.message));
          if (error.code === RATE_LIMITED) throw Object.assign(error, { retryable: true });
          throw error;
        }
        return body.result as T;
      } catch (error) {
        const retryable =
          (error as { retryable?: boolean }).retryable === true ||
          (!(error instanceof RpcError) && !/^HTTP 4\d\d/.test(String((error as Error).message)));
        if (!retryable || attempt >= retries) {
          if (error instanceof RpcError) throw error;
          throw new Error(`RPC ${method} failed on ${this.host}: ${redact(String((error as Error).message ?? error))}`);
        }
        const waitMs =
          (error as { waitMs?: number }).waitMs ??
          Math.min(8_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
        logger.debug('RPC retry', { method, host: this.host, attempt: attempt + 1, waitMs });
        await sleep(waitMs);
      }
    }
  }

  getSlot(commitment: 'processed' | 'confirmed' | 'finalized' = 'confirmed'): Promise<number> {
    return this.call<number>('getSlot', [{ commitment }]);
  }

  getEpochInfo(): Promise<RpcEpochInfo> {
    return this.call<RpcEpochInfo>('getEpochInfo', [{ commitment: 'confirmed' }]);
  }

  getEpochSchedule(): Promise<RpcEpochSchedule> {
    return this.call<RpcEpochSchedule>('getEpochSchedule');
  }

  /** Full block, raw transactions (base64, v0 and v1), rewards; null when the node has no block for the slot. */
  getBlock(slot: number): Promise<RpcBlock | null> {
    return this.call<RpcBlock | null>('getBlock', [
      slot,
      {
        encoding: 'base64',
        maxSupportedTransactionVersion: 1,
        transactionDetails: 'full',
        rewards: true,
        commitment: 'confirmed',
      },
    ]);
  }

  /** Leader identities of `limit` (≤ 5,000) consecutive slots from `startSlot`. */
  getSlotLeaders(startSlot: number, limit: number): Promise<string[]> {
    return this.call<string[]>('getSlotLeaders', [startSlot, limit]);
  }

  getVoteAccounts(): Promise<{ current: RpcVoteAccount[]; delinquent: RpcVoteAccount[] }> {
    return this.call('getVoteAccounts', [{ commitment: 'confirmed', keepUnstakedDelinquents: false }]);
  }

  getVersion(): Promise<{ 'solana-core': string; 'feature-set'?: number }> {
    return this.call('getVersion');
  }
}
