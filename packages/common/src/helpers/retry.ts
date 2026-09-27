import { sleep } from './sleep';

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number) => void;
}

/** Retries `fn` with exponential backoff. Throws the last error when retries run out. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { retries, baseDelayMs = 250, maxDelayMs = 10_000, onRetry } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      onRetry?.(error, attempt + 1);
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError;
}
