import { type EpochProgramConfig } from '@epoch/config-sdk';
import {
  type AccountName,
  accountFilters,
  type AdvanceAccount,
  decodeAdvance,
  decodeFeeIndex,
  decodeFeeQuote,
  decodeLenderShares,
  decodePool,
  decodeSwapPosition,
  decodeValidatorPosition,
  decodeWithdrawRequest,
  type EventName,
  type FeeIndexAccount,
  type FeeQuoteAccount,
  fieldFilter,
  findFeeIndexPda,
  findLenderPda,
  findPoolPda,
  findPositionPda,
  type LenderSharesAccount,
  type PoolAccount,
  type SwapPositionAccount,
  type Tranche,
  type ValidatorPositionAccount,
  type WithdrawRequestAccount,
} from '@epoch/epoch-sdk';
import { ServiceUnavailableException } from '@epoch/exceptions';
import { Logger } from '@epoch/logger';
import { ConnectionManager } from '@epoch/solana';
import { type EpochSchedule, type GetProgramAccountsFilter, PublicKey } from '@solana/web3.js';

import { SnapshotCache } from '../Lib/SnapshotCache';

const logger = Logger.create('EpochProgramSource');

/** A decoded program account and its address. */
export interface ProgramAccount<T> {
  address: string;
  account: T;
}

export interface ProgramEpochInfo {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
}

type CacheKey = 'pool' | 'feeIndex' | 'positions' | 'advances' | 'lenders' | 'withdrawRequests' | 'quotes' | 'swaps';

/** Which cached reads a program event makes stale. */
const STALE_AFTER: Partial<Record<EventName, CacheKey[]>> = {
  PoolInitialized: ['pool'],
  ParamsUpdated: ['pool', 'feeIndex'],
  PauseToggled: ['pool'],
  Deposited: ['pool', 'lenders'],
  WithdrawRequested: ['pool', 'lenders', 'withdrawRequests'],
  WithdrawCancelled: ['pool', 'lenders', 'withdrawRequests'],
  WithdrawProcessed: ['pool', 'lenders', 'withdrawRequests'],
  Accrued: ['pool'],
  ValidatorOnboarded: ['pool', 'positions'],
  CollectorsSet: ['positions'],
  ScoreUpdated: ['positions'],
  BondPosted: ['pool', 'positions'],
  BondWithdrawn: ['pool', 'positions'],
  AdvanceOpened: ['pool', 'positions', 'advances'],
  Swept: ['pool', 'positions', 'advances'],
  AdvanceRepaid: ['pool', 'positions', 'advances'],
  AdvanceDefaulted: ['pool', 'positions', 'advances'],
  CommissionUpdated: ['positions'],
  IdentityUpdated: ['positions'],
  ValidatorReleased: ['pool', 'positions'],
  IndexProposed: ['feeIndex'],
  IndexFinalized: ['feeIndex'],
  IndexVetoed: ['feeIndex'],
  QuotePosted: ['quotes'],
  SwapOpened: ['quotes', 'swaps'],
  SwapSettled: ['quotes', 'swaps'],
};

/** `https://x` → `wss://x`, `http://x` → `ws://x` (web3.js does the same when no wsEndpoint is given). */
export const toWsUrl = (httpUrl: string): string => httpUrl.replace(/^http/, 'ws');

/**
 * Reads the Epoch program's accounts on its own cluster (devnet for now) through epoch-sdk decoders, with short
 * caches that program events invalidate. Program endpoints answer 503 `PROGRAM_NOT_CONFIGURED` until
 * `EPOCH_PROGRAM_ID` is set and 503 `POOL_NOT_INITIALIZED` until the Pool account exists.
 */
export class EpochProgramSource {
  readonly programId?: PublicKey;
  readonly marketMaker?: PublicKey;
  readonly cluster: EpochProgramConfig['EPOCH_CLUSTER'];
  readonly connections: ConnectionManager;

  private readonly poolCache: SnapshotCache<ProgramAccount<PoolAccount> | null>;
  private readonly feeIndexCache: SnapshotCache<ProgramAccount<FeeIndexAccount> | null>;
  private readonly positionsCache: SnapshotCache<ProgramAccount<ValidatorPositionAccount>[]>;
  private readonly advancesCache: SnapshotCache<ProgramAccount<AdvanceAccount>[]>;
  private readonly lendersCache: SnapshotCache<ProgramAccount<LenderSharesAccount>[]>;
  private readonly withdrawCache: SnapshotCache<ProgramAccount<WithdrawRequestAccount>[]>;
  private readonly quotesCache: SnapshotCache<ProgramAccount<FeeQuoteAccount>[]>;
  private readonly swapsCache: SnapshotCache<ProgramAccount<SwapPositionAccount>[]>;
  private readonly epochCache: SnapshotCache<ProgramEpochInfo>;
  private schedule?: Promise<EpochSchedule>;

