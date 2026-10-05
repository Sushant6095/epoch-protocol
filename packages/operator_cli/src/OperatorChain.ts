import {
  type AdvanceAccount,
  decodeAdvance,
  decodePool,
  decodeValidatorPosition,
  findPoolPda,
  findPositionPda,
  type PoolAccount,
  type ValidatorPositionAccount,
} from '@epoch/epoch-sdk';
import {
  type ConnectionManager,
  errorLogs,
  isExecutionFailure,
  parseVoteState,
  type SimulationResult,
  type TransactionSender,
  type VoteState,
} from '@epoch/solana';
import {
  type AccountInfo,
  type Keypair,
  type PublicKey,
  type Signer,
  type TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads and sends on the Epoch program's cluster for the operator and admin commands. */
export class OperatorChain {
  constructor(
    readonly programId: PublicKey,
    private readonly connections: ConnectionManager,
    private readonly sender: TransactionSender,
    private readonly computeUnitPriceMicroLamports: number,
    /** The signer's keypair, for the partly signed transactions of offline signing. */
    readonly signer: Keypair,
  ) {}

  get operator(): PublicKey {
    return this.sender.payerKey;
  }

  get priorityFeeMicroLamports(): number {
    return this.computeUnitPriceMicroLamports;
  }

  async epoch(): Promise<bigint> {
    return BigInt((await this.connections.withFailover((c) => c.getEpochInfo('confirmed'))).epoch);
  }

  async position(vote: PublicKey): Promise<ValidatorPositionAccount | null> {
    return this.load(findPositionPda(this.programId, vote)[0], decodeValidatorPosition);
  }

  async advance(address: PublicKey): Promise<AdvanceAccount | null> {
    return this.load(address, decodeAdvance);
  }

  async pool(): Promise<PoolAccount | null> {
    return this.load(findPoolPda(this.programId)[0], decodePool);
  }

  /** The vote account on the program's cluster, or null when missing or unreadable. */
  async voteState(vote: PublicKey): Promise<VoteState | null> {
    const info = await this.connections.withFailover((c) => c.getAccountInfo(vote, 'confirmed'));
    if (!info) return null;
    try {
      return parseVoteState(info.data);
    } catch {
      return null;
    }
  }

  /** Raw accounts, in order (null for a missing one). */
  async accounts(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    return this.connections.withFailover((c) => c.getMultipleAccountsInfo(keys, 'confirmed'));
  }

  async latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    return this.connections.withFailover((c) => c.getLatestBlockhash('confirmed'));
  }

  /** A durable nonce account's current nonce and authority, or null when it is not one. */
  async nonce(account: PublicKey): Promise<{ nonce: string; authority: PublicKey } | null> {
    const value = await this.connections.withFailover((c) => c.getNonce(account, 'confirmed'));
    return value ? { nonce: value.nonce, authority: value.authorizedPubkey } : null;
  }

  simulate(instructions: TransactionInstruction[]): Promise<SimulationResult> {
    return this.sender.simulate(instructions, { computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports });
  }

  send(instructions: TransactionInstruction[], signers: Signer[]): Promise<string> {
    return this.sender.send(instructions, signers, {
      computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
      retries: 1,
      shouldRetry: (error) => !isExecutionFailure({ logs: errorLogs(error), message: String(error) }),
    });
  }

  /** Simulates a fully signed, serialized transaction as it is (signatures verified, blockhash kept). */
  async simulateSigned(serialized: Uint8Array): Promise<SimulationResult> {
    const tx = VersionedTransaction.deserialize(serialized);
    const { value } = await this.connections.withFailover((c) =>
      c.simulateTransaction(tx, { sigVerify: true, replaceRecentBlockhash: false, commitment: 'confirmed' }),
    );
    return { ok: value.err === null, err: value.err, logs: value.logs ?? [], unitsConsumed: value.unitsConsumed };
  }

  /** Sends a fully signed, serialized transaction and waits (about a minute) until it is confirmed. */
  async sendSigned(serialized: Uint8Array): Promise<string> {
    const signature = await this.connections.withFailover((c) =>
      c.sendRawTransaction(serialized, { preflightCommitment: 'confirmed', maxRetries: 3 }),
    );
    for (let i = 0; i < 60; i++) {
      const { value } = await this.connections.withFailover((c) => c.getSignatureStatuses([signature]));
      const status = value[0];
      if (status?.err) throw Object.assign(new Error(`${signature} failed`), { details: { error: status.err } });
      if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
        return signature;
      }
      await sleep(1_000);
    }
    throw new Error(`${signature} not confirmed after 60 s: check it on an explorer before sending again`);
  }

  private async load<T>(address: PublicKey, decode: (data: Uint8Array) => T): Promise<T | null> {
    const info = await this.connections.withFailover((c) => c.getAccountInfo(address, 'confirmed'));
    if (!info || !info.owner.equals(this.programId)) return null;
    return decode(info.data);
  }
}
