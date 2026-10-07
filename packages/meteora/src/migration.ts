/**
 * Graduation: a DBC curve whose raise is complete migrates to a DAMM v2 pool through DBC `migration_damm_v2`. Meteora's
 * mainnet keepers only migrate SOL curves whose threshold is 10 SOL (docs.meteora.ag, DBC developer guide, "Migration
 * Keepers"), below Epoch's raises, so cranks_app's `LaunchMigrationJob` sends it; the instruction is permissionless (the
 * payer funds the new pool's accounts). The DAMM v2 config comes from the DBC config's migration fee option.
 */
import { DAMM_V2_MIGRATION_FEE_ADDRESS, deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { type Connection, type Keypair, PublicKey, type Transaction } from '@solana/web3.js';

import { dbcClient, readCurveAccounts } from './pools';
import { toBigInt } from './units';

export type MigrationReadiness =
  | { ready: true; dammConfig: string; dammPool: string }
  | {
      ready: false;
      reason:
        'NOT_FOUND' | 'CURVE_INCOMPLETE' | 'LOCKER_REQUIRED' | 'ALREADY_MIGRATED' | 'NOT_DAMM_V2' | 'NO_DAMM_CONFIG';
    };

/**
 * DBC `VirtualPool.migration_progress` (docs.meteora.ag, DBC program accounts, `MigrationProgress`: 0 pre-bonding curve,
 * 1 post-bonding curve, 2 locked vesting, 3 created pool). At the threshold a curve with locked vesting moves to
 * PostBondingCurve and needs DBC `create_locker` first; any other curve moves straight to LockedVesting, the only state
 * in which the DAMM pool can be created (core-products/dbc/accounts-and-permissions, "Migration progress").
 */
export const MIGRATION_PROGRESS = {
  PreBondingCurve: 0,
  PostBondingCurve: 1,
  LockedVesting: 2,
  CreatedPool: 3,
} as const;

/** Whether `migration_damm_v2` can run now for a DBC pool, and the DAMM v2 config and pool it would use. */
export async function migrationReadiness(
  connection: Connection,
  dbcPool: PublicKey | string,
): Promise<MigrationReadiness> {
  const accounts = await readCurveAccounts(connection, dbcPool);
  if (!accounts) return { ready: false, reason: 'NOT_FOUND' };
  const { pool, config } = accounts;
  const progress = pool.poolState.migrationProgress;
  if (pool.poolState.isMigrated === 1 || progress === MIGRATION_PROGRESS.CreatedPool) {
    return { ready: false, reason: 'ALREADY_MIGRATED' };
  }
  if (config.migrationOption !== 1) return { ready: false, reason: 'NOT_DAMM_V2' };
  const threshold = toBigInt(config.migrationQuoteThreshold);
  if (toBigInt(pool.poolState.quoteReserve) < threshold || progress === MIGRATION_PROGRESS.PreBondingCurve) {
    return { ready: false, reason: 'CURVE_INCOMPLETE' };
  }
  // Locked vesting: the curve waits in PostBondingCurve until someone sends `create_locker`; migrating now would fail.
  if (progress !== MIGRATION_PROGRESS.LockedVesting) return { ready: false, reason: 'LOCKER_REQUIRED' };
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption];
  if (!dammConfig) return { ready: false, reason: 'NO_DAMM_CONFIG' };
  // The pool address `migration_damm_v2` derives: (DAMM v2 config, base mint, quote mint).
  const dammPool = deriveDammV2PoolAddress(dammConfig, pool.poolState.baseMint, config.quoteMint);
  return { ready: true, dammConfig: dammConfig.toBase58(), dammPool: dammPool.toBase58() };
}

/**
 * The unsigned `migration_damm_v2` transaction for a completed curve, with the two position-NFT mint keypairs that must
 * co-sign it (fresh, single-use) and the DAMM v2 pool it creates. Blockhash and fee payer are set.
 */
export async function buildMigrateToDammV2Tx(params: {
  connection: Connection;
  dbcPool: PublicKey | string;
  payer: PublicKey;
}): Promise<{ transaction: Transaction; signers: Keypair[]; dammPool: string; dammConfig: string }> {
  const { connection, payer } = params;
  const readiness = await migrationReadiness(connection, params.dbcPool);
  if (!readiness.ready) throw new Error(`cannot migrate ${String(params.dbcPool)}: ${readiness.reason}`);
  const response = await dbcClient(connection).migration.migrateToDammV2({
    payer,
    pool: new PublicKey(params.dbcPool),
    dammConfig: new PublicKey(readiness.dammConfig),
  });
  const transaction = response.transaction;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = payer;
  return {
    transaction,
    signers: [response.firstPositionNftKeypair, response.secondPositionNftKeypair],
    dammPool: readiness.dammPool,
    dammConfig: readiness.dammConfig,
  };
}
