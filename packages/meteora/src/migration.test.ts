import { readFileSync } from 'fs';
import { join } from 'path';

import { DAMM_V2_MIGRATION_FEE_ADDRESS } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { type AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

import { DBC_PROGRAM } from './events';
import { MIGRATION_PROGRESS, migrationReadiness } from './migration';
import * as pools from './pools';

/**
 * `migrationReadiness`, the gate `LaunchMigrationJob` sends `migration_damm_v2` behind, on the rehearsal's real DBC pool
 * and config read through the real SDK. Each case moves the decoded state the way the DBC program does
 * (docs.meteora.ag, core-products/dbc/accounts-and-permissions, "Migration progress": at the threshold a curve with
 * locked vesting goes to PostBondingCurve and needs `create_locker`; any other goes straight to LockedVesting).
 */
const account = (name: string): { address: string; data: Buffer } => {
  const raw = JSON.parse(readFileSync(join(__dirname, '__fixtures__/rehearsal', `${name}.json`), 'utf8')) as {
    address: string;
    data: string;
  };
  return { address: raw.address, data: Buffer.from(raw.data, 'base64') };
};
const POOL = account('account-dbc-pool');
const CONFIG = account('account-dbc-config');
/** The DAMM v2 pool the rehearsal's `migration_damm_v2` actually created. */
const GRADUATED_DAMM_POOL = account('account-damm-pool').address;

function servedBy(accounts: Map<string, Buffer>): Connection {
  const connection = new Connection('http://127.0.0.1:1', 'confirmed');
  const info = (key: PublicKey): AccountInfo<Buffer> | null => {
    const data = accounts.get(key.toBase58());
    return data ? { data, owner: new PublicKey(DBC_PROGRAM), lamports: 1, executable: false, rentEpoch: 0 } : null;
  };
  Object.assign(connection, {
    getAccountInfo: async (key: PublicKey) => info(key),
    getAccountInfoAndContext: async (key: PublicKey) => ({ context: { slot: 1 }, value: info(key) }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(info),
  });
  return connection;
}

const served = (): Connection =>
  servedBy(
    new Map([
      [POOL.address, POOL.data],
      [CONFIG.address, CONFIG.data],
    ]),
  );

type CurveAccounts = NonNullable<Awaited<ReturnType<typeof pools.readCurveAccounts>>>;

/** Readiness after `change` edits the decoded rehearsal accounts (Anchor's coder cannot re-encode the config). */
async function readinessWith(change: (pool: CurveAccounts['pool'], config: CurveAccounts['config']) => void) {
  const connection = served();
  const accounts = await pools.readCurveAccounts(connection, POOL.address);
  if (!accounts) throw new Error('the rehearsal pool was not served');
  change(accounts.pool, accounts.config);
  const read = jest.spyOn(pools, 'readCurveAccounts').mockResolvedValue(accounts);
  try {
    return await migrationReadiness(connection, POOL.address);
  } finally {
    read.mockRestore();
  }
}

/** The curve just completed: the raise is in, nothing migrated yet, progress as the program sets it. */
const completed =
  (progress: number) =>
  (pool: CurveAccounts['pool'], config: CurveAccounts['config']): void => {
    pool.poolState.isMigrated = 0;
    pool.poolState.migrationProgress = progress;
    pool.poolState.quoteReserve = new BN(config.migrationQuoteThreshold.toString());
  };

describe('migrationReadiness on the rehearsal curve', () => {
  it('reads the graduated rehearsal pool, byte for byte, as already migrated', async () => {
    expect(await migrationReadiness(served(), POOL.address)).toEqual({ ready: false, reason: 'ALREADY_MIGRATED' });
  });

  it('is ready in LockedVesting and derives the DAMM v2 pool the rehearsal migration created', async () => {
    const readiness = await readinessWith(completed(MIGRATION_PROGRESS.LockedVesting));
    expect(readiness).toEqual({
      ready: true,
      // migration fee option 2 (the 1% tier) → its DAMM v2 config (dbc/index, migration config table)
      dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[2]!.toBase58(),
      dammPool: GRADUATED_DAMM_POOL,
    });
  });

  it('waits for create_locker in PostBondingCurve instead of sending a migration that would fail', async () => {
    expect(await readinessWith(completed(MIGRATION_PROGRESS.PostBondingCurve))).toEqual({
      ready: false,
      reason: 'LOCKER_REQUIRED',
    });
  });

  it('is incomplete one lamport below the threshold, and while the program still says PreBondingCurve', async () => {
    expect(
      await readinessWith((pool, config) => {
        completed(MIGRATION_PROGRESS.PreBondingCurve)(pool, config);
        pool.poolState.quoteReserve = new BN(config.migrationQuoteThreshold.toString()).subn(1);
      }),
    ).toEqual({ ready: false, reason: 'CURVE_INCOMPLETE' });
    expect(await readinessWith(completed(MIGRATION_PROGRESS.PreBondingCurve))).toEqual({
      ready: false,
      reason: 'CURVE_INCOMPLETE',
    });
  });

  it('treats CreatedPool as migrated even before is_migrated is read', async () => {
    expect(await readinessWith(completed(MIGRATION_PROGRESS.CreatedPool))).toEqual({
      ready: false,
      reason: 'ALREADY_MIGRATED',
    });
  });

  it('refuses DAMM v1 curves and fee options without a DAMM v2 config', async () => {
    expect(
      await readinessWith((pool, config) => {
        completed(MIGRATION_PROGRESS.LockedVesting)(pool, config);
        config.migrationOption = 0;
      }),
    ).toEqual({ ready: false, reason: 'NOT_DAMM_V2' });
    expect(
      await readinessWith((pool, config) => {
        completed(MIGRATION_PROGRESS.LockedVesting)(pool, config);
        config.migrationFeeOption = 9;
      }),
    ).toEqual({ ready: false, reason: 'NO_DAMM_CONFIG' });
  });

  it('answers NOT_FOUND for a pool that does not exist', async () => {
    expect(await migrationReadiness(servedBy(new Map()), POOL.address)).toEqual({ ready: false, reason: 'NOT_FOUND' });
  });

  it('numbers the progress states as the DBC program accounts page does', () => {
    expect(MIGRATION_PROGRESS).toEqual({ PreBondingCurve: 0, PostBondingCurve: 1, LockedVesting: 2, CreatedPool: 3 });
  });
});
