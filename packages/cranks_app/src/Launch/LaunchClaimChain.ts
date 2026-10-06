import { findAssociatedTokenAddress } from '@epoch/epoch-sdk';
import {
  buildClaimTx,
  buildMigrateToDammV2Tx,
  type ClaimableItem,
  type LaunchClaimsState,
  type MigrationReadiness,
  migrationReadiness,
  readLaunchClaims,
} from '@epoch/meteora';
import { type BeamRoute, type ConnectionManager, isExecutionFailure, TransactionSender } from '@epoch/solana';
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
  /** Whether the launch's curve can graduate now (`migration_damm_v2`), and the DAMM v2 pool it would create. */
  migrationReadiness(launch: ClaimLaunch): Promise<MigrationReadiness>;
  /** Builds, signs (`payer` plus the two fresh position NFT mints) and sends the migration; resolves once confirmed. */
  sendMigration(launch: ClaimLaunch, payer: Keypair): Promise<{ signature: string; dammPool: string }>;
  /** Simulates the migration as `payer` without a signature (dry run). */
  simulateMigration(launch: ClaimLaunch, payer: PublicKey): Promise<ClaimSimulation>;
}

/** DBC's `migrateToDammV2` builder asks for this much compute (it creates the pool and two positions). */
export const MIGRATION_COMPUTE_UNITS = 600_000;

/** Instructions without the builder's own compute budget (the sender sets the limit and the price once). */
const withoutComputeBudget = (instructions: TransactionInstruction[]): TransactionInstruction[] =>
  instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));

/**
 * Claims through `@epoch/meteora` on the launch cluster, with failover and a priority fee; through Solami Beam when a
 * route is given (mainnet with SOLAMI_BEAM_URL).
 */
export class RpcLaunchClaimChain implements LaunchClaimChain {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly computeUnitPriceMicroLamports: number,
    private readonly beam?: BeamRoute,
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
    return new TransactionSender(this.connections, signer, { beam: this.beam }).send(tx.instructions, [], {
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
    return new TransactionSender(this.connections, cranker, { beam: this.beam }).send(instructions, [], {
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

  migrationReadiness(launch: ClaimLaunch): Promise<MigrationReadiness> {
    return this.connections.withFailover((connection) => migrationReadiness(connection, launch.dbcPool));
  }

  async sendMigration(launch: ClaimLaunch, payer: Keypair): Promise<{ signature: string; dammPool: string }> {
    const built = await this.connections.withFailover((connection) =>
      buildMigrateToDammV2Tx({ connection, dbcPool: launch.dbcPool, payer: payer.publicKey }),
    );
    const signature = await new TransactionSender(this.connections, payer, { beam: this.beam }).send(
      withoutComputeBudget(built.transaction.instructions),
      built.signers,
      {
        computeUnitPriceMicroLamports: this.computeUnitPriceMicroLamports,
        computeUnitLimit: MIGRATION_COMPUTE_UNITS,
        shouldRetry: (error) =>
          !isExecutionFailure({ message: String(error), logs: (error as { logs?: string[] }).logs }),
      },
    );
    return { signature, dammPool: built.dammPool };
  }

  async simulateMigration(launch: ClaimLaunch, payer: PublicKey): Promise<ClaimSimulation> {
    return this.connections.withFailover(async (connection) => {
      const built = await buildMigrateToDammV2Tx({ connection, dbcPool: launch.dbcPool, payer });
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: MIGRATION_COMPUTE_UNITS }),
        ...withoutComputeBudget(built.transaction.instructions),
      );
      tx.feePayer = payer;
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
