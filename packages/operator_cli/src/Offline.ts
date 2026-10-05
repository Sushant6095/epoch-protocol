/**
 * Offline signing for transactions that need a second signer the operator does not hold (onboarding: the vote
 * account's current withdraw authority). The operator builds and signs; the transaction travels as base64 (a file or
 * a message); the other signer inspects and signs it with `sign-tx`, which needs no RPC and no config; the operator
 * submits it with `submit-tx`.
 *
 * The Solana CLI can decode such a transaction (`solana decode-transaction <base64> base64`) but has no command that
 * signs an arbitrary one, so `sign-tx` is the signing step. A recent blockhash expires after about a minute; for a
 * signer who is not at hand, use a durable nonce account (`--nonce`, authority: the operator).
 */
import { bytesToHex, instructionNameOf } from '@epoch/epoch-sdk';
import {
  ComputeBudgetProgram,
  type Keypair,
  type PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';

/** How the transaction stays valid while it waits for the other signature. */
export type Lifetime =
  | { kind: 'blockhash'; blockhash: string; lastValidBlockHeight: number }
  | { kind: 'nonce'; account: PublicKey; nonce: string; authority: PublicKey };

/**
 * The transaction the operator signs first: fee payer and first signer the operator, a priority fee, and with a nonce
 * the `AdvanceNonceAccount` instruction first (as the runtime requires).
 */
export function buildPartlySigned(input: {
  instructions: TransactionInstruction[];
  signer: Keypair;
  lifetime: Lifetime;
  priorityFeeMicroLamports: number;
}): Transaction {
  const { signer, lifetime } = input;
  const budget = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.priorityFeeMicroLamports });
  const tx =
    lifetime.kind === 'nonce'
      ? new Transaction({
          feePayer: signer.publicKey,
          nonceInfo: {
            nonce: lifetime.nonce,
            nonceInstruction: SystemProgram.nonceAdvance({
              noncePubkey: lifetime.account,
              authorizedPubkey: lifetime.authority,
            }),
          },
        })
      : new Transaction({
          feePayer: signer.publicKey,
          blockhash: lifetime.blockhash,
          lastValidBlockHeight: lifetime.lastValidBlockHeight,
        });
  tx.add(budget, ...input.instructions);
  tx.partialSign(signer);
  return tx;
}

export const encodeTransaction = (tx: Transaction): string =>
  tx.serialize({ requireAllSignatures: false, verifySignatures: true }).toString('base64');

/** Reads a transaction from a file's text: base64, surrounding whitespace ignored. */
export function decodeTransaction(text: string): Transaction {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) throw new Error('the transaction is not base64');
  return Transaction.from(Buffer.from(trimmed, 'base64'));
}

/** The keys that must sign, in order, and whether each signature is there. */
export function signatureStatus(tx: Transaction): { key: PublicKey; signed: boolean }[] {
  const message = tx.compileMessage();
  return message.accountKeys.slice(0, message.header.numRequiredSignatures).map((key) => {
    const entry = tx.signatures.find((s) => s.publicKey.equals(key));
    return { key, signed: !!entry?.signature && entry.signature.some((b) => b !== 0) };
  });
}

const PROGRAM_NAMES: Record<string, string> = {
  [SystemProgram.programId.toBase58()]: 'System',
  [ComputeBudgetProgram.programId.toBase58()]: 'Compute Budget',
  Vote111111111111111111111111111111111111111: 'Vote',
};

/** What a signer should read before signing: the lifetime, the signers and every instruction. */
export function describeTransaction(tx: Transaction, epochProgramId?: PublicKey): string {
  const message = tx.compileMessage();
  const status = signatureStatus(tx);
  const lines = [
    `Fee payer   ${tx.feePayer?.toBase58() ?? '?'}`,
    `Lifetime    ${tx.nonceInfo ? `durable nonce ${tx.nonceInfo.nonce}` : `blockhash ${message.recentBlockhash} (expires after ~1 minute)`}`,
    'Signers',
    ...status.map((s) => `  ${s.key.toBase58()}  ${s.signed ? 'signed' : 'MISSING'}`),
    'Instructions',
  ];
  tx.instructions.forEach((ix, i) => {
    const program = ix.programId.toBase58();
    const epochName = instructionNameOf(ix.data);
    const name =
      PROGRAM_NAMES[program] ??
      (epochProgramId && ix.programId.equals(epochProgramId) ? 'Epoch' : epochName ? 'Epoch?' : 'unknown');
    lines.push(`  #${i + 1} ${name}${epochName ? ` ${epochName}` : ''} → ${program}`);
    ix.keys.forEach((meta, j) => {
      const flags = [meta.isSigner ? 'signer' : '', meta.isWritable ? 'writable' : ''].filter(Boolean).join(', ');
      lines.push(`    ${String(j).padStart(2)} ${meta.pubkey.toBase58().padEnd(44)} [${flags}]`);
    });
    lines.push(`    data ${bytesToHex(new Uint8Array(ix.data))}`);
  });
  return lines.join('\n');
}

/** Adds `signer`'s signature. Throws when the transaction does not ask for that key. */
export function addSignature(tx: Transaction, signer: Keypair): Transaction {
  if (!signatureStatus(tx).some((s) => s.key.equals(signer.publicKey))) {
    throw new Error(`${signer.publicKey.toBase58()} is not a signer of this transaction`);
  }
  tx.partialSign(signer);
  return tx;
}

/** Problems that keep a transaction from being submitted: missing or invalid signatures. */
export function submitProblems(tx: Transaction): string[] {
  const missing = signatureStatus(tx).filter((s) => !s.signed);
  if (missing.length) return missing.map((s) => `missing the signature of ${s.key.toBase58()}`);
  return tx.verifySignatures(true) ? [] : ['a signature does not match the transaction (it was changed after signing)'];
}
