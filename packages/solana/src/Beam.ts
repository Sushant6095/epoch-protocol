import { Logger } from '@epoch/logger';
import { PublicKey, SystemProgram, type TransactionInstruction } from '@solana/web3.js';

/** Solami's floor: a Beam transaction must tip at least 100,000 lamports (0.0001 SOL). */
export const BEAM_MIN_TIP_LAMPORTS = 100_000;
export const BEAM_TIP_ADDRESSES_URL = 'https://api.solami.dev/onchain/tip-addresses';
export const BEAM_LANDING_URL = 'https://api.solami.dev/swqos/tx';

/**
 * Beam over HTTP (Solami docs, "Endpoints"): a normal `sendTransaction` to your Solami RPC endpoint that carries a
 * transfer to a current tip address is routed through Beam's stake-weighted lane. No QUIC client or certificate.
 */
export interface BeamRoute {
  /** Solami RPC with the key: https://rpc.solami.dev/sol?api_key=<key>. Never logged. */
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

/** The current tip addresses from Solami's public API (no auth), refreshed every 10 minutes; never hardcoded. */
export class BeamTipAccounts {
  private cached?: { accounts: PublicKey[]; at: number };

  constructor(
    private readonly url = BEAM_TIP_ADDRESSES_URL,
    private readonly fetchFn: Fetch = fetch,
    private readonly ttlMs = 600_000,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<PublicKey[]> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.accounts;
    try {
      const res = await this.fetchFn(this.url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body) || body.length === 0) throw new Error('expected a non-empty array of addresses');
      const accounts = body.map((address) => new PublicKey(String(address)));
      this.cached = { accounts, at: this.now() };
      return accounts;
    } catch (error) {
      // A slightly old list is still valid; with nothing cached the caller cannot tip safely.
      if (this.cached) {
        logger.warn('tip address refresh failed; keeping the previous list', { error: String(error) });
        return this.cached.accounts;
      }
      throw new Error(`Beam tip addresses unavailable: ${String(error)}`);
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
