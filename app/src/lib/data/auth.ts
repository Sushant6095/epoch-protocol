"use client";
// Sign In With Solana against the API's /v1/auth routes (packages/api_app/src/Routes/AccountRouters.ts):
//   POST /v1/auth/siws/nonce → the wallet signs the SIWS message (Wallet Standard `solana:signIn`, or signMessage on
//   the same text for wallets without it) → POST /v1/auth/siws/verify { message, signature, address } sets the
//   session cookie → GET /v1/auth/session. A message, never a transaction: no SOL moves.

import { base58Encode } from "@epoch/epoch-sdk";
import type { WalletContextState } from "@solana/wallet-adapter-react";
import { useQueryClient } from "@tanstack/react-query";

import { apiPost } from "@/lib/api/client";

import { apiKey, useEpochQuery } from "./query";
import type { SessionView, SiwsNonce } from "./types";

export function useSession() {
  return useEpochQuery<SessionView | null>({
    key: ["auth", "session"],
    path: "/v1/auth/session",
    sample: () => null,
    refetchInterval: 5 * 60_000,
  });
}

export interface SiwsInput {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: "1";
  chainId: "mainnet";
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

/** The fields the wallet will sign, from a fresh nonce. */
export function siwsInput(nonce: SiwsNonce, address: string): SiwsInput {
  return {
    domain: window.location.host,
    address,
    statement: nonce.statement,
    uri: window.location.origin,
    version: "1",
    chainId: "mainnet",
    nonce: nonce.nonce,
    issuedAt: nonce.issuedAt,
    expirationTime: nonce.expirationTime,
  };
}

/** The exact SIWS text (the API's parser: header, address, statement, then the fields in order). */
export function siwsMessage(i: SiwsInput): string {
  return [
    `${i.domain} wants you to sign in with your Solana account:`,
    i.address,
    "",
    i.statement,
    "",
    `URI: ${i.uri}`,
    `Version: ${i.version}`,
    `Chain ID: ${i.chainId}`,
    `Nonce: ${i.nonce}`,
    `Issued At: ${i.issuedAt}`,
    `Expiration Time: ${i.expirationTime}`,
  ].join("\n");
}

export const fetchNonce = () => apiPost<SiwsNonce>("/v1/auth/siws/nonce", {});

/** Ask the wallet to sign `input` and open the session. Throws the wallet's error when the user rejects. */
export async function signInWithSolana(wallet: WalletContextState, input: SiwsInput): Promise<SessionView> {
  if (wallet.signIn) {
    const out = await wallet.signIn({
      domain: input.domain,
      address: input.address,
      statement: input.statement,
      uri: input.uri,
      version: input.version,
      chainId: input.chainId,
      nonce: input.nonce,
      issuedAt: input.issuedAt,
      expirationTime: input.expirationTime,
    });
    return apiPost<SessionView>("/v1/auth/siws/verify", {
      message: new TextDecoder().decode(out.signedMessage),
      signature: base58Encode(out.signature),
      address: out.account.address,
    });
  }
  if (wallet.signMessage) {
    const message = siwsMessage(input);
    const signature = await wallet.signMessage(new TextEncoder().encode(message));
    return apiPost<SessionView>("/v1/auth/siws/verify", { message, signature: base58Encode(signature), address: input.address });
  }
  throw new Error("This wallet can't sign messages, so it can't sign in. Try Phantom, Solflare or Backpack.");
}

export function useSessionActions() {
  const qc = useQueryClient();
  return {
    setSession: (session: SessionView | null) =>
      qc.setQueryData(apiKey("auth", "session"), { data: session, source: "api", receivedAt: Date.now() }),
    signOut: async () => {
      try {
        await apiPost("/v1/auth/logout", {});
      } finally {
        qc.setQueryData(apiKey("auth", "session"), { data: null, source: "api", receivedAt: Date.now() });
      }
    },
  };
}
