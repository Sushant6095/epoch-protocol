import {
  accountFilters,
  decodeFeeIndex,
  decodeFeeQuote,
  decodePool,
  type FeeIndexAccount,
  type FeeQuoteAccount,
  fieldFilter,
  findFeeIndexPda,
  findPoolPda,
  parseEpochError,
  parseEventsFromLogs,
  type PoolAccount,
} from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { type ConnectionManager, errorLogs, isExecutionFailure, type TransactionSender } from '@epoch/solana';
import { type EpochSchedule, type PublicKey, type TransactionInstruction } from '@solana/web3.js';

import { sameHash } from '../Index/InputsHash';
import {
  type ChainClock,
  describeFailure,
  type ExecuteResult,
  type ProgramAccount,
  type PublisherChain,
  type PublisherRole,
} from './PublisherChain';

const logger = Logger.create('PublisherClient');

/** How far back `findProposalSignature` looks in the publisher key's history. */
const PROPOSAL_SEARCH_LIMIT = 50;
/** Under DRY_RUN an identical action is simulated once per this window, not on every tick. */
const DRY_RUN_MEMO_MS = 30 * 60_000;

export interface PublisherClientOptions {
  programId: PublicKey;
  connections: ConnectionManager;
  /** One sender per configured role; each key pays for its own transactions. */
  senders: Partial<Record<PublisherRole, TransactionSender>>;
  computeUnitPriceMicroLamports: number;
  dryRun: boolean;
  now?: () => number;
}

export class PublisherClient implements PublisherChain {
  readonly programId: PublicKey;
  readonly dryRun: boolean;
  private readonly connections: ConnectionManager;
  private readonly senders: Partial<Record<PublisherRole, TransactionSender>>;
  private readonly computeUnitPriceMicroLamports: number;
  private readonly now: () => number;
  private schedule?: Promise<EpochSchedule>;
  private readonly dryRunMemo = new Map<string, number>();

  constructor(options: PublisherClientOptions) {
    this.programId = options.programId;
    this.dryRun = options.dryRun;
    this.connections = options.connections;
    this.senders = options.senders;
    this.computeUnitPriceMicroLamports = options.computeUnitPriceMicroLamports;
    this.now = options.now ?? Date.now;
  }

  keyOf(role: PublisherRole): PublicKey | undefined {
    return this.senders[role]?.payerKey;
  }

  async clock(): Promise<ChainClock> {
    const info = await this.connections.withFailover((c) => c.getEpochInfo('confirmed'));
    return { epoch: BigInt(info.epoch), slot: BigInt(info.absoluteSlot) };
  }

  async firstSlotOfEpoch(epoch: bigint): Promise<bigint> {
    if (!this.schedule) {
      this.schedule = this.connections
        .withFailover((c) => c.getEpochSchedule())
        .catch((error: unknown) => {
          this.schedule = undefined;
          throw error;
        });
    }
    return BigInt((await this.schedule).getFirstSlotInEpoch(Number(epoch)));
  }

  async pool(): Promise<PoolAccount | null> {
    return this.loadOne(findPoolPda(this.programId)[0], decodePool);
  }

  async feeIndex(): Promise<FeeIndexAccount | null> {
    return this.loadOne(findFeeIndexPda(this.programId, findPoolPda(this.programId)[0])[0], decodeFeeIndex);
  }

  async quotes(maker: PublicKey): Promise<ProgramAccount<FeeQuoteAccount>[]> {
    const accounts = await this.connections.withFailover((c) =>
      c.getProgramAccounts(this.programId, {
        commitment: 'confirmed',
        filters: [...accountFilters('FeeQuote'), fieldFilter('FeeQuote', 'maker', maker)],
      }),
    );
    return accounts.map(({ pubkey, account }) => ({ address: pubkey, account: decodeFeeQuote(account.data) }));
  }

  async balance(address: PublicKey): Promise<bigint> {
    return BigInt(await this.connections.withFailover((c) => c.getBalance(address, 'confirmed')));
  }

  async rentExemptMinimum(dataSize: number): Promise<bigint> {
    return BigInt(await this.connections.withFailover((c) => c.getMinimumBalanceForRentExemption(dataSize)));
  }

  async findProposalSignature(inputsHash: Uint8Array): Promise<string | null> {
    const publisher = this.keyOf('publisher');
    if (!publisher) return null;
    const signatures = await this.connections.withFailover((c) =>
      c.getSignaturesForAddress(publisher, { limit: PROPOSAL_SEARCH_LIMIT }, 'confirmed'),
    );
    for (const { signature, err } of signatures) {
      if (err) continue;
      const tx = await this.connections.withFailover((c) =>
        c.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }),
      );
      const events = parseEventsFromLogs(tx?.meta?.logMessages ?? [], this.programId);
      if (events.some((e) => e.name === 'IndexProposed' && sameHash(e.data.inputsHash, inputsHash))) return signature;
    }
    return null;
  }

  async execute(label: string, instructions: TransactionInstruction[], role: PublisherRole): Promise<ExecuteResult> {
    const sender = this.senders[role];
    if (!sender) throw new Error(`no keypair configured for the ${role} role`);
    const options = { computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports };

    if (this.dryRun) {
      const at = this.dryRunMemo.get(label);
      if (at !== undefined && this.now() - at < DRY_RUN_MEMO_MS) {
        return { status: 'simulated', logs: [] };
      }
      let result: ExecuteResult;
      try {
        const sim = await sender.simulate(instructions, options);
        const error = sim.ok ? undefined : parseEpochError({ err: sim.err, logs: sim.logs });
        const transient = !error && !isExecutionFailure({ err: sim.err, logs: sim.logs });
        result = sim.ok
          ? { status: 'simulated', logs: sim.logs, unitsConsumed: sim.unitsConsumed }
          : { status: 'failed', error, message: JSON.stringify(sim.err), logs: sim.logs, transient };
      } catch (rpcError) {
        result = { status: 'failed', message: String(rpcError), logs: [], transient: true };
      }
      if (result.status === 'simulated') {
        this.dryRunMemo.set(label, this.now());
        logger.info('DRY_RUN: simulated, not sent', { label, unitsConsumed: result.unitsConsumed });
      } else {
        logger.warn('DRY_RUN: simulation failed', { label, reason: describeFailure(result) });
      }
      return result;
    }

    try {
      const signature = await sender.send(instructions, [], {
        ...options,
        retries: 2,
        shouldRetry: (error) => !isExecutionFailure({ logs: errorLogs(error), message: String(error) }),
      });
      logger.info('sent', { label, signature });
      return { status: 'sent', signature };
    } catch (error) {
      const details = (error as { details?: { error?: unknown; logs?: unknown } }).details ?? {};
      const logs = Array.isArray(details.logs) ? (details.logs as string[]) : [];
      const message = typeof details.error === 'string' ? details.error : String(error);
      const programError = parseEpochError({ logs, error: message });
      return {
        status: 'failed',
        error: programError,
        message,
        logs,
        transient: !programError && !isExecutionFailure({ logs, message }),
      };
    }
  }

  private async loadOne<T>(address: PublicKey, decode: (data: Uint8Array) => T): Promise<T | null> {
    const info = await this.connections.withFailover((c) => c.getAccountInfo(address, 'confirmed'));
    if (!info || !info.owner.equals(this.programId)) return null;
    return decode(info.data);
  }
}
