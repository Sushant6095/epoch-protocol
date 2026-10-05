/**
 * The launch script's pre-flight checks, as pure functions of what it read: each returns pass, warn or fail with one line
 * of detail. A launch is sent only when nothing failed (and, on mainnet, after the operator types the symbol).
 */
import { type ConfigParameters, type PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk';

import { LAMPORTS_PER_SOL, NATIVE_MINT, TOKEN_PROGRAM_ID } from './constants';
import { endEpochOf } from './math';
import { type LaunchCluster, type LaunchRegistryEntry } from './registry';
import { toBigInt } from './units';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Genesis hashes of the public clusters. */
export const GENESIS_HASH: Record<LaunchCluster, string> = {
  mainnet: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
};

const NATIVE_MINT_ADDRESS = NATIVE_MINT.toBase58();
const TOKEN_PROGRAM_ID_ADDRESS = TOKEN_PROGRAM_ID.toBase58();

const pass = (name: string, detail: string): PreflightCheck => ({ name, status: 'pass', detail });
const warn = (name: string, detail: string): PreflightCheck => ({ name, status: 'warn', detail });
const fail = (name: string, detail: string): PreflightCheck => ({ name, status: 'fail', detail });
const sol = (lamports: number | bigint): string =>
  `${(Number(lamports) / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 6 })} SOL`;

/** The RPC serves the cluster the launch is for. A local stand-in passes only with `allowOther`. */
export function checkCluster(cluster: LaunchCluster, genesisHash: string, allowOther = false): PreflightCheck {
  const name = 'Cluster';
  if (genesisHash === GENESIS_HASH[cluster]) return pass(name, `${cluster} (genesis ${genesisHash})`);
  const actual = Object.entries(GENESIS_HASH).find(([, hash]) => hash === genesisHash)?.[0];
  if (actual) return fail(name, `the RPC serves ${actual}, not ${cluster}`);
  if (cluster === 'mainnet') return fail(name, `the RPC is not mainnet (genesis ${genesisHash})`);
  return allowOther
    ? warn(name, `not the public ${cluster}: genesis ${genesisHash} (a local stand-in, --allow-unknown-genesis)`)
    : fail(name, `not ${cluster}: genesis ${genesisHash} (pass --allow-unknown-genesis for a local stand-in)`);
}

/** A program the launch calls is deployed and executable. */
export function checkProgram(label: string, info: { executable: boolean } | null): PreflightCheck {
  const name = `${label} program`;
  if (!info) return fail(name, 'not deployed on this cluster');
  return info.executable ? pass(name, 'deployed') : fail(name, 'the account exists but is not executable');
}

/** An account the launch needs exists (the DAMM v2 migration config, the pool authorities). */
export function checkAccount(label: string, exists: boolean, missing: string): PreflightCheck {
  return exists ? pass(label, 'exists') : fail(label, missing);
}

/** The payer can cover the launch, with a margin for fees. */
export function checkPayerBalance(
  balanceLamports: number | null,
  costLamports: number,
  marginLamports = 10_000_000,
  what: { name: string; step: string } = { name: 'Payer balance', step: 'launch' },
): PreflightCheck {
  const { name } = what;
  if (balanceLamports === null) return warn(name, 'no payer key loaded (dry run): balance not checked');
  const needed = costLamports + marginLamports;
  return balanceLamports >= needed
    ? pass(name, `${sol(balanceLamports)}, ${what.step} needs about ${sol(costLamports)}`)
    : fail(name, `${sol(balanceLamports)}, needs at least ${sol(needed)} (cost + ${sol(marginLamports)} margin)`);
}

/**
 * The registry has no live launch of the same symbol or validator on this cluster: one revenue token per vote account
 * (the program's `RevenueToken` PDA is per vote), and symbols identify launches in the API.
 */
export function checkRegistry(
  entries: readonly LaunchRegistryEntry[],
  launch: { symbol: string; vote: string | null; cluster: LaunchCluster; currentEpoch: number | null },
): PreflightCheck[] {
  const sameCluster = entries.filter((entry) => entry.cluster === launch.cluster);
  const live = (entry: LaunchRegistryEntry) =>
    launch.currentEpoch === null || launch.currentEpoch <= endEpochOf(entry.startEpoch, entry.termEpochs);
  const checks: PreflightCheck[] = [];
  const bySymbol = sameCluster.find((entry) => entry.symbol.toLowerCase() === launch.symbol.toLowerCase());
  checks.push(
    bySymbol
      ? fail('Registry: symbol', `${bySymbol.symbol} is already launched on ${launch.cluster} (mint ${bySymbol.mint})`)
      : pass('Registry: symbol', `${launch.symbol} is new on ${launch.cluster}`),
  );
  if (launch.vote) {
    const byVote = sameCluster.find((entry) => entry.validator.vote === launch.vote && live(entry));
    checks.push(
      byVote
        ? fail(
            'Registry: validator',
            `${byVote.symbol} already sells this vote account's revenue until epoch ${endEpochOf(byVote.startEpoch, byVote.termEpochs)}`,
          )
        : pass('Registry: validator', 'no live revenue token for this vote account'),
    );
  }
  return checks;
}

/** The fields of an existing DBC config that must match the planned one for it to be reused. */
const CONFIG_FIELDS = [
  'migrationQuoteThreshold',
  'sqrtStartPrice',
  'tokenDecimal',
  'migrationFeePercentage',
  'creatorMigrationFeePercentage',
  'partnerPermanentLockedLiquidityPercentage',
  'migrationOption',
  'migrationFeeOption',
  'tokenUpdateAuthority',
  'creatorTradingFeePercentage',
  'collectFeeMode',
] as const;

const fieldValue = (value: unknown): string =>
  value !== null && typeof value === 'object' && 'toString' in value ? String(value) : String(value);

/** An existing config (`--config-account`) matches the plan and names Epoch's treasury PDA as fee claimer. */
export function checkExistingConfig(
  onChain: PoolConfig | null,
  planned: ConfigParameters,
  partner: { feeClaimer: string; leftoverReceiver: string },
): PreflightCheck {
  const name = 'Existing DBC config';
  if (!onChain) return fail(name, 'not found on this cluster');
  const problems: string[] = [];
  if (onChain.feeClaimer.toBase58() !== partner.feeClaimer) {
    problems.push(`fee claimer ${onChain.feeClaimer.toBase58()} is not the treasury PDA ${partner.feeClaimer}`);
  }
  if (onChain.leftoverReceiver.toBase58() !== partner.leftoverReceiver) {
    problems.push(`leftover receiver ${onChain.leftoverReceiver.toBase58()} is not ${partner.leftoverReceiver}`);
  }
  const plannedRecord = planned as unknown as Record<string, unknown>;
  const onChainRecord = onChain as unknown as Record<string, unknown>;
  const plannedFields: Record<string, unknown> = {
    ...plannedRecord,
    tokenDecimal: plannedRecord.tokenDecimal,
    migrationFeePercentage: (plannedRecord.migrationFee as { feePercentage: number } | undefined)?.feePercentage,
    creatorMigrationFeePercentage: (plannedRecord.migrationFee as { creatorFeePercentage: number } | undefined)
      ?.creatorFeePercentage,
    creatorTradingFeePercentage: plannedRecord.creatorTradingFeePercentage,
  };
  for (const key of CONFIG_FIELDS) {
    const want = plannedFields[key];
    const have = onChainRecord[key];
    if (want === undefined || have === undefined) continue;
    const same =
      typeof want === 'object' || typeof have === 'object'
        ? toBigInt(fieldValue(want)) === toBigInt(fieldValue(have))
        : Number(want) === Number(have);
    if (!same) problems.push(`${key}: on chain ${fieldValue(have)}, planned ${fieldValue(want)}`);
  }
  // The curve: the planned segments first, then empty slots on chain.
  const plannedCurve = (plannedRecord.curve as { sqrtPrice: unknown; liquidity: unknown }[] | undefined) ?? [];
  const onChainCurve = (onChainRecord.curve as { sqrtPrice: unknown; liquidity: unknown }[] | undefined) ?? [];
  const curveDiffers = plannedCurve.some(
    (point, i) =>
      toBigInt(fieldValue(point.sqrtPrice)) !== toBigInt(fieldValue(onChainCurve[i]?.sqrtPrice ?? 0)) ||
      toBigInt(fieldValue(point.liquidity)) !== toBigInt(fieldValue(onChainCurve[i]?.liquidity ?? 0)),
  );
  if (curveDiffers) problems.push('the curve segments differ');
  return problems.length === 0
    ? pass(name, 'matches the plan; reusing it (no new config account)')
    : fail(name, problems.join('; '));
}

/** The metadata URI serves JSON whose name and symbol match the launch. */
export function checkMetadataJson(
  fetched: { ok: boolean; status?: number; json?: unknown; error?: string },
  launch: { name: string; symbol: string; cluster: LaunchCluster },
): PreflightCheck {
  const name = 'Metadata URI';
  const soft = launch.cluster === 'mainnet' ? fail : warn;
  if (!fetched.ok) return soft(name, `not reachable (${fetched.error ?? `HTTP ${fetched.status}`})`);
  const json = (fetched.json ?? {}) as { name?: unknown; symbol?: unknown; image?: unknown };
  const problems: string[] = [];
  if (json.name !== launch.name) problems.push(`name "${String(json.name)}" ≠ "${launch.name}"`);
  if (json.symbol !== launch.symbol) problems.push(`symbol "${String(json.symbol)}" ≠ "${launch.symbol}"`);
  if (typeof json.image !== 'string') problems.push('no image');
  return problems.length === 0
    ? pass(name, 'JSON with matching name, symbol and an image')
    : soft(name, problems.join('; '));
}

/** The first buy fits on the curve without completing the raise. */
export function checkInitialBuy(buySol: number | undefined, raiseSol: number): PreflightCheck {
  const name = 'Initial buy';
  if (!buySol) return pass(name, 'none');
  if (buySol >= raiseSol) return fail(name, `${buySol} SOL would complete the ${raiseSol} SOL raise on its own`);
  if (buySol > raiseSol * 0.2) return warn(name, `${buySol} SOL is more than 20% of the raise`);
  return pass(name, `${buySol} SOL by the pool creator, in the pool's creation transaction`);
}

// ── The Epoch program (plain values: this module does not depend on the program's SDK) ──────────────

/**
 * `EPOCH_TREASURY`, when an operator sets it, must be the treasury PDA the launch derives (`["treasury", pool]`):
 * `register_revenue_token` refuses any other fee claimer. Returns the refusal, or null when they agree (or it is unset).
 */
export function treasuryMismatch(given: string | undefined, treasuryPda: string): string | null {
  if (!given || given === treasuryPda) return null;
  return (
    `EPOCH_TREASURY is ${given}, but the fee claimer must be the Epoch program's treasury PDA ${treasuryPda} ` +
    '(["treasury", pool]): register_revenue_token refuses any other. Unset EPOCH_TREASURY or set it to the PDA.'
  );
}

/** The program's limits on a revenue token's terms (`RevenueToken::validate_terms`). */
export interface RevenueTokenLimits {
  minShareBps: number;
  maxShareBps: number;
  minTermEpochs: number;
  maxTermEpochs: number;
}

/** The share and term fit what `register_revenue_token` accepts (1–5,000 bps, 10–1,000 epochs). */
export function checkRevenueTokenTerms(
  terms: { shareBps: number; termEpochs: number },
  limits: RevenueTokenLimits,
): PreflightCheck {
  const name = 'Terms (register_revenue_token)';
  const problems: string[] = [];
  if (terms.shareBps < limits.minShareBps || terms.shareBps > limits.maxShareBps) {
    problems.push(`share ${terms.shareBps} bps is outside ${limits.minShareBps}–${limits.maxShareBps}`);
  }
  if (terms.termEpochs < limits.minTermEpochs || terms.termEpochs > limits.maxTermEpochs) {
    problems.push(`term ${terms.termEpochs} epochs is outside ${limits.minTermEpochs}–${limits.maxTermEpochs}`);
  }
  return problems.length === 0
    ? pass(name, `${terms.shareBps} bps of gross revenue for ${terms.termEpochs} epochs`)
    : fail(name, `${problems.join('; ')}: the program would refuse the registration`);
}

/** The Epoch Pool exists on the launch cluster and is not paused (registration refuses a paused pool). */
export function checkEpochPool(pool: { address: string; exists: boolean; paused: boolean | null }): PreflightCheck {
  const name = 'Epoch Pool';
  if (!pool.exists) return fail(name, `${pool.address} does not exist: the program is not initialized here`);
  return pool.paused
    ? fail(name, `${pool.address} is paused: registration would fail`)
    : pass(name, `${pool.address} (not paused)`);
}

/** What the launch read of the validator's `ValidatorPosition` (null: not onboarded). */
export interface ValidatorPositionState {
  address: string;
  status: string;
  operator: string;
  revenueToken: string | null;
  /** The vote account's withdraw authority is still the program's `vote_auth` PDA. */
  authorityHeld: boolean;
}

/**
 * The validator can register the token: onboarded with Epoch, Active, no revenue token yet, the program still holds
 * its withdraw authority, and the operator key (when given) is the position's operator. A launch on mainnet that could
 * not be registered fails; on devnet it warns (the operator may onboard before registering).
 */
export function checkValidatorPosition(
  position: ValidatorPositionState | null,
  context: {
    cluster: LaunchCluster;
    vote: string | null;
    operatorKey: string | null;
    /** Registering now (the register script): anything that would make it fail is a failure on any cluster. */
    registeringNow?: boolean;
  },
): PreflightCheck[] {
  const name = 'Validator position';
  const soft = context.cluster === 'mainnet' || context.registeringNow ? fail : warn;
  if (!context.vote) return [fail(name, 'no validator.vote in the launch config: nothing to register the token to')];
  if (!position) {
    return [
      soft(name, `${context.vote} is not onboarded with Epoch: it must onboard before it can register the token`),
    ];
  }
  const checks: PreflightCheck[] = [];
  if (position.revenueToken) {
    checks.push(fail(name, `${position.address} already has a revenue token (${position.revenueToken})`));
  } else if (position.status !== 'active') {
    checks.push(soft(name, `${position.address} is ${position.status}: only an Active position can register`));
  } else if (!position.authorityHeld) {
    checks.push(soft(name, "the program no longer holds the vote account's withdraw authority"));
  } else {
    checks.push(pass(name, `${position.address}: Active, operator ${position.operator}`));
  }
  if (context.operatorKey && context.operatorKey !== position.operator) {
    checks.push(
      fail('Operator key', `LAUNCH_OPERATOR_KEYPAIR_PATH holds ${context.operatorKey}, not ${position.operator}`),
    );
  }
  return checks;
}

/** A launched token's DBC config, as `register_revenue_token` checks it (SOL-quoted, DAMM v2, SPL, fee claimer). */
export function checkRegistrableConfig(
  config: { feeClaimer: string; quoteMint: string; migrationOption: number; tokenType: number } | null,
  treasuryPda: string,
): PreflightCheck {
  const name = 'DBC config';
  if (!config) return fail(name, 'not found on this cluster');
  const problems: string[] = [];
  if (config.feeClaimer !== treasuryPda) {
    problems.push(
      `fee claimer ${config.feeClaimer} is not the treasury PDA ${treasuryPda}: the program refuses it (relaunch with the PDA)`,
    );
  }
  if (config.quoteMint !== NATIVE_MINT_ADDRESS) problems.push(`quote mint ${config.quoteMint} is not wrapped SOL`);
  if (config.migrationOption !== 1) problems.push('it does not graduate to DAMM v2');
  if (config.tokenType !== 0) problems.push('it is not an SPL Token launch (Token-2022 is refused)');
  return problems.length === 0
    ? pass(name, 'SOL-quoted, graduates to DAMM v2, SPL Token, fee claimer = the treasury PDA')
    : fail(name, problems.join('; '));
}

/** The mint `register_revenue_token` accepts: classic SPL Token, supply above 0, no mint or freeze authority. */
export function checkRegistrableMint(
  mint: { tokenProgram: string; supply: bigint; mintAuthority: string | null; freezeAuthority: string | null } | null,
): PreflightCheck {
  const name = 'Mint';
  if (!mint) return fail(name, 'not found on this cluster');
  const problems: string[] = [];
  if (mint.tokenProgram !== TOKEN_PROGRAM_ID_ADDRESS) problems.push(`owned by ${mint.tokenProgram}, not SPL Token`);
  if (mint.supply <= 0n) problems.push('no supply');
  if (mint.mintAuthority) problems.push(`mint authority ${mint.mintAuthority}`);
  if (mint.freezeAuthority) problems.push(`freeze authority ${mint.freezeAuthority}`);
  return problems.length === 0
    ? pass(name, 'SPL Token, fixed supply, no mint or freeze authority')
    : fail(name, problems.join('; '));
}

/** The leftover receiver should be the treasury PDA: the program withdraws the unsold supply from it and burns it. */
export function checkLeftoverReceiver(receiver: string, treasuryPda: string): PreflightCheck {
  const name = 'Leftover receiver';
  return receiver === treasuryPda
    ? pass(name, 'the treasury PDA (the program burns the unsold supply)')
    : warn(name, `${receiver} is not the treasury PDA: the program can only burn a leftover the treasury receives`);
}

/** The program starts the term with the epoch after registration; a different `startEpoch` in the config is ignored. */
export function checkStartEpoch(configStart: number | undefined, registrationStart: number): PreflightCheck {
  const name = 'Start epoch';
  if (configStart === undefined || configStart === registrationStart) {
    return pass(name, `${registrationStart} (the epoch after registration)`);
  }
  return warn(
    name,
    `the config says ${configStart}, but the program starts the term with the epoch after registration (${registrationStart} if registered now)`,
  );
}

export interface PreflightSummary {
  ok: boolean;
  failures: PreflightCheck[];
  warnings: PreflightCheck[];
}

export function summarizePreflight(checks: readonly PreflightCheck[]): PreflightSummary {
  const failures = checks.filter((check) => check.status === 'fail');
  return { ok: failures.length === 0, failures, warnings: checks.filter((check) => check.status === 'warn') };
}
