import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

interface TraceStore {
  traceId: string;
}

const storage = new AsyncLocalStorage<TraceStore>();

/** Runs `fn` with a trace ID that every log line inside it will carry. */
export function runWithTrace<T>(fn: () => T, traceId: string = randomUUID()): T {
  return storage.run({ traceId }, fn);
}

export function getTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}
