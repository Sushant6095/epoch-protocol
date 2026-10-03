import { Logger } from '@epoch/logger';
import {
  countTokenHolders,
  type DammPoolState,
  type LaunchPoolState,
  type LaunchRegistryEntry,
  readDammPool,
  readLaunchPool,
  readTokenMint,
  type TokenHolders,
  type TokenMintInfo,
} from '@epoch/meteora';
import { type ConnectionManager } from '@epoch/solana';
import { PublicKey } from '@solana/web3.js';

import { LAMPORTS_PER_SOL } from '../../Lib/Stats';

const logger = Logger.create('LaunchChain');

export interface LaunchEpochInfo {
  epoch: number;
  slotIndex: number;
  slotsInEpoch: number;
  absoluteSlot: number;
}

export interface HolderExclusions {
  /** Token accounts that are not holders: the pools' vaults. */
  accounts: string[];
  /** Owners that are not buyers: the escrow and the leftover receiver. */
  owners: string[];
}

/** Every chain read a launch needs, on the launch cluster. `RpcLaunchChainReader` reads RPC; tests pass fakes. */
export interface LaunchChainReader {
  epochInfo(): Promise<LaunchEpochInfo>;
  /** The DBC pool and its config; null when the pool does not exist yet. */
  launchPool(dbcPool: string, dbcConfig: string | null): Promise<LaunchPoolState | null>;
  dammPool(pool: string): Promise<DammPoolState | null>;
  mint(mint: string): Promise<TokenMintInfo | null>;
  holders(mint: string, tokenProgram: string, exclude: HolderExclusions): Promise<TokenHolders>;
  balanceSol(address: string): Promise<number>;
}

/** Reads through `@epoch/meteora` on the launch RPC, with failover. */
export class RpcLaunchChainReader implements LaunchChainReader {
  constructor(private readonly connections: ConnectionManager) {}

  epochInfo(): Promise<LaunchEpochInfo> {
    return this.connections.withFailover(async (connection) => {
      const info = await connection.getEpochInfo('confirmed');
      return {
        epoch: info.epoch,
        slotIndex: info.slotIndex,
        slotsInEpoch: info.slotsInEpoch,
        absoluteSlot: info.absoluteSlot,
      };
    });
  }

  launchPool(dbcPool: string, dbcConfig: string | null): Promise<LaunchPoolState | null> {
    return this.connections.withFailover((connection) => readLaunchPool({ connection, dbcPool, dbcConfig }));
  }

  dammPool(pool: string): Promise<DammPoolState | null> {
    return this.connections.withFailover((connection) => readDammPool({ connection, pool }));
  }

  mint(mint: string): Promise<TokenMintInfo | null> {
    return this.connections.withFailover((connection) => readTokenMint({ connection, mint }));
  }

  holders(mint: string, tokenProgram: string, exclude: HolderExclusions): Promise<TokenHolders> {
    return this.connections.withFailover((connection) =>
      countTokenHolders({ connection, mint, tokenProgram, exclude }),
    );
  }

  async balanceSol(address: string): Promise<number> {
    const lamports = await this.connections.withFailover((connection) =>
      connection.getBalance(new PublicKey(address), 'confirmed'),
    );
    return lamports / LAMPORTS_PER_SOL;
  }
}

/**
 * What the chain says about one launch. `undefined` = not read (the registry has no such account, or the read
 * failed: see `failed`); `null` = read, and the account does not exist.
 */
export interface LaunchChainSnapshot {
  pool?: LaunchPoolState | null;
  damm?: DammPoolState | null;
  mint?: TokenMintInfo | null;
  holders?: TokenHolders;
  escrowSol?: number;
  /** Names of the reads that failed. */
  failed: string[];
}

/** Reads one launch: its curve, then the DAMM v2 pool it graduated to, its mint, holders and escrow. */
export async function readLaunchChain(
  entry: LaunchRegistryEntry,
  reader: LaunchChainReader,
  holders: (mint: string, tokenProgram: string, exclude: HolderExclusions) => Promise<TokenHolders> = (...args) =>
    reader.holders(...args),
): Promise<LaunchChainSnapshot> {
  const failed: string[] = [];
  const attempt = async <T>(name: string, read: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await read();
    } catch (error) {
      failed.push(name);
      logger.warn('launch read failed', { mint: entry.mint, read: name, error: String(error) });
      return undefined;
    }
  };
  const { dbcPool, escrow } = entry;
  const [pool, mint, escrowSol] = await Promise.all([
    dbcPool ? attempt('curve pool', () => reader.launchPool(dbcPool, entry.dbcConfig ?? null)) : undefined,
    attempt('mint', () => reader.mint(entry.mint)),
    escrow ? attempt('escrow', () => reader.balanceSol(escrow)) : undefined,
  ]);
  const dammAddress = entry.dammPool ?? pool?.dammPool ?? null;
  const damm = dammAddress ? await attempt('DAMM v2 pool', () => reader.dammPool(dammAddress)) : undefined;
  const exclude: HolderExclusions = {
    accounts: [pool?.baseVault, damm ? (damm.baseIsTokenA ? damm.tokenAVault : damm.tokenBVault) : undefined].filter(
      (key): key is string => !!key,
    ),
    owners: [escrow, pool?.leftoverReceiver].filter((key): key is string => !!key),
  };
  const counted = mint ? await attempt('holders', () => holders(entry.mint, mint.tokenProgram, exclude)) : undefined;
  return { pool, damm, mint, holders: counted, escrowSol, failed };
}
