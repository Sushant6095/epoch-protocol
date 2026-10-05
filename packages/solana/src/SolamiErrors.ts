/**
 * Solami's errors, explained: what went wrong and what to change. The strings matched here are the ones Solami's
 * docs ("Errors", "Troubleshooting") say it sends, so a log line or the key check can say "the key was refused" or
 * "over the plan's requests per second" instead of a bare status.
 */

export type SolamiErrorKind =
  | 'auth'
  | 'key-type'
  | 'allowlist'
  | 'rate-limit'
  | 'balance'
  | 'plan'
  | 'firehose'
  | 'stream-limit'
  | 'reconnect-limit'
  | 'filter-limit'
  | 'backpressure'
  | 'gpa-limit'
  | 'beam-tip'
  | 'dns'
  | 'unavailable'
  | 'other';

export interface SolamiErrorInfo {
  kind: SolamiErrorKind;
  /** Retrying with backoff can help (rate limits, restarts); otherwise something has to change first. */
  retryable: boolean;
  /** One line for logs and the key check. Never contains a key. */
  hint: string;
}

/**
 * The whole message of an error and its `cause` chain: the native gRPC client's top level is generic ("failed to open
 * subscribe stream"); the gRPC status and Solami's message are in the causes.
 */
export function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    const message = current instanceof Error ? current.message : typeof current === 'string' ? current : '';
    if (message && !parts.some((part) => part.includes(message))) parts.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(': ') || String(error);
}

interface Rule {
  test: RegExp;
  kind: SolamiErrorKind;
  retryable: boolean;
  hint: string;
}

const RPC_RULES: Rule[] = [
  {
    test: /does not have RPC access/i,
    kind: 'key-type',
    retryable: false,
    hint: 'this key type cannot call RPC (a GrpcKey or SnapKey): use a Standard (ApiKey) or RpcKey key in SOLAMI_RPC_URL',
  },
  {
    test: /IP not allowed|domain not allowed|requires browser Origin/i,
    kind: 'allowlist',
    retryable: false,
    hint: "the key's IP or domain allowlist rejects this host: edit the key's allowlist in the Solami dashboard",
  },
  {
    test: /HTTP 401|unauthorized|-32001\b/i,
    kind: 'auth',
    retryable: false,
    hint: 'Solami RPC refused the key (HTTP 401): SOLAMI_RPC_URL must be https://rpc.solami.dev/sol?api_key=<a live key>',
  },
  {
    test: /-32005\b|HTTP 429|rate ?limited/i,
    kind: 'rate-limit',
    retryable: true,
    hint:
      'Solami RPC rate limit (-32005, sent with HTTP 200): over the plan’s requests per second (Pro: 200; each ' +
      'plan’s limit is at api.solami.dev/pricing): lower GAP_FILL_RPS / GAP_FILL_CONCURRENCY or turn on RPC ' +
      'pay-as-you-go',
  },
  {
    test: /HTTP 402|insufficient balance/i,
    kind: 'balance',
    retryable: false,
    hint: 'the pay-as-you-go balance cannot cover the call: top up in the Solami dashboard (minimum $5)',
  },
  {
    test: /-32010\b|exceeds your account limit/i,
    kind: 'gpa-limit',
    retryable: false,
    hint: 'getProgramAccounts is over the plan’s account cap: use getProgramAccountsV2 (paginated) or a fallback RPC',
  },
  {
    test: /-32600\b|plan does not include|batch size \d+ exceeds/i,
    kind: 'plan',
    retryable: false,
    hint: 'the plan does not include this call (or the batch is over 10): upgrade, or send it to a fallback RPC',
  },
];

