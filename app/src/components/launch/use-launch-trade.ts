"use client";
// Launch trades (docs/pages/launch.md "The buy/sell ticket"): the API builds an unsigned legacy transaction (a Meteora
// DBC swap on the curve, a DAMM v2 swap after graduation), the wallet signs it, and this page sends it on the launch
// cluster's RPC and confirms it against the build's blockhash. The API never signs or sends. Redeem (the fallback) is
// built here with @epoch/epoch-sdk and sent on the program's cluster the same way.

import { base64Decode } from "@epoch/epoch-sdk";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TxStep } from "@/components/tx/tx-stepper";
import { ApiError } from "@/lib/api/client";
import { env } from "@/lib/env";

export type LaunchPhase = "idle" | "building" | "signing" | "sending" | "confirming" | "done" | "failed";

export interface LaunchTxState {
  phase: LaunchPhase;
  failedAt: TxStep | null;
  error: string | null;
  code: string | null;
  signature: string | null;
  explorerCluster: string | null;
}

const INITIAL: LaunchTxState = { phase: "idle", failedAt: null, error: null, code: null, signature: null, explorerCluster: null };

/** One Connection per RPC URL for the page's lifetime. */
const connections = new Map<string, Connection>();
export function rpc(url: string): Connection {
  let c = connections.get(url);
  if (!c) {
    c = new Connection(url, "confirmed");
    connections.set(url, c);
  }
  return c;
}

/** Words for the ticket's error codes (the contract's table) and for wallet and chain failures. */
export function launchErrorWords(error: unknown): { text: string; code: string | null } {
  if (error instanceof ApiError) {
    const c = error.code;
    const d = error.details ?? {};
    const words: Record<string, string> = {
      CONSENT_REQUIRED: "Tick the box first: nothing is built without it.",
      AMOUNT_TOO_LARGE: d.maxSol !== undefined ? `Buys are capped at ${String(d.maxSol)} SOL while the demo runs.` : error.message,
      AMOUNT_TOO_SMALL: "That amount rounds to nothing. Try a little more.",
      BAD_REQUEST: error.message || "The request was not valid.",
      NOT_LAUNCHED: "There is no pool for this token yet.",
      NOT_OPEN: error.message || "The pool has not opened yet.",
      CURVE_COMPLETE: "Raise complete: graduating to DAMM v2. Back in minutes.",
      NOT_TRADING: "The pool is not trading right now.",
      WRONG_TOKEN: "This pool does not trade this token.",
      INSUFFICIENT_LIQUIDITY: "The pool can't fill that. Try a smaller amount.",
      TOO_MANY_REQUESTS: `Too many requests. Try again in ${error.retryAfterSeconds ?? 30} s.`,
      NOT_FOUND: "This token is not listed.",
    };
    return { text: words[c] ?? `${error.message || "Something went wrong"} (${c}).`, code: c };
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (/reject|denied|cancel|declined/i.test(msg)) return { text: "You declined in the wallet. Nothing was signed and nothing moved.", code: "WALLET_REJECTED" };
  if (/block ?height exceeded|expired/i.test(msg)) return { text: "The transaction expired before it landed. Get a new quote and try again.", code: "EXPIRED" };
  if (/slippage|ExceededSlippage|0x1771|minimum/i.test(msg)) return { text: "The price moved past your limit. Nothing was traded.", code: "SLIPPAGE" };
  if (/insufficient (funds|lamports)/i.test(msg)) return { text: "Not enough SOL in the wallet for this and its fee.", code: "INSUFFICIENT_FUNDS" };
  return { text: msg || "Something went wrong.", code: null };
}

export interface BuiltTx {
  transaction: Transaction;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Where to send it: the launch RPC (swaps) or the program's RPC (redeem). */
  rpcUrl: string;
  explorerCluster: string | null;
}

/** Build → sign → send → confirm, with the state the stepper shows. */
export function useLaunchTx(onConfirmed?: (signature: string) => void) {
  const wallet = useWallet();
  const [state, setState] = useState<LaunchTxState>(INITIAL);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const set = (patch: Partial<LaunchTxState>) => alive.current && setState((s) => ({ ...s, ...patch }));

  const run = useCallback(
    async (build: () => Promise<BuiltTx>) => {
      let at: TxStep = "build";
      setState({ ...INITIAL, phase: "building" });
      try {
        const b = await build();
        set({ phase: "signing", explorerCluster: b.explorerCluster });
        at = "sign";
        const connection = rpc(b.rpcUrl);
        let signature: string;
        if (wallet.signTransaction) {
          const signed = await wallet.signTransaction(b.transaction);
          set({ phase: "sending" });
          at = "submit";
          signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
        } else {
          signature = await wallet.sendTransaction(b.transaction, connection);
          at = "submit";
        }
        set({ phase: "confirming", signature });
        at = "confirmed";
        const res = await connection.confirmTransaction({ signature, blockhash: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight }, "confirmed");
        if (res.value.err) throw new Error(`The transaction failed on chain: ${JSON.stringify(res.value.err)}`);
        set({ phase: "done" });
        onConfirmed?.(signature);
      } catch (e) {
        const { text, code } = launchErrorWords(e);
        set({ phase: "failed", failedAt: at, error: text, code });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallet, onConfirmed],
  );
  const reset = useCallback(() => setState(INITIAL), []);
  return { state, run, reset };
}

/** A legacy transaction from the API's base64. */
export const decodeLegacyTx = (b64: string) => Transaction.from(base64Decode(b64));

/** The connected wallet's SOL and token balances on the launch cluster (for the chips and the "more than you hold" check). */
export function useLaunchBalances(mint: string | null, owner: string | null, enabled: boolean) {
  const qc = useQueryClient();
  const key = useMemo(() => ["launch-balances", env.launchRpcUrl, mint, owner], [mint, owner]);
  const q = useQuery({
    queryKey: key,
    enabled: enabled && !!mint && !!owner,
    refetchInterval: 30_000,
    queryFn: async () => {
      const c = rpc(env.launchRpcUrl);
      const ownerKey = new PublicKey(owner!);
      const [lamports, accounts] = await Promise.all([
        c.getBalance(ownerKey, "confirmed"),
        c.getParsedTokenAccountsByOwner(ownerKey, { mint: new PublicKey(mint!) }, "confirmed"),
      ]);
      const raw = accounts.value.reduce((a, acc) => a + BigInt((acc.account.data.parsed?.info?.tokenAmount?.amount as string | undefined) ?? "0"), 0n);
      const decimals = (accounts.value[0]?.account.data.parsed?.info?.tokenAmount?.decimals as number | undefined) ?? null;
      const ui = accounts.value.reduce((a, acc) => a + Number(acc.account.data.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
      return { sol: lamports / 1e9, tokens: ui, rawTokens: raw, decimals };
    },
  });
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: key }), [qc, key]);
  return { ...q, refresh };
}
