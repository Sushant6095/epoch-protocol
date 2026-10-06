"use client";
// The buy ticket (Kraken Pro order form: a two-way toggle, an amount with preset chips, the estimate rows, one
// full-width button), with the gates in its slot (Coinbase's gated ticket) and the review in place (Reown's preview):
//   quote (debounced ≥ 600 ms; Panta allows 30 quotes a minute for the whole app) → the summary verbatim + an explicit
//   consent box + "Powered by Panta" → build → the wallet signs → Epoch submits → status until confirmed.
// Browsing and quotes work signed out; Buy asks for Sign In With Solana first.

import { useWallet } from "@solana/wallet-adapter-react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Lock, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";

import { PoweredByPanta } from "@/components/integrations/powered-by-panta";
import { TradeGate, useTradeGate } from "@/components/tx/trade-gate";
import { TxStepper } from "@/components/tx/tx-stepper";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useConnectDialog } from "@/components/wallet/connect";
import { ApiError, apiPost } from "@/lib/api/client";
import { useSession } from "@/lib/data/auth";
import type { PantaAccess, PantaBuildView, PantaFeeIndexMarket, PantaMarketCard, PantaQuoteView, PantaSide } from "@/lib/data/types";
import { fmtCountdown, fmtDateTimeIst, fmtNum, fmtUsdc, shortKey, toNum } from "@/lib/format";
import { cn } from "@/lib/utils";

import { pantaErrorWords, stepperFor, usePantaTrade } from "./use-panta-trade";

const CHIPS = ["5", "10", "25", "50"];

