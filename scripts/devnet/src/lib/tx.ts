/**
 * Sending transactions on a public cluster: priority fee with a simulated compute-unit limit, rebroadcast until
 * confirmed, and a new blockhash only once the old one can no longer land.
 *
 * Adapted from jito-foundation/stakenet/sdk/src/utils/transactions.rs (Apache-2.0): the send → rebroadcast → confirm
 * → re-sign loop of `parallel_execute_transactions` and the compute-unit limit from `simulate_instruction`, ported to
 * TypeScript for one transaction at a time. Changed: stakenet re-signs as soon as the RPC reports the blockhash
 * invalid or not found, which can execute twice if the first copy still lands (harmless for its idempotent cranks,
 * not for deposits, swaps or transfers); here a transaction is re-signed only after the confirmed block height has
 * passed its `lastValidBlockHeight` and a status lookup that searches history has not found its signature. RPC
 * errors are retried with backoff only when they are transport errors, never program errors, and failures carry the
 * parsed Epoch error.
 */
import * as sdk from '@epoch/epoch-sdk';
import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  type PublicKey,
  SendTransactionError,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';

import { KitError } from './errors';

export const MAX_COMPUTE_UNITS = 1_400_000;

/** The compute-unit limit for a simulated use: +15% and 1,000 units of headroom, capped at the transaction maximum. */
export function computeUnitLimit(simulatedUnits: number): number {
  return Math.min(MAX_COMPUTE_UNITS, Math.ceil(simulatedUnits * 1.15) + 1_000);
}

const RETRYABLE = [
  /\b429\b/,
  /too many requests/i,
  /\b50[234]\b/,
  /fetch failed/i,
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up/i,
  /node is (behind|unhealthy)/i,
];

/** RPC failures worth retrying (rate limits, gateway errors, dropped connections); never program errors. */
export function isRetryableRpcError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  return RETRYABLE.some((re) => re.test(text));
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Call `fn`, retrying retryable RPC errors with exponential backoff (0.5 s, 1 s, 2 s, … up to 8 s). */
export async function withRpcRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= attempts || !isRetryableRpcError(e)) throw e;
      await sleep(Math.min(8_000, 500 * 2 ** i));
    }
  }
}

export class TxError extends KitError {
  constructor(
    readonly label: string,
    readonly epochError: sdk.EpochErrorInfo | undefined,
    readonly logs: string[],
    detail: string,
    readonly signature?: string,
  ) {
    super('TX_FAILED', `${label} failed: ${epochError ? `${epochError.code} ${epochError.name}` : detail}`);
  }
}

export interface SendOptions {
  /** Priority fee in micro-lamports per compute unit; 0 sends without compute-budget instructions. */
  microLamportsPerCu?: bigint;
  /** Land the transaction even if it fails (CP1's refused UpdateCommission); the result carries `err`. */
  allowFailure?: boolean;
  /** Blockhashes to try before giving up (each one is ≈ 60–90 s of rebroadcasting). */
  maxBlockhashes?: number;
  rebroadcastMs?: number;
  /** Parse Epoch events from the logs. */
  programId?: PublicKey;
}

export interface Landed {
  label: string;
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
  events: sdk.EpochEvent[];
  fee: bigint;
  computeUnits: number | null;
}

async function logsOf(conn: Connection, e: unknown): Promise<string[]> {
  if (!(e instanceof SendTransactionError)) return [];
  try {
    return (await e.getLogs(conn)) ?? [];
  } catch {
    return e.logs ?? [];
  }
}

async function simulateUnits(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<number> {
  const { blockhash, lastValidBlockHeight } = await withRpcRetry(() => conn.getLatestBlockhash('confirmed'));
  const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
    ...ixs,
  );
  tx.sign(...signers);
  const sim = await withRpcRetry(() => conn.simulateTransaction(tx));
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    throw new TxError(
      label,
      sdk.parseEpochError(sim) ?? sdk.parseEpochError(sim.value.err),
      logs,
      JSON.stringify(sim.value.err),
    );
  }
  return sim.value.unitsConsumed ?? 200_000;
}

async function fetchLanded(conn: Connection, label: string, signature: string, programId?: PublicKey): Promise<Landed> {
  for (let i = 0; i < 40; i++) {
    const tx = await withRpcRetry(() =>
      conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
    );
    if (tx) {
      const logs = tx.meta?.logMessages ?? [];
      return {
        label,
        signature,
        slot: tx.slot,
        err: tx.meta?.err ?? null,
        logs,
        events: programId ? sdk.parseEventsFromLogs(logs, programId) : [],
        fee: BigInt(tx.meta?.fee ?? 0),
        computeUnits: tx.meta?.computeUnitsConsumed ?? null,
      };
    }
    await sleep(500);
  }
  throw new KitError('TX_FAILED', `${label}: ${signature} confirmed but not returned by getTransaction`);
}

