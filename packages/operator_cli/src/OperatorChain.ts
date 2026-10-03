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
import { type PublicKey, type Signer, type TransactionInstruction } from '@solana/web3.js';

/** Reads and sends on the Epoch program's cluster for the operator commands. */
export class OperatorChain {
  constructor(
    readonly programId: PublicKey,
    private readonly connections: ConnectionManager,
    private readonly sender: TransactionSender,
    private readonly computeUnitPriceMicroLamports: number,
  ) {}

  get operator(): PublicKey {
    return this.sender.payerKey;
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

  private async load<T>(address: PublicKey, decode: (data: Uint8Array) => T): Promise<T | null> {
    const info = await this.connections.withFailover((c) => c.getAccountInfo(address, 'confirmed'));
    if (!info || !info.owner.equals(this.programId)) return null;
    return decode(info.data);
  }
}
