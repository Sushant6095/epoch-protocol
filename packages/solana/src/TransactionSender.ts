import { retry } from '@epoch/common';
import { TransactionFailedException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import {
  ComputeBudgetProgram,
  type Keypair,
  type Signer,
  Transaction,
  type TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

import { type ConnectionManager } from './ConnectionManager';

export interface SendOptions {
  computeUnitPriceMicroLamports?: number;
  computeUnitLimit?: number;
  retries?: number;
}

const logger = Logger.create('TransactionSender');

export class TransactionSender {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly payer: Keypair,
  ) {}

  async send(
    instructions: TransactionInstruction[],
    signers: Signer[] = [],
    options: SendOptions = {},
  ): Promise<string> {
    const { computeUnitPriceMicroLamports = 10_000, computeUnitLimit, retries = 3 } = options;
    const budget = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPriceMicroLamports })];
    if (computeUnitLimit) budget.push(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));

    try {
      return await retry(
        () =>
          this.connections.withFailover((connection) =>
            sendAndConfirmTransaction(connection, new Transaction().add(...budget, ...instructions), [
              this.payer,
              ...signers,
            ]),
          ),
        { retries, onRetry: (error, attempt) => logger.warn('send retry', { attempt, error: String(error) }) },
      );
    } catch (error) {
      throw new TransactionFailedException('Transaction failed after retries', { error: String(error) });
    }
  }
}
