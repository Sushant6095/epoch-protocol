import { type PantaBotConfig } from '@epoch/config-sdk';
import { findFeeIndexPda, findPoolPda } from '@epoch/epoch-sdk';
import { usdcToBase } from '@epoch/panta';
import { PublicKey } from '@solana/web3.js';

import { type LifecycleConfig } from './MarketLifecycle';
import { DEFAULT_SCHEDULE } from './Markets/EpochSchedule';
import { type FeeIndexAccountRef } from './Markets/MarketText';

/** A public https URL (not localhost): what Panta's resolver and catalog must be able to open. */
export function isPublicHttps(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const local = host === 'localhost' || host.endsWith('.localhost') || /^(127\.|10\.|192\.168\.|0\.)/.test(host);
    return parsed.protocol === 'https:' && !local;
  } catch {
    return false;
  }
}

/** The Epoch program's FeeIndex PDA (`["fee_index", pool]`), or null when the program id is unusable. */
export function feeIndexAccountOf(
  config: Pick<PantaBotConfig, 'EPOCH_PROGRAM_ID' | 'EPOCH_CLUSTER'>,
): FeeIndexAccountRef | null {
  if (!config.EPOCH_PROGRAM_ID) return null;
  try {
    const programId = new PublicKey(config.EPOCH_PROGRAM_ID);
    const [pool] = findPoolPda(programId);
    return { address: findFeeIndexPda(programId, pool)[0].toBase58(), cluster: config.EPOCH_CLUSTER };
  } catch {
    return null;
  }
}

/**
 * Why this configuration may not create real markets; empty when it may. Creating spends USDC and opens a market real
 * people trade, so everything it needs must be in place: otherwise the bot only logs the plan (a dry run).
 */
export function dryRunReasons(config: PantaBotConfig, databaseConfigured: boolean): string[] {
  const reasons: string[] = [];
  if (config.PANTA_DRY_RUN) reasons.push('PANTA_DRY_RUN=true');
  if (!config.PANTA_API_KEY) reasons.push('PANTA_API_KEY is unset');
  if (!config.PANTA_BOT_KEYPAIR_PATH) reasons.push('PANTA_BOT_KEYPAIR_PATH is unset');
  if (!isPublicHttps(config.PANTA_MARKET_IMAGE_URL)) reasons.push('PANTA_MARKET_IMAGE_URL must be a public https URL');
  if (!isPublicHttps(config.PUBLIC_API_URL)) {
    reasons.push('PUBLIC_API_URL must be the public https API that markets resolve from (/v1/index/epochs/{N})');
  }
  if (!feeIndexAccountOf(config)) {
    reasons.push('EPOCH_PROGRAM_ID is unset or invalid: a market is final only once the program finalizes its value');
  }
  if (!databaseConfigured) reasons.push('DATABASE_URL is unset (thresholds and idempotency need Postgres)');
  return reasons;
}

/** The lifecycle's settings from the environment. */
export function lifecycleConfig(config: PantaBotConfig, reasons: string[]): LifecycleConfig {
  return {
    dryRun: reasons.length > 0,
    dryRunReasons: reasons,
    marketsPerEpoch: config.PANTA_MARKETS_PER_EPOCH,
    epochsAhead: config.PANTA_EPOCHS_AHEAD,
    thresholdLookback: config.PANTA_THRESHOLD_LOOKBACK_EPOCHS,
    schedule: {
      ...DEFAULT_SCHEDULE,
      closeBeforeEpochSec: config.PANTA_CLOSE_BEFORE_EPOCH_MINUTES * 60,
      minTradingSec: Math.round(config.PANTA_MIN_TRADING_HOURS * 3_600),
      resolutionBufferSec: Math.round(config.PANTA_RESOLUTION_BUFFER_HOURS * 3_600),
    },
    maxCreateUsdcBasePerDay: Number(usdcToBase(config.PANTA_MAX_CREATE_USDC_PER_DAY)),
    maxLamportsPerCreate: Math.round(Number(config.PANTA_MAX_SOL_PER_CREATE) * 1_000_000_000),
    imageUrl: config.PANTA_MARKET_IMAGE_URL ?? null,
    publicApiUrl: config.PUBLIC_API_URL ?? null,
    methodologyUrl: config.PANTA_METHODOLOGY_URL,
    feeIndexAccount: feeIndexAccountOf(config),
    graceHours: config.PANTA_RESOLUTION_GRACE_HOURS,
    region: config.PANTA_REGION,
    creatorFeeCheckMs: Math.round(config.PANTA_CREATOR_FEE_CHECK_HOURS * 3_600_000),
    maxAttempts: 3,
  };
}
