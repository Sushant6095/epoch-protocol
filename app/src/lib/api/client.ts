// The Epoch API client. api_app answers `{ ok: true, data }` or `{ ok: false, error: { code, message, details },
// traceId }`; apiGet/apiPost unwrap the first and throw ApiError for the second. A request that never reaches the
// server (refused, DNS, CORS, timeout) throws ApiUnreachableError, which the data hooks turn into sample mode.

import { env } from "@/lib/env";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly traceId: string | undefined;

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>, traceId?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
    this.traceId = traceId;
  }

  /** Seconds to wait before retrying, when the API said so (429). */
  get retryAfterSeconds(): number | null {
    const v = this.details?.retryAfterSeconds;
    return typeof v === "number" ? v : null;
  }
}

/** The API could not be reached at all (network error, refused connection, timeout). */
export class ApiUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiUnreachableError";
  }
}

export const isApiError = (e: unknown, code?: string): e is ApiError =>
  e instanceof ApiError && (code === undefined || e.code === code);

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
  traceId?: string;
}

export interface ApiRequestOptions {
  signal?: AbortSignal;
  /** Abort after this many ms (default 15 s). */
  timeoutMs?: number;
}

async function request<T>(method: "GET" | "POST", path: string, body: unknown, opts: ApiRequestOptions = {}): Promise<T> {
  const url = path.startsWith("http") ? path : `${env.apiUrl}${path}`;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      // build, submit, claims and sign-in use the session cookie (docs/pages/predict.md).
      credentials: "include",
      headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      cache: "no-store",
    });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    throw new ApiUnreachableError(`Couldn't reach the Epoch API at ${env.apiUrl} (${String((error as Error)?.message ?? error)})`);
  }
  let json: Envelope<T> | null = null;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    throw new ApiError("BAD_RESPONSE", `The API answered HTTP ${res.status} without JSON`, res.status);
  }
  if (json && json.ok === true) return json.data as T;
  if (json && json.ok === false) {
    throw new ApiError(
      json.error?.code ?? "ERROR",
      json.error?.message ?? `HTTP ${res.status}`,
      res.status,
      json.error?.details,
      json.traceId,
    );
  }
  throw new ApiError("BAD_RESPONSE", `Unexpected answer (HTTP ${res.status})`, res.status);
}

export const apiGet = <T>(path: string, opts?: ApiRequestOptions) => request<T>("GET", path, undefined, opts);
export const apiPost = <T>(path: string, body: unknown, opts?: ApiRequestOptions) => request<T>("POST", path, body ?? {}, opts);

/** Words for an error, for inline error cards. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof ApiUnreachableError) return "The Epoch API can't be reached right now.";
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
