import '@epoch/common/first-module';

import { EpochProgramConfigSchema, KeeperConfigSchema, LaunchClaimsConfigSchema, loadConfig } from '@epoch/config-sdk';
import { Logger } from '@epoch/logger';
import { loadKeypair } from '@epoch/solana';
import { PublicKey } from '@solana/web3.js';

import {
  createLaunchFeeClaimJob,
  createLaunchMigrationJob,
  type LaunchClaimsProgram,
  startLaunchFeeClaims,
} from './launchClaims';

const logger = Logger.create('launch-claims');

/**
 * The Epoch program route for the partner treasury's claims, when EPOCH_PROGRAM_ID and CRANK_KEYPAIR_PATH are set
 * (the crank sends them and pays the fees). Without them those claims are simulated, as the treasury PDA cannot sign.
 */
function programRoute(): LaunchClaimsProgram | undefined {
  const { EPOCH_PROGRAM_ID, EPOCH_CLUSTER } = loadConfig(EpochProgramConfigSchema);
  const { CRANK_KEYPAIR_PATH } = loadConfig(KeeperConfigSchema.partial());
  if (!EPOCH_PROGRAM_ID || !CRANK_KEYPAIR_PATH) return undefined;
  return {
    programId: new PublicKey(EPOCH_PROGRAM_ID),
    cluster: EPOCH_CLUSTER,
    cranker: loadKeypair(CRANK_KEYPAIR_PATH),
  };
}

/**
 * Launch fee claims on their own, without the Epoch program's cranks: `node dist/launch-claims.js` runs the loop;
 * `node dist/launch-claims.js --once` runs one pass and exits. Set EPOCH_PROGRAM_ID and CRANK_KEYPAIR_PATH to send the
 * treasury's claims through the program.
 */
async function main(): Promise<void> {
  const config = loadConfig(LaunchClaimsConfigSchema);
  const program = programRoute();
  if (process.argv.includes('--once')) {
    const migration = createLaunchMigrationJob(config, program);
    if (migration) {
      await migration.run();
      logger.info('migrations done', {
        migrated: migration.last.migrated.length,
        simulated: migration.last.simulated.length,
      });
    }
    const job = createLaunchFeeClaimJob(config, program);
    const outcome = await job.run();
    logger.info('one pass done', { outcome, claimed: job.last.claimed.length, simulated: job.last.simulated.length });
    process.exitCode = job.last.failed.length > 0 || (migration?.last.failed.length ?? 0) > 0 ? 1 : 0;
    return;
  }
  if (!startLaunchFeeClaims(config, program)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  logger.error('launch-claims failed', error);
  process.exit(1);
});
