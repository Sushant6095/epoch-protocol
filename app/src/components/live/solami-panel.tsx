"use client";
// "Powered by Solami": what Epoch uses of Solami right now, from GET /v1/live/solami (every 10 s). One row per
// product with a dot that is on only when `inUse` lists it, and words beside it (colour never alone). Hosts that are
// not Solami (public fallbacks) are listed too, marked as such. The newest error shows under the panel while it is
// less than five minutes old.

import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";

import { DataStatus, LiveDot } from "@/components/data/source-badge";
import { ErrorCard, Unavailable } from "@/components/data/primitives";
import { Skeleton } from "@/components/ui/skeleton";
import { useSolamiUsage } from "@/lib/data/live";
import { fmtAgo, fmtBytes, fmtInt, fmtNum, fmtSol, fmtTimeIst, secondsSince } from "@/lib/format";
import { cn } from "@/lib/utils";

function Row({ on, title, status, children }: { on: boolean; title: string; status: string; children?: ReactNode }) {
  return (
    <li className="flex flex-col gap-2 border-t border-ep-line py-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <LiveDot on={on} />
        <span className="font-medium text-ep-text">{title}</span>
        <span className={cn("ml-auto text-xs", on ? "text-ep-accent" : "text-ep-muted")}>{status}</span>
      </div>
      {children ? <div className="pl-4 text-xs text-ep-text-2">{children}</div> : null}
    </li>
  );
}

export function SolamiPanel() {
  const usage = useSolamiUsage();
  if (usage.isPending) return <Skeleton className="h-64 w-full" />;
  if (usage.isError && !usage.data) return <ErrorCard error={usage.error} what="the Solami usage report" onRetry={() => void usage.refetch()} />;
  const u = usage.data?.data;
  if (!u) return <Unavailable />;
  const sample = usage.data?.source === "sample";
  const inUse = new Set(u.inUse);
  const grpcLive = u.grpc.filter((g) => g.status === "streaming");
  const solamiRpc = u.rpc.filter((r) => r.solami);
  const otherRpc = u.rpc.filter((r) => !r.solami);
  const errAge = secondsSince(u.lastError?.at, sample ? Date.parse(u.asOf) : Date.now());

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <DataStatus
          source={usage.data?.source}
          idleLabel={`Counters at ${fmtTimeIst(u.asOf)}`}
          sampleNote="The documented report of 5 Oct 2026, recorded without a Solami key."
          asOf={u.asOf}
        />
        <span className="text-xs text-ep-muted">
          {u.components.map((c) => `${c.name}${c.stale ? " (not reporting)" : ""}`).join(" · ")}
        </span>
      </div>
      <ul className="flex flex-col">
        <Row on={inUse.has("grpc")} title="Yellowstone gRPC" status={inUse.has("grpc") ? "streaming" : u.grpc.every((g) => g.status === "off") ? "off · no key" : u.grpc.map((g) => g.status).join(" · ")}>
          {u.grpc.length ? (
            <ul className="flex flex-col gap-1">
              {u.grpc.map((g) => (
                <li key={`${g.component}-${g.subscription}`} className="num flex flex-wrap gap-x-3">
                  <span className="text-ep-text">{g.component}</span>
                  <span>{g.subscription ?? "—"}</span>
                  <span>{g.endpoint ?? "—"}</span>
                  <span>{fmtBytes(g.bytes)}</span>
                  <span>{fmtInt(g.updates)} updates</span>
                  {g.lagSlots !== null ? <span>lag {fmtInt(g.lagSlots)} slots</span> : null}
                  {g.reconnects ? <span>{fmtInt(g.reconnects)} reconnects</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            "No stream reported."
          )}
        </Row>
        <Row on={inUse.has("rpc")} title="Solami RPC" status={solamiRpc.length ? `${fmtInt(solamiRpc.reduce((a, r) => a + r.calls, 0))} calls` : "not used yet"}>
          {[...solamiRpc, ...otherRpc].map((r) => (
            <div key={`${r.component}-${r.host}`} className="num flex flex-wrap gap-x-3">
              <span className="text-ep-text">{r.component}</span>
              <span className={r.solami ? "text-ep-accent" : "text-ep-muted"}>
                {r.host}
                {r.solami ? "" : " (not Solami)"}
              </span>
              <span>{fmtInt(r.calls)} calls</span>
              <span>
                p50 {fmtInt(r.p50Ms)} ms · p95 {fmtInt(r.p95Ms)} ms
              </span>
              {r.errors ? <span className="text-ep-warn">{fmtInt(r.errors)} errors ({fmtInt(r.rateLimited)} rate-limited)</span> : null}
            </div>
          ))}
        </Row>
        <Row on={inUse.has("beam")} title="Beam" status={u.beamTotals.sends ? `${fmtInt(u.beamTotals.landed)} of ${fmtInt(u.beamTotals.sends)} landed` : "no sends yet"}>
          {u.beam.length ? (
            u.beam.map((b) => (
              <div key={b.component} className="num flex flex-wrap gap-x-3">
                <span className="text-ep-text">{b.component}</span>
                <span>
                  {fmtInt(b.landed)}/{fmtInt(b.sends)} landed
                </span>
                <span>tips {fmtSol(b.tipsSpentSol)}</span>
                <span>tip list: {b.tipSource ?? "—"}</span>
                {b.lastLandedAt ? <span>last landed {fmtTimeIst(b.lastLandedAt)}</span> : null}
              </div>
            ))
          ) : (
            <span>Beam sends start with the first mainnet post_index or crank transaction.</span>
          )}
          {u.beamTotals.sends ? <div className="num mt-1">tips spent in total: {fmtNum(u.beamTotals.tipsSpentSol, 6)} SOL</div> : null}
        </Row>
      </ul>
      {grpcLive.length === 0 && !inUse.size ? (
        <p className="text-xs text-ep-muted">
          {sample
            ? "This sample was recorded without a Solami key, so the indexer polled public RPC; with a key the rows above show the streams, the Solami RPC host and Beam."
            : "This API runs without a Solami key: the indexer polls public RPC, and nothing here is counted as Solami."}
        </p>
      ) : null}
      {u.lastError && errAge !== null && errAge < 300 ? (
        <p className="flex items-start gap-2 rounded-md border border-ep-warn-line bg-ep-warn-soft p-2 text-xs text-ep-text-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-ep-warn" aria-hidden />
          <span>
            <span className="text-ep-text">{u.lastError.component}</span> · {u.lastError.product}: {u.lastError.message} ({fmtAgo(errAge)})
          </span>
        </p>
      ) : null}
    </div>
  );
}
