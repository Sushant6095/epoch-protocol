import { sleep as realSleep } from '@epoch/common';
import { TransactionFailedException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import { type Keypair, type PublicKey, type TransactionError, VersionedTransaction } from '@solana/web3.js';

import { type ConnectionManager } from './ConnectionManager';
import { errorLogs, isExecutionFailure } from './TransactionSender';

// Transactions built by someone else (a partner API such as Panta returns an unsigned VersionedTransaction that must be
// signed as-is: no compute-budget instructions added, no new blockhash). Sign, then PERSIST the signature, then
// broadcast: a crash between the two can always be resolved from the signature (landed, failed, or expired).

const logger = Logger.create('PrebuiltTransaction');
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 (Bitcoin alphabet), for signatures. */
export function encodeBase58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += '1';
  }
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]];
  return out;
}

export interface SignedPrebuilt {
  transaction: VersionedTransaction;
  /** The fee payer's signature, base58: the transaction's id. Known before anything is sent. */
  signature: string;
  /** The signed transaction, base64: what to re-broadcast after a restart. */
  signedBase64: string;
}

/**
 * Signs an unsigned VersionedTransaction (base64) with `payer`. Refuses one whose fee payer is not `payer` or that needs
 * any other signature: the caller would otherwise sign something it cannot complete, or pay for someone else's.
 */
export function signPrebuiltTransaction(base64: string, payer: Keypair): SignedPrebuilt {
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
  } catch {
    throw new TransactionFailedException('Not a serialized versioned transaction');
  }
  const { header, staticAccountKeys } = transaction.message;
  if (!staticAccountKeys[0]?.equals(payer.publicKey)) {
    throw new TransactionFailedException('The transaction is not paid by this key', {
      feePayer: staticAccountKeys[0]?.toBase58() ?? null,
      payer: payer.publicKey.toBase58(),
    });
  }
  if (header.numRequiredSignatures !== 1) {
    throw new TransactionFailedException('The transaction needs other signers too', {
      requiredSignatures: header.numRequiredSignatures,
    });
  }
  transaction.sign([payer]);
  return {
    transaction,
    signature: encodeBase58(transaction.signatures[0]),
    signedBase64: Buffer.from(transaction.serialize()).toString('base64'),
  };
}

export type SignatureState =
  | { status: 'confirmed'; slot: number }
  | { status: 'failed'; slot: number; err: TransactionError | string }
  | { status: 'unknown' };

/** Where a signature stands at `confirmed` or better. `history`: also search old slots (for recovery after a restart). */
export async function signatureState(
  connections: ConnectionManager,
  signature: string,
  history = false,
): Promise<SignatureState> {
  const { value } = await connections.withFailover((connection) =>
    connection.getSignatureStatuses([signature], { searchTransactionHistory: history }),
  );
  const status = value[0];
  if (!status) return { status: 'unknown' };
  if (status.err) return { status: 'failed', slot: status.slot, err: status.err };
  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
    return { status: 'confirmed', slot: status.slot };
  }
  return { status: 'unknown' };
}

export interface SendSignedOptions {
  /** From the build: past this block height the blockhash is dead and the transaction can never land. */
  lastValidBlockHeight: number;
  /** Status poll interval. Default 2 s. */
  pollMs?: number;
  /** Re-broadcast interval while unconfirmed. Default 6 s. */
  resendMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Broadcasts a signed transaction and waits for `confirmed`, re-sending until it lands or its blockhash expires. The
 * first send runs preflight (a deterministic program failure throws at once); re-sends skip it. Resolves with the
 * signature; throws `TransactionFailedException` when it failed on chain (`details.err`) or expired
 * (`details.expired: true`, safe to rebuild: it can never land).
 */
export async function sendSignedTransaction(
  connections: ConnectionManager,
  signed: Pick<SignedPrebuilt, 'transaction' | 'signature'>,
  options: SendSignedOptions,
): Promise<string> {
  const { lastValidBlockHeight, pollMs = 2_000, resendMs = 6_000 } = options;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const raw = signed.transaction.serialize();
  const { signature } = signed;
  let lastSend = Number.NEGATIVE_INFINITY;
  let first = true;

  for (;;) {
    if (now() - lastSend >= resendMs) {
      try {
        await connections.withFailover((connection) =>
          connection.sendRawTransaction(raw, {
            skipPreflight: !first,
            maxRetries: 0,
            preflightCommitment: 'confirmed',
          }),
        );
      } catch (error) {
        const failure = { message: String(error), logs: errorLogs(error) };
        if (first && isExecutionFailure(failure)) {
          throw new TransactionFailedException('Transaction failed in preflight', { signature, ...failure });
        }
        logger.warn('broadcast failed; will retry', { signature, error: failure.message });
      }
      lastSend = now();
      first = false;
    }
    await sleep(pollMs);

    const state = await signatureState(connections, signature).catch(() => ({ status: 'unknown' }) as const);
    if (state.status === 'confirmed') return signature;
    if (state.status === 'failed') {
      throw new TransactionFailedException('Transaction failed on chain', { signature, err: state.err });
    }
    const height = await connections
      .withFailover((connection) => connection.getBlockHeight('confirmed'))
      .catch(() => undefined);
    if (height !== undefined && height > lastValidBlockHeight) {
      // One last look, in case it landed between the two reads.
      const last = await signatureState(connections, signature, true);
      if (last.status === 'confirmed') return signature;
      if (last.status === 'failed') {
        throw new TransactionFailedException('Transaction failed on chain', { signature, err: last.err });
      }
      throw new TransactionFailedException('Transaction expired before it landed', { signature, expired: true });
    }
  }
}

/**
 * `TransactionSender`'s counterpart for transactions built elsewhere: signs with the payer it holds (the keypair never
 * leaves it) and broadcasts through the same RPC failover. `TransactionSender.send` cannot be used for these: it
 * rebuilds the transaction with its own blockhash and compute-budget instructions, which a partner's build forbids.
 */
export class PrebuiltTransactionSender {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly payer: Keypair,
  ) {}

  get payerKey(): PublicKey {
    return this.payer.publicKey;
  }

  /** Signs; persist `signature` and `signedBase64` before `send`. */
  sign(base64: string): SignedPrebuilt {
    return signPrebuiltTransaction(base64, this.payer);
  }

  send(signed: Pick<SignedPrebuilt, 'transaction' | 'signature'>, options: SendSignedOptions): Promise<string> {
    return sendSignedTransaction(this.connections, signed, options);
  }

  /** Re-broadcasts a transaction signed before a restart (`signedBase64`). */
  resend(signedBase64: string, options: SendSignedOptions): Promise<string> {
    const transaction = VersionedTransaction.deserialize(Buffer.from(signedBase64, 'base64'));
    return sendSignedTransaction(
      this.connections,
      { transaction, signature: encodeBase58(transaction.signatures[0]) },
      options,
    );
  }

  state(signature: string, history = true): Promise<SignatureState> {
    return signatureState(this.connections, signature, history);
  }
}
