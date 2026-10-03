import {
  type AccountName,
  accountFilters,
  type AdvanceAccount,
  decodeAdvance,
  decodeFeeIndex,
  decodePool,
  decodeSwapPosition,
  decodeValidatorPosition,
  decodeWithdrawRequest,
  type FeeIndexAccount,
  fieldFilter,
  findFeeIndexPda,
  findPoolPda,
  findWithdrawRequestPda,
  parseEpochError,
  type PoolAccount,
  type SwapPositionAccount,
  type ValidatorPositionAccount,
  type WithdrawRequestAccount,
} from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import {
  type ConnectionManager,
  errorLogs,
  isEpochRewardsActive,
  isExecutionFailure,
  type TransactionSender,
} from '@epoch/solana';
import {
  type GetProgramAccountsFilter,
  type Keypair,
  type PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js';

import {
  type ChainClock,
  describeFailure,
  type EpochChain,
  type ExecuteResult,
  type ProgramAccount,
  type SignerRole,
} from './EpochChain';

const logger = Logger.create('ProgramClient');

/** Under DRY_RUN the same action is simulated once per this window, so a minute poller does not log it every tick. */
const DRY_RUN_MEMO_MS = 30 * 60_000;

export interface ProgramClientOptions {
  programId: PublicKey;
  connections: ConnectionManager;
  /** Signs and pays every crank transaction (built with the crank keypair). */
  sender: TransactionSender;
  /** The Pool's scorer: co-signs update_score. */
  scorer?: Keypair;
  computeUnitPriceMicroLamports: number;
  dryRun: boolean;
  now?: () => number;
}

/**
 * The cranks' view of the Epoch program: reads through epoch-sdk decoders, sends through the shared
 * TransactionSender with the crank keypair, turns failures into readable program errors (`parseEpochError`), and
 * under DRY_RUN only simulates.
 */
export class ProgramClient implements EpochChain {
  readonly programId: PublicKey;
  readonly dryRun: boolean;
  private readonly connections: ConnectionManager;
  private readonly sender: TransactionSender;
  private readonly scorer?: Keypair;
  private readonly computeUnitPriceMicroLamports: number;
  private readonly now: () => number;
  private readonly dryRunMemo = new Map<string, { at: number; result: ExecuteResult }>();

  constructor(options: ProgramClientOptions) {
    this.programId = options.programId;
    this.dryRun = options.dryRun;
    this.connections = options.connections;
    this.sender = options.sender;
    this.scorer = options.scorer;
    this.computeUnitPriceMicroLamports = options.computeUnitPriceMicroLamports;
    this.now = options.now ?? Date.now;
  }

  keyOf(role: SignerRole): PublicKey | undefined {
    return role === 'crank' ? this.sender.payerKey : this.scorer?.publicKey;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async clock(): Promise<ChainClock> {
    const info = await this.connections.withFailover((c) => c.getEpochInfo('confirmed'));
    return { epoch: BigInt(info.epoch), slot: BigInt(info.absoluteSlot) };
  }

  epochRewardsActive(): Promise<boolean> {
    return isEpochRewardsActive(this.connections);
  }

  async pool(): Promise<ProgramAccount<PoolAccount> | null> {
    return this.loadOne(findPoolPda(this.programId)[0], decodePool);
  }

  positions(): Promise<ProgramAccount<ValidatorPositionAccount>[]> {
    return this.loadAll('ValidatorPosition', decodeValidatorPosition);
  }

  async advance(address: PublicKey): Promise<AdvanceAccount | null> {
    return (await this.loadOne(address, decodeAdvance))?.account ?? null;
  }

  feeIndex(): Promise<ProgramAccount<FeeIndexAccount> | null> {
    const [pool] = findPoolPda(this.programId);
    return this.loadOne(findFeeIndexPda(this.programId, pool)[0], decodeFeeIndex);
  }

  async withdrawRequest(seq: bigint): Promise<WithdrawRequestAccount | null> {
    const [pool] = findPoolPda(this.programId);
    const [address] = findWithdrawRequestPda(this.programId, pool, seq);
    return (await this.loadOne(address, decodeWithdrawRequest))?.account ?? null;
  }

  swaps(taker?: PublicKey): Promise<ProgramAccount<SwapPositionAccount>[]> {
    return this.loadAll('SwapPosition', decodeSwapPosition, taker ? [fieldFilter('SwapPosition', 'taker', taker)] : []);
  }

  // ── Transactions ───────────────────────────────────────────────────────────

  async simulate(label: string, instructions: TransactionInstruction[], role: SignerRole): Promise<ExecuteResult> {
    if (role === 'scorer') this.requireScorer();
    try {
      const sim = await this.sender.simulate(instructions, {
        computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
      });
      if (sim.ok) return { status: 'simulated', logs: sim.logs, unitsConsumed: sim.unitsConsumed };
      const error = parseEpochError({ err: sim.err, logs: sim.logs });
      const transient = !error && !isExecutionFailure({ err: sim.err, logs: sim.logs });
      return { status: 'failed', error, message: JSON.stringify(sim.err), logs: sim.logs, transient };
    } catch (rpcError) {
      logger.warn('simulation request failed', { label, error: String(rpcError) });
      return { status: 'failed', message: String(rpcError), logs: [], transient: true };
    }
  }

  async execute(label: string, instructions: TransactionInstruction[], role: SignerRole): Promise<ExecuteResult> {
    if (this.dryRun) return this.dryRunSimulate(label, instructions, role);
    const signers = role === 'scorer' ? [this.requireScorer()] : [];
    try {
      const signature = await this.sender.send(instructions, signers, {
        computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
        retries: 2,
        // An instruction that failed fails again: re-sending cannot help, the next tick re-reads the chain instead.
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
        // Not an instruction failure (RPC, network, blockhash, crank out of SOL): worth another try next tick.
        transient: !programError && !isExecutionFailure({ logs, message }),
      };
    }
  }

  private async dryRunSimulate(
    label: string,
    instructions: TransactionInstruction[],
    role: SignerRole,
  ): Promise<ExecuteResult> {
    const memo = this.dryRunMemo.get(label);
    if (memo && this.now() - memo.at < DRY_RUN_MEMO_MS) {
      logger.debug('DRY_RUN: already simulated', { label, status: memo.result.status });
      return memo.result;
    }
    const result = await this.simulate(label, instructions, role);
    if (result.status === 'simulated') {
      logger.info('DRY_RUN: simulated, not sent', { label, unitsConsumed: result.unitsConsumed });
      this.dryRunMemo.set(label, { at: this.now(), result });
    } else {
      logger.warn('DRY_RUN: simulation failed', { label, error: describeFailure(result) });
    }
    return result;
  }

  private requireScorer(): Keypair {
    if (!this.scorer) throw new Error('SCORER_KEYPAIR_PATH is not configured');
    return this.scorer;
  }

  private async loadOne<T>(address: PublicKey, decode: (data: Uint8Array) => T): Promise<ProgramAccount<T> | null> {
    const info = await this.connections.withFailover((c) => c.getAccountInfo(address, 'confirmed'));
    if (!info || !info.owner.equals(this.programId)) return null;
    return { address, account: decode(info.data) };
  }

  private async loadAll<T>(
    name: AccountName,
    decode: (data: Uint8Array) => T,
    extra: GetProgramAccountsFilter[] = [],
  ): Promise<ProgramAccount<T>[]> {
    const accounts = await this.connections.withFailover((c) =>
      c.getProgramAccounts(this.programId, { commitment: 'confirmed', filters: [...accountFilters(name), ...extra] }),
    );
    const out: ProgramAccount<T>[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        out.push({ address: pubkey, account: decode(account.data) });
      } catch (error) {
        logger.warn('skipping an account that does not decode', {
          name,
          address: pubkey.toBase58(),
          error: String(error),
        });
      }
    }
    return out;
  }
}
