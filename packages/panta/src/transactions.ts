import { createHash } from 'crypto';

import { base58Encode } from '@epoch/epoch-sdk';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';

import { PantaInputError } from './errors';
import { type PantaInstruction } from './schemas';

// Primary buys and claims come back as instruction lists plus a blockhash ("compile a versioned transaction from
// `instructions` + `recentBlockhash`, sign with `wallet`"); market creation comes back as a whole unsigned
// VersionedTransaction. These helpers compile the former and describe either, so a server can hand a wallet one
// base64 transaction and later check that what came back signed is exactly what it built.

const WHERE = 'transaction';

/** What a transaction asks for: who pays, who must sign, which programs run, and a hash of the message bytes. */
export interface TransactionSummary {
  /** sha256 (hex) of the serialized message: the bytes every signer signs. Same message ⇔ same hash. */
  messageHash: string;
  feePayer: string;
  /** In order; the fee payer first. */
  requiredSigners: string[];
  recentBlockhash: string;
  /** Distinct programs invoked by top-level instructions. */
  programIds: string[];
  /** Address lookup tables the message uses (0 for what `compileUnsignedTransaction` builds). */
  lookupTables: number;
}

export interface UnsignedTransaction extends TransactionSummary {
  /** Base64 VersionedTransaction (v0, no lookup tables) with empty signatures, ready for `signTransaction`. */
  transaction: string;
}

/** Panta's JSON instructions as web3.js instructions (`data` is base64). */
export function toTransactionInstructions(instructions: readonly PantaInstruction[]): TransactionInstruction[] {
  try {
    return instructions.map(
      (ix) =>
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.accounts.map((account) => ({
            pubkey: new PublicKey(account.pubkey),
            isSigner: account.isSigner,
            isWritable: account.isWritable,
          })),
          data: Buffer.from(ix.data, 'base64'),
        }),
    );
  } catch (error) {
    throw new PantaInputError(`Unusable instruction from Panta: ${(error as Error).message}`, WHERE);
  }
}

/**
 * Compiles Panta's instructions into an unsigned v0 transaction paid by `payer`. Refuses instructions that need any
 * other signer: one wallet could never complete them, and a server must never be asked to co-sign a user's trade.
 */
export function compileUnsignedTransaction(params: {
  payer: string;
  recentBlockhash: string;
  instructions: readonly PantaInstruction[];
}): UnsignedTransaction {
  let payer: PublicKey;
  try {
    payer = new PublicKey(params.payer);
  } catch {
    throw new PantaInputError('payer is not a public key', WHERE);
  }
  const instructions = toTransactionInstructions(params.instructions);
  for (const ix of instructions) {
    for (const key of ix.keys) {
      if (key.isSigner && !key.pubkey.equals(payer)) {
        throw new PantaInputError(`Instruction needs a signer other than the wallet (${key.pubkey.toBase58()})`, WHERE);
      }
    }
  }
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: params.recentBlockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return { transaction: Buffer.from(tx.serialize()).toString('base64'), ...describeTransaction(tx) };
}

/** Base64 → VersionedTransaction (signed or not). */
export function decodeTransaction(base64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
  } catch {
    throw new PantaInputError('Not a serialized Solana transaction', WHERE);
  }
}

export function describeTransaction(tx: VersionedTransaction): TransactionSummary {
  const keys = tx.message.staticAccountKeys;
  const required = tx.message.header.numRequiredSignatures;
  return {
    messageHash: messageHash(tx),
    feePayer: keys[0].toBase58(),
    requiredSigners: keys.slice(0, required).map((key) => key.toBase58()),
    recentBlockhash: tx.message.recentBlockhash,
    programIds: [...new Set(tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex].toBase58()))],
    lookupTables: tx.message.addressTableLookups.length,
  };
}

export const messageHash = (tx: VersionedTransaction): string =>
  createHash('sha256').update(tx.message.serialize()).digest('hex');

/** The first (fee payer's) signature in base58, or null while unsigned. This is the transaction's id on chain. */
export function transactionSignature(tx: VersionedTransaction): string | null {
  const first = tx.signatures[0];
  if (!first || first.every((byte) => byte === 0)) return null;
  return base58Encode(first);
}
