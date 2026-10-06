import { type MigrationReadiness } from '@epoch/meteora';
import { Keypair, type PublicKey } from '@solana/web3.js';

import { type ClaimSimulation } from '../Launch/LaunchClaimChain';
import { type ClaimLaunch } from '../Launch/LaunchRegistryFile';
import { LaunchMigrationJob, type LaunchMigrationOptions } from './LaunchMigrationJob';

const DAMM = '67RY3gT3ipjqhpyRAbR5ZeCxBZDgYgWuJ5MvKMbtYXZ1';
const CONFIG = 'Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp';

const launch = (symbol: string, dammPool: string | null = null): ClaimLaunch => ({
  mint: `mint-${symbol}`,
  symbol,
  cluster: 'mainnet',
  dbcPool: `pool-${symbol}`,
  dbcConfig: null,
  dammPool,
});

/** Curves by DBC pool: what `migrationReadiness` answers; a sent migration graduates the curve. */
class FakeMigrationChain {
  readiness = new Map<string, MigrationReadiness>();
  sent: { dbcPool: string; payer: string }[] = [];
  simulated: { dbcPool: string; payer: string }[] = [];
  failSend = false;
  readError: Error | null = null;

  async migrationReadiness(target: ClaimLaunch): Promise<MigrationReadiness> {
    if (this.readError) throw this.readError;
    return this.readiness.get(target.dbcPool) ?? { ready: false, reason: 'NOT_FOUND' };
  }

  async sendMigration(target: ClaimLaunch, payer: Keypair): Promise<{ signature: string; dammPool: string }> {
    if (this.failSend) throw new Error('custom program error: 0x177e');
    this.sent.push({ dbcPool: target.dbcPool, payer: payer.publicKey.toBase58() });
    this.readiness.set(target.dbcPool, { ready: false, reason: 'ALREADY_MIGRATED' });
    return { signature: `sig-${target.symbol}`, dammPool: DAMM };
  }

  async simulateMigration(target: ClaimLaunch, payer: PublicKey): Promise<ClaimSimulation> {
    this.simulated.push({ dbcPool: target.dbcPool, payer: payer.toBase58() });
    return { ok: true, error: null };
  }
}

describe('LaunchMigrationJob', () => {
  const payer = Keypair.generate();
  const ready: MigrationReadiness = { ready: true, dammConfig: CONFIG, dammPool: DAMM };
  let chain: FakeMigrationChain;
  const job = (options: Partial<LaunchMigrationOptions> = {}, launches = [launch('rDONE'), launch('rCURV')]) =>
    new LaunchMigrationJob({ launches: () => launches, chain, payer, dryRun: false, ...options });

  beforeEach(() => {
    chain = new FakeMigrationChain();
    chain.readiness.set('pool-rDONE', ready);
    chain.readiness.set('pool-rCURV', { ready: false, reason: 'CURVE_INCOMPLETE' });
  });

  it('migrates only the completed curves, paid by the crank, once', async () => {
    const migrations = job();
    expect(await migrations.run()).toBe('done');
    expect(chain.sent).toEqual([{ dbcPool: 'pool-rDONE', payer: payer.publicKey.toBase58() }]);
    expect(migrations.last.migrated).toEqual([{ symbol: 'rDONE', signature: 'sig-rDONE', dammPool: DAMM }]);
    // The next run reads the pool again: already migrated, nothing sent.
    expect(await migrations.run()).toBe('done');
    expect(chain.sent).toHaveLength(1);
  });

  it('skips a launch whose registry entry already names its DAMM v2 pool, without reading it', async () => {
    chain.readError = new Error('should not be read');
    expect(await job({}, [launch('rGRAD', DAMM)]).run()).toBe('done');
  });

  it('simulates under dry run, and without a payer key reports what it would need', async () => {
    const dry = job({ dryRun: true });
    await dry.run();
    expect(chain.sent).toEqual([]);
    expect(chain.simulated).toEqual([{ dbcPool: 'pool-rDONE', payer: payer.publicKey.toBase58() }]);
    expect(dry.last.simulated).toEqual([{ symbol: 'rDONE', ok: true, reason: 'LAUNCH_CLAIMS_DRY_RUN' }]);
    const keyless = job({ payer: undefined });
    await keyless.run();
    expect(keyless.last.simulated).toEqual([
      { symbol: 'rDONE', ok: false, reason: 'no payer key (CRANK_KEYPAIR_PATH)' },
    ]);
  });

  it('retries next run when a read or a send fails', async () => {
    chain.failSend = true;
    const failing = job();
    expect(await failing.run()).toBe('retry');
    expect(failing.last.failed).toEqual([{ symbol: 'rDONE', error: 'Error: custom program error: 0x177e' }]);
    chain.failSend = false;
    chain.readError = new Error('429 Too Many Requests');
    expect(await job().run()).toBe('retry');
  });
});
