import { EventEmitter } from 'events';

import type { EventName } from '@epoch/epoch-sdk';

/** A decoded program event as stored in program_events and passed around the process. */
export interface StoredProgramEvent {
  signature: string;
  /** Position of the event in its transaction's logs. */
  ix: number;
  slot: number;
  /** The program cluster's epoch of `slot`, when known. */
  epoch: number | null;
  /** ISO 8601, when known. */
  blockTime: string | null;
  name: EventName;
  /** epoch-sdk `eventToJson(event).data`: pubkeys base58, u64/i64 decimal strings, byte arrays hex. */
  data: Record<string, string | number | boolean>;
}

/** A Predict call, for the activity feed (calls are not transactions). */
export interface PredictCallEvent {
  id: number;
  marketId: string;
  label: string;
  address: string;
  side: 'yes' | 'no';
  points: number;
  createdAt: string;
}

interface BusEvents {
  /** A new program event was ingested (live or backfill). */
  programEvent: [StoredProgramEvent];
  /** A Predict call was placed. */
  predictCall: [PredictCallEvent];
}

/** In-process pub/sub between the ingester, caches, the websocket hub and jobs. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<K extends keyof BusEvents>(event: K, listener: (...args: BusEvents[K]) => void): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: BusEvents[K]): void {
    this.emitter.emit(event, ...args);
  }
}

/** One bus per process. */
export const bus = new EventBus();
