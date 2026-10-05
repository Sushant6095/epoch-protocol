/** Which Solami product a counter belongs to. */
export type SolamiProduct = 'grpc' | 'rpc' | 'beam';

export interface RpcMethodUsage {
  method: string;
  calls: number;
  errors: number;
  /** Solami's -32005 (sent with HTTP 200) or HTTP 429. Also counted in `errors`. */
  rateLimited: number;
  /** Over the method's last 500 calls, ms. */
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface RpcHostUsage {
  /** Host only: a key in the URL is never kept. */
  host: string;
  /** A *.solami.dev host. */
  solami: boolean;
  calls: number;
  errors: number;
  rateLimited: number;
  /** Over the last 500 calls of every method. */
  p50Ms: number | null;
  p95Ms: number | null;
  methods: RpcMethodUsage[];
}

export interface GrpcUsage {
  /** What the stream asks for, e.g. `firehose`, `meta` (indexer) or `slots+program` (api_app). */
  subscription: string | null;
  endpoint: string | null;
  /** connecting | streaming | reconnecting | stopped | off */
  status: string;
  compression: string | null;
  /** Protobuf bytes of the updates received (as the client hands them over, after any decompression). */
  bytes: number;
  updates: number;
  reconnects: number;
  /** Unix ms. */
  lastUpdateAt: number | null;
  /** Slots behind the tip, when the owner knows (the indexer does). */
  lagSlots: number | null;
}

export interface BeamUsage {
  /** Transactions submitted through Beam. */
  sends: number;
  /** Confirmed on chain without an error. */
  landed: number;
  /** Refused, failed on chain, or never confirmed. */
  failed: number;
  /** Sent the normal way because no tip address could be read. */
  fallbacks: number;
  /** The tip per transaction, lamports. */
  tipLamports: number | null;
  /** Tips of landed transactions (a failed transaction's transfer is rolled back), lamports. */
  tipsSpentLamports: number;
  /** Where the last tip address came from: Solami's API, or the list pinned from its SDK. */
  tipSource: 'api' | 'pinned' | null;
  lastSignature: string | null;
  /** Unix ms. */
  lastLandedAt: number | null;
}

export interface UsageError {
  product: SolamiProduct;
  message: string;
  /** Unix ms. */
  at: number;
}

/** One process's Solami usage: what `GET /v1/live/solami` shows per component. */
export interface SolamiUsageReport {
  component: string;
  /** Unix ms. */
  startedAt: number;
  at: number;
  grpc: GrpcUsage | null;
  rpc: RpcHostUsage[];
  beam: BeamUsage | null;
  lastError: UsageError | null;
}

const SAMPLES = 500;

/** Latencies of the last SAMPLES calls (a ring). */
class Samples {
  private readonly values: number[] = [];
  private next = 0;

  add(ms: number): void {
    if (this.values.length < SAMPLES) this.values.push(ms);
    else this.values[this.next] = ms;
    this.next = (this.next + 1) % SAMPLES;
  }

  percentile(p: number): number | null {
    if (this.values.length === 0) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]);
  }
}

interface MethodCounters {
  calls: number;
  errors: number;
  rateLimited: number;
  samples: Samples;
}

interface HostCounters {
  methods: Map<string, MethodCounters>;
  samples: Samples;
}

/** The host of an endpoint URL (never its query string, where Solami keys live). */
export function usageHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

export const isSolamiHost = (host: string): boolean => host === 'solami.dev' || host.endsWith('.solami.dev');

/**
 * Counters for the Solami usage report: RPC calls by method with latency percentiles and errors, the gRPC stream
 * (status, bytes, updates), Beam sends (landed, tips spent) and the last error. Cheap enough to record every call;
 * each app persists `report()` (Postgres `solami_usage`) or serves it (api_app).
 */
export class SolamiUsage {
  private readonly rpcHosts = new Map<string, HostCounters>();
  private grpcState: GrpcUsage | null = null;
  private beamState: BeamUsage | null = null;
  private last: UsageError | null = null;
  readonly startedAt: number;

