/**
 * The pure half of the launch script (`scripts/launch-revenue-token.ts`): validate a launch config, price the share and
 * build the DBC curve, and describe the registry entry. The script adds the chain reads, keys and transactions.
 */
import { PublicKey } from '@solana/web3.js';

import { type DammFeeBps, revenueCurveConfig, type RevenueCurve } from './curve';
import { endEpochOf, launchBand, type LaunchBand } from './math';
import { type LaunchCluster, type LaunchRegistryEntry } from './registry';

/** The JSON a launch starts from (see `scripts/launch-config.example.json`). */
export interface LaunchConfigInput {
  validator: {
    name: string;
    /** Mainnet vote account; required when `avgRevenueSol` is not given (revenue is read from it). */
    vote: string | null;
  };
  /** Up to 10 characters, e.g. rKEST. */
  symbol: string;
  /** Up to 32 characters. */
  name: string;
  /** Token metadata URI, up to 200 characters. */
  uri: string;
  shareBps: number;
  termEpochs: number;
  /** 10-epoch average revenue per epoch, SOL. Omitted: the script reads it from mainnet `getInflationReward`. */
  avgRevenueSol?: number;
  /** Fixed supply, whole tokens. */
  supply: number;
  /** 6–9. */
  decimals: number;
  /** The raise that graduates the token (2–5 SOL for the demo). Omitted: the whole supply goes on the curve. */
  raiseTargetSol?: number;
  tradingFeeBps?: number;
  dammFeeBps?: DammFeeBps;
  /** Sqrt-price points of the curve (2–17, default 2). */
  curvePoints?: number;
  /** First epoch of the term. Omitted: the next epoch on the launch cluster. */
  startEpoch?: number;
  /** The validator's wallet: the pool's creator role (and its 70% at graduation) is transferred to it after launch. */
  creator?: string;
}