  constructor(config: EpochProgramConfig) {
    this.cluster = config.EPOCH_CLUSTER;
    this.programId = config.EPOCH_PROGRAM_ID ? new PublicKey(config.EPOCH_PROGRAM_ID) : undefined;
    this.marketMaker = config.EPOCH_MARKET_MAKER ? new PublicKey(config.EPOCH_MARKET_MAKER) : undefined;
    this.connections = new ConnectionManager(config.EPOCH_RPC_URL, config.EPOCH_RPC_FALLBACK_URL, 'confirmed');
    this.poolCache = new SnapshotCache('program.pool', 10_000, () => this.loadPool());
    this.feeIndexCache = new SnapshotCache('program.feeIndex', 10_000, () => this.loadFeeIndex());
    this.positionsCache = new SnapshotCache('program.positions', 30_000, () =>
      this.loadAll('ValidatorPosition', decodeValidatorPosition),
    );
    this.advancesCache = new SnapshotCache('program.advances', 30_000, () => this.loadAll('Advance', decodeAdvance));
    this.lendersCache = new SnapshotCache('program.lenders', 60_000, () =>
      this.loadAll('LenderShares', decodeLenderShares),
    );
    this.withdrawCache = new SnapshotCache('program.withdrawRequests', 30_000, () =>
      this.loadAll('WithdrawRequest', decodeWithdrawRequest),
    );
    this.quotesCache = new SnapshotCache('program.quotes', 15_000, () =>
      this.loadAll(
        'FeeQuote',
        decodeFeeQuote,
        this.marketMaker ? [fieldFilter('FeeQuote', 'maker', this.marketMaker)] : [],
      ),
    );
    this.swapsCache = new SnapshotCache('program.swaps', 15_000, () =>
      this.loadAll('SwapPosition', decodeSwapPosition),
    );
    this.epochCache = new SnapshotCache('program.epochInfo', 5_000, async () => {
      const info = await this.connections.withFailover((c) => c.getEpochInfo('confirmed'));
      return {
        epoch: info.epoch,
        slotIndex: info.slotIndex,
        slotsInEpoch: info.slotsInEpoch,
        absoluteSlot: info.absoluteSlot,
      };
    });
  }

  /** True when EPOCH_PROGRAM_ID is set. */
  get configured(): boolean {
    return this.programId !== undefined;
  }

  /** The program id; 503 PROGRAM_NOT_CONFIGURED when unset. */
  requireProgramId(): PublicKey {
    if (!this.programId) {
      throw new ServiceUnavailableException(
        "The Epoch program isn't deployed on this API yet: set EPOCH_PROGRAM_ID",
        'PROGRAM_NOT_CONFIGURED',
        { cluster: this.cluster },
      );
    }
    return this.programId;
  }

  poolAddress(): PublicKey {
    return findPoolPda(this.requireProgramId())[0];
  }

  /** The Pool, or null before `initialize_pool`. */
  async pool(): Promise<ProgramAccount<PoolAccount> | null> {
    this.requireProgramId();
    return this.poolCache.get();
  }

  /** The Pool; 503 POOL_NOT_INITIALIZED before `initialize_pool`. */
  async requirePool(): Promise<ProgramAccount<PoolAccount>> {
    const pool = await this.pool();
    if (!pool) {
      throw new ServiceUnavailableException(
        "The Epoch program is deployed but its Pool isn't initialized yet",
        'POOL_NOT_INITIALIZED',
        { cluster: this.cluster, programId: this.programId?.toBase58() },
      );
    }
    return pool;
  }

  /** The FeeIndex account, or null before `initialize_index`. */
  async feeIndex(): Promise<ProgramAccount<FeeIndexAccount> | null> {
    this.requireProgramId();
    return this.feeIndexCache.get();
  }

  async positions(): Promise<ProgramAccount<ValidatorPositionAccount>[]> {
    this.requireProgramId();
    return this.positionsCache.get();
  }

  /** One validator's position, read directly (fresh), or null when not onboarded. */
  async position(vote: string): Promise<ProgramAccount<ValidatorPositionAccount> | null> {
    const programId = this.requireProgramId();
    const address = findPositionPda(programId, new PublicKey(vote))[0];
    const info = await this.connections.withFailover((c) => c.getAccountInfo(address, 'confirmed'));
    if (!info || !info.owner.equals(programId)) return null;
    return { address: address.toBase58(), account: decodeValidatorPosition(info.data) };
  }

  /** Positions whose operator is `address` (cached list, filtered). */
  async positionsByOperator(address: string): Promise<ProgramAccount<ValidatorPositionAccount>[]> {
    return (await this.positions()).filter((p) => p.account.operator.toBase58() === address);
  }

  async advances(): Promise<ProgramAccount<AdvanceAccount>[]> {
    this.requireProgramId();
    return this.advancesCache.get();
  }

