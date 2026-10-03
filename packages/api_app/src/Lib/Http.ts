import { retry, sleep } from '@epoch/common';
import { ChainException, EpochException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';

const logger = Logger.create('Http');

/** How many times one request waits out an HTTP 429 before it counts as a failure. */
const RATE_LIMIT_WAITS = 4;

/** Hides API keys and paths so RPC URLs can be logged safely. */
export const redactUrl = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
};

/** GET a JSON document with a timeout and two retries. */
export async function getJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  return retry(
    async () => {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new EpochException(`HTTP ${res.status} from ${redactUrl(url)}`, 'UPSTREAM_ERROR', 502);
      return (await res.json()) as T;
    },
    { retries: 2, baseDelayMs: 500 },
  );
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code: number; message: string };
}

/**
 * Minimal Solana JSON-RPC client over fetch: retries each endpoint, then fails over to the next.
 * Used instead of web3.js `Connection` because several fields we need (`clientId` in getClusterNodes,
 * `inflationRewardsCommissionBps` in getVoteAccounts) are not in its types yet.
 */
export class JsonRpcClient {
  private nextId = 1;

  constructor(
    private readonly urls: string[],
    private readonly timeoutMs = 30_000,
  ) {
    if (urls.length === 0) throw new Error('JsonRpcClient needs at least one URL');
  }

  async call<T>(method: string, params: unknown[] = [], timeoutMs = this.timeoutMs): Promise<T> {
    let lastError: unknown;
    for (const url of this.urls) {
      try {
        return await retry(() => this.post<T>(url, method, params, timeoutMs), { retries: 2, baseDelayMs: 400 });
      } catch (error) {
        lastError = error;
        logger.warn('RPC call failed on this endpoint', { method, host: redactUrl(url), error: String(error) });
      }
    }
    throw new ChainException(`RPC ${method} failed`, { cause: String(lastError) });
  }

  private async post<T>(url: string, method: string, params: unknown[], timeoutMs: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Rate limited: wait as long as the server asks (or 2–10 s) before the normal retries kick in.
      if (res.status === 429 && attempt < RATE_LIMIT_WAITS) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1_000 : Math.min(10_000, 2_000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as RpcEnvelope<T>;
      if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
      return body.result as T;
    }
  }
}
