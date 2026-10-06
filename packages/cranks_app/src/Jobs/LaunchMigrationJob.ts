import { Logger } from '@epoch/logger';
import { type MigrationReadiness } from '@epoch/meteora';
import { type Keypair } from '@solana/web3.js';

import { type LaunchClaimChain } from '../Launch/LaunchClaimChain';
import { type ClaimLaunch } from '../Launch/LaunchRegistryFile';
import { type Job, type JobOutcome } from './Job';

const logger = Logger.create('LaunchMigrationJob');

export interface LaunchMigrationOptions {
  /** This cluster's launches (re-read each run). */
  launches: () => ClaimLaunch[];
  chain: Pick<LaunchClaimChain, 'migrationReadiness' | 'sendMigration' | 'simulateMigration'>;
  /** Pays the new DAMM v2 pool's accounts (about 0.023 SOL) and the fee. None: migrations are simulated. */
  payer?: Keypair;
  /** Simulate and log every migration; send nothing. */
  dryRun: boolean;
}

/** What one run did, for logs and tests. */
export interface MigrationRunSummary {
  migrated: { symbol: string; signature: string; dammPool: string }[];
  simulated: { symbol: string; ok: boolean; reason: string }[];
  failed: { symbol: string; error: string }[];
}

/**
 * Graduates Epoch's completed curves to DAMM v2 (DBC `migration_damm_v2`, permissionless). Meteora's mainnet migration
 * keepers only take SOL curves whose `migration_quote_threshold` is 10 SOL (docs.meteora.ag, DBC developer guide,
 * "Migration Keepers"); Epoch's raises are smaller, so without this crank a completed curve would stop trading until
 * someone ran Meteora's manual migrator. Every run reads each pool first (`migrationReadiness`), so a pool that is not
 * complete, already migrated (by a keeper or anyone else) or misconfigured is skipped; a repeat is a no-op.
 */
export class LaunchMigrationJob implements Job {
  readonly name = 'LaunchMigrationJob';
  last: MigrationRunSummary = { migrated: [], simulated: [], failed: [] };

  constructor(private readonly options: LaunchMigrationOptions) {}

  async run(): Promise<JobOutcome> {
    const summary: MigrationRunSummary = { migrated: [], simulated: [], failed: [] };
    for (const launch of this.options.launches()) {
      // The registry names the DAMM v2 pool once someone recorded the graduation: nothing to do.
      if (launch.dammPool) continue;
      let readiness: MigrationReadiness;
      try {
        readiness = await this.options.chain.migrationReadiness(launch);
      } catch (error) {
        summary.failed.push({ symbol: launch.symbol, error: String(error) });
        logger.warn('could not read a curve; retrying next run', { symbol: launch.symbol, error: String(error) });
        continue;
      }
      if (!readiness.ready) {
        if (readiness.reason !== 'CURVE_INCOMPLETE' && readiness.reason !== 'ALREADY_MIGRATED') {
          logger.warn('curve cannot migrate to DAMM v2', { symbol: launch.symbol, reason: readiness.reason });
        }
        continue;
      }
      const context = {
        symbol: launch.symbol,
        dbcPool: launch.dbcPool,
        dammPool: readiness.dammPool,
        dammConfig: readiness.dammConfig,
      };
      const payer = this.options.payer;
      if (this.options.dryRun || !payer) {
        const reason = this.options.dryRun ? 'LAUNCH_CLAIMS_DRY_RUN' : 'no payer key (CRANK_KEYPAIR_PATH)';
        let simulation = { ok: false, error: 'no payer to simulate with' as string | null };
        if (payer) {
          try {
            simulation = await this.options.chain.simulateMigration(launch, payer.publicKey);
          } catch (error) {
            simulation = { ok: false, error: String(error) };
          }
        }
        summary.simulated.push({ symbol: launch.symbol, ok: simulation.ok, reason });
        logger.info('curve complete; migration not sent (dry run)', {
          ...context,
          reason,
          simulation: simulation.ok ? 'ok' : simulation.error,
        });
        continue;
      }
      try {
        const sent = await this.options.chain.sendMigration(launch, payer);
        summary.migrated.push({ symbol: launch.symbol, signature: sent.signature, dammPool: sent.dammPool });
        logger.info('curve migrated to DAMM v2', { ...context, signature: sent.signature });
      } catch (error) {
        summary.failed.push({ symbol: launch.symbol, error: String(error) });
        logger.error('migration failed; retrying next run', error, context);
      }
    }
    this.last = summary;
    return summary.failed.length > 0 ? 'retry' : 'done';
  }
}
