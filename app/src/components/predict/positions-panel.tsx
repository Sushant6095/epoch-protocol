"use client";
// The connected wallet's Panta positions (public chain data) with Claim on claimable rows. Claiming opens a dialog:
// the summary + a consent box + "Powered by Panta" → claim/build → the wallet signs → submit → status.

import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import { toast } from "sonner";

import { DataStatus } from "@/components/data/source-badge";
import { EmptyBlock, ErrorCard } from "@/components/data/primitives";
import { PoweredByPanta } from "@/components/integrations/powered-by-panta";
import { TxStepper } from "@/components/tx/tx-stepper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnectDialog } from "@/components/wallet/connect";
import { apiPost } from "@/lib/api/client";
import { useSession } from "@/lib/data/auth";
import { usePantaPositions } from "@/lib/data/predict";
import type { PantaBuildView, PantaPositionView } from "@/lib/data/types";
import { fmtNum, fmtUsdc, shortKey, toNum } from "@/lib/format";
import { cn } from "@/lib/utils";

import { stepperFor, usePantaTrade } from "./use-panta-trade";

const STATE_WORDS: Record<PantaPositionView["state"], string> = {
  open: "Open",
  claimable: "Claimable",
  won: "Won · not claimable yet",
  lost: "Lost",
  claimed: "Claimed",
  cancelled: "Cancelled",
};

export function PositionsPanel({ sample }: { sample: boolean }) {
  const wallet = useWallet();
  const address = wallet.publicKey?.toBase58() ?? null;
  const showConnect = useConnectDialog((s) => s.show);
  const positions = usePantaPositions(address);
  const [claiming, setClaiming] = useState<PantaPositionView | null>(null);
  const data = positions.data?.data;

  return (
    <section aria-labelledby="positions-title" className="flex flex-col gap-3 rounded-lg border border-ep-line bg-ep-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="positions-title" className="text-base font-semibold text-ep-text">
          Your positions
        </h2>
        <div className="flex items-center gap-2">
          {data ? <DataStatus source={positions.data?.source} stale={data.stale} asOf={data.asOf} staleWord="Delayed" idleLabel={`${shortKey(data.wallet)}`} sampleNote="The documented example positions." /> : null}
          <PoweredByPanta />
        </div>
      </div>
      {!address ? (
        <div className="flex flex-col gap-2 text-sm text-ep-text-2">
          <p>Connect a wallet to see its Panta positions and claims.</p>
          <Button variant="outline" size="sm" onClick={() => showConnect("connect")}>
            Connect a wallet
          </Button>
        </div>
      ) : positions.isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : positions.isError && !data ? (
        <ErrorCard error={positions.error} what="your positions" onRetry={() => void positions.refetch()} />
      ) : !data || data.positions.length === 0 ? (
        <EmptyBlock title="No positions yet" body="Shares you buy here, or anywhere on Panta, show up for this wallet." />
      ) : (
        <ul className="flex flex-col divide-y divide-ep-line">
          {data.positions.map((p) => (
            <li key={`${p.marketId}-${p.side}`} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-ep-text">{p.title ?? shortKey(p.marketId)}</p>
                <Badge variant="outline" className={cn(p.side === "yes" ? "text-ep-accent" : "text-ep-info")}>
                  {p.side.toUpperCase()}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ep-muted">
                <span className="num">{fmtNum(toNum(p.shares), 2)} shares</span>
                <span className="num">{p.price !== null ? `at ${fmtNum(p.price, 2, 2)}` : "—"}</span>
                <span className="num">≈ {fmtUsdc(p.estValueUsdc)} USDC</span>
                <span className={cn(p.state === "claimable" ? "text-ep-accent" : p.state === "lost" ? "text-ep-warn" : "text-ep-text-2")}>{STATE_WORDS[p.state]}</span>
                {p.ours ? <span>Epoch&apos;s market</span> : null}
                {p.state === "claimable" ? (
                  <Button size="xs" className="ml-auto" disabled={sample} onClick={() => setClaiming(p)}>
                    Claim
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {claiming && address ? <ClaimDialog position={claiming} wallet={address} onClose={() => setClaiming(null)} /> : null}
    </section>
  );
}

function ClaimDialog({ position, wallet, onClose }: { position: PantaPositionView; wallet: string; onClose: () => void }) {
  const session = useSession();
  const showConnect = useConnectDialog((s) => s.show);
  const signedIn = session.data?.data?.address === wallet;
  const [consent, setConsent] = useState(false);
  const trade = usePantaTrade((st) => toast.success("Claimed", { description: `${fmtUsdc(st.amountUsdc)} USDC to ${shortKey(wallet)} · Powered by Panta` }));
  const busy = ["building", "signing", "submitting", "confirming"].includes(trade.state.phase);
  const step = stepperFor(trade.state, { hasQuote: true, consent, quoting: false });
  const summary =
    trade.state.build?.summary ??
    `Claim winnings on "${position.title ?? position.marketId}": ${fmtNum(toNum(position.shares), 2)} winning ${position.side.toUpperCase()} shares, about ${fmtUsdc(position.estValueUsdc)} USDC to wallet ${shortKey(wallet)} on Solana mainnet.`;

  return (
    <Dialog open onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Claim winnings</DialogTitle>
          <DialogDescription>A real USDC transaction on Solana mainnet, signed by your wallet.</DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-relaxed text-ep-text-2">{summary}</p>
        <label htmlFor="claim-consent" className="flex cursor-pointer items-start gap-3 text-sm text-ep-text">
          <Checkbox id="claim-consent" checked={consent} disabled={busy} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
          <span>I understand this is a real USDC transaction on Solana mainnet</span>
        </label>
        <PoweredByPanta className="self-start" />
        <TxStepper
          current={step.current === "quote" || step.current === "review" ? "build" : step.current}
          status={step.status}
          error={trade.state.error}
          explorerUrl={trade.state.status?.explorerUrl ?? trade.state.submit?.explorerUrl ?? null}
          titles={{ quote: "Position", review: "Consent", build: "Build the claim" }}
          details={{ quote: `${fmtNum(toNum(position.shares), 2)} ${position.side.toUpperCase()} shares`, review: consent ? "Consent given" : "Tick the box" }}
        />
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" disabled={busy} onClick={onClose}>
            {trade.state.phase === "done" ? "Close" : "Cancel"}
          </Button>
          {trade.state.phase !== "done" ? (
            <Button
              className="flex-1"
              disabled={!consent || busy}
              onClick={() => {
                if (!signedIn) return showConnect("signin");
                void trade.run(() => apiPost<PantaBuildView>("/v1/predict/panta/claim/build", { wallet, marketId: position.marketId, consent: true }));
              }}
            >
              {busy ? "Working…" : signedIn ? "Claim" : "Sign in to claim"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
