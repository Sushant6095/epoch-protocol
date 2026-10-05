import { Logger } from '@epoch/logger';
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

/** Solami's floor: a Beam transaction must tip at least 100,000 lamports (0.0001 SOL). */
export const BEAM_MIN_TIP_LAMPORTS = 100_000;
export const BEAM_TIP_ADDRESSES_URL = 'https://api.solami.dev/onchain/tip-addresses';
export const BEAM_LANDING_URL = 'https://api.solami.dev/swqos/tx';
/** Beam's HTTP host as llms.txt names it. It did not resolve on 5 Oct 2026 (NXDOMAIN); `pnpm solami:check` tests it. */
export const BEAM_HTTP_URL = 'https://beam-http.solami.dev';

/**
 * Solami's tip accounts as its official SDK pins them (npm `solami` 0.1.56, `TIP_ACCOUNTS`). All ten were in
 * GET /onchain/tip-addresses on 5 Oct 2026 (which listed fifteen). Used only while that endpoint cannot be read.
 */
export const BEAM_PINNED_TIP_ACCOUNTS: readonly string[] = [
  '15qWd4huAkoxvhDsHMfpUn27TW1YBYMMJJ2jkAkbeam',
  '9XuGciSwr5wb7dLTQm91JhuBTvj3GG8WjuRDc3obeam',
  'kiQioJNyFG7pU36ELLsRKXkeT48kFbk3b6rSgrWbeam',
  'kjmVhW1UzJrW2sU5bY5NtZ79jpvjSStsj37Pzmabeam',
  'kREnjPWFpt4AHeY5pijPmyXaCrMnbatUQJo7d3Xbeam',
  'praRZG6N6MdbsT4EFpKgZJWReZGXQhAMFcH68oCbeam',
  'SqoKQKU5uwBxovq3R7yEBxFwptc4z7vwoghU3M9beam',
  'sV72TY66T1RfmDSeHPPbwX6wwJ3bBv5hd4ehJ8tbeam',
  'swf8MyEeLo7gtRUo27UuJj6naCASUrypU7dbteSbeam',
  'uiuaQsxA47JybQAVN4FTfYuoEDkMiXV1r591Aewbeam',
];

/**
 * Beam over HTTP: a JSON-RPC `sendTransaction` carrying a transfer to a current tip address goes out through Beam's
 * stake-weighted lane (Solami's policy docs: an untipped `sendTransaction` over HTTP can instead draw the tip from the
 * account's balance; tips are refunded when a transaction does not land). No QUIC client or certificate.
 */
export interface BeamRoute {
  /** The HTTP endpoint that takes the tipped `sendTransaction`: your Solami RPC URL (key in the query string). Never logged. */
  url: string;
  /** At least BEAM_MIN_TIP_LAMPORTS. */
  tipLamports: number;
  tipAccounts: BeamTipAccounts;
}

type Fetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const logger = Logger.create('Beam');

/**
 * The current tip addresses from Solami's public API (no auth), cached for 10 minutes. When the API cannot be read:
 * the last list read, else the list pinned from Solami's SDK (retried after a minute).
 */
export class BeamTipAccounts {
  private cached?: { accounts: PublicKey[]; at: number; source: 'api' | 'pinned' };

  constructor(
    private readonly url = BEAM_TIP_ADDRESSES_URL,
    private readonly fetchFn: Fetch = fetch,
    private readonly ttlMs = 600_000,
    private readonly now: () => number = Date.now,
    private readonly pinned: readonly string[] = BEAM_PINNED_TIP_ACCOUNTS,
  ) {}

  /** Where the list in use came from (null before the first read). */
  get source(): 'api' | 'pinned' | null {
    return this.cached?.source ?? null;
  }

  async list(): Promise<PublicKey[]> {
    const cached = this.cached;
    const ttl = cached?.source === 'pinned' ? Math.min(this.ttlMs, 60_000) : this.ttlMs;
    if (cached && this.now() - cached.at < ttl) return cached.accounts;
    try {
      const res = await this.fetchFn(this.url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body) || body.length === 0) throw new Error('expected a non-empty array of addresses');
      const accounts = body.map((address) => new PublicKey(String(address)));
      this.cached = { accounts, at: this.now(), source: 'api' };
      return accounts;
    } catch (error) {
      // A slightly old list is still valid.
      if (cached?.source === 'api') {
        logger.warn('tip address refresh failed; keeping the previous list', { error: String(error) });
        return cached.accounts;
      }
      if (this.pinned.length === 0) throw new Error(`Beam tip addresses unavailable: ${String(error)}`);
      logger.warn('tip addresses unavailable; using the list pinned from Solami’s SDK', { error: String(error) });
      const accounts = this.pinned.map((address) => new PublicKey(address));
      this.cached = { accounts, at: this.now(), source: 'pinned' };
      return accounts;
    }
  }

  /** One of the current tip addresses, at random (as Solami's SDK does). */
  async pick(random: () => number = Math.random): Promise<PublicKey> {
    const accounts = await this.list();
    return accounts[Math.floor(random() * accounts.length) % accounts.length];
  }
}

/** The tip: a plain system transfer from the fee payer to a tip address. */
export function beamTipInstruction(payer: PublicKey, tipAccount: PublicKey, lamports: number): TransactionInstruction {
  if (!Number.isSafeInteger(lamports) || lamports < BEAM_MIN_TIP_LAMPORTS) {
    throw new RangeError(`Beam tip must be at least ${BEAM_MIN_TIP_LAMPORTS} lamports, got ${lamports}`);
  }
  return SystemProgram.transfer({ fromPubkey: payer, toPubkey: tipAccount, lamports });
}

/**
 * A Beam route for mainnet senders; undefined (Beam off) without a URL or off mainnet, where Solami's tip accounts and
 * leaders do not exist.
 */
export function beamRoute(options: {
  url?: string;
  tipLamports?: number;
  tipAddressesUrl?: string;
  cluster: string;
}): BeamRoute | undefined {
  if (!options.url) return undefined;
  if (options.cluster !== 'mainnet') {
    logger.warn('SOLAMI_BEAM_URL is set but the cluster is not mainnet: sending without Beam', {
      cluster: options.cluster,
    });
    return undefined;
  }
  return {
    url: options.url,
    tipLamports: Math.max(BEAM_MIN_TIP_LAMPORTS, options.tipLamports ?? BEAM_MIN_TIP_LAMPORTS),
    tipAccounts: new BeamTipAccounts(options.tipAddressesUrl),
  };
}

export interface BeamLanding {
  signature: string;
  isLanded: boolean;
  landedViaJito: boolean;
  region: string | null;
  tipLamports: number | null;
}

/** Solami's public landing lookup (GET /swqos/tx/{signature}, no auth); null when Beam never saw it (404). */
export async function beamLanding(
  signature: string,
  fetchFn: Fetch = fetch,
  baseUrl = BEAM_LANDING_URL,
): Promise<BeamLanding | null> {
  const res = await fetchFn(`${baseUrl}/${signature}`, { signal: AbortSignal.timeout(10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  return {
    signature,
    isLanded: body.is_landed === true,
    landedViaJito: body.landed_via_jito === true,
    region: typeof body.region === 'string' ? body.region : null,
    tipLamports: typeof body.tip_lamports === 'number' ? body.tip_lamports : null,
  };
}
