import { retry } from '@epoch/common';
import { TransactionFailedException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import {
  ComputeBudgetProgram,
  type Keypair,
  PublicKey,
  type Signer,
  Transaction,
  type TransactionError,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import { type ConnectionManager } from './ConnectionManager';

export interface SendOptions {
  computeUnitPriceMicroLamports?: number;
  computeUnitLimit?: number;
  retries?: number;
  /**
   * Whether a failed attempt is worth retrying. Defaults to always. Pass a predicate that answers false for
   * deterministic failures (a program error found in the simulation logs) so they fail fast instead of being
   * re-sent `retries` times.
   */
  shouldRetry?: (error: unknown) => boolean;
}

export interface SimulationResult {
  /** True when the simulated transaction succeeded. */
  ok: boolean;
  err: TransactionError | string | null;
  logs: string[];
  unitsConsumed?: number;
}

const logger = Logger.create('TransactionSender');

/** Program logs carried by a web3.js SendTransactionError (or anything with a `logs` array). */
export function errorLogs(error: unknown): string[] {
  const logs = (error as { logs?: unknown } | null | undefined)?.logs;
  return Array.isArray(logs) ? logs.filter((line): line is string => typeof line === 'string') : [];
}

const PROGRAM_FAILED_LOG = /^Program [1-9A-HJ-NP-Za-km-z]{32,44} failed/;
const EXECUTION_FAILURE_TEXT = /InstructionError|custom program error|Error processing Instruction|Error Number: \d+/;

/**
 * True when the transaction ran and an instruction failed (in simulation, preflight or on chain): a program error,
 * an Anchor constraint, a builtin instruction error. Such a failure repeats for as long as the chain state does, so
 * re-sending is pointless. False for RPC, network, blockhash and fee-payer funding problems, which are worth retrying.
 */
export function isExecutionFailure(failure: { err?: unknown; logs?: readonly string[]; message?: string }): boolean {
  const { err, logs = [], message = '' } = failure;
  if (typeof err === 'object' && err !== null && 'InstructionError' in err) return true;
  if (logs.some((line) => PROGRAM_FAILED_LOG.test(line) || EXECUTION_FAILURE_TEXT.test(line))) return true;
  return EXECUTION_FAILURE_TEXT.test(message);
}

export class TransactionSender {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly payer: Keypair,
  ) {}

  /** The fee payer (and first signer) of every transaction this sender builds. */
  get payerKey(): PublicKey {
    return this.payer.publicKey;
  }

  async send(
    instructions: TransactionInstruction[],
    signers: Signer[] = [],
    options: SendOptions = {},
  ): Promise<string> {
    const { retries = 3, shouldRetry } = options;
    const budget = this.budget(options);

    // A failure `shouldRetry` rejects ends the loop: it is kept here and rethrown below.
    const abort: { aborted: boolean; error?: unknown } = { aborted: false };
    try {
      const signature = await retry(
        async () => {
          try {
            return await this.connections.withFailover((connection) =>
              sendAndConfirmTransaction(connection, new Transaction().add(...budget, ...instructions), [
                this.payer,
                ...signers,
              ]),
            );
          } catch (error) {
            if (shouldRetry && !shouldRetry(error)) {
              abort.aborted = true;
              abort.error = error;
              return '';
            }
            throw error;
          }
        },
        { retries, onRetry: (error, attempt) => logger.warn('send retry', { attempt, error: String(error) }) },
      );
      if (abort.aborted) throw abort.error;
      return signature;
    } catch (error) {
      throw new TransactionFailedException('Transaction failed after retries', {
        error: String(error),
        logs: errorLogs(error),
      });
    }
  }

  /**
   * Simulates the transaction `send` would build (same compute-budget instructions) without signing it: signature
   * verification is off and the RPC substitutes a recent blockhash, so only the payer's public key is needed.
   */
  async simulate(instructions: TransactionInstruction[], options: SendOptions = {}): Promise<SimulationResult> {
    const message = new TransactionMessage({
      payerKey: this.payer.publicKey,
      // Replaced by the RPC (`replaceRecentBlockhash`); any valid base58 hash will do.
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [...this.budget(options), ...instructions],
    }).compileToLegacyMessage();
    const { value } = await this.connections.withFailover((connection) =>
      connection.simulateTransaction(new VersionedTransaction(message), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      }),
    );
    return {
      ok: value.err === null,
      err: value.err,
      logs: value.logs ?? [],
      unitsConsumed: value.unitsConsumed,
    };
  }

  private budget(options: SendOptions): TransactionInstruction[] {
    const { computeUnitPriceMicroLamports = 10_000, computeUnitLimit } = options;
    const budget = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicroLamports })];
    if (computeUnitLimit) budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
    return budget;
  }
}
