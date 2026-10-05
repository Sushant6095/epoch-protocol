/**
 * Drives a launched revenue token through its lifecycle for a rehearsal (docs/runbooks/meteora-devnet-rehearsal.md):
 * trades from test wallets (through the API's POST /v1/launches/:mint/build, as the Launch page does, or built
 * locally), graduation, the permissionless migration to DAMM v2, a look at every claim, and recording transactions and
 * decoded accounts as test fixtures. Keypairs are read from paths and never printed.
 *
 *   pnpm --filter @epoch/meteora rehearse -- <command> --registry <launches.json> --symbol <SYM> --rpc <url> [options]
 *
 *   status                                          curve, DAMM v2 pool, claims
 *   trade --wallet <keypair> --side buy|sell --amount <n> [--api <url>] [--slippage-bps 100]
 *   migrate --payer <keypair> [--wait <seconds>]    wait for Meteora's migrator, then migrate it ourselves
 *   record --out <dir> --signatures a,b,c           raw getTransaction JSON + decoded launch accounts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';

import { Connection, Transaction } from '@solana/web3.js';

import {
  buildMigrateToDammV2Tx,
  buildTradeTx,
  decodeMeteoraEvents,
  launchTradesFromTransaction,
  type LaunchRegistryEntry,
  migrationReadiness,
  normalizeTransaction,
  quoteTrade,
  readDammPool,
  readLaunchClaims,
  readLaunchPool,
  readTokenMetadata,
  readTokenMint,
  type TradePoolInfo,
} from '../src';
import { err, explorer, loadKeypairFile, out, readRegistryFile, sendLabelled } from './cli';

const json = (value: unknown): string => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

interface Ctx {
  connection: Connection;
  rpc: string;
  entry: LaunchRegistryEntry;
  values: Record<string, string | boolean | undefined>;
}

async function dammPoolOf(ctx: Ctx): Promise<string | null> {
  if (ctx.entry.dammPool) return ctx.entry.dammPool;
  const pool = ctx.entry.dbcPool
    ? await readLaunchPool({ connection: ctx.connection, dbcPool: ctx.entry.dbcPool })
    : null;
  return pool?.dammPool ?? null;
}

async function status(ctx: Ctx): Promise<void> {
  const { connection, entry } = ctx;
  const pool = entry.dbcPool
    ? await readLaunchPool({ connection, dbcPool: entry.dbcPool, dbcConfig: entry.dbcConfig })
    : null;
  out(
    `Curve   ${json(pool && { price: pool.priceSol, raised: pool.quoteReserveSol, target: pool.migrationThresholdSol, progressPct: pool.curveProgressPct, complete: pool.curveComplete, migrated: pool.migrated, dammPool: pool.dammPool })}`,
  );
  const damm = await dammPoolOf(ctx);
  if (damm) out(`DAMM v2 ${json(await readDammPool({ connection, pool: damm }))}`);
  if (entry.dbcPool) {
    const claims = await readLaunchClaims({
      connection,
      dbcPool: entry.dbcPool,
      dbcConfig: entry.dbcConfig,
      dammPool: damm,
    });
    out(
      `Claims  ${json(claims?.items.map((item) => ({ kind: item.kind, available: item.available, lamports: item.lamports, tokens: item.tokens, reason: item.reason })))}`,
    );
    out(`LP      ${json(claims?.positions)}`);
  }
}

async function trade(ctx: Ctx): Promise<void> {
  const { connection, entry, values } = ctx;
  const wallet = loadKeypairFile(String(values.wallet), '--wallet');
  const side = values.side === 'sell' ? 'sell' : 'buy';
  const amount = Number(values.amount);
  const slippageBps = Number(values['slippage-bps'] ?? 100);
  if (!(amount > 0)) throw new Error('--amount must be positive');
  let tx: Transaction;
  let venue: string;
  if (values.api) {
    // The Launch page's path: quote, then build an unsigned transaction for the wallet, which signs and sends it.
    const base = `${String(values.api).replace(/\/+$/, '')}/v1/launches/${entry.mint}`;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { ok: boolean; data?: Record<string, unknown>; error?: unknown };
      if (!payload.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(payload.error)}`);
      return payload.data as Record<string, unknown>;
    };
    const quoted = await post('quote', { side, amount, slippageBps });
    const quote = quoted.quote as { minimumOut: number; venue: string; amountOut: number };
    out(`Quote   ${json(quoted.quote)} warnings ${json(quoted.warnings)}`);
    const built = await post('build', {
      side,
      amount,
      slippageBps,
      owner: wallet.publicKey.toBase58(),
      minimumOut: quote.minimumOut,
      consent: true,
    });
    tx = Transaction.from(Buffer.from(String(built.transaction), 'base64'));
    venue = quote.venue;
  } else {
    const dammPool = await dammPoolOf(ctx);
    const ref = {
      dbcPool: entry.dbcPool,
      dbcConfig: entry.dbcConfig,
      dammPool,
      mint: entry.mint,
      decimals: entry.decimals,
    };
    const quote = await quoteTrade({ connection, launch: ref, side, amount, slippageBps });
    out(`Quote   ${json(quote)}`);
    tx = await buildTradeTx({
      connection,
      launch: ref,
      side,
      amount,
      slippageBps,
      owner: wallet.publicKey,
      minimumOut: quote.minimumOut,
    });
    venue = quote.venue;
  }
  const signature = await sendLabelled({
    connection,
    tx,
    signers: [wallet],
    label: `${side} ${amount} (${venue})`,
    cluster: ctx.entry.cluster,
    rpc: ctx.rpc,
  });
  const raw = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: 'confirmed',
  });
  const normalized = normalizeTransaction(raw, signature);
  const dammPool = await dammPoolOf(ctx);
  const pools = new Map<string, TradePoolInfo>([
    [String(entry.dbcPool), { venue: 'dbc', baseDecimals: entry.decimals }],
  ]);
  if (dammPool) pools.set(dammPool, { venue: 'damm-v2', baseDecimals: entry.decimals, baseIsTokenA: true });
  out(
    `Events  ${decodeMeteoraEvents(normalized)
      .map((event) => `${event.program}:${event.name}`)
      .join(', ')}`,
  );
  out(`Trades  ${json(launchTradesFromTransaction(normalized, pools))}`);
}

async function migrate(ctx: Ctx): Promise<void> {
  const { connection, entry, values } = ctx;
  if (!entry.dbcPool) throw new Error('no DBC pool');
  const waitSeconds = Number(values.wait ?? 0);
  const deadline = Date.now() + waitSeconds * 1000;
  let readiness = await migrationReadiness(connection, entry.dbcPool);
  // Meteora's migrator usually graduates a complete curve within minutes; give it the chance first.
  while (readiness.ready && Date.now() < deadline) {
    out(`Waiting for Meteora's migrator (${Math.ceil((deadline - Date.now()) / 1000)} s left) …`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    readiness = await migrationReadiness(connection, entry.dbcPool);
  }
  if (!readiness.ready) {
    out(
      `Not migrating: ${readiness.reason}${readiness.reason === 'ALREADY_MIGRATED' ? " (Meteora's migrator, or an earlier run, did it)" : ''}`,
    );
    return;
  }
  const payer = loadKeypairFile(String(values.payer), '--payer');
  const { transaction, signers, dammPool, dammConfig } = await buildMigrateToDammV2Tx({
    connection,
    dbcPool: entry.dbcPool,
    payer: payer.publicKey,
  });
  out(
    `Migrating to DAMM v2 pool ${dammPool} (config ${dammConfig}), permissionless, paid by ${payer.publicKey.toBase58()}`,
  );
  await sendLabelled({
    connection,
    tx: transaction,
    signers: [payer, ...signers],
    label: 'migrateToDammV2',
    cluster: entry.cluster,
    rpc: ctx.rpc,
  });
  out(`DAMM v2 ${explorer('address', dammPool, entry.cluster, ctx.rpc)}`);
}

async function record(ctx: Ctx): Promise<void> {
  const { connection, entry, values } = ctx;
  const dir = String(values.out);
  mkdirSync(dir, { recursive: true });
  const signatures = String(values.signatures ?? '')
    .split(',')
    .filter(Boolean);
  for (const signature of signatures) {
    const response = await fetch(ctx.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransaction',
        params: [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
      }),
    });
    const body = (await response.json()) as { result: unknown };
    if (!body.result) err(`not available (pruned?): ${signature}`);
    writeFileSync(join(dir, `${signature.slice(0, 16)}.json`), `${JSON.stringify(body.result)}\n`);
  }
  const dammPool = await dammPoolOf(ctx);
  const accounts = {
    curve: entry.dbcPool
      ? await readLaunchPool({ connection, dbcPool: entry.dbcPool, dbcConfig: entry.dbcConfig })
      : null,
    damm: dammPool ? await readDammPool({ connection, pool: dammPool }) : null,
    claims: entry.dbcPool
      ? await readLaunchClaims({ connection, dbcPool: entry.dbcPool, dbcConfig: entry.dbcConfig, dammPool })
      : null,
    mint: await readTokenMint({ connection, mint: entry.mint }),
    metadata: await readTokenMetadata({ connection, mint: entry.mint }),
  };
  writeFileSync(join(dir, 'accounts.json'), `${json(accounts)}\n`);
  out(`Recorded ${signatures.length} transactions and the decoded accounts in ${dir}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2).filter((arg) => arg !== '--');
  const { values } = parseArgs({
    args: rest,
    options: {
      registry: { type: 'string' },
      symbol: { type: 'string' },
      rpc: { type: 'string' },
      wallet: { type: 'string' },
      side: { type: 'string' },
      amount: { type: 'string' },
      'slippage-bps': { type: 'string' },
      api: { type: 'string' },
      payer: { type: 'string' },
      wait: { type: 'string' },
      out: { type: 'string' },
      signatures: { type: 'string' },
    },
    strict: true,
  });
  const registry = values.registry ?? process.env.LAUNCHES_PATH;
  if (!command || !registry || !values.symbol) {
    out(readFileSync(__filename, 'utf8').split('*/')[0]);
    process.exit(2);
  }
  const entry = readRegistryFile(registry).find((candidate) => candidate.symbol === values.symbol);
  if (!entry) throw new Error(`${values.symbol} is not in ${registry}`);
  const rpc = values.rpc ?? process.env.LAUNCH_RPC_URL ?? 'https://api.devnet.solana.com';
  const ctx: Ctx = { connection: new Connection(rpc, 'confirmed'), rpc, entry, values };
  const commands: Record<string, (ctx: Ctx) => Promise<void>> = { status, trade, migrate, record };
  const run = commands[command];
  if (!run) throw new Error(`unknown command ${command} (status, trade, migrate, record)`);
  await run(ctx);
}

main().catch((error: unknown) => {
  err(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
