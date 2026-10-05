import { type ConnectionManager, errorLogs, isExecutionFailure } from '@epoch/solana';

/** What a signature did, at `confirmed` or better. */
export type ChainState = 'confirmed' | 'failed' | 'unknown';

/** A broadcast the cluster refused (preflight): a program error, an already-processed transaction… */
export class BroadcastRejected extends Error {
  constructor(
    message: string,
    readonly logs: string[],
  ) {
    super(message);
    this.name = 'BroadcastRejected';
  }
}

/** Solana mainnet, for user trades: broadcast what the wallet signed, then watch the signature. */
export interface PantaChain {
  /** Sends a signed transaction with preflight. `BroadcastRejected` when the cluster refuses it. */
  broadcast(signedTransaction: Uint8Array): Promise<void>;
  statuses(signatures: readonly string[]): Promise<Map<string, ChainState>>;
  blockHeight(): Promise<number>;
}

const STATUS_BATCH = 256;

/** `@epoch/solana`'s RPC failover on PANTA_RPC_URL (mainnet). */
export class LivePantaChain implements PantaChain {
  constructor(private readonly connections: ConnectionManager) {}

  async broadcast(signedTransaction: Uint8Array): Promise<void> {
    try {
      await this.connections.withFailover((connection) =>
        connection.sendRawTransaction(signedTransaction, {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 5,
        }),
      );
    } catch (error) {
      const logs = errorLogs(error);
      const message = error instanceof Error ? error.message : String(error);
      if (isExecutionFailure({ logs, message }) || /already been processed|Blockhash not found/i.test(message)) {
        throw new BroadcastRejected(message.split('\n')[0].slice(0, 300), logs.slice(-8));
      }
      throw error;
    }
  }

  async statuses(signatures: readonly string[]): Promise<Map<string, ChainState>> {
    const out = new Map<string, ChainState>();
    for (let start = 0; start < signatures.length; start += STATUS_BATCH) {
      const batch = signatures.slice(start, start + STATUS_BATCH);
      const { value } = await this.connections.withFailover((connection) =>
        connection.getSignatureStatuses([...batch], { searchTransactionHistory: true }),
      );
      batch.forEach((signature, i) => {
        const status = value[i];
        if (!status) out.set(signature, 'unknown');
        else if (status.err) out.set(signature, 'failed');
        else if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          out.set(signature, 'confirmed');
        } else out.set(signature, 'unknown');
      });
    }
    return out;
  }

  blockHeight(): Promise<number> {
    return this.connections.withFailover((connection) => connection.getBlockHeight('confirmed'));
  }
}