/**
 * Sign, send and confirm. Throws `TxError` (with the parsed Epoch error and logs) when the transaction fails, unless
 * `allowFailure`, in which case a landed failure is returned with `err` set.
 */
export async function sendTx(
  conn: Connection,
  label: string,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  opts: SendOptions = {},
): Promise<Landed> {
  const price = opts.microLamportsPerCu ?? 0n;
  const budget: TransactionInstruction[] = [];
  if (price > 0n && !opts.allowFailure) {
    const units = await simulateUnits(conn, ixs, signers, label);
    budget.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit(units) }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
    );
  }
  const maxBlockhashes = opts.maxBlockhashes ?? 3;
  for (let attempt = 1; attempt <= maxBlockhashes; attempt++) {
    const { blockhash, lastValidBlockHeight } = await withRpcRetry(() => conn.getLatestBlockhash('confirmed'));
    const tx = new Transaction({ feePayer: signers[0].publicKey, blockhash, lastValidBlockHeight }).add(
      ...budget,
      ...ixs,
    );
    tx.sign(...signers);
    const raw = tx.serialize();
    const signature = sdk.base58Encode(tx.signature!);
    try {
      await conn.sendRawTransaction(raw, {
        skipPreflight: opts.allowFailure === true,
        preflightCommitment: 'confirmed',
        maxRetries: 0,
      });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      if (!/already been processed/i.test(text) && !isRetryableRpcError(e)) {
        throw new TxError(label, sdk.parseEpochError(e), await logsOf(conn, e), text.split('\n')[0]);
      }
    }
    const finish = async (): Promise<Landed> => {
      const landed = await fetchLanded(conn, label, signature, opts.programId);
      if (landed.err && !opts.allowFailure) {
        throw new TxError(label, sdk.parseEpochError(landed.err), landed.logs, JSON.stringify(landed.err), signature);
      }
      return landed;
    };
    const confirmed = (s: { confirmationStatus?: string } | null | undefined): boolean =>
      s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized';
    for (;;) {
      const status = (await withRpcRetry(() => conn.getSignatureStatuses([signature]))).value[0];
      if (confirmed(status)) return finish();
      const height = await withRpcRetry(() => conn.getBlockHeight('confirmed'));
      if (height > lastValidBlockHeight) {
        const late = (
          await withRpcRetry(() => conn.getSignatureStatuses([signature], { searchTransactionHistory: true }))
        ).value[0];
        if (late) {
          // It landed (possibly only processed so far): wait for confirmation, then return it.
          while (
            !confirmed(
              (await withRpcRetry(() => conn.getSignatureStatuses([signature], { searchTransactionHistory: true })))
                .value[0],
            )
          ) {
            await sleep(1_000);
          }
          return finish();
        }
        break; // expired and never landed: safe to sign again with a fresh blockhash
      }
      await sleep(opts.rebroadcastMs ?? 2_000);
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
  }
  throw new KitError('TX_FAILED', `${label}: not confirmed within ${maxBlockhashes} blockhashes`);
}

/** True for a failed Epoch transaction whose program error is one of `names` (a "not yet", not a failure). */
export function isRetryableProgramError(e: unknown, names: readonly string[]): boolean {
  return e instanceof TxError && !!e.epochError && names.includes(e.epochError.name);
}

/**
 * `sendTx`, retried while the program answers with one of `retryOn`, e.g. `RewardsInProgress` in the first slots of an
 * epoch while the runtime distributes rewards. Stakenet's keepers treat such answers as "try again shortly"; bounded
 * here (default 60 × 5 s), after which the error goes to the caller and a re-run picks the step up.
 */
export async function sendTxRetrying(
  conn: Connection,
  label: string,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  opts: SendOptions & { retryOn: readonly string[]; attempts?: number; waitMs?: number },
): Promise<Landed> {
  const attempts = opts.attempts ?? 60;
  for (let i = 1; ; i++) {
    try {
      return await sendTx(conn, label, ixs, signers, opts);
    } catch (e) {
      if (i >= attempts || !isRetryableProgramError(e, opts.retryOn)) throw e;
      await sleep(opts.waitMs ?? 5_000);
    }
  }
}
