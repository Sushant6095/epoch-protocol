"use client";
// Wallets: @solana/wallet-adapter-react with Wallet Standard discovery. Phantom, Solflare and Backpack (and any other
// Wallet Standard wallet) register themselves, so no legacy adapters are bundled; the Connect dialog lists what the
// browser has and links the three to their install pages when they are missing.

import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import type { WalletError } from "@solana/wallet-adapter-base";
import { type ReactNode, useCallback } from "react";

import { env } from "@/lib/env";

export function EpochWalletProvider({ children }: { children: ReactNode }) {
  const onError = useCallback((error: WalletError) => {
    // Rejections and missing wallets are shown where they happen (dialog, ticket); nothing to do globally.
    if (process.env.NODE_ENV !== "production") console.warn("[wallet]", error.name, error.message);
  }, []);
  return (
    <ConnectionProvider endpoint={env.mainnetRpcUrl} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={[]} autoConnect onError={onError} localStorageKey="epoch.wallet">
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
