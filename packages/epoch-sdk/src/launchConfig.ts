/**
 * The DBC config checks `register_revenue_token` runs (`check_launch_config` in
 * `programs/epoch/src/instructions/revenue/register.rs`), for a pre-flight before anyone signs: read the config
 * account, decode the fields the program reads (same fixed offsets as `meteora_account.rs`) and run the same checks in
 * the same order. A config that passes here passes on chain; one that fails names the program error it would hit.
 */
import { PublicKey } from '@solana/web3.js';

import { NATIVE_MINT } from './constants';
import { bytesEqual } from './encoding';
import { dbcMigratedFeeBps, dbcMinBaseFeeNumerator, EpochMathError, maxImpactBound, venueFeeFloorBps } from './math';

/** `sha256("account:PoolConfig")[..8]`. */
export const DBC_POOL_CONFIG_DISCRIMINATOR = Uint8Array.from([26, 108, 14, 123, 116, 230, 129, 43]);
/** Size of a DBC `PoolConfig` account. */
export const DBC_POOL_CONFIG_LEN = 1_048;

/** The fields of a DBC `PoolConfig` that registration checks. */
export interface DbcLaunchConfig {
  quoteMint: PublicKey;
  feeClaimer: PublicKey;
  leftoverReceiver: PublicKey;
  /** Numerators over 10⁹; mode 0/1 fee scheduler (firstFactor = periods, thirdFactor = reduction), 2 rate limiter. */
  baseFee: { cliffFeeNumerator: bigint; firstFactor: number; secondFactor: bigint; thirdFactor: bigint; mode: number };
  /** Percent of the graduated pool's liquidity. */
  liquidity: {
    partnerPermanentLocked: number;
    partnerUnlocked: number;
    partnerVesting: number;
    creatorPermanentLocked: number;
    creatorUnlocked: number;
    creatorVesting: number;
  };
  /** 1 = DAMM v2. */
  migrationOption: number;
  /** 0 = SPL Token. */
  tokenType: number;
  /** 0–5 fixed DAMM v2 fee tiers, 6 customizable. */
  migrationFeeOption: number;
  /** 1 = fixed supply: the leftover goes to `leftoverReceiver`. */
  fixedTokenSupplyFlag: number;
  migratedPoolFeeBps: number;
  migratedPoolBaseFeeMode: number;
}

const keyAt = (d: Uint8Array, at: number): PublicKey => new PublicKey(d.subarray(at, at + 32));
const u16At = (d: Uint8Array, at: number): number => d[at] | (d[at + 1] << 8);
const u64At = (d: Uint8Array, at: number): bigint =>
  new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);

/** `sha256("account:VirtualPool")[..8]`. */
export const DBC_VIRTUAL_POOL_DISCRIMINATOR = Uint8Array.from([213, 224, 5, 209, 98, 69, 119, 92]);
/** Size of a DBC `VirtualPool` account. */
export const DBC_VIRTUAL_POOL_LEN = 424;

/** The head of a DBC `VirtualPool`: what registration checks (`meteora_account.rs` offsets). */
export interface DbcPoolHead {
  config: PublicKey;
  creator: PublicKey;
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  /** 0 = SPL Token. */
  poolType: number;
  /** 0 pre-bonding-curve … 3 the DAMM v2 pool exists. */
  migrationProgress: number;
}

/** Decodes a DBC `VirtualPool` account's head. Throws on a wrong discriminator or a short buffer. */
export function decodeDbcPoolHead(data: Uint8Array): DbcPoolHead {
  if (data.length < DBC_VIRTUAL_POOL_LEN || !bytesEqual(data.subarray(0, 8), DBC_VIRTUAL_POOL_DISCRIMINATOR)) {
    throw new Error('not a Meteora DBC VirtualPool account');
  }
  return {
    config: keyAt(data, 72),
    creator: keyAt(data, 104),
    baseMint: keyAt(data, 136),
    baseVault: keyAt(data, 168),
    quoteVault: keyAt(data, 200),
    poolType: data[304],
    migrationProgress: data[308],
  };
}

