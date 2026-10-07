import { type EpochDb, PostgresConnectionManager, runMigrations, validatorMevEpochs } from '@epoch/pg_models';
import { eq, TransactionRollbackError } from 'drizzle-orm';

import { type MevEpochRow, MemoryMevRepository, type MevRepository, PgMevRepository } from './MevRepository';

const TEST_DB = process.env.TEST_DATABASE_URL;
// Epochs no other test file uses; every write happens in a transaction that is rolled back.
const E = 7_351;
const VOTE_A = '3N7s9zXMZ4QqvHQR15t5GNHyqc89KduzMP7423eWiD5g';
const VOTE_B = 'CcaHc2L43ZWjwCHART3oZoJvHLAe9hzT2DJNUpBzoTN1';

const tdaRow = (vote: string, epoch: number, patch: Partial<MevEpochRow> = {}): MevEpochRow => ({
  vote,
  epoch,
  tda: `tda-${vote.slice(0, 4)}-${epoch}`,
  mevCommissionBps: 700,
  tipsLamports: 106_700_426_062n,
  tdaLamports: 6_336_992n,
  rootUploaded: true,
  totalFundsClaimedLamports: 106_695_592_750n,
  nodesClaimed: 6_579,
  maxNodes: 10_188,
  validatorShareLamports: 7_469_029_824n,
  validatorShareEstimated: true,
  validatorClaim: 'pending',
  validatorClaimedSlot: null,
  expiresAt: epoch + 10,
  uploadAuthority: '8F4jGUmxF36vQ6yabnsxX6AQVXdKBhs8kGSUuRKSg8Xt',
  pfda: null,
  pfCommissionBps: null,
  pfTransferredLamports: null,
  pfTotalClaimLamports: null,
  pfRootUploaded: null,
  ...patch,
});

async function exercise(repo: MevRepository, read: (vote: string, epoch: number) => Promise<MevEpochRow | undefined>) {
  await repo.upsert([
    tdaRow(VOTE_A, E, { mevCommissionBps: 0, validatorClaim: 'none', validatorShareLamports: 0n }),
    tdaRow(VOTE_B, E),
    tdaRow(VOTE_A, E + 1, {
      rootUploaded: false,
      tipsLamports: 32_920_331_764n,
      mevCommissionBps: 0,
      validatorClaim: 'none',
    }),
    // A validator with only a PFDA: it never blocks the epoch from settling.
    { ...tdaRow('PfOnly1111111111111111111111111111111111111', E), tda: null, validatorClaim: null },
  ]);
  // E has a pending commission node, E + 1 no root yet.
  expect(await repo.settledEpochs([E, E + 1, E + 2])).toEqual(new Set());
  expect(await repo.claimedNodes(E)).toEqual(new Map());

  // The claim lands: the row is replaced, E settles, and the claim is known (not read again).
  await repo.upsert([
    tdaRow(VOTE_B, E, { validatorClaim: 'claimed', validatorShareEstimated: false, validatorClaimedSlot: 454_050_628 }),
  ]);
  expect(await repo.settledEpochs([E, E + 1])).toEqual(new Set([E]));
  expect(await repo.claimedNodes(E)).toEqual(new Map([[VOTE_B, { amount: 7_469_029_824n, slot: 454_050_628 }]]));
  expect(await read(VOTE_B, E)).toMatchObject({ validatorClaim: 'claimed', validatorShareEstimated: false });

  // A PFDA validator node still pending keeps the epoch open too, until it is claimed.
  const pfRow = (pfValidatorClaim: string): MevEpochRow => ({
    ...tdaRow('PfNode11111111111111111111111111111111111111', E),
    tda: null,
    validatorClaim: null,
    pfda: 'pfda-1',
    pfCommissionBps: 5_000,
    pfRootUploaded: true,
    pfValidatorClaim,
  });
  await repo.upsert([pfRow('pending')]);
  expect(await repo.settledEpochs([E])).toEqual(new Set());
  await repo.upsert([pfRow('claimed')]);
  expect(await repo.settledEpochs([E])).toEqual(new Set([E]));

  // Expiry: a pending node whose TDA expired before the current epoch.
  await repo.upsert([tdaRow(VOTE_B, E + 1, { expiresAt: E + 11 })]);
  expect(await repo.expirePending(E + 11)).toBe(0);
  expect(await repo.expirePending(E + 12)).toBe(1);
  expect((await read(VOTE_B, E + 1))?.validatorClaim).toBe('expired');
}

describe('MemoryMevRepository', () => {
  it('settles epochs, remembers claims and expires pending nodes', async () => {
    const repo = new MemoryMevRepository();
    await exercise(repo, async (vote, epoch) => repo.rows.get(`${epoch}:${vote}`));
  });
});

(TEST_DB ? describe : describe.skip)('PgMevRepository (TEST_DATABASE_URL)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });
  afterAll(() => PostgresConnectionManager.close());

  it('settles epochs, remembers claims and expires pending nodes', () =>
    PostgresConnectionManager.getDb()
      .transaction(async (tx) => {
        const db = tx as unknown as EpochDb;
        const repo = new PgMevRepository(db);
        await exercise(repo, async (vote, epoch) => {
          const rows = await db.select().from(validatorMevEpochs).where(eq(validatorMevEpochs.vote, vote));
          return rows.find((r) => r.epoch === epoch);
        });
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      }));
});
