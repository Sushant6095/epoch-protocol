"use client";
// One live proof number per integration, read from the API (Sample badge when the API can't be reached). Used on the
// Integrations hub cards and in each page's Proof section.

import { DataStatus } from "@/components/data/source-badge";
import { KeyValue, KeyValueGrid } from "@/components/data/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { useLaunches } from "@/lib/data/launch";
import { useLiveSummary, useSolamiUsage } from "@/lib/data/live";
import { usePantaStats } from "@/lib/data/predict";
import { isSampleKind } from "@/lib/data/query";
import { fmtBytes, fmtCu, fmtInt, fmtPct, fmtSolValue, fmtTimeIst, fmtUsdc } from "@/lib/format";

import { PoweredByPanta } from "./powered-by-panta";

function ProofSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3" aria-hidden>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-14" />
      ))}
    </div>
  );
}

const PRODUCT_WORDS: Record<string, string> = { grpc: "Yellowstone gRPC", rpc: "RPC", beam: "Beam" };

export function SolamiProof() {
  const summary = useLiveSummary();
  const usage = useSolamiUsage();
  if (!summary.data && summary.isPending) return <ProofSkeleton />;
  const s = summary.data?.data;
  const u = usage.data?.data;
  const sample = summary.data?.source === "sample";
  const grpcBytes = u?.grpc.reduce((a, g) => a + g.bytes, 0) ?? null;
  const solamiCalls = u?.rpc.filter((r) => r.solami).reduce((a, r) => a + r.calls, 0) ?? null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DataStatus
          source={summary.data?.source}
          live={s?.live}
          stale={s ? !s.live : false}
          asOf={s?.stream.lastSlotAt ?? s?.asOf}
          liveDetail={s?.dataSource}
          sampleNote="Recorded 3 Oct 2026 on public RPC (epoch 1048)."
        />
      </div>
      <KeyValueGrid cols={3}>
        <KeyValue
          label={s?.estimate?.sampled ? "Sampled estimate" : "Fee Index, running"}
          value={<>{fmtCu(s?.estimate?.value)} <span className="text-unit text-ep-muted">µL/CU</span></>}
          sub={s?.epoch ? `epoch ${s.epoch.number} · ${fmtPct(s.epoch.progressPct, 0)} done` : undefined}
          valueClassName="text-xl"
        />
        <KeyValue
          label="Solami in use"
          value={u ? (u.inUse.length ? u.inUse.map((p) => PRODUCT_WORDS[p] ?? p).join(" · ") : "none yet") : "—"}
          sub={u && !u.inUse.length ? (sample ? "recorded without a key" : "no Solami key on this server") : `${fmtBytes(grpcBytes)} streamed`}
        />
        <KeyValue
          label="Lag behind tip"
          value={s?.lagSlots !== null && s?.lagSlots !== undefined ? `${fmtInt(s.lagSlots)} slots` : "—"}
          sub={solamiCalls ? `${fmtInt(solamiCalls)} Solami RPC calls` : s?.stream.endpoint ?? undefined}
        />
      </KeyValueGrid>
    </div>
  );
}

export function PantaProof() {
  const stats = usePantaStats();
  if (!stats.data && stats.isPending) return <ProofSkeleton />;
  if (!stats.data) {
    return <p className="text-sm text-ep-muted">Panta traction is not available right now{stats.error ? `: ${stats.error.message}` : ""}.</p>;
  }
  const t = stats.data.data.traction;
  // Panta's metrics never answered: show that, not zeros (Epoch's own counts still are facts).
  const unknown = t.asOf === null;
  const e = stats.data.data.epoch;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DataStatus
          source={stats.data.source}
          stale={t.stale}
          asOf={t.asOf}
          staleWord="Delayed"
          idleLabel={`As of ${fmtTimeIst(t.asOf)}`}
          unavailable={unknown}
          unavailableLabel="Panta's metrics not readable right now"
          unavailableDetail={stats.data.data.note || undefined}
          sampleNote="The traction example in docs/pages/predict.md."
        />
        <PoweredByPanta />
      </div>
      <KeyValueGrid cols={3}>
        <KeyValue label="Markets created" value={unknown ? fmtInt(e.marketsCreated) : fmtInt(t.marketsCreated)} valueClassName="text-xl" sub={unknown ? "Epoch's own count" : "on Panta, by Epoch's bot"} />
        <KeyValue
          label="Attributed volume"
          value={<>{unknown ? fmtUsdc(e.volumeUsdc) : fmtUsdc(t.attributedVolumeUsdc)} <span className="text-unit text-ep-muted">USDC</span></>}
          sub={unknown ? `${fmtInt(e.trades)} trades through Epoch` : `${fmtInt(t.attributedTrades)} trades`}
        />
        <KeyValue label="Traders" value={unknown ? "—" : `${fmtInt(t.traders)}${t.tradersComplete ? "" : "+"}`} sub={unknown ? "not readable now" : `${fmtUsdc(t.marketsVolumeUsdc)} USDC on our markets`} />
      </KeyValueGrid>
    </div>
  );
}

export function MeteoraProof() {
  const list = useLaunches();
  if (!list.data && list.isPending) return <ProofSkeleton />;
  if (!list.data) return <p className="text-sm text-ep-muted">Launches are not available right now.</p>;
  const l = list.data.data;
  const raised = l.launches.reduce((a, x) => a + x.raise.raisedSol, 0);
  const graduated = l.launches.filter((x) => x.status === "graduated").length;
  const onCurve = l.launches.filter((x) => x.status === "curve").length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DataStatus source={isSampleKind(l.kind) ? "sample" : list.data.source} asOf={l.asOf} sampleNote="Tokens recorded on the local stand-in with Meteora's mainnet programs (3–5 Oct 2026)." />
      </div>
      <KeyValueGrid cols={3}>
        <KeyValue label="Revenue tokens" value={fmtInt(l.launches.length)} valueClassName="text-xl" sub={`${onCurve} on the curve · ${graduated} graduated`} />
        <KeyValue label="Raised on DBC" value={<>{fmtSolValue(raised)} <span className="text-unit text-ep-muted">SOL</span></>} sub="curve quote reserves" />
        <KeyValue label="Network" value={l.network === "mainnet" ? "Mainnet" : "Devnet"} sub="launch cluster" />
      </KeyValueGrid>
    </div>
  );
}

/** The live proof for one integration (a client component, so server pages can render it by id). */
export function LiveProof({ id }: { id: "solami" | "panta" | "meteora" }) {
  if (id === "solami") return <SolamiProof />;
  if (id === "panta") return <PantaProof />;
  return <MeteoraProof />;
}
