#!/usr/bin/env node
import '@epoch/common/first-module';

import { getArg } from '@epoch/common';
import { BeamConfigSchema, IndexerConfigSchema, loadConfig } from '@epoch/config-sdk';
import { geyserClient } from '@epoch/solana';

import { formatReport, SolamiCheck } from './Check/SolamiCheck';
import { redact, SolanaRpc } from './Rpc/SolanaRpc';

const out = (line: string): void => void process.stdout.write(`${line}\n`);

/** The key in a Solami RPC URL (`?api_key=`), so it can be kept out of every line printed. */
function urlKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).searchParams.get('api_key') ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * pnpm solami:check [--slots 20] [--firehose-seconds 5] [--compression zstd|gzip|none] [--env .env]
 * Reads SOLAMI_GRPC_URL, SOLAMI_TOKEN, SOLAMI_RPC_URL, SOLAMI_GRPC_COMPRESSION and SOLAMI_BEAM_URL. Never prints a key
 * and never sends a transaction.
 */
async function main(): Promise<number> {
  const config = loadConfig(IndexerConfigSchema);
  const beam = loadConfig(BeamConfigSchema);
  const slots = Number(getArg(['--slots']) ?? 20);
  const firehoseSeconds = Number(getArg(['--firehose-seconds']) ?? 5);
  const compressionArg = getArg(['--compression']);
  const compression = compressionArg ?? config.SOLAMI_GRPC_COMPRESSION;
  if (!['none', 'zstd', 'gzip'].includes(compression)) throw new Error('--compression must be zstd, gzip or none');
  const secrets = [config.SOLAMI_TOKEN, urlKey(config.SOLAMI_RPC_URL), urlKey(beam.SOLAMI_BEAM_URL)].filter(
    (s): s is string => !!s,
  );
  const check = new SolamiCheck(
    {
      grpc: config.SOLAMI_TOKEN
        ? { name: 'solami', url: config.SOLAMI_GRPC_URL, token: config.SOLAMI_TOKEN }
        : undefined,
      rpc: config.SOLAMI_RPC_URL ? new SolanaRpc(config.SOLAMI_RPC_URL, { retries: 1 }) : undefined,
      slots: Number.isFinite(slots) && slots > 0 ? slots : 20,
      firehoseSeconds: Number.isFinite(firehoseSeconds) && firehoseSeconds >= 0 ? firehoseSeconds : 5,
      compression: compression === 'none' ? undefined : (compression as 'zstd' | 'gzip'),
      beamUrl: beam.SOLAMI_BEAM_URL,
      secrets,
    },
    {
      createClient: geyserClient,
      fetchJson: async (url) => {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      },
      http: async (url, body) => {
        const res = await fetch(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        return { status: res.status, body: await res.text() };
      },
      log: out,
    },
  );
  out('Solami check (read-only; keys are never printed)\n');
  const results = await check.run();
  out(`\n${formatReport(results)}`);
  return check.passed ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`solami-check failed: ${redact(error instanceof Error ? error.message : String(error))}\n`);
    process.exit(1);
  });
