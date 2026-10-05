import { Logger } from '@epoch/logger';
import { base58Encode } from '@epoch/meteora';
import {
  CommitmentLevel,
  type GeyserClient,
  type GrpcEndpoint,
  GrpcStream,
  type GrpcStreamStatus,
  type SubscribeRequest,
  type SubscribeUpdate,
  type SubscribeUpdateTransaction,
} from '@epoch/solana';
import { type Context, type Logs, PublicKey, type SlotInfo } from '@solana/web3.js';

const logger = Logger.create('LaunchRealtime');

/** How the trade feed learns about new transactions: a realtime source, or the polling backstop alone. */
export type LaunchFeedMode = 'grpc' | 'websocket' | 'polling';

/** A transaction a realtime source saw touch one of the watched pools. */
export interface RealtimeTransaction {
  signature: string;
  slot: number;
  /** The watched pools among its accounts. */
  pools: string[];
  failed: boolean;
  /** The transaction in a shape `normalizeTransaction` reads (gRPC carries it); null: fetch it over RPC. */
  raw: unknown | null;
  /** When the source received it (epoch ms). */
  receivedAt: number;
}

/**
 * A push source for the Launch page's trade feed. `LaunchTradeIngester` tells it which pools to watch (every launch's
 * curve and DAMM v2 pool) and decodes what it delivers with the same decoder as the polling backstop.
 */
export interface LaunchRealtimeSource {
  readonly mode: 'grpc' | 'websocket';
  /** Starts delivering; `onHealth` is called when the transport goes up or down. */
  start(onTransaction: (tx: RealtimeTransaction) => void, onHealth?: (healthy: boolean) => void): void;
  /** The pools to watch from now on. */
  watch(pools: readonly string[]): void;
  /** The transport is up (connected and alive), so polling can slow down. */
  healthy(): boolean;
  stop(): void;
}

// ── gRPC (Yellowstone, through @epoch/solana's GrpcStream) ────────────────────────────────────────────────────────

/**
 * The launch pools' transactions, confirmed, successful and non-vote: a transactions filter scoped with
 * `accountInclude` (allowed on Solami plan streams; an empty list would be a firehose, so it is never sent empty).
 */
