import { findAssociatedTokenAddress } from '@epoch/epoch-sdk';
import { buildClaimTx, type ClaimableItem, type LaunchClaimsState, readLaunchClaims } from '@epoch/meteora';
import { type ConnectionManager, isExecutionFailure, TransactionSender } from '@epoch/solana';
import {
  ComputeBudgetProgram,
  type Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';

import { type ClaimLaunch } from './LaunchRegistryFile';

/** What a simulated claim did. */
export interface ClaimSimulation {
  ok: boolean;
  error: string | null;
}

/** The chain reads and writes the fee claims need. `RpcLaunchClaimChain` uses RPC; tests pass a fake. */
export interface LaunchClaimChain {
  /** Everything claimable from a launch now; null when its DBC pool does not exist. */
  readClaims(launch: ClaimLaunch): Promise<LaunchClaimsState | null>;
  /** Builds, signs (`signer` also pays) and sends one claim; resolves to the signature once confirmed. */
  sendClaim(launch: ClaimLaunch, claim: ClaimableItem, dammPool: string | null, signer: Keypair): Promise<string>;
  /** Simulates one claim as `signer` without a signature (dry run). */
  simulateClaim(
    launch: ClaimLaunch,
    claim: ClaimableItem,
    dammPool: string | null,
    signer: PublicKey,
  ): Promise<ClaimSimulation>;
  /**
   * Sends Epoch program instructions (a treasury claim) signed and paid by `cranker`; resolves to the signature once
   * confirmed.
   */
  sendProgramClaim(instructions: TransactionInstruction[], cranker: Keypair, computeUnitLimit: number): Promise<string>;
  /** Simulates Epoch program instructions as `cranker` without a signature (dry run). */
  simulateProgramClaim(
    instructions: TransactionInstruction[],
    cranker: PublicKey,
    computeUnitLimit: number,
  ): Promise<ClaimSimulation>;
  /** What the treasury's associated token account for `mint` holds (0 when it does not exist), base units. */
  treasuryTokenBalance(mint: PublicKey, treasury: PublicKey): Promise<bigint>;
}

/** Claims through `@epoch/meteora` on the launch cluster, with failover and a priority fee. */
export class RpcLaunchClaimChain implements LaunchClaimChain {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly computeUnitPriceMicroLamports: number,
  ) {}

  readClaims(launch: ClaimLaunch): Promise<LaunchClaimsState | null> {
    return this.connections.withFailover((connection) =>
      readLaunchClaims({ connection, dbcPool: launch.dbcPool, dbcConfig: launch.dbcConfig, dammPool: launch.dammPool }),
    );
  }

  async sendClaim(
    launch: ClaimLaunch,
    claim: ClaimableItem,
    dammPool: string | null,
    signer: Keypair,
  ): Promise<string> {
    const tx = await this.connections.withFailover((connection) =>
      buildClaimTx({ connection, claim, dbcPool: launch.dbcPool, dammPool, signer: signer.publicKey }),
    );
    // The sender rebuilds the transaction with a compute-unit price; program errors are not retried.
    return new TransactionSender(this.connections, signer).send(tx.instructions, [], {
      computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
      shouldRetry: (error) =>
        !isExecutionFailure({ message: String(error), logs: (error as { logs?: string[] }).logs }),
    });
  }

  async simulateClaim(
    launch: ClaimLaunch,
    claim: ClaimableItem,
    dammPool: string | null,
    signer: PublicKey,
  ): Promise<ClaimSimulation> {
    return this.connections.withFailover(async (connection) => {
      const tx = await buildClaimTx({ connection, claim, dbcPool: launch.dbcPool, dammPool, signer });
      const { value } = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      });
      return { ok: value.err === null, error: value.err === null ? null : JSON.stringify(value.err) };
    });
  }

  sendProgramClaim(
    instructions: TransactionInstruction[],
    cranker: Keypair,
    computeUnitLimit: number,
  ): Promise<string> {
    return new TransactionSender(this.connections, cranker).send(instructions, [], {
      computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
      computeUnitLimit,
      shouldRetry: (error) =>
        !isExecutionFailure({ message: String(error), logs: (error as { logs?: string[] }).logs }),
    });
  }

  async simulateProgramClaim(
    instructions: TransactionInstruction[],
    cranker: PublicKey,
    computeUnitLimit: number,
  ): Promise<ClaimSimulation> {
    return this.connections.withFailover(async (connection) => {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
        ...instructions,
      );
      tx.feePayer = cranker;
      tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
      const { value } = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      });
      return { ok: value.err === null, error: value.err === null ? null : JSON.stringify(value.err) };
    });
  }

  treasuryTokenBalance(mint: PublicKey, treasury: PublicKey): Promise<bigint> {
    return this.connections.withFailover(async (connection) => {
      const info = await connection.getAccountInfo(findAssociatedTokenAddress(treasury, mint), 'confirmed');
      // SPL Token account: amount (u64) at byte 64.
      return info && info.data.length >= 72 ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
    });
  }
}

/** The public key a claim must be signed by, or null for a permissionless one. */
export const claimSigner = (claim: ClaimableItem): PublicKey | null =>
  claim.signer ? new PublicKey(claim.signer) : null;
