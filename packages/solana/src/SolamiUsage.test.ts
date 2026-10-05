import { explainSolamiError } from './SolamiErrors';
import { isSolamiHost, SolamiUsage, usageHost } from './SolamiUsage';

const KEYED = 'https://rpc.solami.dev/sol?api_key=not-a-real-key';

describe('SolamiUsage', () => {
  it('counts RPC calls by host and method with p50/p95 latency, never keeping the key', () => {
    let now = 1_000;
    const usage = new SolamiUsage('indexer', () => now);
    for (let ms = 1; ms <= 100; ms++) usage.recordRpc(KEYED, 'getBlock', ms, 'ok');
    usage.recordRpc(KEYED, 'getSlot', 7, 'ok');
    now = 2_000;
    usage.recordRpc(KEYED, 'getBlock', 300, 'rate-limited', '-32005: Rate limited');
    usage.recordRpc('https://api.mainnet-beta.solana.com', 'getSlot', 50, 'error', 'HTTP 503');

    const report = usage.report();
    expect(JSON.stringify(report)).not.toContain('not-a-real-key');
    expect(report.component).toBe('indexer');
    expect(report.rpc.map((r) => [r.host, r.solami, r.calls])).toEqual([
      ['rpc.solami.dev', true, 102],
      ['api.mainnet-beta.solana.com', false, 1],
    ]);
    const getBlock = report.rpc[0].methods[0];
    expect(getBlock).toEqual({ method: 'getBlock', calls: 101, errors: 1, rateLimited: 1, p50Ms: 51, p95Ms: 96 });
    expect(report.rpc[0]).toMatchObject({ errors: 1, rateLimited: 1 });
    expect(report.lastError).toEqual({
      product: 'rpc',
      message: 'getSlot on api.mainnet-beta.solana.com: HTTP 503',
      at: 2_000,
    });
  });

  it('keeps the gRPC stream’s state, bytes and updates', () => {
    let now = 5;
    const usage = new SolamiUsage('api', () => now);
    expect(usage.report().grpc).toBeNull();
    usage.grpc({ subscription: 'slots+program', endpoint: 'solami', status: 'streaming' });
    usage.grpcUpdate(120);
    now = 9;
    usage.grpcBytes(80);
    usage.grpcUpdateOnly();
    usage.grpc({ lagSlots: 2 });
    expect(usage.report().grpc).toMatchObject({
      subscription: 'slots+program',
      status: 'streaming',
      bytes: 200,
      updates: 2,
      lastUpdateAt: 9,
      lagSlots: 2,
    });
  });

  it('counts Beam sends, landings, failures and the tips actually spent', () => {
    const usage = new SolamiUsage('publisher', () => 42);
    usage.beamSent('a', 100_000, 'api');
    usage.beamLanded('a', 100_000);
    usage.beamSent('b', 100_000, 'pinned');
    usage.beamFailed('b failed on chain: {"InstructionError":[1,{"Custom":6004}]}');
    usage.beamFallback('no tip address');
    expect(usage.report().beam).toEqual({
      sends: 2,
      landed: 1,
      failed: 1,
      fallbacks: 1,
      tipLamports: 100_000,
      tipsSpentLamports: 100_000,
      tipSource: 'pinned',
      lastSignature: 'b',
      lastLandedAt: 42,
    });
    expect(usage.report().lastError).toMatchObject({ product: 'beam', message: 'no tip address' });
  });

  it('reduces endpoints to their host', () => {
    expect(usageHost(KEYED)).toBe('rpc.solami.dev');
    expect(usageHost('nope')).toBe('invalid-url');
    expect(isSolamiHost('rpc.solami.dev')).toBe(true);
    expect(isSolamiHost('solami.dev.evil.com')).toBe(false);
  });
});

describe('explainSolamiError', () => {
  // The messages below are the ones Solami's docs ("Errors", "Troubleshooting") say it sends.
  it.each([
    ['rpc', new Error('HTTP 401 from rpc.solami.dev'), 'auth', false],
    ['rpc', new Error('HTTP 403: this key does not have RPC access'), 'key-type', false],
    ['rpc', new Error('HTTP 403: IP not allowed for this key'), 'allowlist', false],
    ['rpc', new Error('-32005: Rate limited'), 'rate-limit', true],
    ['rpc', new Error('HTTP 429'), 'rate-limit', true],
    ['rpc', new Error('HTTP 402: insufficient balance'), 'balance', false],
    [
      'rpc',
      new Error(
        '-32010: getProgramAccounts result exceeds your account limit of 10000; use getProgramAccountsV2 with paginationKey for the full set',
      ),
      'gpa-limit',
      false,
    ],
    ['rpc', new Error('-32600: this plan does not include getProgramAccounts access'), 'plan', false],
    ['rpc', new Error('HTTP 503'), 'unavailable', true],
    ['grpc', new Error(`gRPC status: code: 'x', message: "invalid api key"`), 'auth', false],
    ['grpc', new Error('UNAUTHENTICATED: api key revoked'), 'auth', false],
    ['grpc', new Error('PERMISSION_DENIED: this key does not have gRPC access'), 'key-type', false],
    [
      'grpc',
      new Error(
        'PERMISSION_DENIED: unfiltered/firehose subscriptions are not allowed on non-PAYG streams; narrow your filters, enable PAYG, or request the firehose allowance',
      ),
      'firehose',
      false,
    ],
    ['grpc', new Error('RESOURCE_EXHAUSTED: max concurrent streams (2) reached for your tier'), 'stream-limit', true],
    [
      'grpc',
      new Error('RESOURCE_EXHAUSTED: too many reconnections from your ip; limit is 100 per 10 seconds'),
      'reconnect-limit',
      true,
    ],
    ['grpc', new Error('RESOURCE_EXHAUSTED: insufficient balance, please top up'), 'balance', false],
    [
      'grpc',
      new Error('RESOURCE_EXHAUSTED: stream backpressure: client too slow, please reconnect'),
      'backpressure',
      true,
    ],
    [
      'grpc',
      new Error('UNAVAILABLE: server is shutting down, please reconnect to another instance'),
      'unavailable',
      true,
    ],
    ['grpc', new Error('INVALID_ARGUMENT: too many filters in subscribe request: 40 (max 25)'), 'filter-limit', false],
    ['beam', new Error('tip_too_low'), 'beam-tip', false],
    ['beam', new Error('getaddrinfo ENOTFOUND beam-http.solami.dev'), 'dns', false],
    ['beam', new Error('-32005: Rate limited'), 'rate-limit', true],
  ] as const)('%s: %s → %s', (product, error, kind, retryable) => {
    const info = explainSolamiError(product, error);
    expect(info.kind).toBe(kind);
    expect(info.retryable).toBe(retryable);
    expect(info.hint.length).toBeGreaterThan(20);
  });

  it('reads the gRPC status from the native error’s cause chain', () => {
    const native = Object.assign(new Error('failed to open subscribe stream'), {
      cause: new Error(
        `gRPC status: code: 'The request does not have valid authentication credentials', message: "missing api key"`,
      ),
    });
    expect(explainSolamiError('grpc', native)).toMatchObject({ kind: 'auth', retryable: false });
    expect(explainSolamiError('rpc', new Error('something new'))).toEqual({
      kind: 'other',
      retryable: true,
      hint: 'something new',
    });
  });
});
