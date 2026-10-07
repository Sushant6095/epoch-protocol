import { FEE_INDEX_METHODOLOGY_URL, loadConfig, PantaApiConfigSchema } from '@epoch/config-sdk';
import { findFeeIndexPda, findIndexBallotPda, findPoolPda } from '@epoch/epoch-sdk';
import { type EpochDb, epochIndex, PostgresConnectionManager } from '@epoch/pg_models';
import { PublicKey } from '@solana/web3.js';
import { eq } from 'drizzle-orm';

import { dbAvailable } from '../../Lib/Db';
import { type StoredProgramEvent } from '../../Lib/EventBus';
import { isoIst } from '../../Lib/Stats';
import { type FeeIndexBallotView, type FeeIndexStatus } from '../../types/Activity.types';
import { type FeeIndexEpochStatus, type FeeIndexEpochView } from '../../types/Panta.types';
import { getServices } from '../index';
import { TimedCache } from '../Panta/TimedCache';
import { BALLOT_EVENT_NAMES, ballotFromAccount, ballotFromEvents } from './FeeIndexBallotView';
import { FeeIndexService } from './FeeIndexService';

export const FEE_INDEX_EPOCH_SOURCE = "Epoch indexer (epoch_index) and the Epoch program's FeeIndex account";

/** What one mainnet epoch's view is built from. */
export interface FeeIndexEpochDeps {
  /** The indexer's row for a MAINNET epoch (`epoch_index`), or null (missing, or no Postgres). */
  computed(epoch: number): Promise<{ value: number; postedSignature: string | null } | null>;
  /** The program's own value for a PROGRAM epoch (final, proposed or vetoed), or null. */
  programPoint(programEpoch: number): Promise<{ value: number; status: FeeIndexStatus } | null>;
  /**
   * The program epoch an index post landed under: its IndexProposed event, or under operator consensus its
   * IndexVoteCast event (publisher_app records the first vote's signature). Null when not ingested.
   */
  postedEpoch(signature: string): Promise<number | null>;
  /** The operator-consensus ballot of a PROGRAM epoch (live account, else rebuilt from events), or null. */
  ballot?(programEpoch: number): Promise<FeeIndexBallotView | null>;
  /** The `finalize_index` transaction of a PROGRAM epoch (its IndexFinalized event), or null. */
  finalizedBy?(programEpoch: number): Promise<string | null>;
  program: { programId: string | null; cluster: string };
  methodologyUrl: string;
  now?: () => number;
}

const NOTE =
  'Solana mainnet epoch. pending: no value yet. computed: computed by the indexer, not posted on chain yet. ' +
  'voting: the registered operators are voting on it (ballot), no agreed value proposed yet. ' +
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
    const finalizeSignature =
      status === 'final' && programEpoch !== null && deps.finalizedBy ? await deps.finalizedBy(programEpoch) : null;
    const ballot = programEpoch !== null && deps.ballot ? await deps.ballot(programEpoch) : null;
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
            finalizeSignature,
          }
        : null,
      ballot,
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
  // No offset and no recorded posts: its points stay numbered by PROGRAM epoch (mainnetEpoch = clusterEpoch), which is
  // what programPoint asks it for.
  const programOnly = new FeeIndexService({ program, events, computed: null });
  const db: (() => EpochDb) | null = dbAvailable() ? () => PostgresConnectionManager.getDb() : null;
  // The IndexProposed / IndexFinalized events, re-read at most every 30 s (a post or a finalize, once found, never
  // changes).
  const posts = new TimedCache<Map<string, number>>(30_000, 10 * 60_000, 1);
  const finals = new TimedCache<Map<number, string>>(30_000, 10 * 60_000, 1);
  // Closed ballots' events, re-read at most every 15 s.
  const ballotEvents = new TimedCache<StoredProgramEvent[]>(15_000, 10 * 60_000, 1);
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
        const posted = await events.query({ names: ['IndexProposed', 'IndexVoteCast'], limit: 10_000 });
        return new Map(posted.map((event) => [event.signature, Number(event.data.epoch)]));
      });
      return map.value.get(signature) ?? null;
    },
    ballot: async (programEpoch) => {
      if (!program.configured || !program.programId) return null;
      const [ballots, index] = await Promise.all([program.indexBallots(), program.feeIndex()]);
      const live = ballots.find((b) => Number(b.account.epoch) === programEpoch);
      if (live) return ballotFromAccount(live.address, live.account, index?.account ?? null);
      const stored = await ballotEvents.get('ballots', () =>
        events.query({ names: BALLOT_EVENT_NAMES, limit: 10_000 }),
      );
      const feeIndex = findFeeIndexPda(program.programId, findPoolPda(program.programId)[0])[0];
      const address = findIndexBallotPda(program.programId, feeIndex, programEpoch)[0].toBase58();
      return ballotFromEvents(address, programEpoch, stored.value, index?.account ?? null);
    },
    finalizedBy: async (programEpoch) => {
      const map = await finals.get('finals', async () => {
        const finalized = await events.query({ names: ['IndexFinalized'], limit: 10_000 });
        return new Map(finalized.map((event) => [Number(event.data.epoch), event.signature]));
      });
      return map.value.get(programEpoch) ?? null;
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