/** Decodes a DBC `PoolConfig` account's data. Throws on a wrong discriminator or a short buffer. */
export function decodeDbcLaunchConfig(data: Uint8Array): DbcLaunchConfig {
  if (data.length < DBC_POOL_CONFIG_LEN || !bytesEqual(data.subarray(0, 8), DBC_POOL_CONFIG_DISCRIMINATOR)) {
    throw new Error('not a Meteora DBC PoolConfig account');
  }
  return {
    quoteMint: keyAt(data, 8),
    feeClaimer: keyAt(data, 40),
    leftoverReceiver: keyAt(data, 72),
    baseFee: {
      cliffFeeNumerator: u64At(data, 104),
      secondFactor: u64At(data, 112),
      thirdFactor: u64At(data, 120),
      firstFactor: u16At(data, 128),
      mode: data[130],
    },
    liquidity: {
      partnerPermanentLocked: data[239],
      partnerUnlocked: data[240],
      partnerVesting: data[185],
      creatorPermanentLocked: data[241],
      creatorUnlocked: data[242],
      creatorVesting: data[201],
    },
    migrationOption: data[233],
    tokenType: data[237],
    migrationFeeOption: data[243],
    fixedTokenSupplyFlag: data[244],
    migratedPoolFeeBps: u16At(data, 362),
    migratedPoolBaseFeeMode: data[364],
  };
}

/** The program errors a config check can name. */
export type LaunchConfigError =
  'InvalidDbcConfig' | 'NotTreasuryLeftoverReceiver' | 'LiquidityNotLocked' | 'UnsupportedVenueFee';

export type LaunchConfigCheck =
  | {
      ok: true;
      /** The lowest fee, bps, the curve or the graduated pool can charge (stored as `fee_floor_bps`). */
      feeFloorBps: number;
      /** The highest `max_impact_bps` the token will accept: twice the floor, capped. */
      maxImpactBound: number;
    }
  | { ok: false; error: LaunchConfigError; reason: string };

const fail = (error: LaunchConfigError, reason: string): LaunchConfigCheck => ({ ok: false, error, reason });

/** `check_launch_config`: the config checks of `register_revenue_token`, in the program's order. */
export function checkLaunchConfig(config: DbcLaunchConfig, treasury: PublicKey): LaunchConfigCheck {
  if (!config.quoteMint.equals(NATIVE_MINT)) return fail('InvalidDbcConfig', 'the quote mint is not wrapped SOL');
  if (config.migrationOption !== 1) return fail('InvalidDbcConfig', 'it does not graduate to DAMM v2');
  if (config.tokenType !== 0) return fail('InvalidDbcConfig', 'the token is not SPL Token (Token-2022 is refused)');
  if (!config.feeClaimer.equals(treasury)) {
    return fail('InvalidDbcConfig', `the fee claimer ${config.feeClaimer.toBase58()} is not the treasury PDA`);
  }
  if (config.fixedTokenSupplyFlag === 1 && !config.leftoverReceiver.equals(treasury)) {
    return fail(
      'NotTreasuryLeftoverReceiver',
      `fixed supply: the leftover receiver ${config.leftoverReceiver.toBase58()} is not the treasury PDA`,
    );
  }
  const lp = config.liquidity;
  if (
    lp.partnerPermanentLocked + lp.creatorPermanentLocked !== 100 ||
    lp.partnerUnlocked !== 0 ||
    lp.partnerVesting !== 0 ||
    lp.creatorUnlocked !== 0 ||
    lp.creatorVesting !== 0
  ) {
    return fail(
      'LiquidityNotLocked',
      `only ${lp.partnerPermanentLocked + lp.creatorPermanentLocked}% is locked forever`,
    );
  }
  let floor: number;
  try {
    const curve = dbcMinBaseFeeNumerator(
      config.baseFee.mode,
      config.baseFee.cliffFeeNumerator,
      config.baseFee.firstFactor,
      config.baseFee.thirdFactor,
    );
    const pool = dbcMigratedFeeBps(
      config.migrationFeeOption,
      config.migratedPoolFeeBps,
      config.migratedPoolBaseFeeMode,
    );
    floor = venueFeeFloorBps(curve, pool);
  } catch (error) {
    if (!(error instanceof EpochMathError)) throw error;
    return fail('UnsupportedVenueFee', 'a base fee mode or migration fee option the program does not accept');
  }
  const bound = maxImpactBound(floor);
  if (bound < 10) return fail('UnsupportedVenueFee', `the lowest venue fee is ${floor} bps: below 5 bps`);
  return { ok: true, feeFloorBps: floor, maxImpactBound: bound };
}