export class LaunchConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid launch config: ${problems.join('; ')}`);
    this.name = 'LaunchConfigError';
  }
}

const DAMM_FEES: readonly number[] = [25, 30, 100, 200, 400, 600];

const isPubkey = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
};

/** Validates a parsed launch config JSON; throws `LaunchConfigError` listing every problem. */
export function parseLaunchConfig(raw: unknown): LaunchConfigInput {
  const problems: string[] = [];
  const obj = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null) problems.push('expected a JSON object');
  const text = (key: string, max: number): string => {
    const value = obj[key];
    if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
      problems.push(`${key}: a string of 1–${max} characters`);
      return '';
    }
    return value;
  };
  const int = (key: string, min: number, max: number, optional = false): number | undefined => {
    const value = obj[key];
    if (value === undefined && optional) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      problems.push(`${key}: an integer from ${min} to ${max}`);
      return undefined;
    }
    return value;
  };
  const positive = (key: string): number | undefined => {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      problems.push(`${key}: a positive number`);
      return undefined;
    }
    return value;
  };

  const validator = (typeof obj.validator === 'object' && obj.validator !== null ? obj.validator : {}) as Record<
    string,
    unknown
  >;
  const validatorName = validator.name;
  if (typeof validatorName !== 'string' || validatorName.trim() === '' || validatorName.length > 64) {
    problems.push('validator.name: a string of 1–64 characters');
  }
  const vote = validator.vote ?? null;
  if (vote !== null && !isPubkey(vote)) problems.push('validator.vote: a base58 vote account or null');

  const symbol = text('symbol', 10);
  const name = text('name', 32);
  const uri = text('uri', 200);
  const shareBps = int('shareBps', 1, 10_000);
  const termEpochs = int('termEpochs', 1, 10_000);
  const avgRevenueSol = positive('avgRevenueSol');
  const supply = int('supply', 1, 1_000_000_000_000);
  const decimals = int('decimals', 6, 9);
  const raiseTargetSol = positive('raiseTargetSol');
  const tradingFeeBps = int('tradingFeeBps', 25, 9_900, true);
  const curvePoints = int('curvePoints', 2, 17, true);
  const startEpoch = int('startEpoch', 0, 1_000_000, true);
  const dammFeeBps = obj.dammFeeBps;
  if (dammFeeBps !== undefined && !DAMM_FEES.includes(dammFeeBps as number)) {
    problems.push(`dammFeeBps: one of ${DAMM_FEES.join(', ')}`);
  }
  const creator = obj.creator;
  if (creator !== undefined && !isPubkey(creator)) problems.push('creator: a base58 wallet address');
  if (avgRevenueSol === undefined && vote === null && !problems.some((p) => p.startsWith('avgRevenueSol'))) {
    problems.push('avgRevenueSol: required when validator.vote is null (revenue is read from the vote account)');
  }
  if (problems.length > 0) throw new LaunchConfigError(problems);

  return {
    validator: { name: validatorName as string, vote: vote as string | null },
    symbol,
    name,
    uri,
    shareBps: shareBps as number,
    termEpochs: termEpochs as number,
    avgRevenueSol,
    supply: supply as number,
    decimals: decimals as number,
    raiseTargetSol,
    tradingFeeBps,
    dammFeeBps: dammFeeBps as DammFeeBps | undefined,
    curvePoints,
    startEpoch,
    creator: creator as string | undefined,
  };
}

export interface LaunchPlan {
  config: LaunchConfigInput;
  cluster: LaunchCluster;
  avgRevenueSol: number;
  startEpoch: number;
  endEpoch: number;
  band: LaunchBand;
  curve: RevenueCurve;
}

/** Prices the share and builds the curve for a validated config (pure; throws if the curve cannot be built). */
export function planLaunch(input: {
  config: LaunchConfigInput;
  avgRevenueSol: number;
  startEpoch: number;
  cluster?: LaunchCluster;
}): LaunchPlan {
  const { config, avgRevenueSol, startEpoch } = input;
  if (!(avgRevenueSol > 0)) {
    throw new RangeError(`average revenue must be positive to price the share, got ${avgRevenueSol} SOL`);
  }
  const band = launchBand({
    avgRevenueSol,
    shareBps: config.shareBps,
    termEpochs: config.termEpochs,
    supply: config.supply,
  });
  const curve = revenueCurveConfig({
    bandLowSol: band.bandLowSol,
    bandHighSol: band.bandHighSol,
    supply: config.supply,
    decimals: config.decimals,
    raiseTargetSol: config.raiseTargetSol,
    tradingFeeBps: config.tradingFeeBps,
    dammFeeBps: config.dammFeeBps,
    points: config.curvePoints,
  });
  return {
    config,
    cluster: input.cluster ?? 'devnet',
    avgRevenueSol,
    startEpoch,
    endEpoch: endEpochOf(startEpoch, config.termEpochs),
    band,
    curve,
  };
}

/** The registry entry for a launched plan. */
export function registryEntryFor(
  plan: LaunchPlan,
  accounts: { mint: string; dbcPool: string; dbcConfig: string },
  launchedAt?: string,
): LaunchRegistryEntry {
  const { config } = plan;
  return {
    mint: accounts.mint,
    symbol: config.symbol,
    name: config.name,
    validator: { name: config.validator.name, vote: config.validator.vote },
    shareBps: config.shareBps,
    termEpochs: config.termEpochs,
    startEpoch: plan.startEpoch,
    opensAtEpoch: null,
    dbcPool: accounts.dbcPool,
    dbcConfig: accounts.dbcConfig,
    dammPool: null,
    escrow: null,
    supply: config.supply,
    decimals: config.decimals,
    burned: 0,
    cluster: plan.cluster,
    avgRevenueSol: plan.avgRevenueSol,
    raiseTargetSol: plan.curve.migrationThresholdSol,
    graduatedEpoch: null,
    ...(launchedAt ? { launchedAt } : {}),
  };
}
