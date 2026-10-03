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
  /** IP geolocation city and hosting organisation (validator profile tags, My Stake suggestions). */
  ip_city?: string | null;
  ip_org?: string | null;
}

/** One entry of Stakewiz's commission change log; `commission` in bps, newest first. */
export interface StakewizCommissionChange {
  commission: number;
  /** `2026-02-22 01:24:11.135988+01` (see Lib/EpochTimes parseStakewizTime). */
  observed_at: string;
}

export class StakewizSource {
  constructor(private readonly baseUrl: string) {}

  async getValidators(): Promise<Map<string, StakewizValidator>> {
    const rows = await getJson<StakewizValidator[]>(`${this.baseUrl.replace(/\/$/, '')}/validators`, 30_000);
    return new Map(rows.map((row) => [row.vote_identity, row]));
  }

  /** Active stake per epoch for the last 30 epochs, newest first (`/validator_total_stakes/<vote>`), SOL. */
  getTotalStakes(vote: string): Promise<{ epoch: number; stake: number }[]> {
    return getJson(`${this.baseUrl.replace(/\/$/, '')}/validator_total_stakes/${vote}`, 20_000);
  }

  /** Every inflation-commission value Stakewiz has observed, newest first (`/commission_history/<vote>`). */
  getCommissionHistory(vote: string): Promise<StakewizCommissionChange[]> {
    return getJson(`${this.baseUrl.replace(/\/$/, '')}/commission_history/${vote}`, 20_000);
  }

  /** When every epoch started (`/all_epochs_history`, ~900 epochs, newest first; the current one's end is a guess). */
  getEpochHistory(): Promise<{ epoch: number; start: string; end: string }[]> {
    return getJson(`${this.baseUrl.replace(/\/$/, '')}/all_epochs_history`, 30_000);
  }
}

/** One finished epoch of a validator's Jito history (`/api/v1/validators/<vote>`), lamports and bps. */
export interface KobeEpochRewards {
  epoch: number;
  mev_commission_bps: number | null;
  /** Tips earned by the validator's stake that epoch, before its commission. */
  mev_rewards: number | null;
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

  /** Tips and MEV commission per finished epoch, newest first (~165 epochs); empty for a validator Jito never saw. */
  getValidatorHistory(vote: string): Promise<KobeEpochRewards[]> {
    return getJson(`${this.baseUrl.replace(/\/$/, '')}/api/v1/validators/${vote}`, 20_000);
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
