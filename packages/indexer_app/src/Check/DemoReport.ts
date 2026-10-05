import { type LiveIndexPayload } from '@epoch/pg_models';
import { type SolamiUsageReport } from '@epoch/solana';

import { type SlotRecord } from '../Repositories/IndexerStore';
import { type SlotStreamStats } from '../Streams/SlotStream';

/** What one `pnpm demo:solami` line is made of. */
export interface DemoSnapshot {
  /** Unix ms. */
  at: number;
  /** Seconds since the demo started. */
  elapsedSeconds: number;
  stats: SlotStreamStats;
  /** Blocks processed live so far. */
  blocks: number;
  latest: SlotRecord | null;
  estimate: LiveIndexPayload | null;
  usage: SolamiUsageReport;
  stride: number;
}

const n = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toLocaleString('en-US');
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** hh:mm:ss in IST, as the API reports times. */
export const istClock = (at: number): string =>
  new Date(at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });

/** Four lines: the source and lag, the newest block, the running index, and what was used of Solami. */
export function formatDemo(snapshot: DemoSnapshot): string[] {
  const { stats, latest, estimate, usage } = snapshot;
  const lagSeconds = stats.lagSlots !== null ? ` (${(stats.lagSlots * 0.4).toFixed(1)} s)` : '';
  const perMinute = snapshot.elapsedSeconds > 0 ? ((snapshot.blocks * 60) / snapshot.elapsedSeconds).toFixed(1) : '0';
  const lines = [
    `[${istClock(snapshot.at)} IST] ${stats.source ?? 'starting'} · ${stats.status} · ${stats.endpoint ?? '—'} · ` +
      `tip ${n(stats.tipSlot)} · processed ${n(stats.processedSlot)} · lag ${n(stats.lagSlots)} slots${lagSeconds}`,
  ];
  if (latest) {
    const fees = latest.fees;
    lines.push(
      `  newest block ${n(fees.slot)} · leader ${fees.leader.slice(0, 8)}… · median ${n(fees.medianCuPrice)} µL/CU · ` +
        `${n(fees.pricedTxs)} priced, ${n(fees.unpricedTxs)} unpriced, ${n(fees.leaderPaidTxs)} leader-paid, ` +
        `${n(fees.failedTxs)} failed · ${n(snapshot.blocks)} blocks (${perMinute}/min)`,
    );
  } else {
    lines.push('  waiting for the first block…');
  }
  if (estimate) {
    lines.push(
      `  epoch ${estimate.epoch} running Fee Index ${n(estimate.estimate)} µL/CU · ${n(estimate.leaders)} staked leaders · ` +
        `${n(estimate.slotsWithFees)} slots${snapshot.stride > 1 ? ` · sampled 1 slot in ${snapshot.stride}` : ''}`,
    );
  }
  const grpc = usage.grpc;
  const grpcText =
    grpc && grpc.status !== 'off'
      ? `gRPC ${grpc.subscription ?? ''} ${grpc.status} on ${grpc.endpoint ?? '—'}, ${mib(grpc.bytes)} in ${n(grpc.updates)} updates` +
        (snapshot.elapsedSeconds > 0 ? ` (${(grpc.bytes / 1024 / snapshot.elapsedSeconds).toFixed(1)} KiB/s)` : '') +
        (grpc.compression ? `, ${grpc.compression}` : '')
      : 'gRPC off (no SOLAMI_TOKEN: RPC polling)';
  const rpcText = usage.rpc
    .map(
      (r) =>
        `RPC ${r.host}${r.solami ? '' : ' (not Solami)'} ${n(r.calls)} calls, p50 ${n(r.p50Ms)} ms, p95 ${n(r.p95Ms)} ms, ` +
        `${n(r.errors)} errors${r.rateLimited ? ` (${n(r.rateLimited)} rate-limited)` : ''}`,
    )
    .join(' · ');
  lines.push(`  Solami: ${grpcText}${rpcText ? ` · ${rpcText}` : ''}`);
  if (usage.lastError && snapshot.at - usage.lastError.at < 60_000) {
    lines.push(`  last error (${usage.lastError.product}): ${usage.lastError.message}`);
  }
  return lines;
}