export function launchTransactionsRequest(pools: readonly string[]): SubscribeRequest {
  if (pools.length === 0) throw new Error('a launch transactions filter needs at least one pool');
  return {
    accounts: {},
    slots: {},
    transactions: {
      launch: { vote: false, failed: false, accountInclude: [...pools], accountExclude: [], accountRequired: [] },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.CONFIRMED,
    fromSlot: undefined,
    ping: undefined,
  };
}

/**
 * A Yellowstone transaction update in the JSON-RPC `getTransaction` shape that `@epoch/meteora`'s
 * `normalizeTransaction` reads (keys in base58, instruction data as bytes, loaded addresses after the static keys).
 * gRPC updates carry no block time: `blockTime` is what the caller knows (when the node created the update, else when
 * it arrived). Null for an update without a transaction.
 */
export function rpcTransactionFromGrpc(
  update: SubscribeUpdateTransaction,
  blockTime: number | null,
): { signature: string; slot: number; failed: boolean; keys: string[]; raw: unknown } | null {
  const info = update.transaction;
  const message = info?.transaction?.message;
  if (!info || !message) return null;
  const meta = info.meta;
  const instruction = (ix: { programIdIndex: number; accounts: Uint8Array; data: Uint8Array }) => ({
    programIdIndex: ix.programIdIndex,
    accounts: Array.from(ix.accounts),
    data: ix.data,
  });
  const loaded = {
    writable: (meta?.loadedWritableAddresses ?? []).map((key) => base58Encode(key)),
    readonly: (meta?.loadedReadonlyAddresses ?? []).map((key) => base58Encode(key)),
  };
  const accountKeys = message.accountKeys.map((key) => base58Encode(key));
  const slot = Number(update.slot);
  const failed = !!meta?.err;
  return {
    signature: base58Encode(info.signature),
    slot,
    failed,
    keys: [...accountKeys, ...loaded.writable, ...loaded.readonly],
    raw: {
      slot,
      blockTime,
      meta: meta
        ? {
            err: failed ? { grpc: Array.from(meta.err?.err ?? []) } : null,
            innerInstructions: meta.innerInstructions.map((group) => ({
              index: group.index,
              instructions: group.instructions.map((ix) => ({
                ...instruction(ix),
                stackHeight: ix.stackHeight ?? null,
              })),
            })),
            loadedAddresses: loaded,
            logMessages: meta.logMessages,
          }
        : null,
      transaction: {
        signatures: (info.transaction?.signatures ?? []).map((signature) => base58Encode(signature)),
        message: { accountKeys, instructions: message.instructions.map(instruction) },
      },
    },
  };
}

export interface GrpcRealtimeOptions {
  compression?: 'zstd' | 'gzip';
  /** Tests: a fake Yellowstone client. */
  createClient?: (endpoint: GrpcEndpoint) => GeyserClient;
  now?: () => number;
}

/**
 * The launch pools' transactions over Yellowstone gRPC (Solami, RPC Fast as failover) through `GrpcStream`, which
 * reconnects and fails over by itself. The filter names the pools, so a new pool (a launch, a graduation) restarts the
 * subscription with the new list.
 */
export class GrpcRealtimeSource implements LaunchRealtimeSource {
  readonly mode = 'grpc' as const;
  private pools: string[] = [];
  private stream?: GrpcStream;
  private status: GrpcStreamStatus = 'stopped';
  private onTransaction?: (tx: RealtimeTransaction) => void;
  private onHealth?: (healthy: boolean) => void;
  private readonly now: () => number;

  constructor(
    private readonly endpoints: GrpcEndpoint[],
    private readonly options: GrpcRealtimeOptions = {},
  ) {
    if (endpoints.length === 0) throw new Error('GrpcRealtimeSource needs at least one endpoint');
    this.now = options.now ?? Date.now;
  }

  start(onTransaction: (tx: RealtimeTransaction) => void, onHealth?: (healthy: boolean) => void): void {
    this.onTransaction = onTransaction;
    this.onHealth = onHealth;
    this.restart();
  }

  watch(pools: readonly string[]): void {
    const next = [...new Set(pools)].sort();
    if (next.length === this.pools.length && next.every((pool, i) => pool === this.pools[i])) return;
    this.pools = next;
    if (this.onTransaction) this.restart();
  }

  healthy(): boolean {
    return this.status === 'streaming';
  }

  stop(): void {
    this.onTransaction = undefined;
    this.stream?.stop();
    this.stream = undefined;
    this.setStatus('stopped');
  }

  private restart(): void {
    this.stream?.stop();
    this.stream = undefined;
    if (this.pools.length === 0) {
      this.setStatus('stopped');
      return;
    }
    const pools = this.pools;
    const watched = new Set(pools);
    const create = this.options.createClient;
    const stream = new GrpcStream(this.endpoints, {
      compression: this.options.compression,
      onState: (state) => {
        if (this.stream === stream) this.setStatus(state.status);
      },
      ...(create ? { createClient: (endpoint: GrpcEndpoint) => create(endpoint) } : {}),
    });
    this.stream = stream;
    logger.info('launch pools: gRPC transaction subscription', { pools: pools.length });
    void stream
      .run(
        () => launchTransactionsRequest(pools),
        (update) => this.deliver(update, watched),
      )
      .catch((error: unknown) => {
        logger.warn('launch gRPC subscription stopped', { error: String(error) });
        if (this.stream === stream) this.setStatus('stopped');
      });
  }

  private deliver(update: SubscribeUpdate, watched: ReadonlySet<string>): void {
    if (!update.transaction || !this.onTransaction) return;
    const receivedAt = this.now();
    // Yellowstone sends no block time. The closest is when the node created the update (its slot was confirmed), so
    // the feed lag includes the stream's own delay; without it (or from a node clock ahead of ours), the arrival time.
    const created = update.createdAt?.getTime();
    const at = created !== undefined && Number.isFinite(created) && created <= receivedAt ? created : receivedAt;
    const tx = rpcTransactionFromGrpc(update.transaction, Math.floor(at / 1000));
    if (!tx) return;
    const pools = tx.keys.filter((key) => watched.has(key));
    if (pools.length === 0) return;
    this.onTransaction({ signature: tx.signature, slot: tx.slot, pools, failed: tx.failed, raw: tx.raw, receivedAt });
  }

  private setStatus(status: GrpcStreamStatus): void {
    const was = this.healthy();
    this.status = status;
    if (was !== this.healthy()) this.onHealth?.(this.healthy());
  }
}

// ── Websocket (the launch RPC's logsSubscribe) ─────────────────────────────────────────────────────────────────────

/** What the websocket source needs from a web3.js `Connection` (its websocket endpoint). */
export interface LogsConnection {
  onLogs(filter: PublicKey, callback: (logs: Logs, context: Context) => void, commitment?: 'confirmed'): number;
  removeOnLogsListener(id: number): Promise<void>;
  onSlotChange(callback: (slot: SlotInfo) => void): number;
  removeSlotChangeListener(id: number): Promise<void>;
}

export interface WebsocketRealtimeOptions {
  /** No slot notification for this long: the websocket counts as down. Default 15 s. */
  heartbeatMs?: number;
  now?: () => number;
}

/**
 * The launch pools' transactions over the launch RPC's websocket: one `logsSubscribe` per pool (confirmed), each
 * notification a signature to fetch and decode. Slot notifications are the heartbeat: without one for `heartbeatMs`
 * the source reports itself down and polling speeds back up (web3.js reconnects the socket by itself).
 */
export class WebsocketRealtimeSource implements LaunchRealtimeSource {
  readonly mode = 'websocket' as const;
  private pools = new Set<string>();
  private readonly subscriptions = new Map<string, number>();
  private slotSubscription?: number;
  private lastSlotAt: number | null = null;
  private onTransaction?: (tx: RealtimeTransaction) => void;
  private onHealth?: (healthy: boolean) => void;
  private healthTimer?: NodeJS.Timeout;
  private wasHealthy = false;
  private readonly now: () => number;
  private readonly heartbeatMs: number;

  constructor(
    private readonly connection: LogsConnection,
    options: WebsocketRealtimeOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
  }

  start(onTransaction: (tx: RealtimeTransaction) => void, onHealth?: (healthy: boolean) => void): void {
    this.onTransaction = onTransaction;
    this.onHealth = onHealth;
    this.slotSubscription = this.connection.onSlotChange(() => {
      this.lastSlotAt = this.now();
      this.checkHealth();
    });
    this.healthTimer = setInterval(() => this.checkHealth(), 2_000);
    this.healthTimer.unref();
    this.apply();
  }

  watch(pools: readonly string[]): void {
    this.pools = new Set(pools);
    if (this.onTransaction) this.apply();
  }

  healthy(): boolean {
    return (
      !!this.onTransaction &&
      this.subscriptions.size > 0 &&
      this.lastSlotAt !== null &&
      this.now() - this.lastSlotAt < this.heartbeatMs
    );
  }

  stop(): void {
    this.onTransaction = undefined;
    if (this.healthTimer) clearInterval(this.healthTimer);
    for (const id of this.subscriptions.values()) void this.connection.removeOnLogsListener(id).catch(() => undefined);
    this.subscriptions.clear();
    if (this.slotSubscription !== undefined) {
      void this.connection.removeSlotChangeListener(this.slotSubscription).catch(() => undefined);
      this.slotSubscription = undefined;
    }
    this.checkHealth();
  }

  /** Subscribes the new pools and drops the ones no longer watched. */
  private apply(): void {
    const before = this.subscriptions.size;
    let changed = false;
    for (const pool of this.pools) {
      if (this.subscriptions.has(pool)) continue;
      changed = true;
      const id = this.connection.onLogs(
        new PublicKey(pool),
        (logs, context) =>
          this.onTransaction?.({
            signature: logs.signature,
            slot: context.slot,
            pools: [pool],
            failed: logs.err !== null,
            raw: null,
            receivedAt: this.now(),
          }),
        'confirmed',
      );
      this.subscriptions.set(pool, id);
    }
    for (const [pool, id] of this.subscriptions) {
      if (this.pools.has(pool)) continue;
      changed = true;
      this.subscriptions.delete(pool);
      void this.connection.removeOnLogsListener(id).catch(() => undefined);
    }
    if (changed) logger.info('launch pools: websocket logs subscriptions', { pools: this.subscriptions.size, before });
    this.checkHealth();
  }

  private checkHealth(): void {
    const healthy = this.healthy();
    if (healthy === this.wasHealthy) return;
    this.wasHealthy = healthy;
    this.onHealth?.(healthy);
  }
}
