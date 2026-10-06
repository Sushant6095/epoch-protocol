import {
  buildTradeTx,
  type HolderLabels,
  type LaunchClaimsState,
  type LaunchRef,
  type LaunchTradeQuote,
  quoteTrade,
  readLaunchClaims,
  readTopHolders,
  type TopHolder,
  type TradeSide,
} from '@epoch/meteora';
import { type ConnectionManager } from '@epoch/solana';
import { Connection, PublicKey, type Transaction } from '@solana/web3.js';

import { redactUrl } from '../../Lib/Http';
import { RpcAnswerError } from '../../Sources/ProgramLogsSource';

/** A getSignaturesForAddress entry (newest first from the RPC). */
export interface PoolSignature {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}

/** The live reads and transactions of the Launch page, beyond `LaunchChainReader`. Tests pass fakes. */
export interface LaunchLiveChain {
  signatures(address: string, options: { until?: string; before?: string; limit: number }): Promise<PoolSignature[]>;
  /** The raw `getTransaction` result (JSON encoding, any version), or null when the node does not have it. */
  transaction(signature: string): Promise<unknown | null>;
  topHolders(mint: string, decimals: number, labels: HolderLabels): Promise<TopHolder[]>;
  claims(dbcPool: string, dbcConfig: string | null, dammPool: string | null): Promise<LaunchClaimsState | null>;
  quote(launch: LaunchRef, side: TradeSide, amount: number, slippageBps: number): Promise<LaunchTradeQuote>;
  build(
    launch: LaunchRef,
    side: TradeSide,
    amount: number,
    slippageBps: number,
    owner: string,
    minimumOut?: number,
  ): Promise<Transaction>;
}

/** JSON-RPC -32015: the transaction's version is newer than the request allowed (the message names the one to ask for). */
const UNSUPPORTED_VERSION = -32015;

async function postJsonRpc<T>(url: string, method: string, params: unknown[], timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${redactUrl(url)}`);
  const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new RpcAnswerError(body.error.code, body.error.message);
  return body.result as T;
}

/**
 * A full transaction (instructions and inner instructions, JSON encoding) over plain JSON-RPC: web3.js v1 refuses
 * transaction versions above 0, and devnet carries version-1 transactions. Asks for version 1, then for the version
 * the node names.
 */
export async function fetchFullTransaction(url: string, signature: string): Promise<unknown | null> {
  const request = (version: number) =>
    postJsonRpc<unknown | null>(url, 'getTransaction', [
      signature,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: version },
    ]);
  try {
    return await request(1);
  } catch (error) {
    const named =
      error instanceof RpcAnswerError && error.code === UNSUPPORTED_VERSION
        ? /"maxSupportedTransactionVersion":\s*(\d+)/.exec(error.message)
        : null;
    if (!named || Number(named[1]) <= 1) throw error;
    return request(Number(named[1]));
  }
}

/** Reads through `@epoch/meteora` and plain JSON-RPC on the launch cluster, with failover. */
export class RpcLaunchLiveChain implements LaunchLiveChain {
  /** Signatures and transactions: no web3.js retry on 429, the ingester backs off itself. */
  private readonly ingest: Connection;

  constructor(
    private readonly connections: ConnectionManager,
    private readonly url: string,
    /** The swap's priority fee, micro-lamports per compute unit (LAUNCH_TRADE_PRIORITY_MICROLAMPORTS). */
    private readonly priorityMicroLamports?: number,
  ) {
    this.ingest = new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  }

  async signatures(
    address: string,
    options: { until?: string; before?: string; limit: number },
  ): Promise<PoolSignature[]> {
    const rows = await this.ingest.getSignaturesForAddress(new PublicKey(address), options, 'confirmed');
    return rows.map((row) => ({
      signature: row.signature,
      slot: row.slot,
      err: row.err,
      blockTime: row.blockTime ?? null,
    }));
  }

  transaction(signature: string): Promise<unknown | null> {
    return fetchFullTransaction(this.url, signature);
  }

  topHolders(mint: string, decimals: number, labels: HolderLabels): Promise<TopHolder[]> {
    return this.connections.withFailover((connection) => readTopHolders({ connection, mint, decimals, labels }));
  }

  claims(dbcPool: string, dbcConfig: string | null, dammPool: string | null): Promise<LaunchClaimsState | null> {
    return this.connections.withFailover((connection) =>
      readLaunchClaims({ connection, dbcPool, dbcConfig, dammPool }),
    );
  }

  quote(launch: LaunchRef, side: TradeSide, amount: number, slippageBps: number): Promise<LaunchTradeQuote> {
    // Not through withFailover: a LaunchTradeError is an answer, not an RPC failure.
    return quoteTrade({ connection: this.connections.primary, launch, side, amount, slippageBps });
  }

  build(
    launch: LaunchRef,
    side: TradeSide,
    amount: number,
    slippageBps: number,
    owner: string,
    minimumOut?: number,
  ): Promise<Transaction> {
    return buildTradeTx({
      connection: this.connections.primary,
      launch,
      side,
      amount,
      slippageBps,
      owner,
      minimumOut,
      priorityMicroLamports: this.priorityMicroLamports,
    });
  }
}
