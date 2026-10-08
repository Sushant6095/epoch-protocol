'use client';
import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { fmt } from './shared';
export const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || '';
export const PROGRAM_ID = process.env.NEXT_PUBLIC_EPOCH_PROGRAM_ID || '';
export const PROGRAM_NETWORK = process.env.NEXT_PUBLIC_EPOCH_NETWORK || '';
export function TransactionReview({
  title,
  summary,
  build,
  disabled = false,
}: {
  title: string;
  summary: string;
  build: (connection: Connection) => Promise<TransactionInstruction[]>;
  disabled?: boolean;
}) {
  const wallet = useWallet(),
    cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [transaction, setTransaction] = useState<Transaction | null>(null);
  const [fee, setFee] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signature, setSignature] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [preparedSummary, setPreparedSummary] = useState('');
  async function prepare() {
    setOpen(true);
    setPreparedSummary(summary);
    setError('');
    setSignature('');
    setConfirmed(false);
    setTransaction(null);
    setFee(null);
    if (!wallet.publicKey || !RPC_URL || !PROGRAM_NETWORK) {
      setError('Connect a wallet and configure the RPC URL and network before preparing a transaction.');
      return;
    }
    setBusy(true);
    try {
      const connection = new Connection(RPC_URL, 'confirmed');
      const genesis = await connection.getGenesisHash();
      const expected =
        PROGRAM_NETWORK === 'devnet'
          ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
          : PROGRAM_NETWORK === 'mainnet'
            ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
            : null;
      if (!expected || genesis !== expected) throw new Error('The configured RPC does not match the selected network.');
      const tx = new Transaction().add(...(await build(connection)));
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      setFee((await connection.getFeeForMessage(tx.compileMessage())).value);
      setTransaction(tx);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the transaction.');
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if (!transaction || !wallet.publicKey) return;
    if (!transaction.feePayer?.equals(wallet.publicKey) || summary !== preparedSummary) {
      setError('The wallet or action changed. Close this review and prepare a new transaction.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const connection = new Connection(RPC_URL, 'confirmed');
      const block = await connection.getLatestBlockhash();
      transaction.recentBlockhash = block.blockhash;
      const sig = await wallet.sendTransaction(transaction, connection, { skipPreflight: false });
      setSignature(sig);
      const result = await connection.confirmTransaction({ ...block, signature: sig }, 'confirmed');
      if (result.value.err) throw new Error('The transaction failed on-chain. Check the explorer for details.');
      setConfirmed(true);
      await cache.invalidateQueries();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The transaction was not confirmed. Check its status before retrying.');
    } finally {
      setBusy(false);
    }
  }
  const explorer = signature
    ? `https://explorer.solana.com/tx/${signature}${PROGRAM_NETWORK === 'devnet' ? '?cluster=devnet' : ''}`
    : '';
  return (
    <>
      <Button className="w-full" disabled={disabled} onClick={prepare}>
        {title}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!busy) setOpen(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmed ? 'Transaction confirmed' : signature ? 'Transaction submitted' : title}
            </DialogTitle>
            <DialogDescription>{preparedSummary}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 rounded-lg bg-muted p-4 text-sm">
            <div className="flex justify-between">
              <span>Network</span>
              <span>{PROGRAM_NETWORK || 'Not configured'}</span>
            </div>
            <div className="flex justify-between">
              <span>Estimated network fee</span>
              <span className="num">{fee === null ? '—' : fmt(fee / 1e9, 9)} SOL</span>
            </div>
            <p className="text-xs text-muted-foreground">Account rent may be charged in addition to the network fee.</p>
            {transaction?.instructions.map((ix, i) => (
              <div key={i}>
                <p className="text-xs text-muted-foreground">Program</p>
                <p className="num break-all text-xs">{ix.programId.toBase58()}</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs">Accounts to be used</summary>
                  {ix.keys.map((k) => (
                    <p key={k.pubkey.toBase58()} className="num mt-1 break-all text-xs text-muted-foreground">
                      {k.pubkey.toBase58()} · {k.isWritable ? 'writable' : 'read-only'}
                      {k.isSigner ? ' · signer' : ''}
                    </p>
                  ))}
                </details>
              </div>
            ))}
          </div>
          {error && (
            <p role="alert" className="text-sm text-ep-warn">
              {error}
            </p>
          )}
          {signature && (
            <a href={explorer} target="_blank" rel="noreferrer" className="text-sm text-primary underline">
              View transaction on Solana Explorer
            </a>
          )}
          {!signature && transaction && (
            <Button disabled={busy || fee === null} onClick={send}>
              {busy ? 'Waiting for wallet / confirmation…' : 'Approve in your wallet'}
            </Button>
          )}
          {busy && !transaction && <p className="text-sm text-muted-foreground">Preparing transaction…</p>}
          {confirmed && <Button onClick={() => setOpen(false)}>Done</Button>}
        </DialogContent>
      </Dialog>
    </>
  );
}
