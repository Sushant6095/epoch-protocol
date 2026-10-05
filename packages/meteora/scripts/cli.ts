/**
 * Node helpers shared by the launch scripts: output, keypair files, the registry file, prompts, sending with priority
 * fees and confirmations, explorer links. Keypairs are read from paths and never printed or written.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { createInterface } from 'readline/promises';

import {
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  PublicKey,
  type Signer,
  SendTransactionError,
  type Transaction,
  type TransactionSignature,
  VersionedTransaction,
} from '@solana/web3.js';

import { type LaunchCluster, type LaunchRegistryEntry } from '../src';

export const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

export const err = (line = ''): void => {
  process.stderr.write(`${line}\n`);
};

/** ISO 8601 in India Standard Time, as everything shown to users. */
export const isoIst = (date: Date = new Date()): string =>
  `${new Date(date.getTime() + 330 * 60_000).toISOString().slice(0, 19)}+05:30`;

export const DEFAULT_RPC: Record<LaunchCluster, string> = {
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

const expandHome = (path: string): string => path.replace(/^~(?=$|\/)/, homedir());

/** Loads a Solana CLI keypair file. The secret stays in memory; only the public key is ever shown. */
export function loadKeypairFile(path: string, label: string): Keypair {
  const file = resolve(expandHome(path));
  if (!existsSync(file)) throw new Error(`${label}: no keypair file at ${file}`);
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${label}: ${file} is not a Solana CLI keypair file (a JSON array of 64 numbers)`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) {
    throw new Error(`${label}: ${file} is not a Solana CLI keypair file (a JSON array of 64 numbers)`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}

/** The registry file (a JSON array); a missing file is an empty registry. */
export function readRegistryFile(path: string): LaunchRegistryEntry[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed) || parsed.some((row) => typeof (row as { mint?: unknown })?.mint !== 'string')) {
    throw new Error(`${path}: expected a JSON array of launches`);
  }
  return parsed as LaunchRegistryEntry[];
}

/** Writes the registry through a temporary file, so the API never reads half a file. */
export function writeRegistryFile(path: string, entries: readonly LaunchRegistryEntry[]): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`);
  renameSync(temporary, path);
}

/** Replaces the launch of the same mint and cluster in the registry file (written atomically). */
export function replaceRegistryEntry(path: string, entry: LaunchRegistryEntry): void {
  const entries = readRegistryFile(path);
  const same = (candidate: LaunchRegistryEntry) => candidate.mint === entry.mint && candidate.cluster === entry.cluster;
  if (!entries.some(same)) throw new Error(`${entry.symbol} (${entry.mint}) is not in ${path}`);
  writeRegistryFile(
    path,
    entries.map((candidate) => (same(candidate) ? entry : candidate)),
  );
}

/** Asks a question on the terminal; resolves to the trimmed answer ('' without a terminal). */
export async function ask(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Explorer links: the public clusters, or a custom RPC (a local stand-in) through `customUrl`. */
export function explorer(kind: 'tx' | 'address', value: string, cluster: LaunchCluster, rpc: string): string {
  const isPublic = rpc === DEFAULT_RPC[cluster] || !/127\.0\.0\.1|localhost/.test(rpc);
  const query = isPublic
    ? cluster === 'mainnet'
      ? ''
      : `?cluster=${cluster}`
    : `?cluster=custom&customUrl=${encodeURIComponent(rpc)}`;
  return `https://explorer.solana.com/${kind}/${value}${query}`;
}

/** Adds a compute-unit price (priority fee) and, when known, a limit, unless the transaction already sets them. */
export function withPriorityFee(tx: Transaction, microLamports: number, unitLimit?: number): Transaction {
  const budgetProgram = ComputeBudgetProgram.programId;
  const hasBudget = (discriminator: number) =>
    tx.instructions.some((ix) => ix.programId.equals(budgetProgram) && ix.data[0] === discriminator);
  const pre = [];
  // ComputeBudget instruction tags: 2 = SetComputeUnitLimit, 3 = SetComputeUnitPrice.
  if (unitLimit && !hasBudget(2)) pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }));
  if (microLamports > 0 && !hasBudget(3)) pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  if (pre.length > 0) tx.instructions.unshift(...pre);
  return tx;
}

