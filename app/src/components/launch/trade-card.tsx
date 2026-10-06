"use client";
// LP20–LP27: the Trade card (Wealthsimple's sticky Buy card; Reown's swap preview for the review; Coinbase's gate).
//   Buy · Sell (· Redeem when the escrow is in redeem mode) → amount and chips → a quote from POST /quote (debounced to
//   one a second; the API allows 30 quotes and builds a minute) → Review: the rows, the API's warnings verbatim and a
//   consent tick → POST /build (consent: true, the reviewed minimumOut) → the wallet signs → this page sends it on the
//   launch cluster and confirms it → the trade shows as pending until its WS `trade` frame arrives.
// Redeem burns tokens for their share of the buyback escrow: the payout is estimated on chain with @epoch/epoch-sdk
// (`redeemPayout` over `circulatingSupply`) and the instruction is built here (`redeem`).

import {
  circulatingSupply,
  findAssociatedTokenAddress,
  findBuybackEscrowPda,
  findBuybackTokensPda,
  findTreasuryTokensAddress,
  redeem,
  redeemPayout,
} from "@epoch/epoch-sdk";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Eye, EyeOff, Lock, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";

import { PriceText } from "@/components/data/primitives";
import { TradeGate, useTradeGate } from "@/components/tx/trade-gate";
import { TxStepper, type TxStep } from "@/components/tx/tx-stepper";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useConnectDialog } from "@/components/wallet/connect";
import { apiPost } from "@/lib/api/client";
import type { LaunchBuildResponse, LaunchBuybackFeed, LaunchPage, LaunchQuoteResponse } from "@/lib/data/types";
import { env } from "@/lib/env";
import { clusterLabel, explorerTx } from "@/lib/explorers";
import { fmtEpoch, fmtNum, fmtPct, fmtSolValue, fmtTokens, shortKey, toNum } from "@/lib/format";
import { cn } from "@/lib/utils";

import { decodeLegacyTx, launchErrorWords, rpc, useLaunchBalances, useLaunchTx } from "./use-launch-trade";

export type TradeSide = "buy" | "sell" | "redeem";
const SLIPPAGE_BPS = 100;
const SIG_FEE_SOL = 0.000005;

function Row({ label, children, tone }: { label: string; children: React.ReactNode; tone?: "warn" | "accent" }) {
  return (
    <>
      <dt className="text-ep-muted">{label}</dt>
      <dd className={cn("num text-right text-ep-text", tone === "warn" && "text-ep-warn", tone === "accent" && "text-ep-accent")}>{children}</dd>
    </>
  );
}

