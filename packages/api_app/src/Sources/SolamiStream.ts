import { GracefulShutdown } from '@epoch/common';
import { base58Encode } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import {
  CommitmentLevel,
  explainSolamiError,
  type GrpcEndpoint,
  GrpcStream,
  type GrpcStreamOptions,
  type GrpcStreamState,
  SlotStatus,
  type SolamiUsage,
  solamiUsage,
  type SubscribeRequest,
  type SubscribeUpdate,
} from '@epoch/solana';

const logger = Logger.create('SolamiStream');

/** A transaction that touched the Epoch program, as Yellowstone delivers it: enough to parse its events. */
export interface ProgramTransaction {
  signature: string;
  slot: number;
  /** The program logs (`Program data:` lines carry the events). */
  logs: string[];
  failed: boolean;
}

/** idle (not started) → connecting → streaming ⇄ reconnecting; failed when Solami refused the key or filter. */
export type LiveStreamState = 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'failed' | 'stopped';

/** What GrpcStream gives this class (a fake in tests). */
export interface GrpcStreamLike {
  run(build: () => SubscribeRequest, onUpdate: (update: SubscribeUpdate) => Promise<void> | void): Promise<void>;
  stop(): void;
}

export interface SolamiStreamOptions {
  /** grpc.solami.dev with the key (x-token). */
  endpoint: GrpcEndpoint;
  compression?: 'zstd' | 'gzip';
  /** The Epoch program, when it runs on mainnet: its transactions are streamed too (otherwise slots only). */
  programId?: string;
  usage?: SolamiUsage;
  /** Tests. */
  createStream?: (endpoints: GrpcEndpoint[], options: GrpcStreamOptions) => GrpcStreamLike;
}

/** Refusals that reconnecting cannot fix: the key, its type or allowlist, a filter cap, an empty balance. */
const FATAL = new Set(['auth', 'key-type', 'allowlist', 'firehose', 'filter-limit', 'balance']);

/**
 * api_app's one Yellowstone connection to Solami. It carries confirmed slot updates (the WS `slot` channel) and, when
 * the Epoch program runs on mainnet, the program's successful transactions with their logs (program_events), so one
 * plan stream serves both. Started on first use; listeners see `failed` when Solami refuses the key, and their
 * owners fall back (slot polling, logsSubscribe).
 */
export class SolamiStream {
  private readonly slotListeners = new Set<(slot: number) => void>();
  private readonly txListeners = new Set<(tx: ProgramTransaction) => void>();
  private readonly stateListeners = new Set<(state: LiveStreamState) => void>();
  private grpc?: GrpcStreamLike;
  private running?: Promise<void>;
  private current: LiveStreamState = 'idle';
  private shutdownRegistered = false;

  constructor(private readonly options: SolamiStreamOptions) {}

  get state(): LiveStreamState {
    return this.current;
  }

  /** True when the program's transactions are part of the subscription. */
  get streamsProgram(): boolean {
    return this.options.programId !== undefined;
  }

  /** Confirmed slots as they arrive; returns the unsubscribe. Starts the stream. */
  onSlot(listener: (slot: number) => void): () => void {
    this.slotListeners.add(listener);
    this.start();
    return () => this.slotListeners.delete(listener);
  }

  /** The program's transactions (failed ones excluded by the filter); returns the unsubscribe. Starts the stream. */
  onProgramTransaction(listener: (tx: ProgramTransaction) => void): () => void {
    this.txListeners.add(listener);
    this.start();
    return () => this.txListeners.delete(listener);
  }

  onState(listener: (state: LiveStreamState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  start(): void {
    if (this.running || this.current === 'failed' || this.current === 'stopped') return;
    const usage = this.options.usage ?? solamiUsage;
    const create =
      this.options.createStream ??
      ((endpoints: GrpcEndpoint[], options: GrpcStreamOptions) => new GrpcStream(endpoints, options) as GrpcStreamLike);
    const grpc = create([this.options.endpoint], {
      compression: this.options.compression,
      isFatal: (error) => FATAL.has(explainSolamiError('grpc', error).kind),
      onState: (state) => this.onGrpcState(state),
      usage,
      subscription: this.streamsProgram ? 'slots+program' : 'slots',
    });
    this.grpc = grpc;
    this.setState('connecting');
    logger.info('Solami gRPC stream starting', {
      endpoint: new URL(this.options.endpoint.url).host,
      program: this.options.programId ?? null,
    });
    this.running = grpc
      .run(
        () => this.request(),
        (update) => this.onUpdate(update),
      )
      .then(
        () => this.setState('stopped'),
        (error: unknown) => {
          logger.error('Solami gRPC refused the stream; the API falls back to polling and logsSubscribe', undefined, {
            hint: explainSolamiError('grpc', error).hint,
          });
          this.setState('failed');
        },
      );
    if (!this.shutdownRegistered) {
      this.shutdownRegistered = true;
      GracefulShutdown.register('solami-stream', () => this.stop());
    }
  }

  async stop(): Promise<void> {
    this.grpc?.stop();
    await this.running;
    this.setState('stopped');
  }

  /** Confirmed slot statuses, plus the program's successful non-vote transactions when it runs on mainnet. */
  request(): SubscribeRequest {
    const programId = this.options.programId;
    return {
      accounts: {},
      slots: { slots: { filterByCommitment: true } },
      transactions: programId
        ? {
            program: {
              vote: false,
              failed: false,
              accountInclude: [programId],
              accountExclude: [],
              accountRequired: [],
            },
          }
        : {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      commitment: CommitmentLevel.CONFIRMED,
      accountsDataSlice: [],
    } as SubscribeRequest;
  }

  private onUpdate(update: SubscribeUpdate): void {
    if (update.slot) {
      if (update.slot.status !== SlotStatus.SLOT_CONFIRMED) return;
      const slot = Number(update.slot.slot);
      for (const listener of this.slotListeners) listener(slot);
      return;
    }
    const tx = update.transaction?.transaction;
    if (!tx || !update.transaction) return;
    const meta = tx.meta;
    const transaction: ProgramTransaction = {
      signature: base58Encode(tx.signature),
      slot: Number(update.transaction.slot),
      logs: meta && !meta.logMessagesNone ? [...meta.logMessages] : [],
      failed: meta?.err !== undefined,
    };
    for (const listener of this.txListeners) listener(transaction);
  }

  private onGrpcState(state: GrpcStreamState): void {
    if (this.current === 'failed') return;
    if (state.status === 'streaming') this.setState('streaming');
    else if (state.status === 'reconnecting') this.setState('reconnecting');
    else if (state.status === 'connecting') this.setState('connecting');
  }

  private setState(state: LiveStreamState): void {
    if (this.current === state || this.current === 'failed') return;
    this.current = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
