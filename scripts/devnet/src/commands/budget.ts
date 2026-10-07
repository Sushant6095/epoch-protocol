/**
 * `pnpm devnet budget --url devnet [--so target/deploy/epoch.so] [--max-len 1600000] [--params <json>]`
 *
 * The exact SOL each stage needs on the target cluster, from the cluster's own rent rate and the SDK's account sizes.
 * Needs no keys and sends nothing.
 */
import fs from 'node:fs';
import path from 'node:path';

import * as sdk from '@epoch/epoch-sdk';

import {
  type BudgetLine,
  deployLines,
  perByteFromRentOfZero,
  rentFromPerByte,
  roundUpSol,
  sol,
  totals,
  txFee,
} from '../lib/budget';
import { type Context } from '../lib/context';
import { KitError } from '../lib/errors';
import { INDEX_OPERATOR_FEE_FLOAT, ROLE_FEE_FLOAT } from '../lib/funding';
import { REPO_ROOT } from '../lib/keys';
import { out } from '../lib/log';
import { loadParams } from '../lib/params';
import { DEVNET_PLAN, seedLines } from '../seed/plan';
import { DEFAULT_INDEX_OPERATORS } from './init';

export const BUDGET_OPTIONS = {
  so: { type: 'string' },
  'so-size': { type: 'string' },
  'max-len': { type: 'string' },
  params: { type: 'string' },
} as const;

/** The vote program's account size (VoteState v3/v4), as `programs/epoch/src/constants.rs` VOTE_STATE_SIZE. */
export const VOTE_ACCOUNT_SIZE = 3_762;

/** The build's size when no `.so` is at hand (1,261,400 bytes on 7 Oct 2026, with operator consensus and get_sfi). */
export const DEFAULT_SO_SIZE = 1_261_400;
/**
 * Program-data room reserved at the first deploy: 1.6 MB, so the program can grow through P1's validator-history
 * instructions and P2's index consensus (P2's build alone is 1.08 MB) and later upgrades without `program extend`.
 */
export const DEFAULT_MAX_LEN = 1_600_000;

export function defaultSoPath(): string {
  const target = process.env.CARGO_TARGET_DIR ?? path.join(REPO_ROOT, 'target');
  return path.join(target, 'deploy', 'epoch.so');
}

export function soSize(so: string | undefined, soSizeArg: string | undefined): { bytes: number; source: string } {
  if (soSizeArg) return { bytes: Number(soSizeArg), source: '--so-size' };
  const file = so ?? defaultSoPath();
  if (fs.existsSync(file)) return { bytes: fs.statSync(file).size, source: file };
  if (so) throw new KitError('BAD_ARGS', `--so ${so} does not exist`);
  return {
    bytes: DEFAULT_SO_SIZE,
    source: `no build at ${file}; the build size with operator consensus and get_sfi (7 Oct)`,
  };
}

/**
 * Pool, vault and Fee Index rent, the role wallets' fee floats and the treasury's rent-exempt minimum (all sent by the
 * deployer through `init`), plus the init transactions (funding, pool, index).
 */
export function initLines(
  rent: (len: number) => bigint,
  microLamportsPerCu: bigint,
  operators = DEFAULT_INDEX_OPERATORS,
): BudgetLine[] {
  const floats = Object.values(ROLE_FEE_FLOAT).reduce((a, b) => a + b, 0n);
  const consensus: BudgetLine[] = operators
    ? [
        {
          stage: 'init',
          item: `IndexOperators registry (${sdk.ACCOUNT_SIZES.IndexOperators} bytes)`,
          lamports: rent(sdk.ACCOUNT_SIZES.IndexOperators),
        },
        {
          stage: 'init',
          item: `fee floats of ${operators} Fee Index operators`,
          lamports: INDEX_OPERATOR_FEE_FLOAT * BigInt(operators),
          note: "votes and ballot rent (refunded on close); what is not spent stays in the operators' wallets",
        },
        {
          stage: 'init',
          item: 'initialize_index_operators + add_index_operator',
          lamports: txFee(1, microLamportsPerCu),
        },
      ]
    : [];
  return [
    { stage: 'init', item: `Pool account (${sdk.ACCOUNT_SIZES.Pool} bytes)`, lamports: rent(sdk.ACCOUNT_SIZES.Pool) },
    { stage: 'init', item: 'vault PDA (system account, rent-exempt minimum)', lamports: rent(0) },
    {
      stage: 'init',
      item: `Fee Index account (${sdk.ACCOUNT_SIZES.FeeIndex} bytes)`,
      lamports: rent(sdk.ACCOUNT_SIZES.FeeIndex),
    },
    {
      stage: 'init',
      item: `fee floats (${Object.keys(ROLE_FEE_FLOAT).join(', ')})`,
      lamports: floats,
      note: 'what is not spent on fees stays in the wallets',
    },
    { stage: 'init', item: 'treasury (system account, rent-exempt minimum)', lamports: rent(0) },
    {
      stage: 'init',
      item: 'fund roles, initialize_pool, initialize_index',
      lamports: txFee(1, microLamportsPerCu) * 3n,
    },
    ...consensus,
  ];
}