function Locked({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-ep-line-strong bg-ep-inset p-4 text-sm text-ep-text-2">
      <Lock className="mt-0.5 size-4 shrink-0 text-ep-muted" aria-hidden />
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

export function TradeCard({
  page,
  feed,
  sample,
  side,
  onSide,
  watched,
  onWatch,
  onPending,
  onBusy,
  idPrefix = "trade",
  inSheet = false,
}: {
  page: LaunchPage;
  feed: LaunchBuybackFeed | null | undefined;
  sample: boolean;
  side: TradeSide;
  onSide: (s: TradeSide) => void;
  watched: boolean;
  onWatch: () => void;
  /** The signature of a sent trade, until its row arrives in the feed. */
  onPending: (signature: string | null) => void;
  onBusy?: (busy: boolean) => void;
  idPrefix?: string;
  /** Inside the phone's bottom sheet: the sheet carries the title and the frame. */
  inSheet?: boolean;
}) {
  const wallet = useWallet();
  const address = wallet.publicKey?.toBase58() ?? null;
  const showConnect = useConnectDialog((s) => s.show);
  const gate = useTradeGate("launch", address);
  const { market, launch, network } = page;
  const mint = launch.mint;
  const symbol = launch.symbol;
  const cluster = clusterLabel(network);
  const redeemMode = (feed?.escrow.mode ?? page.detail.escrow.mode) === "redeem" && !feed?.closed;
  const effectiveSide: TradeSide = side === "redeem" && !redeemMode ? "buy" : side;
  const isRedeem = effectiveSide === "redeem";

  const [amounts, setAmounts] = useState<Record<TradeSide, string>>({ buy: "0.1", sell: "", redeem: "" });
  const amount = amounts[effectiveSide];
  const setAmount = (v: string) => setAmounts((a) => ({ ...a, [effectiveSide]: v.replace(/[^0-9.]/g, "") }));
  const [debounced] = useDebounceValue(amount, 1000);
  const amt = toNum(debounced);
  const [stage, setStage] = useState<"edit" | "review">("edit");
  const [consent, setConsent] = useState(false);
  const [built, setBuilt] = useState<LaunchBuildResponse | null>(null);

  const balances = useLaunchBalances(mint, address, !sample);
  const tokenBalance = balances.data?.tokens ?? null;
  const solBalance = balances.data?.sol ?? null;

  const tx = useLaunchTx((signature) => {
    balances.refresh();
    toast.success(isRedeem ? "Redeemed" : "Trade confirmed", {
      description: `${cluster} · ${shortKey(signature, 6, 6)}`,
      action: { label: "Explorer", onClick: () => window.open(explorerTx(signature, tx.state.explorerCluster ?? network), "_blank", "noopener") },
    });
  });
  const busy = tx.state.phase !== "idle" && tx.state.phase !== "done" && tx.state.phase !== "failed";
  useEffect(() => onBusy?.(busy), [busy, onBusy]);
  useEffect(() => onPending(tx.state.signature && tx.state.phase !== "failed" ? tx.state.signature : null), [tx.state.signature, tx.state.phase, onPending]);
  const inFeed = !!tx.state.signature && page.trades.some((t) => t.signature === tx.state.signature);

  // A side switch or a new amount starts over.
  useEffect(() => {
    setStage("edit");
    setConsent(false);
  }, [effectiveSide, debounced]);

  const graduating = market.graduation.state === "complete";
  // An unreadable pool comes back as an upcoming-looking block with `freshness.asOf: null`: it is not "upcoming".
  const marketUnknown = market.freshness.asOf === null;
  const upcoming = !marketUnknown && (market.status === "upcoming" || market.graduation.state === "upcoming");
  const blocked = ((): string | null => {
    if (sample) return "Sample data: trading needs the live Epoch API.";
    if (!mint) return "This token has no mint yet.";
    if (isRedeem) {
      if (!env.epochProgramId) return "Redeem needs this app's Epoch program id (NEXT_PUBLIC_EPOCH_PROGRAM_ID), which is not set.";
      if (!(launch.validator.vote ?? feed?.vote)) return "Redeem needs the validator's vote account, which is not known for this token.";
      return null;
    }
    if (marketUnknown) return "The pool can't be read right now, so there is no price to quote. Try again in a minute.";
    if (graduating) return "Raise complete: graduating to DAMM v2. Back in minutes.";
    if (market.venue === null) return "Trading is not open right now.";
    return null;
  })();

  const unit = effectiveSide === "buy" ? "SOL" : symbol;
  const amountError =
    amount === ""
      ? null
      : amt === null || amt <= 0
        ? `Enter an amount in ${unit}.`
        : effectiveSide === "buy" && solBalance !== null && amt > Math.max(0, solBalance - 0.01)
          ? `More than your wallet can spend (${fmtSolValue(solBalance)} SOL, less fees).`
          : effectiveSide !== "buy" && tokenBalance !== null && amt > tokenBalance
            ? tokenBalance === 0
              ? `You have no ${symbol}.`
              : `You have ${fmtTokens(tokenBalance)} ${symbol}.`
            : null;

  // ── Buy / sell quote ─────────────────────────────────────────────────────────────
  const quote = useQuery({
    queryKey: ["launch-quote", mint, effectiveSide, debounced],
    enabled: !blocked && !isRedeem && !upcoming && amt !== null && amt > 0 && !amountError && tx.state.phase === "idle",
    queryFn: () => apiPost<LaunchQuoteResponse>(`/v1/launches/${mint}/quote`, { side: effectiveSide, amount: amt, slippageBps: SLIPPAGE_BPS }),
    retry: false,
    refetchInterval: (q) => (q.state.data && tx.state.phase === "idle" ? q.state.data.validForSeconds * 1000 : false),
    staleTime: 5_000,
  });
  const q = quote.data;
  const quoteError = quote.error ? launchErrorWords(quote.error).text : null;
  // A fresh quote during review needs a fresh tick.
  useEffect(() => setConsent(false), [q?.asOf]);

  // ── Redeem estimate (on chain, epoch-sdk) ──────────────────────────────────────────
  const vote = launch.validator.vote ?? feed?.vote ?? null;
  const decimals = balances.data?.decimals ?? page.detail.token.decimals;
  const estimate = useQuery({
    queryKey: ["launch-redeem-estimate", mint, vote, debounced],
    enabled: !blocked && isRedeem && amt !== null && amt > 0 && !amountError && tx.state.phase === "idle",
    retry: false,
    queryFn: async () => {
      const programId = new PublicKey(env.epochProgramId!);
      const mintKey = new PublicKey(mint!);
      const voteKey = new PublicKey(vote!);
      const c = rpc(env.epochRpcUrl);
      const treasuryTokens = findTreasuryTokensAddress(programId, mintKey);
      const [supply, escrowLamports, rent, bought, treasury] = await Promise.all([
        c.getTokenSupply(mintKey),
        c.getBalance(findBuybackEscrowPda(programId, voteKey)[0]),
        c.getMinimumBalanceForRentExemption(0),
        c.getTokenAccountBalance(findBuybackTokensPda(programId, voteKey)[0]).catch(() => null),
        c.getTokenAccountBalance(treasuryTokens).catch(() => null),
      ]);
      const held = BigInt(bought?.value.amount ?? "0") + BigInt(treasury?.value.amount ?? "0");
      const circulating = circulatingSupply(BigInt(supply.value.amount), held);
      const available = BigInt(Math.max(0, escrowLamports - rent));
      const raw = BigInt(Math.floor(amt! * 10 ** supply.value.decimals));
      const payout = circulating > 0n ? redeemPayout(available, raw, circulating) : 0n;
      return {
        payoutSol: Number(payout) / 1e9,
        escrowSol: Number(available) / 1e9,
        circulating: Number(circulating) / 10 ** supply.value.decimals,
        raw,
        treasuryTokens: treasury ? treasuryTokens.toBase58() : null,
      };
    },
  });
  const est = estimate.data;
  const estimateError = estimate.error ? launchErrorWords(estimate.error).text : null;

  const canReview = !!address && gate.ok && !blocked && !amountError && (isRedeem ? !!est && est.payoutSol > 0 : !!q);

  const sign = () => {
    if (!address || !mint) return;
    if (isRedeem) {
      if (!est || !vote) return;
      void tx.run(async () => {
        const programId = new PublicKey(env.epochProgramId!);
        const holder = new PublicKey(address);
        const mintKey = new PublicKey(mint);
        const c = rpc(env.epochRpcUrl);
        const latest = await c.getLatestBlockhash("confirmed");
        const ixs = redeem({
          programId,
          holder,
          holderTokens: findAssociatedTokenAddress(holder, mintKey),
          vote: new PublicKey(vote),
          mint: mintKey,
          treasuryTokens: est.treasuryTokens ? new PublicKey(est.treasuryTokens) : null,
          amount: est.raw,
        });
        const transaction = new Transaction({ feePayer: holder, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }).add(...ixs);
        return { transaction, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, rpcUrl: env.epochRpcUrl, explorerCluster: network === "mainnet" ? null : network };
      });
      return;
    }
    if (!q) return;
    void tx.run(async () => {
      const b = await apiPost<LaunchBuildResponse>(`/v1/launches/${mint}/build`, {
        side: effectiveSide,
        amount: amt,
        slippageBps: SLIPPAGE_BPS,
        owner: address,
        minimumOut: q.quote.minimumOut,
        consent: true,
      });
      setBuilt(b);
      return { transaction: decodeLegacyTx(b.transaction), blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight, rpcUrl: env.launchRpcUrl, explorerCluster: b.explorerCluster };
    });
  };

  const startOver = () => {
    tx.reset();
    setBuilt(null);
    setStage("edit");
    setConsent(false);
  };

  const step: { current: TxStep; status: "idle" | "working" | "error" | "done" } = (() => {
    switch (tx.state.phase) {
      case "idle":
        if (isRedeem ? !est : !q) return { current: "quote", status: quote.isFetching || estimate.isFetching ? "working" : "idle" };
        return { current: stage === "review" && consent ? "build" : "review", status: "idle" };
      case "building":
        return { current: "build", status: "working" };
      case "signing":
        return { current: "sign", status: "working" };
      case "sending":
        return { current: "submit", status: "working" };
      case "confirming":
        return { current: "confirmed", status: "working" };
      case "done":
        return { current: "confirmed", status: "done" };
      case "failed":
        return { current: tx.state.failedAt ?? "build", status: "error" };
    }
  })();

  const chips = effectiveSide === "buy" ? ["0.1", "0.5", "1"] : ["25%", "50%", "Max"];
  const pickChip = (c: string) => {
    if (effectiveSide === "buy") return setAmount(c);
    if (!tokenBalance) return;
    const share = c === "Max" ? 1 : Number(c.replace("%", "")) / 100;
    const dp = Math.min(6, decimals);
    setAmount(String(Math.floor(tokenBalance * share * 10 ** dp) / 10 ** dp));
  };

  const impact = q?.quote.priceImpactPct ?? null;
  const youSend = isRedeem ? `${fmtTokens(amt)} ${symbol}` : q ? (q.quote.side === "buy" ? `${fmtSolValue(q.quote.amountIn)} SOL` : `${fmtTokens(q.quote.amountIn)} ${symbol}`) : "—";
  const youGet = isRedeem ? (est ? `≈ ${fmtSolValue(est.payoutSol)} SOL` : "—") : q ? (q.quote.side === "buy" ? `≈ ${fmtTokens(q.quote.amountOut)} ${symbol}` : `≈ ${fmtSolValue(q.quote.amountOut)} SOL`) : "—";
  const atLeast = q ? (q.quote.side === "buy" ? `${fmtTokens(q.quote.minimumOut)} ${symbol}` : `${fmtSolValue(q.quote.minimumOut)} SOL`) : "—";
  const avgPrice = q && q.quote.amountOut ? (q.quote.side === "buy" ? q.quote.amountIn / q.quote.amountOut : q.quote.amountOut / q.quote.amountIn) : null;
  const venueWords = (v: "dbc" | "damm-v2" | null | undefined) => (v === "dbc" ? "Meteora curve (DBC)" : v === "damm-v2" ? "Meteora DAMM v2" : "—");
  const networkFee = built?.priorityFeeSol !== undefined ? `≤ ${fmtSolValue(built.priorityFeeSol + SIG_FEE_SOL)} SOL` : `${fmtSolValue(SIG_FEE_SOL)} SOL + priority fee`;

  const sides: TradeSide[] = redeemMode ? ["buy", "sell", "redeem"] : ["buy", "sell"];
  const label = { buy: "Buy", sell: "Sell", redeem: "Redeem" } as const;

  return (
    <section aria-labelledby={`${idPrefix}-title`} className={cn("flex flex-col gap-4", !inSheet && "rounded-lg border border-ep-line bg-ep-raised p-5")}>
      <div className={cn("flex items-center justify-between gap-2", inSheet && "sr-only")}>
        <h2 id={`${idPrefix}-title`} className="text-base font-semibold text-ep-text">
          Trade {symbol}
        </h2>
        <span className="text-xs text-ep-muted">{venueWords(market.venue)}</span>
      </div>

      {upcoming ? (
        <div className="flex flex-col gap-3 rounded-md border border-ep-line-strong bg-ep-inset p-4 text-sm text-ep-text-2">
          <p>
            {launch.opensAtEpoch !== null ? `Opens in epoch ${fmtEpoch(launch.opensAtEpoch)}.` : "Not open yet."} The curve&apos;s band is <PriceText value={launch.bandLowSol} />–<PriceText value={launch.bandHighSol} /> SOL.
          </p>
          <Button variant="outline" aria-pressed={watched} onClick={onWatch}>
            {watched ? <EyeOff aria-hidden /> : <Eye aria-hidden />} {watched ? "Watching" : "Watch"}
          </Button>
        </div>
      ) : (
        <>
          <ToggleGroup
            value={[effectiveSide]}
            onValueChange={(v: string[]) => v[0] && onSide(v[0] as TradeSide)}
            className={cn("grid w-full", sides.length === 3 ? "grid-cols-3" : "grid-cols-2")}
            aria-label="Side"
            disabled={busy}
          >
            {sides.map((s) => (
              <ToggleGroupItem
                key={s}
                value={s}
                className={cn(
                  "h-11",
                  s === "buy" && "aria-pressed:bg-ep-accent aria-pressed:text-ep-accent-ink",
                  s === "sell" && "aria-pressed:bg-ep-warn aria-pressed:text-ep-accent-ink",
                  s === "redeem" && "aria-pressed:bg-ep-info aria-pressed:text-ep-accent-ink",
                )}
              >
                {label[s]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {blocked ? (
            <Locked>
              <p>{blocked}</p>
            </Locked>
          ) : address && !gate.ok ? (
            <TradeGate
              id={`${idPrefix}-gate`}
              regionLine="Buying a validator revenue token is allowed where I live"
              note={`${cluster === "Mainnet" ? "Real SOL." : `${cluster} demo.`} Revenue tokens can be securities in many countries; nothing here is an offer.`}
              onPass={gate.pass}
            />
          ) : stage === "edit" || tx.state.phase === "idle" ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${idPrefix}-amount`} className="flex justify-between text-sm text-ep-text-2">
                  <span>{effectiveSide === "buy" ? "You spend" : effectiveSide === "sell" ? "You sell" : "You burn"}</span>
                  <span className="num text-xs text-ep-muted">
                    {address
                      ? effectiveSide === "buy"
                        ? solBalance !== null
                          ? `${fmtSolValue(solBalance)} SOL in wallet`
                          : ""
                        : tokenBalance !== null
                          ? `${fmtTokens(tokenBalance)} ${symbol} in wallet`
                          : ""
                      : ""}
                  </span>
                </Label>
                <div className="relative">
                  <Input
                    id={`${idPrefix}-amount`}
                    inputMode="decimal"
                    placeholder="0"
                    value={amount}
                    disabled={busy || stage === "review"}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-invalid={amountError ? true : undefined}
                    aria-describedby={`${idPrefix}-amount-help`}
                    className="num h-12 pr-20 text-lg"
                  />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-ep-muted">{unit}</span>
                </div>
                <div className="flex gap-2">
                  {chips.map((c) => (
                    <Button
                      key={c}
                      type="button"
                      variant={amount === c ? "secondary" : "outline"}
                      size="xs"
                      className="flex-1"
                      disabled={busy || stage === "review" || (effectiveSide !== "buy" && !tokenBalance)}
                      onClick={() => pickChip(c)}
                    >
                      {effectiveSide === "buy" ? `${c} SOL` : c}
                    </Button>
                  ))}
                </div>
                <p
                  id={`${idPrefix}-amount-help`}
                  className={cn("text-xs", amountError || quoteError || estimateError ? "text-ep-warn" : "text-ep-muted")}
                  role={amountError || quoteError || estimateError ? "alert" : undefined}
                >
                  {amountError ??
                    (isRedeem ? estimateError : quoteError) ??
                    (isRedeem ? `Burn ${symbol} for its share of the buyback escrow.` : `Quotes refresh every ${q?.validForSeconds ?? 15} s. 1% slippage.`)}
                </p>
              </div>

              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-ep-line bg-ep-inset p-3 text-sm">
                {isRedeem ? (
                  <>
                    <Row label="You get (≈)" tone="accent">
                      {est ? `${fmtSolValue(est.payoutSol)} SOL` : estimate.isFetching ? "estimating…" : "—"}
                    </Row>
                    <Row label="Escrow">{est ? `${fmtSolValue(est.escrowSol)} SOL` : "—"}</Row>
                    <Row label="Circulating">{est ? `${fmtTokens(est.circulating)} ${symbol}` : "—"}</Row>
                  </>
                ) : (
                  <>
                    <Row label="You get (≈)" tone="accent">
                      {q ? youGet.replace("≈ ", "") : quote.isFetching ? "quoting…" : "—"}
                    </Row>
                    <Row label={`At least (${fmtPct(SLIPPAGE_BPS / 100, 2)} slippage)`}>{atLeast}</Row>
                    <Row label="Price impact" tone={impact !== null && impact > 5 ? "warn" : undefined}>
                      {impact !== null ? `${fmtNum(impact, 2)}%${impact > 5 ? " · large for this pool" : ""}` : "—"}
                    </Row>
                    <Row label="Trading fee">{q ? `${fmtSolValue(q.quote.tradingFeeSol)} SOL` : "—"}</Row>
                    <Row label="Venue">{q ? venueWords(q.quote.venue) : venueWords(market.venue)}</Row>
                  </>
                )}
              </dl>
              {q && q.quote.side === "buy" && amt !== null && q.quote.amountIn < amt - 1e-9 ? (
                <p className="text-xs text-ep-info">This buy completes the raise: only {fmtSolValue(q.quote.amountIn)} SOL is used.</p>
              ) : null}

              {!address ? (
                <Button size="lg" className="w-full" onClick={() => showConnect("connect")}>
                  Connect a wallet
                </Button>
              ) : stage === "edit" ? (
                <Button size="lg" className="w-full" disabled={!canReview || busy} onClick={() => setStage("review")}>
                  Review {label[effectiveSide].toLowerCase()}
                </Button>
              ) : null}
              {stage === "review" && tx.state.phase === "idle" ? (
                <Review
                  idPrefix={idPrefix}
                  cluster={cluster}
                  rows={
                    isRedeem
                      ? [
                          ["You burn", youSend],
                          ["You get (≈)", youGet],
                          ["Escrow now", est ? `${fmtSolValue(est.escrowSol)} SOL` : "—"],
                          ["Network fee", `${fmtSolValue(SIG_FEE_SOL)} SOL`],
                        ]
                      : [
                          ["You send", youSend],
                          ["You get at least", atLeast],
                          ["Price", avgPrice !== null ? <PriceText key="p" value={avgPrice} unit="SOL" /> : "—"],
                          ["Price impact", impact !== null ? `${fmtNum(impact, 2)}%` : "—"],
                          ["Trading fee", q ? `${fmtSolValue(q.quote.tradingFeeSol)} SOL` : "—"],
                          ["Venue", q ? venueWords(q.quote.venue) : "—"],
                          ["Network fee", networkFee],
                        ]
                  }
                  warnings={isRedeem ? [] : q?.warnings ?? []}
                  consent={consent}
                  onConsent={setConsent}
                  onCancel={() => {
                    setStage("edit");
                    setConsent(false);
                  }}
                  onSign={sign}
                  canSign={consent && (isRedeem ? !!est : !!q)}
                />
              ) : null}
            </>
          ) : null}

          {tx.state.phase !== "idle" ? (
            <div className="flex flex-col gap-3">
              {tx.state.phase === "done" ? (
                <p className="rounded-md border border-ep-accent-line bg-ep-accent-soft p-3 text-sm text-ep-text" role="status">
                  {isRedeem ? `Burned ${youSend} for ${youGet.replace("≈ ", "about ")}.` : `${label[effectiveSide]} confirmed: ${youGet.replace("≈ ", "about ")}.`}{" "}
                  {inFeed ? "It is in the trade feed." : isRedeem ? "" : "It shows in the trade feed within a few seconds."}
                </p>
              ) : null}
              {tx.state.phase === "failed" ? (
                <p className="flex items-start gap-2 text-sm text-ep-warn" role="alert">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {tx.state.error}
                </p>
              ) : null}
              {tx.state.phase === "done" || tx.state.phase === "failed" ? (
                <Button variant="outline" onClick={startOver}>
                  {tx.state.phase === "done" ? "Done" : (
                    <>
                      <RefreshCw aria-hidden /> Quote again
                    </>
                  )}
                </Button>
              ) : null}
            </div>
          ) : null}

          <TxStepper
            current={step.current}
            status={step.status}
            error={tx.state.error}
            explorerUrl={tx.state.signature ? explorerTx(tx.state.signature, tx.state.explorerCluster ?? (network === "mainnet" ? null : network)) : null}
            titles={{ build: isRedeem ? "Build (epoch-sdk)" : "Build (Epoch API)", submit: `Send on ${cluster}`, confirmed: `Confirmed on ${cluster}` }}
            details={{
              quote: isRedeem
                ? est
                  ? `${youSend} → ${youGet}`
                  : "Estimated on chain from the escrow and circulating supply"
                : q
                  ? `${youSend} → ${youGet}`
                  : "Debounced while you type",
              review: consent ? "Consent given" : "Check the rows and tick the box",
              build: isRedeem ? "redeem() from @epoch/epoch-sdk, built in this page" : built ? `Built for ${shortKey(built.feePayer)}` : "Epoch's API builds the Meteora swap; you are the only signer",
              sign: tx.state.phase === "signing" ? `Waiting for ${wallet.wallet?.adapter.name ?? "the wallet"}` : "Your wallet signs; nothing moves before",
              submit: tx.state.signature ? shortKey(tx.state.signature, 6, 6) : `This page sends it to the ${cluster.toLowerCase()} RPC`,
              confirmed: tx.state.phase === "done" ? (isRedeem || inFeed ? "Confirmed" : `Waiting for the trade feed (${page.ingest.mode === "polling" ? `up to ${page.ingest.pollSeconds ?? 10} s` : "about a second"})`) : "Confirmed against the build's blockhash",
            }}
          />
        </>
      )}

      <p className="text-xs leading-relaxed text-ep-muted">
        {network === "mainnet" ? "Real SOL on Solana mainnet." : `${cluster} demo: no real value.`} Revenue tokens can be securities in many countries; nothing here is an offer.
      </p>
    </section>
  );
}

function Review({
  idPrefix,
  cluster,
  rows,
  warnings,
  consent,
  onConsent,
  onCancel,
  onSign,
  canSign,
}: {
  idPrefix: string;
  cluster: string;
  rows: [string, React.ReactNode][];
  warnings: string[];
  consent: boolean;
  onConsent: (v: boolean) => void;
  onCancel: () => void;
  onSign: () => void;
  canSign: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-ep-line-strong p-3" aria-labelledby={`${idPrefix}-review-title`} role="group">
      <p id={`${idPrefix}-review-title`} className="text-sm font-medium text-ep-text">
        Review
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        {rows.map(([k, v]) => (
          <Row key={k} label={k}>
            {v}
          </Row>
        ))}
      </dl>
      {warnings.length ? (
        <ul className="flex flex-col gap-1 rounded-md border border-ep-warn-line bg-ep-warn-soft p-2 text-xs text-ep-text-2">
          {warnings.map((w) => (
            <li key={w} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-ep-warn" aria-hidden />
              {w}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-ep-muted">Review carefully. Nothing moves until you sign.</p>
      <label htmlFor={`${idPrefix}-consent`} className="flex cursor-pointer items-start gap-3 text-sm text-ep-text">
        <Checkbox id={`${idPrefix}-consent`} checked={consent} onCheckedChange={(v) => onConsent(v === true)} className="mt-0.5" />
        <span>{cluster === "Mainnet" ? "I understand this trade moves real SOL and nothing here is an offer" : `I understand this is a ${cluster.toLowerCase()} demo and nothing here is an offer`}</span>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!canSign} onClick={onSign}>
          Sign in wallet
        </Button>
      </div>
    </div>
  );
}