  async lenders(): Promise<ProgramAccount<LenderSharesAccount>[]> {
    this.requireProgramId();
    return this.lendersCache.get();
  }

  /** A wallet's two Lender PDAs, read directly (fresh); null for a tranche it never deposited into. */
  async lenderAccounts(owner: string): Promise<Record<Tranche, ProgramAccount<LenderSharesAccount> | null>> {
    const programId = this.requireProgramId();
    const pool = this.poolAddress();
    const ownerKey = new PublicKey(owner);
    const keys = (['senior', 'junior'] as const).map((tranche) => findLenderPda(programId, pool, ownerKey, tranche)[0]);
    const infos = await this.connections.withFailover((c) => c.getMultipleAccountsInfo(keys, 'confirmed'));
    const read = (index: number): ProgramAccount<LenderSharesAccount> | null => {
      const info = infos[index];
      if (!info || !info.owner.equals(programId)) return null;
      return { address: keys[index].toBase58(), account: decodeLenderShares(info.data) };
    };
    return { senior: read(0), junior: read(1) };
  }

  /** Open (not yet processed) withdrawal requests, cancelled ones included. */
  async withdrawRequests(): Promise<ProgramAccount<WithdrawRequestAccount>[]> {
    this.requireProgramId();
    return this.withdrawCache.get();
  }

  /** FeeQuote accounts of Epoch's market maker (all makers when EPOCH_MARKET_MAKER is unset). */
  async quotes(): Promise<ProgramAccount<FeeQuoteAccount>[]> {
    this.requireProgramId();
    return this.quotesCache.get();
  }

  /** Every open SwapPosition (settled ones are closed by settle_swap). */
  async swaps(): Promise<ProgramAccount<SwapPositionAccount>[]> {
    this.requireProgramId();
    return this.swapsCache.get();
  }

  /** The program cluster's epoch and slot (cached 5 s). */
  async epochInfo(): Promise<ProgramEpochInfo> {
    return this.epochCache.get();
  }

  /** The cluster's epoch schedule (read once). */
  async epochSchedule(): Promise<EpochSchedule> {
    if (!this.schedule) {
      this.schedule = this.connections
        .withFailover((c) => c.getEpochSchedule())
        .catch((error: unknown) => {
          this.schedule = undefined;
          throw error;
        });
    }
    return this.schedule;
  }

  async epochOfSlot(slot: number): Promise<number> {
    return (await this.epochSchedule()).getEpoch(slot);
  }

  async firstSlotOfEpoch(epoch: number): Promise<number> {
    return (await this.epochSchedule()).getFirstSlotInEpoch(epoch);
  }

  /** Drops the cached reads an event makes stale (called by the event ingester). */
  invalidateFor(event: EventName): void {
    for (const key of STALE_AFTER[event] ?? []) this.invalidate(key);
  }

  invalidate(key: CacheKey | 'all' = 'all'): void {
    const caches: Record<CacheKey, { invalidate(): void }> = {
      pool: this.poolCache,
      feeIndex: this.feeIndexCache,
      positions: this.positionsCache,
      advances: this.advancesCache,
      lenders: this.lendersCache,
      withdrawRequests: this.withdrawCache,
      quotes: this.quotesCache,
      swaps: this.swapsCache,
    };
    if (key === 'all') Object.values(caches).forEach((cache) => cache.invalidate());
    else caches[key].invalidate();
  }

  private async loadPool(): Promise<ProgramAccount<PoolAccount> | null> {
    const programId = this.requireProgramId();
    const address = findPoolPda(programId)[0];
    const info = await this.connections.withFailover((c) => c.getAccountInfo(address, 'confirmed'));
    if (!info || !info.owner.equals(programId)) return null;
    return { address: address.toBase58(), account: decodePool(info.data) };
  }

  private async loadFeeIndex(): Promise<ProgramAccount<FeeIndexAccount> | null> {
    const programId = this.requireProgramId();
    const address = findFeeIndexPda(programId, findPoolPda(programId)[0])[0];
    const info = await this.connections.withFailover((c) => c.getAccountInfo(address, 'confirmed'));
    if (!info || !info.owner.equals(programId)) return null;
    return { address: address.toBase58(), account: decodeFeeIndex(info.data) };
  }

  private async loadAll<T>(
    name: AccountName,
    decode: (data: Uint8Array) => T,
    extra: GetProgramAccountsFilter[] = [],
  ): Promise<ProgramAccount<T>[]> {
    const programId = this.requireProgramId();
    const accounts = await this.connections.withFailover((c) =>
      c.getProgramAccounts(programId, { commitment: 'confirmed', filters: [...accountFilters(name), ...extra] }),
    );
    const out: ProgramAccount<T>[] = [];
    for (const { pubkey, account } of accounts) {
      try {
        out.push({ address: pubkey.toBase58(), account: decode(account.data) });
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
