import {
  CommitmentLevel,
  type GeyserUnaryClient,
  grpcErrorText,
  type GrpcEndpoint,
  type SubscribeRequest,
  type SubscribeUpdate,
  SubscribeUpdate as SubscribeUpdateCodec,
} from '@epoch/solana';

import { redact, rpcHost, type SolanaRpc } from '../Rpc/SolanaRpc';
import { isAuthRefused, isFirehoseRefused, slotStreamRequest } from '../Streams/SlotRequest';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface SolamiCheckOptions {
  grpc?: GrpcEndpoint;
  /** Solami RPC with the key (SOLAMI_RPC_URL); without it the RPC checks are skipped. */
  rpc?: Pick<SolanaRpc, 'getVersion' | 'getSlot' | 'getEpochInfo' | 'url'>;
  /** Block metas to time against RPC getSlot. */
  slots: number;
  /** Seconds of the indexer's firehose request to measure (0 = skip). */
  firehoseSeconds: number;
  compression?: 'zstd' | 'gzip';
  beamUrl?: string;
  /** Secrets that must never appear in the output (the gRPC token, the RPC key). */
  secrets: string[];
}

export interface SolamiCheckDeps {
  createClient: (endpoint: GrpcEndpoint, compression?: 'zstd' | 'gzip') => GeyserUnaryClient;
  fetchJson: (url: string) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress lines (already redacted). */
  log?: (line: string) => void;
}

const DEFAULT_GB_PRICE = 0.08;
const GIB = 1024 ** 3;

type Stream = AsyncIterable<SubscribeUpdate> & { destroy(error?: Error): unknown };

const text = grpcErrorText;

export const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * `pnpm solami:check`: proves a Solami key works for this indexer before a demo, with the user's own key from the
 * environment, and prints a pass/fail table. It reads only: RPC version/slot/epoch, gRPC version and replay window,
 * N block metas (timed against RPC getSlot), a few seconds of the firehose (bytes → GiB/day → $/day at the live PAYG
 * rate), and the public Beam tip addresses. It never sends a transaction and never prints a key.
 */
export class SolamiCheck {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly results: CheckResult[] = [];

