import {
  ApiConfigSchema,
  EpochProgramConfigSchema,
  loadConfig,
  MarketDataConfigSchema,
  StreamConfigSchema,
} from '@epoch/config-sdk';
import { PostgresConnectionManager } from '@epoch/pg_models';

import { dbAvailable } from '../../Lib/Db';
import { bus } from '../../Lib/EventBus';
import { JsonRpcClient } from '../../Lib/Http';
import { toWsUrl } from '../../Sources/EpochProgramSource';
import { MainnetSlotSource } from '../../Sources/MainnetSlotSource';
import { Web3IngestRpc } from '../../Sources/ProgramLogsSource';
import { ActivityService } from '../Activity/ActivityService';
import { PgPredictCallSource } from '../Activity/PredictCallSource';
import { ValidatorNames } from '../Activity/ValidatorNames';
import { getServices } from '../index';
import { StreamHub } from '../Stream/StreamHub';
import { FeeIndexService, PgComputedIndexSource } from './FeeIndexService';
import { PoolSnapshotRecorder, PgPoolSnapshotRepo } from './PoolSnapshotRecorder';
import { ProgramEventIngester } from './ProgramEventIngester';

/** Program events, the activity feed, the Fee Index status and WS /v1/stream (requests #3 and #4). */
export interface ProgramEventServices {
  /** GET /v1/index, the WS `feeIndex` channel, and `latest()` for the Fee Market snapshot. */
  feeIndex: FeeIndexService;
  /** GET /v1/activity and the WS `activity` channel. */
  activity: ActivityService;
  /** Reads program events into program_events and announces them on the bus. start() after the HTTP server. */
  ingester: ProgramEventIngester;
  /** Writes pool_snapshots on each Accrued event. start() before the ingester. */
  recorder: PoolSnapshotRecorder;
  /** WS /v1/stream. attach(server.httpServer) after start(); the vault provider is set with setProvider('vault', …). */
  stream: StreamHub;
}

let eventServices: ProgramEventServices | undefined;

/** One set per process, built on first use from the shared services and the program, API and stream config. */
export function getProgramEventServices(): ProgramEventServices {
  if (eventServices) return eventServices;
  const services = getServices();
  const config = loadConfig(EpochProgramConfigSchema);
  const market = loadConfig(MarketDataConfigSchema);
  const db = dbAvailable() ? PostgresConnectionManager.getDb() : null;
  const { program, events } = services;

  const names = new ValidatorNames(async () => (await services.validators.get()).rows);
  const feeIndex = new FeeIndexService({
    program,
    events,
    computed: db ? new PgComputedIndexSource(db) : null,
  });
  const activity = new ActivityService({
    program,
    events,
    predict: db ? new PgPredictCallSource(db) : null,
    names: () => names.get(),
  });

  // Ingestion has its own connection: a dedicated websocket for logsSubscribe, and 429s left to the ingester's backoff.
  const rpc = program.programId
    ? new Web3IngestRpc({
        url: config.EPOCH_RPC_URL,
        wsUrl: config.EPOCH_RPC_WS_URL ?? toWsUrl(config.EPOCH_RPC_URL),
        fallbackUrl: config.EPOCH_RPC_FALLBACK_URL,
      })
    : undefined;
  const ingester = new ProgramEventIngester({
    programId: program.programId,
    enabled: config.PROGRAM_EVENTS_INGEST,
    rpc,
    store: events,
    bus,
    epochOfSlot: (slot) => program.epochOfSlot(slot),
    invalidate: (name) => program.invalidateFor(name),
    backfillLimit: config.PROGRAM_EVENTS_BACKFILL_LIMIT,
  });

  const recorder = new PoolSnapshotRecorder({
    pool: program,
    events,
    repo: db ? new PgPoolSnapshotRepo(db) : null,
    bus,
    enabled: program.configured,
  });

  const mainnetRpc = new JsonRpcClient(
    [market.DATA_RPC_URL, market.DATA_RPC_FALLBACK_URL].filter((url): url is string => !!url),
  );
  const stream = new StreamHub({
    bus,
    corsOrigins: loadConfig(ApiConfigSchema).API_CORS_ORIGINS,
    slotIntervalMs: loadConfig(StreamConfigSchema).STREAM_SLOT_INTERVAL_MS,
    slots: new MainnetSlotSource(services.solana, mainnetRpc, (info) => services.market.epochInfo.set(info)),
    names: () => names.get(),
    activity,
    // `vault` comes from the VaultService (request #8): index.ts sets stream.setProvider('vault', …).
    providers: { feeIndex: feeIndex.available ? () => feeIndex.stream() : undefined },
  });

  eventServices = { feeIndex, activity, ingester, recorder, stream };
  return eventServices;
}
