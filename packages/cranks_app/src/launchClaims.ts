import { GracefulShutdown } from '@epoch/common';
import { type LaunchClaimsConfig } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { type ClaimKind, toBaseUnits } from '@epoch/meteora';
import { ConnectionManager, loadKeypair } from '@epoch/solana';
import { type Keypair, type PublicKey } from '@solana/web3.js';

import { JobRunner } from './JobRunner';
import { LaunchFeeClaimJob } from './Jobs/LaunchFeeClaimJob';
import { RpcLaunchClaimChain } from './Launch/LaunchClaimChain';
import { LaunchRegistryFile } from './Launch/LaunchRegistryFile';
import { type TreasuryClaimRoute, treasuryClaimRoute } from './Launch/TreasuryClaims';

const logger = Logger.create('LaunchClaims');

/** The Epoch program the cranks run against: it claims for the partner treasury PDA on its own cluster. */
export interface LaunchClaimsProgram {
  programId: PublicKey;
  /** The program's cluster (`EPOCH_CLUSTER`). */
  cluster: string;
  /** The crank keypair: sends treasury claims and pays their fees. */
  cranker: Keypair;
}

/**
 * The program route for treasury claims, when the launches live on the program's cluster (the treasury PDA is the
 * same address everywhere, but only that cluster runs the program).
 */
export function launchClaimsRoute(
  config: LaunchClaimsConfig,
  program: LaunchClaimsProgram | undefined,
): TreasuryClaimRoute | undefined {
  if (!program) return undefined;
  if (program.cluster !== config.LAUNCH_CLUSTER) {
    logger.warn('treasury claims stay simulated: the launches are not on the program cluster', {
      launchCluster: config.LAUNCH_CLUSTER,
      programCluster: program.cluster,
    });
    return undefined;
  }
  return treasuryClaimRoute(program.programId, program.cranker);
}

/** The fee-claim job for a config (keys loaded from their paths; only public keys are logged). */
export function createLaunchFeeClaimJob(config: LaunchClaimsConfig, program?: LaunchClaimsProgram): LaunchFeeClaimJob {
  if (!config.LAUNCHES_PATH) throw new Error('LAUNCHES_PATH is required for launch fee claims');
  const signers = new Map<string, Keypair>();
  const treasury = config.TREASURY_KEYPAIR_PATH ? loadKeypair(config.TREASURY_KEYPAIR_PATH) : undefined;
  if (treasury) signers.set(treasury.publicKey.toBase58(), treasury);
  for (const path of config.LAUNCH_CREATOR_KEYPAIR_PATHS) {
    const creator = loadKeypair(path);
    signers.set(creator.publicKey.toBase58(), creator);
  }
  const registry = new LaunchRegistryFile(config.LAUNCHES_PATH, config.LAUNCH_CLUSTER);
  return new LaunchFeeClaimJob({
    launches: () => registry.load(),
    chain: new RpcLaunchClaimChain(
      new ConnectionManager(config.LAUNCH_RPC_URL, config.LAUNCH_RPC_FALLBACK_URL),
      config.LAUNCH_CLAIM_CU_PRICE_MICROLAMPORTS,
    ),
    signers,
    payer: treasury,
    kinds: new Set<ClaimKind>(config.LAUNCH_CLAIM_KINDS),
    minLamports: toBaseUnits(config.LAUNCH_CLAIM_MIN_SOL, 9),
    dryRun: config.LAUNCH_CLAIMS_DRY_RUN,
    program: launchClaimsRoute(config, program),
  });
}

/**
 * Starts the launch fee claims on their own loop (every LAUNCH_CLAIM_INTERVAL_MINUTES, first run at start) when
 * LAUNCH_CLAIMS_ENABLED. With `program`, the partner treasury's claims go through the Epoch program. Returns the stop
 * function, or undefined when off.
 */
export function startLaunchFeeClaims(
  config: LaunchClaimsConfig,
  program?: LaunchClaimsProgram,
): (() => Promise<void>) | undefined {
  if (!config.LAUNCH_CLAIMS_ENABLED) {
    logger.info('launch fee claims off (LAUNCH_CLAIMS_ENABLED=false)');
    return undefined;
  }
  const job = createLaunchFeeClaimJob(config, program);
  // A runner with no boundary steps: the job is its only poller, run every interval.
  const runner = new JobRunner(async () => 0n, [], [], [job], {
    pollMs: config.LAUNCH_CLAIM_INTERVAL_MINUTES * 60_000,
    alertAfterMs: Number.MAX_SAFE_INTEGER,
  });
  const stop = runner.start();
  GracefulShutdown.register('launch-fee-claims', stop);
  logger.info('launch fee claims started', {
    cluster: config.LAUNCH_CLUSTER,
    everyMinutes: config.LAUNCH_CLAIM_INTERVAL_MINUTES,
    kinds: config.LAUNCH_CLAIM_KINDS,
    treasuryKey: !!config.TREASURY_KEYPAIR_PATH,
    treasuryPda: job.treasury?.toBase58() ?? null,
    creatorKeys: config.LAUNCH_CREATOR_KEYPAIR_PATHS.length,
    dryRun: config.LAUNCH_CLAIMS_DRY_RUN,
  });
  return stop;
}
