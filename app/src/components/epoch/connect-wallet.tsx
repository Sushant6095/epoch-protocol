'use client';
import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useQueryClient } from '@tanstack/react-query';
import { Wallet, ShieldCheck, ArrowUpRight, Check } from 'lucide-react';
import { base58Encode } from '@epoch/epoch-sdk';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { request, apiConfigured } from '@/lib/data/client';
import { useSession } from '@/lib/data/resources';
import type { SiwsNonce } from '@/lib/data/contracts/Account.types';
export function ConnectWallet({ className = '' }: { className?: string }) {
  const wallet = useWallet(),
    session = useSession(),
    cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState<SiwsNonce | null>(null);
  const address = wallet.publicKey?.toBase58();
  const input =
    typeof window !== 'undefined' && nonce && address
      ? {
          domain: window.location.host,
          address,
          statement: nonce.statement,
          uri: window.location.origin,
          version: '1',
          chainId: 'solana:mainnet',
          nonce: nonce.nonce,
          issuedAt: nonce.issuedAt,
          expirationTime: nonce.expirationTime,
        }
      : null;
  const message = input
    ? `${input.domain} wants you to sign in with your Solana account:\n${input.address}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: 1\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}`
    : '';
  async function prepare() {
    setBusy(true);
    setError('');
    try {
      const next = await request<SiwsNonce>('/v1/auth/siws/nonce', { method: 'POST' });
      if (!next.domains.includes(window.location.host))
        throw new Error('This app domain has not been enabled for sign-in by the API.');
      setNonce(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in could not start.');
    } finally {
      setBusy(false);
    }
  }
  async function sign() {
    if (!input || !address) return;
    setBusy(true);
    setError('');
    try {
      if (Date.now() >= Date.parse(input.expirationTime))
        throw new Error('This message expired. Get a fresh message and try again.');
      let signedMessage = message,
        signature: Uint8Array;
      if (wallet.signIn) {
        const result = await wallet.signIn(input);
        signedMessage = new TextDecoder().decode(result.signedMessage);
        signature = result.signature;
      } else if (wallet.signMessage) {
        signature = await wallet.signMessage(new TextEncoder().encode(message));
      } else throw new Error('This wallet does not support message signing.');
      await request('/v1/auth/siws/verify', {
        method: 'POST',
        body: JSON.stringify({ address, message: signedMessage, signature: base58Encode(signature) }),
      });
      await cache.invalidateQueries();
      setOpen(false);
      setNonce(null);
      toast.success('Signed in to Epoch');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Nothing was signed. Please try again.');
      setNonce(null);
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      if (apiConfigured) await request('/v1/auth/logout', { method: 'POST' });
      await wallet.disconnect();
      cache.removeQueries({
        predicate: (q) => q.queryKey.some((v) => typeof v === 'string' && /\/me\/|\/auth\/|\/wallets\//.test(v)),
      });
      setNonce(null);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign out.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        className={className}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        <Wallet />
        <span>
          {session.data
            ? `${session.data.address.slice(0, 4)}…${session.data.address.slice(-4)}`
            : address
              ? 'Wallet connected'
              : 'Connect wallet'}
        </span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-ep-accent-soft text-primary">
              <Wallet />
            </div>
            <DialogTitle>
              {session.data
                ? 'Your account'
                : nonce
                  ? 'Review your sign-in message'
                  : address
                    ? 'Confirm it’s you'
                    : 'Connect to Epoch'}
            </DialogTitle>
            <DialogDescription>
              Sign-in is a message, not a transaction. No SOL moves and there is no network fee.
            </DialogDescription>
          </DialogHeader>
          {!address && (
            <div className="space-y-2">
              {wallet.wallets.map((w) => (
                <Button
                  key={w.adapter.name}
                  variant="outline"
                  className="h-14 w-full justify-between"
                  onClick={() => {
                    wallet.select(w.adapter.name);
                    setError('');
                  }}
                >
                  <span>{w.adapter.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {wallet.wallet?.adapter.name === w.adapter.name ? 'Selected' : w.readyState}
                  </span>
                </Button>
              ))}
              {wallet.wallet && (
                <Button
                  className="w-full"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await wallet.connect();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Could not connect.');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? 'Continue in your wallet…' : `Continue with ${wallet.wallet.adapter.name}`}
                </Button>
              )}
              {!wallet.wallets.length && (
                <div className="rounded-lg border border-border p-4 text-sm">
                  <p className="mb-3 text-muted-foreground">
                    No compatible wallet was detected. Open Epoch in a browser with a Solana wallet installed.
                  </p>
                  <a
                    className="inline-flex items-center gap-2 text-primary"
                    href="https://phantom.com/download"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Get Phantom
                    <ArrowUpRight className="size-4" />
                  </a>
                </div>
              )}
            </div>
          )}
          {address && <p className="num break-all rounded-lg bg-muted p-4 text-xs">{address}</p>}
          {address && !session.data && !nonce && (
            <>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="size-4" />
                You approve every action in your wallet.
              </p>
              {!apiConfigured && (
                <p className="rounded-lg bg-ep-warn-soft p-3 text-sm text-ep-warn">
                  Wallet connection is available. Account sign-in will be enabled when the Epoch API is connected.
                </p>
              )}
              <Button disabled={busy || !apiConfigured} onClick={prepare}>
                {busy ? 'Preparing message…' : 'Review sign-in message'}
              </Button>
            </>
          )}
          {nonce && (
            <>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-4 text-xs num">
                {message}
              </pre>
              <Button disabled={busy} onClick={sign}>
                {busy ? 'Waiting for your wallet…' : 'Sign this message'}
              </Button>
            </>
          )}
          {session.data && (
            <p className="flex items-center gap-2 text-primary">
              <Check className="size-4" />
              Signed in · {session.data.roles.join(', ') || 'Wallet'}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-ep-warn-soft p-3 text-sm text-ep-warn">
              {error}
            </p>
          )}
          {address && (
            <Button variant="ghost" disabled={busy} onClick={disconnect}>
              Disconnect{session.data ? ' and sign out' : ''}
            </Button>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