/** Wire size of a legacy transaction: one signature per required signer plus the message. */
export function transactionSize(tx: Transaction, feePayer: PublicKey): number {
  tx.feePayer = feePayer;
  tx.recentBlockhash ??= PublicKey.default.toBase58();
  const message = tx.compileMessage();
  return 1 + message.header.numRequiredSignatures * 64 + message.serialize().length;
}

export interface SimulationOutcome {
  ok: boolean;
  error: string | null;
  logs: string[];
  unitsConsumed: number | null;
  /** The payer's lamports after the simulated transaction (fees included), when the RPC returned them. */
  payerLamportsAfter: number | null;
}

/** Simulates without signatures (the RPC substitutes a recent blockhash), returning the payer's balance afterwards. */
export async function simulate(connection: Connection, tx: Transaction, payer: PublicKey): Promise<SimulationOutcome> {
  tx.feePayer = payer;
  tx.recentBlockhash ??= PublicKey.default.toBase58();
  const versioned = new VersionedTransaction(tx.compileMessage());
  const { value } = await connection.simulateTransaction(versioned, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: 'confirmed',
    accounts: { addresses: [payer.toBase58()], encoding: 'base64' },
  });
  return {
    ok: value.err === null,
    error: value.err === null ? null : JSON.stringify(value.err),
    logs: value.logs ?? [],
    unitsConsumed: value.unitsConsumed ?? null,
    payerLamportsAfter: value.accounts?.[0]?.lamports ?? null,
  };
}

/**
 * Signs and sends one transaction with a fresh blockhash and waits for `confirmed`; prints the signature and the
 * explorer link, or the program logs when it fails.
 */
export async function sendLabelled(params: {
  connection: Connection;
  tx: Transaction;
  signers: Signer[];
  label: string;
  cluster: LaunchCluster;
  rpc: string;
}): Promise<TransactionSignature> {
  const { connection, tx, signers, label } = params;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0].publicKey;
  tx.sign(...signers);
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(tx.serialize(), {
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    });
  } catch (error) {
    if (error instanceof SendTransactionError) {
      const logs = await error.getLogs(connection).catch(() => undefined);
      if (logs?.length) err(logs.join('\n'));
    }
    throw error;
  }
  // Printed before confirming: a send that times out may still land, and the signature is how to check.
  out(`${label.padEnd(18)} ${signature}`);
  out(`${''.padEnd(19)}${explorer('tx', signature, params.cluster, params.rpc)}`);
  let result: Awaited<ReturnType<Connection['confirmTransaction']>>;
  try {
    result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  } catch (error) {
    throw new Error(
      `${label}: sent as ${signature} but not confirmed (${error instanceof Error ? error.message : String(error)}); check it on the explorer before running again`,
    );
  }
  if (result.value.err) throw new Error(`${label} failed on chain: ${JSON.stringify(result.value.err)} (${signature})`);
  return signature;
}

/** Waits until every signature is finalized (or the timeout passes); returns the ones still not finalized. */
export async function waitFinalized(
  connection: Connection,
  signatures: readonly string[],
  timeoutMs = 120_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let pending = [...signatures];
  while (pending.length > 0 && Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses(pending, { searchTransactionHistory: true });
    pending = pending.filter((_, i) => value[i]?.confirmationStatus !== 'finalized');
    if (pending.length > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return pending;
}

/** BN, bigint and PublicKey values as strings, for printing SDK parameters (BN's own JSON is hex). */
export function printable(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && 'toArrayLike' in value && 'toString' in value) return String(value);
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(printable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, printable(inner)]));
  }
  return value;
}