export function BuyTicket({
  market,
  access,
  sample,
  side,
  onSide,
}: {
  market: PantaMarketCard | PantaFeeIndexMarket;
  access: PantaAccess;
  sample: boolean;
  side: PantaSide;
  onSide: (side: PantaSide) => void;
}) {
  const wallet = useWallet();
  const address = wallet.publicKey?.toBase58() ?? null;
  const session = useSession();
  const signedIn = !!address && session.data?.data?.address === address;
  const showConnect = useConnectDialog((s) => s.show);
  const gate = useTradeGate("predict", address);

  const [amount, setAmount] = useState("10");
  const [debounced] = useDebounceValue(amount, 600);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const trade = usePantaTrade((st) =>
    toast.success("Trade confirmed", {
      description: `${st.side?.toUpperCase() ?? ""} for ${fmtUsdc(st.amountUsdc)} USDC on Solana mainnet · Powered by Panta`,
      action: st.explorerUrl ? { label: "Explorer", onClick: () => window.open(st.explorerUrl!, "_blank", "noopener") } : undefined,
    }),
  );

  const min = toNum(access.minTradeUsdc) ?? 1;
  const max = toNum(access.maxTradeUsdc) ?? 500;
  const amt = toNum(debounced);
  const amountError = amt === null || amt <= 0 ? "Enter an amount in USDC." : amt < min ? `At least ${fmtUsdc(min)} USDC.` : amt > max ? `At most ${fmtUsdc(max)} USDC per buy.` : null;

  const blocked: string | null = sample
    ? "Sample data: trading needs the live Epoch API."
    : !access.tradingEnabled
      ? access.reason ?? "Trading is switched off right now. You can still browse."
      : access.geoBlocked
        ? access.country === null
          ? access.reason ?? "Trading needs your region, which could not be determined."
          : "Real-money trading isn't available in your region."
        : !market.tradable
          ? `Trading closed. Resolves after ${fmtDateTimeIst(market.resolvesAt)}.`
          : null;

  const busy = trade.state.phase !== "idle" && trade.state.phase !== "failed" && trade.state.phase !== "done" && trade.state.phase !== "timeout";

  const quote = useQuery({
    queryKey: ["panta-quote", market.marketId, side, debounced, address],
    enabled: !blocked && !!address && !amountError && gate.ok && trade.state.phase === "idle",
    queryFn: () =>
      apiPost<PantaQuoteView>("/v1/predict/panta/quote", { wallet: address, marketId: market.marketId, side, amountUsdc: fmtNum(amt, 2, 2).replace(/,/g, "") }),
    retry: (count, e) => e instanceof ApiError && e.status === 429 && count < 1,
    retryDelay: (_, e) => Math.min(10, (e instanceof ApiError ? e.retryAfterSeconds : null) ?? 3) * 1000,
    // A quote lives ≈ 90 s: fetch a new one when it expires (no faster, the budget is shared).
    refetchInterval: (q) => (q.state.data ? Math.max(5_000, Date.parse(q.state.data.expiresAt) - Date.now()) : false),
    staleTime: 10_000,
  });

  // A new quote needs a new consent.
  useEffect(() => setConsent(false), [quote.data?.quoteId]);
  // Quote expired or moved during build: re-quote automatically and ask again.
  useEffect(() => {
    if (trade.state.phase === "failed" && (trade.state.code === "PANTA_QUOTE_EXPIRED" || trade.state.code === "PANTA_QUOTE_STALE")) {
      setNotice(trade.state.error);
      trade.reset();
      void quote.refetch();
    }
    if (trade.state.phase === "failed" && (trade.state.code === "UNAUTHORIZED" || trade.state.code === "SESSION_REQUIRED")) showConnect("signin");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade.state.phase, trade.state.code]);

  const q = quote.data;
  const quoteError = quote.error ? pantaErrorWords(quote.error).text : null;
  const step = stepperFor(trade.state, { hasQuote: !!q, consent, quoting: quote.isFetching });

  const confirm = () => {
    if (!q || !address) return;
    if (!signedIn) {
      showConnect("signin");
      return;
    }
    setNotice(null);
    void trade.run(() => apiPost<PantaBuildView>("/v1/predict/panta/build", { quoteId: q.quoteId, wallet: address, consent: true, maxSlippageBps: 100 }));
  };

  const expiresIn = useMemo(() => (q ? fmtCountdown(q.expiresAt) : null), [q]);

  return (
    <section aria-labelledby="ticket-title" className="flex flex-col gap-4 rounded-lg border border-ep-line bg-ep-raised p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 id="ticket-title" className="text-base font-semibold text-ep-text">
          Buy shares
        </h2>
        <PoweredByPanta />
      </div>

      <ToggleGroup
        value={[side]}
        onValueChange={(v: string[]) => v[0] && onSide(v[0] as PantaSide)}
        className="grid w-full grid-cols-2"
        aria-label="Side"
        disabled={busy || !market.tradable}
      >
        <ToggleGroupItem value="yes" className="h-11 aria-pressed:bg-ep-accent aria-pressed:text-ep-accent-ink">
          Yes {market.yesPrice !== null ? <span className="num ml-1 opacity-80">{fmtNum(market.yesPrice, 2, 2)}</span> : null}
        </ToggleGroupItem>
        <ToggleGroupItem value="no" className="h-11 aria-pressed:bg-ep-info aria-pressed:text-ep-accent-ink">
          No {market.noPrice !== null ? <span className="num ml-1 opacity-80">{fmtNum(market.noPrice, 2, 2)}</span> : null}
        </ToggleGroupItem>
      </ToggleGroup>

      {blocked ? (
        <div className="flex items-start gap-3 rounded-md border border-ep-line-strong bg-ep-inset p-4 text-sm text-ep-text-2">
          <Lock className="mt-0.5 size-4 shrink-0 text-ep-muted" aria-hidden />
          <p>{blocked}</p>
        </div>
      ) : !address ? (
        <div className="flex flex-col gap-3 rounded-md border border-ep-line-strong bg-ep-inset p-4 text-sm text-ep-text-2">
          <p>Connect a wallet to get a quote. Signing in is a message, not a transaction.</p>
          <Button onClick={() => showConnect("connect")}>Connect a wallet</Button>
        </div>
      ) : !gate.ok ? (
        <TradeGate id="predict-gate" regionLine="Trading real-money prediction markets is allowed where I live" onPass={gate.pass} />
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <Label htmlFor="amount" className="flex justify-between text-sm text-ep-text-2">
              <span>Amount</span>
              <span className="num text-xs text-ep-muted">
                {fmtUsdc(min)}–{fmtUsdc(max)} USDC
              </span>
            </Label>
            <div className="relative">
              <Input
                id="amount"
                inputMode="decimal"
                value={amount}
                disabled={busy}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                aria-invalid={amountError ? true : undefined}
                aria-describedby="amount-help"
                className="num h-12 pr-16 text-lg"
              />
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-ep-muted">USDC</span>
            </div>
            <div className="flex gap-2">
              {CHIPS.map((c) => (
                <Button key={c} type="button" variant={amount === c ? "secondary" : "outline"} size="xs" className="flex-1" disabled={busy} onClick={() => setAmount(c)}>
                  {c}
                </Button>
              ))}
            </div>
            <p id="amount-help" className={cn("text-xs", amountError || quoteError ? "text-ep-warn" : "text-ep-muted")} role={amountError || quoteError ? "alert" : undefined}>
              {amountError ?? quoteError ?? "USDC on Solana mainnet, from the connected wallet."}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-ep-line bg-ep-inset p-3 text-sm">
            <dt className="text-ep-muted">Shares (≈)</dt>
            <dd className="num text-right text-ep-text">{q ? fmtNum(toNum(q.shares), 2) : "—"}</dd>
            <dt className="text-ep-muted">Average price</dt>
            <dd className="num text-right">{q ? `${fmtNum(toNum(q.avgPrice), 4, 2)} USDC` : "—"}</dd>
            <dt className="text-ep-muted">Panta fee</dt>
            <dd className="num text-right">{q ? `${fmtUsdc(q.feeUsdc)} USDC` : "—"}</dd>
            <dt className="text-ep-muted">Payout if {side === "yes" ? "Yes" : "No"} wins</dt>
            <dd className="num text-right text-ep-accent">{q ? `${fmtUsdc(q.payoutIfWinUsdc)} USDC` : "—"}</dd>
            <dt className="text-ep-muted">Quote expires</dt>
            <dd className="num text-right text-ep-muted">
              {q ? `in ${expiresIn}` : quote.isFetching ? "quoting…" : "—"}
              {q ? (
                <button type="button" onClick={() => void quote.refetch()} className="ml-2 inline-flex size-6 items-center justify-center rounded-sm align-middle text-ep-muted hover:text-ep-text" aria-label="Refresh the quote">
                  <RefreshCw className="size-3" aria-hidden />
                </button>
              ) : null}
            </dd>
          </dl>

          {q ? (
            <div className="flex flex-col gap-3 rounded-md border border-ep-line-strong p-3">
              <p className="text-sm leading-relaxed text-ep-text-2">{trade.state.build?.summary ?? q.summary}</p>
              <label htmlFor="consent" className="flex cursor-pointer items-start gap-3 text-sm text-ep-text">
                <Checkbox id="consent" checked={consent} disabled={busy} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
                <span>I understand this is a real USDC trade on Solana mainnet</span>
              </label>
              <PoweredByPanta className="self-start" />
            </div>
          ) : null}

          {notice ? (
            <p className="flex items-start gap-2 text-xs text-ep-warn" role="status">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {notice}
            </p>
          ) : null}

          <Button size="lg" className="w-full" disabled={!q || !consent || busy || !!amountError} onClick={confirm}>
            {busy
              ? "Working…"
              : !signedIn
                ? "Sign in to buy"
                : `Buy ${side === "yes" ? "Yes" : "No"}${q ? ` for ${fmtUsdc(q.amountUsdc)} USDC` : ""}`}
          </Button>
          {!signedIn ? <p className="-mt-2 text-center text-xs text-ep-muted">Signing in is a message in {wallet.wallet?.adapter.name ?? "your wallet"}, no fee.</p> : null}
        </>
      )}

      <TxStepper
        current={step.current}
        status={step.status}
        error={trade.state.error}
        explorerUrl={trade.state.status?.explorerUrl ?? trade.state.submit?.explorerUrl ?? null}
        details={{
          quote: q ? `${fmtUsdc(q.amountUsdc)} USDC → ≈ ${fmtNum(toNum(q.shares), 2)} ${q.side.toUpperCase()} shares` : "Debounced while you type",
          review: consent ? "Consent given" : "Read the summary and tick the box",
          build: trade.state.build ? `Built by Epoch · ${shortKey(trade.state.build.tradeId, 6, 4)}` : "Epoch's API compiles Panta's order; you are the only signer",
          sign: trade.state.phase === "signing" ? `Waiting for ${wallet.wallet?.adapter.name ?? "the wallet"}` : "Signed unchanged",
          submit: trade.state.submit ? `Broadcast by ${trade.state.submit.broadcastBy === "epoch" ? "Epoch" : "your wallet"} · ${shortKey(trade.state.submit.signature, 4, 4)}` : "Epoch broadcasts and tells Panta",
          confirmed:
            trade.state.status?.attribution === "processed"
              ? "Confirmed · Panta credited the trade to Epoch"
              : trade.state.phase === "timeout"
                ? "Not confirmed yet"
                : "Confirmed on Solana mainnet",
        }}
      />
      {trade.state.phase === "done" || trade.state.phase === "failed" || trade.state.phase === "timeout" ? (
        <Button variant="outline" onClick={() => trade.reset()}>
          {trade.state.phase === "done" ? "Buy more" : "Start again"}
        </Button>
      ) : null}
    </section>
  );
}