/**
 * The deployer is a system account: a transfer that would leave it above 0 but below its rent-exempt minimum fails
 * (rehearsal 12: cp1's funding was refused with 340,000 lamports to spare), so it keeps that minimum throughout.
 */
export function deployerReserveLine(rent: (len: number) => bigint): BudgetLine {
  return {
    stage: 'deploy',
    item: "the deployer's own rent-exempt minimum (it cannot spend below it)",
    lamports: rent(0),
    note: 'stays in the deployer',
  };
}

/** CP1's simulated revenue (swept back to the operator) and its operator's fee float. */
export const CP1_REVENUE = 10_000_000n;
export const CP1_FEE_FLOAT = 20_000_000n;

/**
 * `cp1`: the throwaway vote account with its sweep reserve, the position, escrow and identity rent, the operator's fee
 * float (it pays every fee) and the revenue the proof sweeps. `cp1` funds its operator with exactly the sum.
 */
export function cp1Lines(rent: (len: number) => bigint, voteReserve: bigint): BudgetLine[] {
  return [
    {
      stage: 'cp1',
      item: `throwaway vote account (rent, ${VOTE_ACCOUNT_SIZE} bytes) + sweep reserve`,
      lamports: rent(VOTE_ACCOUNT_SIZE) + voteReserve,
    },
    {
      stage: 'cp1',
      item: 'position, escrow and identity (rent)',
      lamports: rent(sdk.ACCOUNT_SIZES.ValidatorPosition) + rent(0) * 2n,
    },
    { stage: 'cp1', item: 'operator fee float (≈ 10 transactions)', lamports: CP1_FEE_FLOAT },
    {
      stage: 'cp1',
      item: 'revenue swept by the proof (back to the operator)',
      lamports: CP1_REVENUE,
      recoverable: true,
    },
  ];
}

export async function runBudget(
  ctx: Context,
  opts: { so?: string; 'so-size'?: string; 'max-len'?: string; params?: string },
): Promise<void> {
  const conn = ctx.cluster.connection;
  const rentOfZero = BigInt(await conn.getMinimumBalanceForRentExemption(0));
  const perByte = perByteFromRentOfZero(rentOfZero);
  const rent = rentFromPerByte(perByte);
  const probe = BigInt(await conn.getMinimumBalanceForRentExemption(10_000));
  if (probe !== rent(10_000)) {
    throw new KitError(
      'CHECK_FAILED',
      `rent is not linear on this cluster: rent(10000) = ${probe}, expected ${rent(10_000)}`,
    );
  }
  const { bytes, source } = soSize(opts.so, opts['so-size']);
  const maxLen = Number(opts['max-len'] ?? Math.max(DEFAULT_MAX_LEN, bytes));
  const lines = [
    ...deployLines({ soLen: bytes, maxLen, rent, microLamportsPerCu: ctx.priorityFee }),
    deployerReserveLine(rent),
    ...initLines(rent, ctx.priorityFee),
    ...seedLines(
      DEVNET_PLAN,
      rent,
      { voteAccount: VOTE_ACCOUNT_SIZE, voteReserve: loadParams(opts.params).voteReserveLamports },
      ctx.priorityFee,
    ),
    ...cp1Lines(rent, loadParams(opts.params).voteReserveLamports),
  ];

  out(`Budget for ${ctx.cluster.name} (${ctx.cluster.rpcUrl}, genesis ${ctx.cluster.genesisHash})`);
  out(
    `rent ${perByte} lamports/byte · program ${bytes} bytes (${source}) · max-len ${maxLen} · priority fee ${ctx.priorityFee} µlamports/CU`,
  );
  out('');
  for (const l of lines) {
    const kind = l.temporary ? 'peak only' : l.recoverable ? 'recoverable' : 'spent';
    out(`  ${l.stage.padEnd(7)} ${sol(l.lamports).padStart(15)} SOL  ${kind.padEnd(11)}  ${l.item}`);
  }
  const t = totals(lines);
  out('');
  out(`  spent       ${sol(t.spent)} SOL`);
  out(`  recoverable ${sol(t.recoverable)} SOL`);
  out(`  peak        ${sol(t.peak)} SOL  → send at least ${sol(roundUpSol(t.peak))} SOL to the deployer`);
}
