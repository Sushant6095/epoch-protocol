import { FEE_INDEX_METHODOLOGY_URL, loadConfig, PantaApiConfigSchema } from '@epoch/config-sdk';
import { findFeeIndexPda, findPoolPda } from '@epoch/epoch-sdk';
import { type EpochDb, epochIndex, PostgresConnectionManager } from '@epoch/pg_models';
import { PublicKey } from '@solana/web3.js';
import { eq } from 'drizzle-orm';

import { dbAvailable } from '../../Lib/Db';
import { isoIst } from '../../Lib/Stats';
import { type FeeIndexStatus } from '../../types/Activity.types';
import { type FeeIndexEpochStatus, type FeeIndexEpochView } from '../../types/Panta.types';
import { getServices } from '../index';
import { TimedCache } from '../Panta/TimedCache';
import { FeeIndexService } from './FeeIndexService';

export const FEE_INDEX_EPOCH_SOURCE = "Epoch indexer (epoch_index) and the Epoch program's FeeIndex account";

/** What one mainnet epoch's view is built from. */
export interface FeeIndexEpochDeps {
  /** The indexer's row for a MAINNET epoch (`epoch_index`), or null (missing, or no Postgres). */
  computed(epoch: number): Promise<{ value: number; postedSignature: string | null } | null>;
  /** The program's own value for a PROGRAM epoch (final, proposed or vetoed), or null. */
  programPoint(programEpoch: number): Promise<{ value: number; status: FeeIndexStatus } | null>;
  /** The program epoch an index post landed under (from its IndexProposed event), or null when not ingested. */
  postedEpoch(signature: string): Promise<number | null>;
  program: { programId: string | null; cluster: string };
  methodologyUrl: string;
  now?: () => number;
}

const NOTE =
  'Solana mainnet epoch. pending: no value yet. computed: computed by the indexer, not posted on chain yet. ' +
  'proposed: posted to the FeeIndex account, inside its dispute window. final: the dispute window passed without a ' +
  'veto (what Epoch’s Panta markets resolve from). vetoed: the posted value was vetoed; a corrected value may follow.';

/**
 * GET /v1/index/epochs/:epoch: one MAINNET epoch's Solana Fee Index and how settled it is. The program may run on
 * another cluster (devnet), where a mainnet epoch's value is posted under a program epoch `P = M + offset`: the post's
 * signature (`epoch_index.posted_signature`) leads to its IndexProposed event and so to P, whatever the offset. When
 * the program runs on mainnet, P = M.
 */
export class FeeIndexEpochService {
  constructor(private readonly deps: FeeIndexEpochDeps) {}

  async epoch(epoch: number): Promise<FeeIndexEpochView> {
    const { deps } = this;
    const row = await deps.computed(epoch);
    let programEpoch: number | null = null;
    if (deps.program.programId) {
      if (row?.postedSignature) programEpoch = await deps.postedEpoch(row.postedSignature);
      if (programEpoch === null && deps.program.cluster === 'mainnet') programEpoch = epoch;
    }
    const point = programEpoch === null ? null : await deps.programPoint(programEpoch);
    const status: FeeIndexEpochStatus = point?.status ?? (row ? 'computed' : 'pending');
    return {
      schemaVersion: 1,
      kind: 'real',
      asOf: isoIst(new Date(deps.now?.() ?? Date.now())),
      source: FEE_INDEX_EPOCH_SOURCE,
      note: NOTE,
      epoch,
      value: point?.value ?? row?.value ?? null,
      status,
      final: status === 'final',
      unit: 'µL/CU',
      computedValue: row?.value ?? null,
      onChain: deps.program.programId
        ? {
            cluster: deps.program.cluster,
            programId: deps.program.programId,
            feeIndexAccount: feeIndexAddress(deps.program.programId),
            programEpoch,
            postSignature: row?.postedSignature ?? null,
          }
        : null,
      methodology: deps.methodologyUrl,
    };
  }
}

const feeIndexAddress = (programId: string): string => {
  const program = new PublicKey(programId);
  return findFeeIndexPda(program, findPoolPda(program)[0])[0].toBase58();
};

let service: FeeIndexEpochService | undefined;

/** One per process, on the shared program source and event store; Postgres when configured. */
export function getFeeIndexEpochService(): FeeIndexEpochService {
  if (service) return service;
  const { program, events } = getServices();
  const programOnly = new FeeIndexService({ program, events, computed: null });
  const db: (() => EpochDb) | null = dbAvailable() ? () => PostgresConnectionManager.getDb() : null;
  // The IndexProposed events, re-read at most every 30 s (an epoch's post is found once and does not change).
  const posts = new TimedCache<Map<string, number>>(30_000, 10 * 60_000, 1);
  const methodologyUrl = (() => {
    try {
      return loadConfig(PantaApiConfigSchema).PANTA_METHODOLOGY_URL;
    } catch {
      return FEE_INDEX_METHODOLOGY_URL;
    }
  })();
  service = new FeeIndexEpochService({
    computed: async (epoch) => {
      if (!db) return null;
      const [row] = await db().select().from(epochIndex).where(eq(epochIndex.epoch, epoch)).limit(1);
      return row ? { value: row.value, postedSignature: row.postedSignature } : null;
    },
    programPoint: async (programEpoch) => {
      if (!program.configured) return null;
      const [point] = await programOnly.points({ from: programEpoch, to: programEpoch, limit: 1 });
      return point?.status ? { value: point.value, status: point.status } : null;
    },
    postedEpoch: async (signature) => {
      const map = await posts.get('posts', async () => {
        const proposed = await events.query({ names: ['IndexProposed'], limit: 10_000 });
        return new Map(proposed.map((event) => [event.signature, Number(event.data.epoch)]));
      });
      return map.value.get(signature) ?? null;
    },
    program: { programId: program.programId?.toBase58() ?? null, cluster: program.cluster },
    methodologyUrl,
  });
  return service;
}

/** Tests. */
export function setFeeIndexEpochService(next: FeeIndexEpochService | undefined): void {
  service = next;
}