const GRPC_RULES: Rule[] = [
  {
    test: /does not have gRPC access/i,
    kind: 'key-type',
    retryable: false,
    hint:
      'this key cannot use gRPC: SOLAMI_TOKEN must be a Standard (ApiKey) or GrpcKey key (gRPC starts at the Pro ' +
      'plan or with gRPC pay-as-you-go), or an RpcKey with gRPC use enabled',
  },
  {
    test: /IP not allowed/i,
    kind: 'allowlist',
    retryable: false,
    hint: "the key's IP allowlist rejects this host: edit the key's allowlist in the Solami dashboard",
  },
  {
    test: /unauthenticated|missing api key|invalid api key|api key revoked|valid authentication credentials/i,
    kind: 'auth',
    retryable: false,
    hint: 'Solami gRPC refused SOLAMI_TOKEN (sent as x-token): the key is missing, invalid or revoked',
  },
  {
    test: /firehose subscriptions are not allowed/i,
    kind: 'firehose',
    retryable: false,
    hint:
      'plan streams refuse the transaction firehose: turn on gRPC pay-as-you-go in the Solami dashboard, or run ' +
      'SLOT_SOURCE=hybrid (block meta over gRPC, blocks over RPC); SLOT_SOURCE=auto switches by itself',
  },
  {
    test: /max concurrent streams/i,
    kind: 'stream-limit',
    retryable: true,
    hint:
      'every gRPC stream of the plan is in use (indexer_app and api_app hold one each): stop another stream, buy a ' +
      'connection slot, or turn on gRPC pay-as-you-go',
  },
  {
    test: /too many reconnections/i,
    kind: 'reconnect-limit',
    retryable: true,
    hint: 'over 100 reconnects in 10 s from this IP: back off (the stream already does; check for a crash loop)',
  },
  {
    test: /too many filters|account_include has|account filter '.*' has/i,
    kind: 'filter-limit',
    retryable: false,
    hint: 'the subscribe request is over a filter cap (25 filters, 300,000 account_include addresses)',
  },
  {
    test: /insufficient balance|no StreamingBandwidth|balance exhausted/i,
    kind: 'balance',
    retryable: false,
    hint: 'streaming bandwidth and the pay-as-you-go balance are empty: top up in the Solami dashboard',
  },
  {
    test: /backpressure|client too slow/i,
    kind: 'backpressure',
    retryable: true,
    hint: 'the stream disconnected us for reading too slowly: it resumes from the last slot; narrow the filters if it repeats',
  },
  {
    test: /unavailable|shutting down|session expired|restore subscription|no update for/i,
    kind: 'unavailable',
    retryable: true,
    hint: 'a routine restart or failover on Solami’s side: reconnecting (with from_slot replay where possible)',
  },
];

const BEAM_RULES: Rule[] = [
  {
    test: /tip_missing/,
    kind: 'beam-tip',
    retryable: true,
    hint: 'Beam saw no transfer to a current tip address: the tip list is refreshed from /onchain/tip-addresses',
  },
  {
    test: /tip_too_low/,
    kind: 'beam-tip',
    retryable: false,
    hint: 'Beam’s tip floor is 100,000 lamports (0.0001 SOL): raise SOLAMI_BEAM_TIP_LAMPORTS',
  },
  {
    test: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    kind: 'dns',
    retryable: false,
    hint:
      'the Beam host does not resolve (beam-http.solami.dev did not on 5 Oct 2026): set SOLAMI_BEAM_URL to your ' +
      'Solami RPC URL, which routes a tipped sendTransaction through Beam',
  },
  {
    test: /Proxy response \(5\d\d\)|CONNECT tunnel failed/i,
    kind: 'dns',
    retryable: false,
    hint:
      'the Beam host could not be reached through the HTTP proxy (beam-http.solami.dev did not resolve on 5 Oct ' +
      '2026): set SOLAMI_BEAM_URL to your Solami RPC URL, which routes a tipped sendTransaction through Beam',
  },
];

const NETWORK: Rule = {
  test: /HTTP 5\d\d|-32603\b|timeout|timed out|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up/i,
  kind: 'unavailable',
  retryable: true,
  hint: 'the endpoint did not answer in time or failed upstream (worth retrying with backoff)',
};

/** What a Solami error means and what to do about it. */
export function explainSolamiError(product: 'rpc' | 'grpc' | 'beam', error: unknown): SolamiErrorInfo {
  const text = errorText(error);
  const rules = product === 'grpc' ? GRPC_RULES : product === 'beam' ? [...BEAM_RULES, ...RPC_RULES] : [...RPC_RULES];
  for (const rule of [...rules, NETWORK]) {
    if (rule.test.test(text)) return { kind: rule.kind, retryable: rule.retryable, hint: rule.hint };
  }
  return { kind: 'other', retryable: true, hint: text.slice(0, 300) };
}
