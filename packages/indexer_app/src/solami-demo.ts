#!/usr/bin/env node
import '@epoch/common/first-module';
import './Check/demoLogLevel';

import { getArg } from '@epoch/common';
import { IndexerConfigSchema, loadConfig } from '@epoch/config-sdk';
import { type GrpcEndpoint, SolamiUsage } from '@epoch/solana';

import { formatDemo } from './Check/DemoReport';
import { MemoryIndexerStore } from './Repositories/MemoryIndexerStore';
import { redact, SolanaRpc } from './Rpc/SolanaRpc';
import { SlotStream } from './Streams/SlotStream';

const out = (line: string): void => void process.stdout.write(`${line}\n`);

/**
 * pnpm demo:solami [--seconds 180] [--every 3] [--stride N] [--verbose]
 *
 * The live pipeline in a terminal, for a 2–3 minute demo: blocks streamed from Solami gRPC (or polled over RPC when
 * there is no key), each slot's median priority fee, the epoch's running Fee Index, and what was used of Solami,
 * printed every few seconds. Everything stays in memory: it never writes to Postgres, so it runs next to a real
 * indexer_app without touching its cursor. Reads the same environment as indexer_app; never prints a key.
 */
async function main(): Promise<void> {
  const config = loadConfig(IndexerConfigSchema);
  const seconds = Number(getArg(['--seconds']) ?? 180);
  const every = Math.max(1, Number(getArg(['--every']) ?? 3));
  const solamiRpc = config.SOLAMI_RPC_URL;
  // Public RPC is rate-limited: without a Solami RPC key, sample one slot in 4 and poll once a second.
  const strideArg = getArg(['--stride']);
  const stride = strideArg
    ? Math.max(1, Number(strideArg))
    : solamiRpc
      ? config.RPC_SLOT_STRIDE
      : Math.max(4, config.RPC_SLOT_STRIDE);
  const usage = new SolamiUsage('demo');
  const rpc = new SolanaRpc(solamiRpc ?? config.DATA_RPC_URL, { usage });
  const endpoints: GrpcEndpoint[] = config.SOLAMI_TOKEN
    ? [{ name: 'solami', url: config.SOLAMI_GRPC_URL, token: config.SOLAMI_TOKEN }]
    : [];
  const store = new MemoryIndexerStore();
  const stream = new SlotStream(
    {
      mode: config.SLOT_SOURCE,
      endpoints,
      compression: config.SOLAMI_GRPC_COMPRESSION === 'none' ? undefined : config.SOLAMI_GRPC_COMPRESSION,
      backfillEpoch: false,
      gapFillRps: config.GAP_FILL_RPS,
      gapFillConcurrency: config.GAP_FILL_CONCURRENCY,
      gapFillMaxSlots: config.GAP_FILL_MAX_SLOTS,
      rpcPollMs: solamiRpc ? config.RPC_POLL_MS : Math.max(1_000, config.RPC_POLL_MS),
      stride,
      liveIntervalMs: 2_000,
      liveSlotsKeep: 5_000,
    },
    { rpc, store, usage },
  );

  out(
    `Solami live demo: ${endpoints.length ? `Yellowstone gRPC on ${new URL(config.SOLAMI_GRPC_URL).host} (SLOT_SOURCE=${config.SLOT_SOURCE})` : 'no SOLAMI_TOKEN, so RPC polling'}` +
      `, RPC ${rpc.host}${solamiRpc ? '' : ` (not Solami; one slot in ${stride})`}. ` +
      `${seconds > 0 ? `${seconds} s` : 'Until Ctrl-C'}, a report every ${every} s. In memory only; keys are never printed.\n`,
  );
  const started = Date.now();
  const report = () => {
    const live = [...store.liveSlots.values()].filter((r) => r.source !== 'gap-fill');
    const latest = live.reduce<(typeof live)[number] | null>((a, b) => (a && a.fees.slot > b.fees.slot ? a : b), null);
    const epochs = [...store.live.keys()].sort((a, b) => b - a);
    for (const line of formatDemo({
      at: Date.now(),
      elapsedSeconds: (Date.now() - started) / 1_000,
      stats: stream.stats,
      blocks: live.length,
      latest,
      estimate: epochs.length ? (store.live.get(epochs[0]) ?? null) : null,
      usage: usage.report(),
      stride,
    })) {
      out(redact(line, [config.SOLAMI_TOKEN]));
    }
  };
  const timer = setInterval(report, every * 1_000);
  const stop = () => stream.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const deadline = seconds > 0 ? setTimeout(stop, seconds * 1_000) : undefined;
  try {
    await stream.run();
  } finally {
    clearInterval(timer);
    clearTimeout(deadline);
  }
  out('\nFinal:');
  report();
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`demo:solami failed: ${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exit(1);
  });