  constructor(
    public component = 'process',
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Names this process in the report (indexer, api, publisher, cranks). */
  setComponent(component: string): this {
    this.component = component;
    return this;
  }

  /** One RPC call: `url` is reduced to its host. */
  recordRpc(url: string, method: string, ms: number, outcome: 'ok' | 'error' | 'rate-limited', message?: string): void {
    const host = usageHost(url);
    let counters = this.rpcHosts.get(host);
    if (!counters) {
      counters = { methods: new Map(), samples: new Samples() };
      this.rpcHosts.set(host, counters);
    }
    let method_ = counters.methods.get(method);
    if (!method_) {
      method_ = { calls: 0, errors: 0, rateLimited: 0, samples: new Samples() };
      counters.methods.set(method, method_);
    }
    method_.calls++;
    method_.samples.add(ms);
    counters.samples.add(ms);
    if (outcome !== 'ok') {
      method_.errors++;
      if (outcome === 'rate-limited') method_.rateLimited++;
      this.error('rpc', `${method} on ${host}: ${message ?? outcome}`);
    }
  }

  /** Updates the gRPC stream's fields (status, endpoint, subscription, lag…). */
  grpc(patch: Partial<GrpcUsage>): void {
    this.grpcState = { ...(this.grpcState ?? emptyGrpc()), ...patch };
  }

  /** One update received over gRPC. */
  grpcUpdate(bytes: number): void {
    const state = this.grpcState ?? emptyGrpc();
    state.bytes += bytes;
    state.updates++;
    state.lastUpdateAt = this.now();
    this.grpcState = state;
  }

  /** gRPC bytes counted apart from updates (the native client's raw messages). */
  grpcBytes(bytes: number): void {
    const state = this.grpcState ?? emptyGrpc();
    state.bytes += bytes;
    this.grpcState = state;
  }

  /** gRPC update counted apart from its bytes. */
  grpcUpdateOnly(): void {
    const state = this.grpcState ?? emptyGrpc();
    state.updates++;
    state.lastUpdateAt = this.now();
    this.grpcState = state;
  }

  beamSent(signature: string, tipLamports: number, tipSource: 'api' | 'pinned'): void {
    const beam = this.beam();
    beam.sends++;
    beam.tipLamports = tipLamports;
    beam.tipSource = tipSource;
    beam.lastSignature = signature;
  }

  beamLanded(signature: string, tipLamports: number): void {
    const beam = this.beam();
    beam.landed++;
    beam.tipsSpentLamports += tipLamports;
    beam.lastSignature = signature;
    beam.lastLandedAt = this.now();
  }

  beamFailed(message: string): void {
    this.beam().failed++;
    this.error('beam', message);
  }

  beamFallback(message: string): void {
    this.beam().fallbacks++;
    this.error('beam', message);
  }

  error(product: SolamiProduct, message: string): void {
    this.last = { product, message: message.slice(0, 500), at: this.now() };
  }

  report(): SolamiUsageReport {
    const rpc: RpcHostUsage[] = [...this.rpcHosts].map(([host, counters]) => {
      const methods = [...counters.methods].map(([method, c]) => ({
        method,
        calls: c.calls,
        errors: c.errors,
        rateLimited: c.rateLimited,
        p50Ms: c.samples.percentile(0.5),
        p95Ms: c.samples.percentile(0.95),
      }));
      methods.sort((a, b) => b.calls - a.calls || a.method.localeCompare(b.method));
      return {
        host,
        solami: isSolamiHost(host),
        calls: methods.reduce((sum, m) => sum + m.calls, 0),
        errors: methods.reduce((sum, m) => sum + m.errors, 0),
        rateLimited: methods.reduce((sum, m) => sum + m.rateLimited, 0),
        p50Ms: counters.samples.percentile(0.5),
        p95Ms: counters.samples.percentile(0.95),
        methods,
      };
    });
    rpc.sort((a, b) => Number(b.solami) - Number(a.solami) || b.calls - a.calls);
    return {
      component: this.component,
      startedAt: this.startedAt,
      at: this.now(),
      grpc: this.grpcState ? { ...this.grpcState } : null,
      rpc,
      beam: this.beamState ? { ...this.beamState } : null,
      lastError: this.last ? { ...this.last } : null,
    };
  }

  private beam(): BeamUsage {
    this.beamState ??= {
      sends: 0,
      landed: 0,
      failed: 0,
      fallbacks: 0,
      tipLamports: null,
      tipsSpentLamports: 0,
      tipSource: null,
      lastSignature: null,
      lastLandedAt: null,
    };
    return this.beamState;
  }
}

function emptyGrpc(): GrpcUsage {
  return {
    subscription: null,
    endpoint: null,
    status: 'off',
    compression: null,
    bytes: 0,
    updates: 0,
    reconnects: 0,
    lastUpdateAt: null,
    lagSlots: null,
  };
}

/** This process's counters: TransactionSender (Beam), GrpcStream and the apps' RPC clients record here by default. */
export const solamiUsage = new SolamiUsage();
