"use client";
// Connect + Sign In With Solana (click map MS56–MS68, SH8–SH9). One dialog, four steps:
//   wallets → "Continue in <wallet>" → the SIWS message shown in full before the wallet opens → signed in.
// Signing in is a message, never a transaction. Rejections land on a calm "nothing was signed" state. The dialog's
// open state is global so a ticket can ask for sign-in ("Sign in to buy").

import { useWallet, type Wallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { ArrowLeft, Check, ChevronDown, Copy, ExternalLink, LogOut, ShieldCheck, Wallet as WalletIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { create } from "zustand";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorText } from "@/lib/api/client";
import { isSampleMode, useApiStatus } from "@/lib/api/status";
import { fetchNonce, signInWithSolana, siwsInput, siwsMessage, type SiwsInput, useSession, useSessionActions } from "@/lib/data/auth";
import { shortKey } from "@/lib/format";
import { cn } from "@/lib/utils";

type Step = "wallets" | "connecting" | "sign" | "signing" | "done" | "rejected";

interface ConnectStore {
  open: boolean;
  /** "signin": go straight to the message once a wallet is connected. */
  intent: "connect" | "signin";
  show: (intent?: "connect" | "signin") => void;
  hide: () => void;
}

export const useConnectDialog = create<ConnectStore>((set) => ({
  open: false,
  intent: "connect",
  show: (intent = "connect") => set({ open: true, intent }),
  hide: () => set({ open: false }),
}));

const KNOWN: { name: string; url: string }[] = [
  { name: "Phantom", url: "https://phantom.com/download" },
  { name: "Solflare", url: "https://solflare.com/download" },
  { name: "Backpack", url: "https://backpack.app/downloads" },
];

const detected = (w: Wallet) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable;

export function ConnectDialog() {
  const { open, intent, hide } = useConnectDialog();
  const wallet = useWallet();
  const session = useSession();
  const { setSession } = useSessionActions();
  const apiMode = useApiStatus((s) => s.mode);
  const [step, setStep] = useState<Step>("wallets");
  const [pending, setPending] = useState<string | null>(null);
  const [input, setInput] = useState<SiwsInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectedAt, setRejectedAt] = useState<"connect" | "sign">("connect");

  const signedIn = !!session.data?.data && session.data.data.address === wallet.publicKey?.toBase58();
  const sample = isSampleMode(apiMode);

  // Opening: pick the step from where the user already is.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (wallet.connected && signedIn) setStep("done");
    else if (wallet.connected) setStep("sign");
    else setStep("wallets");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The wallet connected (after select): move on to the message.
  useEffect(() => {
    if (open && step === "connecting" && wallet.connected) {
      setStep(intent === "connect" && signedIn ? "done" : "sign");
    }
  }, [open, step, wallet.connected, intent, signedIn]);

  // Prepare the SIWS message (fresh nonce) whenever the sign step shows.
  useEffect(() => {
    if (!open || step !== "sign" || !wallet.publicKey || sample) return;
    let cancelled = false;
    setInput(null);
    setError(null);
    fetchNonce()
      .then((nonce) => !cancelled && setInput(siwsInput(nonce, wallet.publicKey!.toBase58())))
      .catch((e) => !cancelled && setError(`Couldn't start sign-in: ${errorText(e)}`));
    return () => {
      cancelled = true;
    };
  }, [open, step, wallet.publicKey, sample]);

  const wallets = useMemo(() => wallet.wallets.filter(detected), [wallet.wallets]);
  const missing = KNOWN.filter((k) => !wallets.some((w) => w.adapter.name.toLowerCase().startsWith(k.name.toLowerCase())));

  const choose = async (w: Wallet) => {
    setPending(w.adapter.name);
    setError(null);
    setStep("connecting");
    // A rejection in the wallet arrives as the adapter's error event (the provider connects on select).
    const onError = (e: Error) => {
      setRejectedAt("connect");
      setError(errorText(e));
      setStep("rejected");
    };
    w.adapter.once("error", onError);
    try {
      // With autoConnect on, selecting a wallet connects it; an already selected one is connected directly.
      if (wallet.wallet?.adapter.name !== w.adapter.name) wallet.select(w.adapter.name);
      else await wallet.connect();
    } catch (e) {
      onError(e as Error);
    }
  };

  const sign = async () => {
    if (!input) return;
    setStep("signing");
    setError(null);
    try {
      const s = await signInWithSolana(wallet, input);
      setSession(s);
      setStep("done");
      toast.success("Signed in", { description: `${shortKey(s.address)} · no transaction, no fee` });
    } catch (e) {
      setRejectedAt("sign");
      setError(errorText(e));
      setStep("rejected");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : hide())}>
      <DialogContent className="max-w-md">
        {step === "wallets" ? (
          <>
            <DialogHeader>
              <DialogTitle>Connect a wallet</DialogTitle>
              <DialogDescription>Signing in is a message, not a transaction. You approve every action in your wallet.</DialogDescription>
            </DialogHeader>
            <ul className="flex flex-col gap-2">
              {wallets.map((w) => (
                <li key={w.adapter.name}>
                  <button
                    type="button"
                    onClick={() => void choose(w)}
                    className="flex h-14 w-full items-center gap-3 rounded-md border border-ep-line bg-ep-inset px-3 text-left transition-colors duration-200 hover:bg-ep-hover focus-visible:border-ep-accent"
                  >
                    {/* The wallet's own icon, supplied by the extension at runtime. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={w.adapter.icon} alt="" className="size-7 rounded-md" />
                    <span className="flex-1 font-medium">{w.adapter.name}</span>
                    <Badge variant="outline" className="border-ep-accent-line text-ep-accent">Detected</Badge>
                  </button>
                </li>
              ))}
              {missing.map((k) => (
                <li key={k.name}>
                  <a
                    href={k.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-14 w-full items-center gap-3 rounded-md border border-dashed border-ep-line px-3 text-left text-ep-text-2 transition-colors duration-200 hover:bg-ep-hover"
                  >
                    <WalletIcon className="size-5 text-ep-muted" aria-hidden />
                    <span className="flex-1">{k.name}</span>
                    <span className="flex items-center gap-1 text-xs text-ep-muted">
                      Install <ExternalLink className="size-3" aria-hidden />
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            {wallets.length === 0 ? (
              <p className="text-xs text-ep-muted">
                No wallet found in this browser. Any Solana wallet that supports Wallet Standard shows here once it is installed.
              </p>
            ) : null}
          </>
        ) : null}

        {step === "connecting" ? (
          <>
            <DialogHeader>
              <DialogTitle>Continue in {pending ?? "your wallet"}</DialogTitle>
              <DialogDescription>Approve the connection in the wallet window.</DialogDescription>
            </DialogHeader>
            <Button variant="outline" onClick={() => setStep("wallets")}>
              Cancel
            </Button>
          </>
        ) : null}

        {step === "sign" || step === "signing" ? (
          <>
            <DialogHeader>
              <DialogTitle>Sign in with Solana</DialogTitle>
              <DialogDescription>
                Your wallet will ask you to sign this message. It is not a transaction and costs no SOL.
              </DialogDescription>
            </DialogHeader>
            {sample ? (
              <p className="rounded-md border border-ep-warn-line bg-ep-warn-soft p-3 text-sm text-ep-text-2">
                Sign-in needs the Epoch API, which can&apos;t be reached right now. Your wallet is connected and you can browse.
              </p>
            ) : input ? (
              <pre className="num max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-ep-line bg-ep-inset p-3 text-xs leading-relaxed text-ep-text-2">
                {siwsMessage(input)}
              </pre>
            ) : error ? (
              <p role="alert" className="text-sm text-ep-warn">{error}</p>
            ) : (
              <div className="h-40 animate-pulse rounded-md bg-ep-inset" aria-hidden />
            )}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => hide()}>
                Not now
              </Button>
              <Button className="flex-1" disabled={!input || step === "signing" || sample} onClick={() => void sign()}>
                {step === "signing" ? "Waiting for the wallet…" : "Sign message"}
              </Button>
            </div>
          </>
        ) : null}

        {step === "done" ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldCheck className="size-5 text-ep-accent" aria-hidden /> Signed in
              </DialogTitle>
              <DialogDescription>
                {shortKey(wallet.publicKey?.toBase58(), 6, 6)} · session until{" "}
                {session.data?.data?.expiresAt ? new Date(session.data.data.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) : "—"}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2">
              {(session.data?.data?.roles ?? []).length ? (
                session.data!.data!.roles.map((r) => (
                  <Badge key={r} variant="outline" className="capitalize">
                    {r}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-ep-muted">No roles yet</span>
              )}
            </div>
            <Button onClick={() => hide()}>Done</Button>
          </>
        ) : null}

        {step === "rejected" ? (
          <>
            <DialogHeader>
              <DialogTitle>{rejectedAt === "connect" ? "Connection rejected" : "Signature rejected"}</DialogTitle>
              <DialogDescription>Nothing was signed and nothing moved.</DialogDescription>
            </DialogHeader>
            {error ? <p className="text-sm text-ep-muted">{error}</p> : null}
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setStep("wallets")}>
                <ArrowLeft aria-hidden /> Choose another wallet
              </Button>
              <Button className="flex-1" onClick={() => setStep(rejectedAt === "connect" ? "wallets" : "sign")}>
                Try again
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Header slot: Connect, or the account chip with its menu. */
export function ConnectButton({ className }: { className?: string }) {
  const wallet = useWallet();
  const show = useConnectDialog((s) => s.show);
  const session = useSession();
  const { signOut } = useSessionActions();
  const address = wallet.publicKey?.toBase58() ?? null;
  const signedIn = !!address && session.data?.data?.address === address;

  if (!wallet.connected || !address) {
    return (
      <Button size="sm" className={className} onClick={() => show("connect")}>
        <WalletIcon aria-hidden /> Connect
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" className={cn("gap-2", className)} />}>
        <span className={cn("size-2 rounded-full", signedIn ? "bg-ep-accent" : "bg-ep-muted")} aria-hidden />
        <span className="num">{shortKey(address)}</span>
        <span className="sr-only">{signedIn ? "signed in" : "connected, not signed in"}</span>
        <ChevronDown className="size-3.5 text-ep-muted" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="text-xs text-ep-muted">{wallet.wallet?.adapter.name ?? "Wallet"}</span>
            <span className="num text-sm text-ep-text">{shortKey(address, 8, 8)}</span>
            <span className="text-xs text-ep-muted">{signedIn ? "Signed in" : "Connected · not signed in"}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            onClick={() => {
              void navigator.clipboard?.writeText(address);
              toast.success("Address copied");
            }}
          >
            <Copy aria-hidden /> Copy address
          </DropdownMenuItem>
          {signedIn ? (
            <DropdownMenuItem onClick={() => void signOut().then(() => toast("Signed out"))}>
              <LogOut aria-hidden /> Sign out
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => show("signin")}>
              <Check aria-hidden /> Sign in (a message, no fee)
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => {
              void (signedIn ? signOut() : Promise.resolve()).finally(() => void wallet.disconnect());
            }}
          >
            <LogOut aria-hidden /> Disconnect
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
