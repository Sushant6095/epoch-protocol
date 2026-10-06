"use client";
// The free tier, unchanged (docs/pages/predict.md "Points tab"): Fee Index markets in points, calls with the sign-in
// session (no wallet transaction), and the leaderboard of net points over the last 30 epochs. Points have no cash
// value; nothing here involves Panta.

import { useWallet } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { DataStatus } from "@/components/data/source-badge";
import { EmptyBlock, ErrorCard, SectionHeading } from "@/components/data/primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnectDialog } from "@/components/wallet/connect";
import { errorText, apiPost } from "@/lib/api/client";
import { useSession } from "@/lib/data/auth";
import { usePointsLeaderboard, usePointsSnapshot } from "@/lib/data/predict";
import { apiKey } from "@/lib/data/query";
import type { CallPoints, CallSide, PredictSnapshot } from "@/lib/data/types";
import { fmtEpoch, fmtInt, fmtProb } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PointsTab() {
  const snap = usePointsSnapshot();
  const board = usePointsLeaderboard();
  const wallet = useWallet();
  const session = useSession();
  const show = useConnectDialog((s) => s.show);
  const qc = useQueryClient();
  const signedIn = !!wallet.publicKey && session.data?.data?.address === wallet.publicKey.toBase58();
  const [pick, setPick] = useState<{ marketId: string; side: CallSide } | null>(null);
  const [size, setSize] = useState<CallPoints>(25);
  const [sending, setSending] = useState(false);
  const s = snap.data?.data;
  const sample = snap.data?.source === "sample";

  const call = async () => {
    if (!pick) return;
    if (!signedIn) return show("signin");
    setSending(true);
    try {
      const fresh = await apiPost<PredictSnapshot>("/v1/predict/calls", { marketId: pick.marketId, side: pick.side, points: size });
      qc.setQueryData(apiKey("predict", "points", "markets"), { data: fresh, source: "api", receivedAt: Date.now() });
      toast.success("Your call is in", { description: `${size} points on ${pick.side.toUpperCase()}. It settles when the epoch's Fee Index turns final.` });
      setPick(null);
    } catch (e) {
      toast.error("Couldn't send your call", { description: errorText(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {["Points only · no cash value", "100 points an epoch", "18+ · where allowed", "Settles from the final Fee Index"].map((r) => (
          <Badge key={r} variant="outline" className="h-6 text-ep-text-2">
            {r}
          </Badge>
        ))}
        {snap.data ? <DataStatus source={snap.data.source} asOf={s?.asOf} sampleNote="From the kit's points-mode fixture." /> : null}
      </div>
      <h2 className="sr-only">Points markets and calls</h2>
      <div className="grid gap-4 lg:grid-cols-12">
        <section aria-labelledby="points-markets" className="flex flex-col gap-3 lg:col-span-8">
          <SectionHeading as="h3" id="points-markets" title="Fee Index markets in points" description={s ? `Calls of ${s.rules.callSizesPoints.join(", ")} points. No fee: the losing side's points are shared among the winners.` : undefined} />
          {snap.isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : !s ? (
            <ErrorCard error={snap.error} what="the points markets" onRetry={() => void snap.refetch()} />
          ) : s.markets.length === 0 ? (
            <EmptyBlock title="No market open" body="A market opens for the next epochs once the first Fee Index is final." />
          ) : (
            <ul className="flex flex-col gap-3">
              {s.markets.map((m) => (
                <li key={m.id} className="flex flex-col gap-3 rounded-lg border border-ep-line bg-ep-surface p-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-medium text-ep-text">{m.question}</p>
                    <Badge variant="outline" className="capitalize">{m.status}</Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {(["yes", "no"] as const).map((side) => {
                      const share = side === "yes" ? m.yesShare : 1 - m.yesShare;
                      const active = pick?.marketId === m.id && pick.side === side;
                      return (
                        <button
                          key={side}
                          type="button"
                          disabled={m.status !== "open"}
                          aria-pressed={active}
                          onClick={() => setPick({ marketId: m.id, side })}
                          className={cn(
                            "relative flex h-11 items-center overflow-hidden rounded-md border px-3 text-sm transition-colors duration-200 disabled:opacity-60",
                            active ? "border-ep-accent" : "border-ep-line hover:border-ep-line-strong",
                          )}
                        >
                          <span aria-hidden className={cn("absolute inset-y-0 left-0", side === "yes" ? "bg-ep-accent-soft" : "bg-ep-info-soft")} style={{ width: `${share * 100}%` }} />
                          <span className={cn("relative font-medium", side === "yes" ? "text-ep-accent" : "text-ep-info")}>{side === "yes" ? "Yes" : "No"}</span>
                          <span className="num relative ml-auto text-ep-text">{fmtProb(share)}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-ep-muted">
                    Pool <span className="num">{fmtInt(m.poolPoints)}</span> points · <span className="num">{fmtInt(m.players)}</span> players · closes with epoch {fmtEpoch(m.closesAtEpoch)}
                    {m.nowNote ? ` · ${m.nowNote}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <aside className="flex flex-col gap-4 lg:col-span-4">
          <section aria-labelledby="points-ticket" className="flex flex-col gap-3 rounded-lg border border-ep-line bg-ep-raised p-5">
            <h3 id="points-ticket" className="text-base font-semibold text-ep-text">
              Make a call
            </h3>
            <p className="text-sm text-ep-text-2">
              {pick ? `${pick.side === "yes" ? "Yes" : "No"} on ${s?.markets.find((m) => m.id === pick.marketId)?.question ?? pick.marketId}` : "Pick Yes or No on a market."}
            </p>
            <div className="grid grid-cols-4 gap-2" role="group" aria-label="Call size in points">
              {(s?.rules.callSizesPoints ?? [10, 25, 50, 100]).map((p) => (
                <Button key={p} size="sm" variant={size === p ? "secondary" : "outline"} aria-pressed={size === p} onClick={() => setSize(p)}>
                  {p}
                </Button>
              ))}
            </div>
            <p className="text-xs text-ep-muted">
              Points left this epoch: <span className="num">{s?.rules.pointsLeftThisEpoch ?? "—"}</span> of {s?.rules.pointsPerEpoch ?? 100}. A call is not a transaction: nothing is signed.
            </p>
            <Button disabled={!pick || sending || sample} onClick={() => void call()}>
              {sample ? "Sample data: calls need the live API" : signedIn ? (sending ? "Sending…" : `Call ${size} points`) : "Sign in to call"}
            </Button>
          </section>
          <section aria-labelledby="points-board" className="flex flex-col gap-3 rounded-lg border border-ep-line bg-ep-surface p-5">
            <h3 id="points-board" className="text-base font-semibold text-ep-text">
              Leaderboard · last {board.data?.data.epochs ?? 30} epochs
            </h3>
            {board.data?.data.rows.length ? (
              <ol className="flex flex-col divide-y divide-ep-line">
                {board.data.data.rows.slice(0, 5).map((r) => (
                  <li key={r.rank} className="flex items-center gap-3 py-2 text-sm">
                    <span className="num w-5 text-ep-muted">{r.rank}</span>
                    <span className="num text-ep-text">{r.walletShort}</span>
                    <span className="num ml-auto text-ep-accent">+{fmtInt(r.netPoints)}</span>
                    <span className="num w-12 text-right text-xs text-ep-muted">{r.hitPct}%</span>
                  </li>
                ))}
              </ol>
            ) : board.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <p className="text-sm text-ep-muted">No settled calls yet.</p>
            )}
            <p className="text-xs text-ep-muted">Points can&apos;t be bought, sold or transferred · unaudited pre-alpha</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