  constructor(
    private readonly options: SolamiCheckOptions,
    private readonly deps: SolamiCheckDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private clean(value: string): string {
    return redact(value, this.options.secrets);
  }

  private add(name: string, status: CheckStatus, detail: string): void {
    this.results.push({ name, status, detail: this.clean(detail) });
    this.deps.log?.(`${status.padEnd(4)} ${name}: ${this.clean(detail)}`);
  }

  async run(): Promise<CheckResult[]> {
    await this.checkRpc();
    await this.checkGrpc();
    await this.checkBeam();
    return this.results;
  }

  get passed(): boolean {
    return this.results.every((r) => r.status !== 'FAIL');
  }

  private async checkRpc(): Promise<void> {
    const rpc = this.options.rpc;
    if (!rpc) {
      this.add('rpc', 'WARN', 'SOLAMI_RPC_URL is not set: gap fill, leaders and stakes would use DATA_RPC_URL');
      return;
    }
    const host = rpcHost(rpc.url);
    try {
      const t0 = this.now();
      const version = await rpc.getVersion();
      const t1 = this.now();
      const slot = await rpc.getSlot('confirmed');
      const t2 = this.now();
      const info = await rpc.getEpochInfo();
      this.add(
        'rpc',
        'PASS',
        `${host}: solana-core ${version['solana-core']}, confirmed slot ${slot}, epoch ${info.epoch} ` +
          `(${((info.slotIndex / info.slotsInEpoch) * 100).toFixed(1)}%), getVersion ${t1 - t0} ms, getSlot ${t2 - t1} ms`,
      );
    } catch (error) {
      const message = text(error);
      const hint = /HTTP 401|HTTP 403/.test(message)
        ? ' (the api_key in SOLAMI_RPC_URL was refused)'
        : /-32005/.test(message)
          ? ' (rate limited)'
          : '';
      this.add('rpc', 'FAIL', `${host}: ${message}${hint}`);
    }
  }

  private async checkGrpc(): Promise<void> {
    const endpoint = this.options.grpc;
    if (!endpoint?.token) {
      this.add('grpc', 'FAIL', 'SOLAMI_TOKEN is not set (the gRPC key goes on the x-token header)');
      return;
    }
    let client: GeyserUnaryClient;
    try {
      client = this.deps.createClient(endpoint, this.options.compression);
      await client.connect();
      const version = await client.getVersion();
      const replay = await client.subscribeReplayInfo().catch(() => ({ firstAvailable: undefined }));
      const slot = Number((await client.getSlot(CommitmentLevel.CONFIRMED)).slot);
      const window = replay.firstAvailable ? slot - Number(replay.firstAvailable) : null;
      const parsed = parseVersion(version.version);
      // These unary calls answer without a key on Solami: they prove the endpoint, not the key.
      this.add(
        'grpc endpoint',
        'PASS',
        `${rpcHost(endpoint.url)}: ${parsed}, confirmed slot ${slot}` +
          (window !== null
            ? `, from_slot replay window ${window} slots (≈ ${Math.round((window * 0.4) / 60)} min)`
            : ''),
      );
    } catch (error) {
      this.add('grpc endpoint', 'FAIL', text(error));
      return;
    }
    if ((await this.timeBlocks(client)) && this.options.firehoseSeconds > 0) await this.measureFirehose(client);
  }

  /**
   * The key, and N block metas over gRPC, each compared with when RPC getSlot('confirmed') first reached that slot.
   * True when the subscription worked.
   */
  private async timeBlocks(client: GeyserUnaryClient): Promise<boolean> {
    const rpc = this.options.rpc;
    const seenByRpc = new Map<number, number>();
    let rpcHigh = 0;
    let polling = !!rpc;
    const poller = (async () => {
      while (polling && rpc) {
        try {
          const slot = await rpc.getSlot('confirmed');
          const at = this.now();
          for (let s = Math.max(rpcHigh + 1, slot - 64); s <= slot; s++) if (!seenByRpc.has(s)) seenByRpc.set(s, at);
          rpcHigh = Math.max(rpcHigh, slot);
        } catch {
          // a missed poll only widens the error bars
        }
        await this.sleep(100);
      }
    })();
    const arrivals: { slot: number; at: number; blockTime: number | null }[] = [];
    let stream: Stream | undefined;
    try {
      stream = (await client.subscribe(slotStreamRequest('meta'))) as Stream;
      const deadline = this.now() + Math.max(30_000, this.options.slots * 2_000);
      for await (const update of stream) {
        if (update.blockMeta) {
          const ts = update.blockMeta.blockTime?.timestamp;
          arrivals.push({ slot: Number(update.blockMeta.slot), at: this.now(), blockTime: ts ? Number(ts) : null });
          if (arrivals.length >= this.options.slots) break;
        }
        if (this.now() > deadline) break;
      }
    } catch (error) {
      polling = false;
      await poller;
      const auth = isAuthRefused(error);
      this.add('grpc key', 'FAIL', `${text(error)}${auth ? ' (the x-token key was refused: check SOLAMI_TOKEN)' : ''}`);
      return false;
    } finally {
      stream?.destroy();
    }
    // Let RPC catch up with the last few slots before comparing.
    await this.sleep(rpc ? 3_000 : 0);
    polling = false;
    await poller;
    if (arrivals.length === 0) {
      this.add('grpc key', 'FAIL', 'subscribed, but no block meta arrived');
      return false;
    }
    const leads = arrivals.filter((a) => seenByRpc.has(a.slot)).map((a) => (seenByRpc.get(a.slot) as number) - a.at);
    const lead = median(leads);
    const age = median(arrivals.filter((a) => a.blockTime !== null).map((a) => a.at - (a.blockTime as number) * 1000));
    this.add(
      'grpc key',
      'PASS',
      `subscribed; ${arrivals.length} confirmed block metas, slots ${arrivals[0].slot}…${arrivals[arrivals.length - 1].slot}` +
        (lead !== null
          ? `; gRPC was ${Math.abs(Math.round(lead))} ms ${lead >= 0 ? 'ahead of' : 'behind'} RPC getSlot (median of ${leads.length}, ±100 ms)`
          : '; RPC comparison skipped (no SOLAMI_RPC_URL)') +
        (age !== null ? `; arrived ${(age / 1000).toFixed(1)} s after block time (1 s resolution)` : ''),
    );
    return true;
  }

  /** A few seconds of the indexer's own firehose request: does Solami allow it on this key, and what would it cost? */
  private async measureFirehose(client: GeyserUnaryClient): Promise<void> {
    let stream: Stream | undefined;
    let bytes = 0;
    let txs = 0;
    const blocks = new Set<number>();
    try {
      stream = (await client.subscribe(slotStreamRequest('firehose') as SubscribeRequest)) as Stream;
      const started = this.now();
      for await (const update of stream) {
        bytes += SubscribeUpdateCodec.encode(update).finish().length;
        if (update.transaction) txs++;
        if (update.blockMeta) blocks.add(Number(update.blockMeta.slot));
        if (this.now() - started >= this.options.firehoseSeconds * 1_000) break;
      }
      const seconds = Math.max(1, (this.now() - started) / 1_000);
      const perDayGiB = ((bytes / seconds) * 86_400) / GIB;
      const price = await this.gbPrice();
      this.add(
        'grpc firehose',
        blocks.size > 0 ? 'PASS' : 'WARN',
        `${txs} non-vote transactions in ${blocks.size} blocks over ${seconds.toFixed(0)} s: ` +
          `${(bytes / seconds / 1024 / 1024).toFixed(2)} MiB/s ≈ ${perDayGiB.toFixed(0)} GiB/day ≈ ` +
          `$${(perDayGiB * price).toFixed(2)}/day at $${price}/GB PAYG (decoded bytes; compression not counted)`,
      );
    } catch (error) {
      if (isFirehoseRefused(error)) {
        this.add(
          'grpc firehose',
          'WARN',
          'refused on this key (plan streams reject unscoped transaction filters): the indexer will run ' +
            'SLOT_SOURCE=hybrid. Enable gRPC pay-as-you-go (or ask Solami for the firehose allowance) for SLOT_SOURCE=grpc.',
        );
      } else {
        this.add('grpc firehose', 'FAIL', text(error));
      }
    } finally {
      stream?.destroy();
    }
  }

  private async gbPrice(): Promise<number> {
    try {
      const pricing = (await this.deps.fetchJson('https://api.solami.dev/pricing')) as {
        payg?: { grpc?: { usd_per_gb?: number } };
      };
      return pricing.payg?.grpc?.usd_per_gb ?? DEFAULT_GB_PRICE;
    } catch {
      return DEFAULT_GB_PRICE;
    }
  }

  private async checkBeam(): Promise<void> {
    try {
      const tips = await this.deps.fetchJson('https://api.solami.dev/onchain/tip-addresses');
      const count = Array.isArray(tips) ? tips.length : 0;
      const configured = this.options.beamUrl
        ? `SOLAMI_BEAM_URL → ${rpcHost(this.options.beamUrl)}`
        : 'SOLAMI_BEAM_URL unset (Beam off)';
      this.add(
        'beam',
        count > 0 ? 'PASS' : 'WARN',
        `${count} tip addresses from api.solami.dev; ${configured}; nothing sent`,
      );
    } catch (error) {
      this.add('beam', 'WARN', `tip addresses unavailable: ${text(error)}`);
    }
  }
}

function parseVersion(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { version?: { package?: string; version?: string; solana?: string } };
    const v = parsed.version;
    return v ? `${v.package ?? 'yellowstone'} ${v.version ?? '?'} (solana ${v.solana ?? '?'})` : raw;
  } catch {
    return raw;
  }
}

/** The report as a fixed-width table. */
export function formatReport(results: readonly CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.name.length), 5);
  const lines = results.map((r) => `${r.status.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`);
  const verdict = results.some((r) => r.status === 'FAIL') ? 'FAIL' : 'PASS';
  return [...lines, '', `Solami check: ${verdict}`].join('\n');
}
