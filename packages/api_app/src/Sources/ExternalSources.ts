import { Logger } from '@epoch/logger';

import { getJson } from '../Lib/Http';

const logger = Logger.create('ExternalSources');

/** The Stakewiz fields we use (https://api.stakewiz.com/validators). */
export interface StakewizValidator {
  vote_identity: string;
  identity: string;
  name: string | null;
  activated_stake: number;
  commission: number;
  delinquent: boolean;
  version: string | null;
  ip_country: string | null;
  uptime: number | null;
  skip_rate: number | null;
  credit_ratio: number | null;
  first_epoch_with_stake: number | null;
  jito_commission_bps: number | null;
  staking_apy: number | null;
  jito_apy: number | null;
  total_apy: number | null;
}

export class StakewizSource {
  constructor(private readonly baseUrl: string) {}

  async getValidators(): Promise<Map<string, StakewizValidator>> {
    const rows = await getJson<StakewizValidator[]>(`${this.baseUrl.replace(/\/$/, '')}/validators`, 30_000);
    return new Map(rows.map((row) => [row.vote_identity, row]));
  }
}

/** The Jito Kobe fields we use (https://kobe.mainnet.jito.network/api/v1/validators). */
export interface KobeValidator {
  vote_account: string;
  mev_commission_bps: number | null;
  running_jito: boolean;
}

export class JitoKobeSource {
  constructor(private readonly baseUrl: string) {}

  async getValidators(): Promise<Map<string, KobeValidator>> {
    const body = await getJson<{ validators: KobeValidator[] }>(
      `${this.baseUrl.replace(/\/$/, '')}/api/v1/validators`,
      30_000,
    );
    return new Map(body.validators.map((row) => [row.vote_account, row]));
  }
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export class PriceSource {
  constructor(
    private readonly priceUrl: string,
    private readonly fxUrl: string,
  ) {}

  /** SOL in USD from Jupiter Price API v3. */
  async solUsd(): Promise<number> {
    const body = await getJson<Record<string, { usdPrice: number }>>(`${this.priceUrl}?ids=${WSOL_MINT}`);
    const price = body[WSOL_MINT]?.usdPrice;
    if (typeof price !== 'number') throw new Error('SOL price missing from the price API');
    return price;
  }

  /** Rupees per dollar. */
  async usdInr(): Promise<number> {
    const body = await getJson<{ rates: Record<string, number> }>(this.fxUrl);
    const rate = body.rates?.INR;
    if (typeof rate !== 'number') throw new Error('INR rate missing from the FX API');
    return rate;
  }
}

/** Token symbols by mint, from Jupiter's token search; used to name liquid-staking pools. */
export class TokenSource {
  private readonly symbols = new Map<string, string | null>();

  constructor(private readonly searchUrl: string) {}

  /** The symbol; null when the token is unknown (cached); undefined when the lookup failed (retry later). */
  async symbol(mint: string): Promise<string | null | undefined> {
    if (this.symbols.has(mint)) return this.symbols.get(mint) ?? null;
    try {
      const rows = await getJson<{ id: string; symbol: string }[]>(`${this.searchUrl}?query=${mint}`, 10_000);
      const symbol = rows.find((row) => row.id === mint)?.symbol ?? null;
      this.symbols.set(mint, symbol);
      return symbol;
    } catch (error) {
      logger.warn('token symbol lookup failed', { mint, error: String(error) });
      return undefined;
    }
  }
}
