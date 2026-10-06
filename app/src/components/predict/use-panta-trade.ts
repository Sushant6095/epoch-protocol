"use client";
// Build → sign → submit → status for a Panta buy or claim (docs/pages/predict.md "Buying: step by step"). The wallet
// signs the API's transaction unchanged (the server checks the message hash); Epoch broadcasts it and follows the
// signature until confirmed, failed or expired (polling every 2 s, giving up after 90 s with a "check later" link).

import { base64Decode, base64Encode } from "@epoch/epoch-sdk";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, apiGet, apiPost } from "@/lib/api/client";
import type { PantaBuildView, PantaSubmitView, PantaTradeStatusView } from "@/lib/data/types";

import type { TxStep } from "@/components/tx/tx-stepper";

export type TradePhase = "idle" | "building" | "signing" | "submitting" | "confirming" | "done" | "failed" | "timeout";

export interface TradeState {
  phase: TradePhase;
  failedAt: TxStep | null;
  error: string | null;
  /** The API's error code, for callers that react to it (re-quote, sign in). */
  code: string | null;
  build: PantaBuildView | null;
  submit: PantaSubmitView | null;
  status: PantaTradeStatusView | null;
}

const INITIAL: TradeState = { phase: "idle", failedAt: null, error: null, code: null, build: null, submit: null, status: null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Words for every error code in the contract's state table. */
export function pantaErrorWords(error: unknown): { text: string; code: string | null } {
  if (error instanceof ApiError) {
    const c = error.code;
    const words: Record<string, string> = {
      UNAUTHORIZED: "Sign in to trade: a message in your wallet, no fee.",
      SESSION_REQUIRED: "Sign in to trade: a message in your wallet, no fee.",
      WALLET_MISMATCH: "Sign in with the wallet you are trading from.",
      PANTA_GEO_BLOCKED: "Real-money trading isn't available in your region.",
      PANTA_FORBIDDEN: "Panta does not allow this for this wallet or region.",
      PANTA_TRADING_DISABLED: "Trading is switched off right now. You can still browse.",
      PANTA_NOT_CONFIGURED: "Real-money markets are coming soon.",
      PANTA_MARKET_CLOSED: "Trading has closed on this market.",
      PANTA_QUOTE_EXPIRED: "The quote expired. Here is a fresh one: check it and confirm again.",
      PANTA_QUOTE_STALE: "The price moved. Here is a fresh quote: check it and confirm again.",
      PANTA_AMOUNT_TOO_SMALL: "That amount is too small for this market.",
      PANTA_BUSY: "Busy right now, retrying.",
      PANTA_RATE_LIMITED: "Busy right now, retrying.",
      TOO_MANY_REQUESTS: "Busy right now, retrying.",
      TX_REJECTED: `The network rejected it${error.details?.reason ? `: ${String(error.details.reason)}` : "."}`,
      TX_MODIFIED: "The wallet changed the transaction, so it was not sent. Sign it unchanged.",
      TX_NOT_SIGNED: "The transaction came back unsigned.",
      CONSENT_REQUIRED: "Tick the box to confirm you understand this is a real USDC trade.",
      DATABASE_NOT_CONFIGURED: "Trading needs the API's database, which is not set up on this server.",
    };
    if (c === "PANTA_AMOUNT_OUT_OF_RANGE") {
      const d = error.details ?? {};
      return { text: `Between ${String(d.minUsdc ?? "?")} and ${String(d.maxUsdc ?? "?")} USDC.`, code: c };
    }
    if (error.status === 401) return { text: words.UNAUTHORIZED, code: c };
    return { text: words[c] ?? `Something went wrong (${c}).${error.traceId ? ` Trace ${error.traceId.slice(0, 8)}.` : ""}`, code: c };
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (/reject|denied|cancel/i.test(msg)) return { text: "You declined in the wallet. Nothing was signed and nothing moved.", code: "WALLET_REJECTED" };
  return { text: msg || "Something went wrong.", code: null };
}

export function usePantaTrade(onConfirmed?: (status: PantaTradeStatusView) => void) {
  const wallet = useWallet();
  const { connection } = useConnection();
  const qc = useQueryClient();
  const [state, setState] = useState<TradeState>(INITIAL);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const set = (patch: Partial<TradeState>) => alive.current && setState((s) => ({ ...s, ...patch }));

  const run = useCallback(
    async (build: () => Promise<PantaBuildView>) => {
      let at: TxStep = "build";
      setState({ ...INITIAL, phase: "building" });
      try {
        let b: PantaBuildView;
        try {
          b = await build();
        } catch (e) {
          // Busy: wait what the API says and try once more.
          if (e instanceof ApiError && e.status === 429) {
            await sleep(Math.min(10, e.retryAfterSeconds ?? 3) * 1000);
            b = await build();
          } else throw e;
        }
        set({ build: b, phase: "signing" });
        at = "sign";
        const tx = VersionedTransaction.deserialize(base64Decode(b.transaction));
        let submit: PantaSubmitView;
        if (wallet.signTransaction) {
          const signed = await wallet.signTransaction(tx);
          set({ phase: "submitting" });
          at = "submit";
          submit = await apiPost<PantaSubmitView>("/v1/predict/panta/submit", {
            tradeId: b.tradeId,
            signedTransaction: base64Encode(signed.serialize()),
          });
        } else {
          // Wallets that only sign-and-send: they broadcast, Epoch is told the signature.
          const signature = await wallet.sendTransaction(tx, connection);
          set({ phase: "submitting" });
          at = "submit";
          submit = await apiPost<PantaSubmitView>("/v1/predict/panta/submit", { tradeId: b.tradeId, signature });
        }
        set({ submit, phase: "confirming" });
        at = "confirmed";
        const started = Date.now();
        while (alive.current && Date.now() - started < 90_000) {
          const st = await apiGet<PantaTradeStatusView>(`/v1/predict/panta/status/${encodeURIComponent(b.tradeId)}`);
          set({ status: st });
          if (st.status === "confirmed") {
            set({ phase: "done" });
            void qc.invalidateQueries({ queryKey: ["epoch", "api", "predict", "panta"] });
            onConfirmed?.(st);
            return;
          }
          if (st.status === "failed") throw new Error("The network rejected it. Nothing was traded.");
          if (st.status === "expired") throw new Error("Expired before it landed. Get a new quote and try again.");
          await sleep(2000);
        }
        set({ phase: "timeout", failedAt: "confirmed", error: "Still waiting for the network. It may still land: check it later on the explorer." });
      } catch (e) {
        const { text, code } = pantaErrorWords(e);
        set({ phase: "failed", failedAt: at, error: text, code });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet, connection, qc, onConfirmed],
  );

  const reset = useCallback(() => setState(INITIAL), []);
  return { state, run, reset };
}

/** The stepper's current step and status for a trade state (before the trade starts: quote / review). */
export function stepperFor(state: TradeState, before: { hasQuote: boolean; consent: boolean; quoting: boolean }): { current: TxStep; status: "idle" | "working" | "error" | "done" } {
  switch (state.phase) {
    case "idle":
      if (!before.hasQuote) return { current: "quote", status: before.quoting ? "working" : "idle" };
      return { current: before.consent ? "build" : "review", status: "idle" };
    case "building":
      return { current: "build", status: "working" };
    case "signing":
      return { current: "sign", status: "working" };
    case "submitting":
      return { current: "submit", status: "working" };
    case "confirming":
      return { current: "confirmed", status: "working" };
    case "done":
      return { current: "confirmed", status: "done" };
    case "failed":
    case "timeout":
      return { current: state.failedAt ?? "build", status: "error" };
  }
}
