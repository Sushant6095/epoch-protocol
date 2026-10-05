/**
 * Pool-admin plans for mainnet day: `initialize_pool`, `set_roles`, `set_paused`. The signer is the pool admin
 * (`--keypair`, or OPERATOR_KEYPAIR_PATH). Same shape as the operator plans: a summary, the instructions, and the
 * problems that would make the program refuse them (nothing is simulated or sent while there are any).
 */
import {
  findPoolPda,
  findVaultPda,
  initializePool,
  lamportsToSolString,
  type PoolAccount,
  type PoolParams,
  setPaused,
  setRoles,
} from '@epoch/epoch-sdk';
import { type PublicKey, SystemProgram } from '@solana/web3.js';

import { type Plan } from './Plans';

/** What a pool-admin command reads first. */
export interface AdminContext {
  programId: PublicKey;
  /** The signer (should be the pool admin; for init-pool it becomes the admin). */
  signer: PublicKey;
  /** The Pool account, or null before init-pool. */
  pool: PoolAccount | null;
}

const SPEC: Record<keyof PoolParams, 'u8' | 'u16' | 'u64'> = {
  seniorRateBpsPerEpoch: 'u16',
  protocolFeeBps: 'u16',
  advanceBpsUnhedged: 'u16',
  advanceBpsHedged: 'u16',
  bondMultiplier: 'u8',
  feeBps: 'u16',
  remitBps: 'u16',
  minScore: 'u16',
  scoreTtlEpochs: 'u16',
  minAdvanceLamports: 'u64',
  maxAdvanceLamports: 'u64',
  maxPoolAssets: 'u64',
  maxUtilizationBps: 'u16',
  minJuniorBps: 'u16',
  juniorLockEpochs: 'u16',
  maxAdvanceEpochs: 'u16',
  voteReserveLamports: 'u64',
  minCommissionBps: 'u16',
};

const BPS_FIELDS: (keyof PoolParams)[] = [
  'seniorRateBpsPerEpoch',
  'protocolFeeBps',
  'advanceBpsUnhedged',
  'advanceBpsHedged',
  'feeBps',
  'remitBps',
  'minScore',
  'maxUtilizationBps',
  'minJuniorBps',
  'minCommissionBps',
];

/**
 * Parses an init-pool params file: a JSON object with every `PoolParams` field (camelCase, as the SDK names them);
 * lamport amounts as decimal strings or safe integers. Returns the params, or the problems found.
 */
export function parsePoolParams(text: string): { params: PoolParams | null; problems: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { params: null, problems: [`the params file is not JSON: ${(error as Error).message}`] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { params: null, problems: ['the params file must be a JSON object'] };
  }
  const obj = raw as Record<string, unknown>;
  const problems: string[] = [];
  const unknown = Object.keys(obj).filter((k) => !(k in SPEC));
  if (unknown.length) problems.push(`unknown fields: ${unknown.join(', ')}`);
  const out: Record<string, number | bigint> = {};
  for (const [field, type] of Object.entries(SPEC)) {
    const value = obj[field];
    if (value === undefined) {
      problems.push(`${field} is missing`);
      continue;
    }
    if (type === 'u64') {
      const ok =
        (typeof value === 'string' && /^\d+$/.test(value)) ||
        (typeof value === 'number' && Number.isSafeInteger(value));
      const big = ok ? BigInt(value as string | number) : -1n;
      if (!ok || big < 0n || big > 0xffff_ffff_ffff_ffffn) problems.push(`${field} must be a u64 (lamports)`);
      else out[field] = big;
    } else {
      const max = type === 'u8' ? 0xff : 0xffff;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        problems.push(`${field} must be an integer from 0 to ${max}`);
      } else out[field] = value;
    }
  }
  if (problems.length) return { params: null, problems };
  const params = out as unknown as PoolParams;
  // `PoolParams::validate`, so a bad file fails here with the program's reason.
  for (const field of BPS_FIELDS) {
    if (params[field] > 10_000) problems.push(`${field} is above 10,000 bps (BpsOutOfRange)`);
  }
  if (params.remitBps === 0) problems.push('remitBps must be above 0 (InvalidParams)');
  if (params.maxUtilizationBps === 0) problems.push('maxUtilizationBps must be above 0 (InvalidParams)');
  if (params.advanceBpsHedged < params.advanceBpsUnhedged) {
    problems.push('advanceBpsHedged must be at least advanceBpsUnhedged (InvalidParams)');
  }
  if (params.maxAdvanceLamports < params.minAdvanceLamports) {
    problems.push('maxAdvanceLamports must be at least minAdvanceLamports (InvalidParams)');
  }
  if (params.maxAdvanceEpochs === 0) problems.push('maxAdvanceEpochs must be above 0 (InvalidParams)');
  return { params: problems.length ? null : params, problems };
}

const sol = (lamports: bigint) => `${lamportsToSolString(lamports)} SOL`;

function paramRows(p: PoolParams): [string, string][] {
  return [
    ['senior rate', `${p.seniorRateBpsPerEpoch} bps / epoch`],
    ['protocol fee', `${p.protocolFeeBps} bps of income`],
    ['advance (unhedged / hedged)', `${p.advanceBpsUnhedged} / ${p.advanceBpsHedged} bps of trailing revenue`],
    ['bond multiplier', `${p.bondMultiplier}x`],
    ['advance fee / remit', `${p.feeBps} / ${p.remitBps} bps`],
    ['min score, score TTL', `${p.minScore}, ${p.scoreTtlEpochs} epochs`],
    ['advance size', `${sol(p.minAdvanceLamports)} – ${sol(p.maxAdvanceLamports)}, ≤ ${p.maxAdvanceEpochs} epochs`],
    ['pool cap', sol(p.maxPoolAssets)],
    ['max utilization / min junior', `${p.maxUtilizationBps} / ${p.minJuniorBps} bps`],
    ['junior lock', `${p.juniorLockEpochs} epochs`],
    ['vote reserve', sol(p.voteReserveLamports)],
    ['min inflation commission', `${p.minCommissionBps} bps`],
  ];
}

function requireAdmin(ctx: AdminContext): string[] {
  if (!ctx.pool) return ['the Pool account does not exist: run init-pool first (or check EPOCH_PROGRAM_ID)'];
  if (!ctx.pool.admin.equals(ctx.signer)) {
    return [`the signer ${ctx.signer.toBase58()} is not the pool admin ${ctx.pool.admin.toBase58()} (NotAdmin)`];
  }
  return [];
}

/** `initialize_pool(params)`: the signer becomes the admin and pays the Pool's and the vault's rent. */
export function planInitPool(
  ctx: AdminContext,
  params: PoolParams | null,
  paramProblems: string[],
  treasury: PublicKey,
  scorer: PublicKey,
): Plan {
  const problems = [...paramProblems];
  if (ctx.pool) problems.push('the Pool account already exists (initialize_pool runs once per program)');
  const warnings: string[] = [];
  if (treasury.equals(ctx.signer)) warnings.push('the treasury (protocol fees) is the admin key itself');
  if (scorer.equals(ctx.signer)) warnings.push('the scorer is the admin key: give the scorer crank its own key');
  return {
    title: 'initialize_pool',
    summary: [
      ['program', ctx.programId.toBase58()],
      ['admin (signer, pays rent)', ctx.signer.toBase58()],
      ['treasury (protocol fees)', treasury.toBase58()],
      ['scorer', scorer.toBase58()],
      ...(params ? paramRows(params) : []),
    ],
    instructions: params
      ? initializePool({ programId: ctx.programId, admin: ctx.signer, treasury, scorer, params })
      : [],
    problems,
    warnings,
  };
}

/** `set_roles`: rotate treasury, scorer and admin; a role not given keeps its current key. */
export function planSetRoles(
  ctx: AdminContext,
  change: { newAdmin?: PublicKey; treasury?: PublicKey; scorer?: PublicKey },
): Plan {
  const problems = requireAdmin(ctx);
  const pool = ctx.pool;
  const next = {
    admin: change.newAdmin ?? pool?.admin ?? ctx.signer,
    treasury: change.treasury ?? pool?.treasury ?? ctx.signer,
    scorer: change.scorer ?? pool?.scorer ?? ctx.signer,
  };
  const warnings: string[] = [];
  if (pool && !next.admin.equals(pool.admin)) {
    warnings.push(
      `the admin moves to ${next.admin.toBase58()}: from then on only that key (e.g. the Squads vault) can pause, ` +
        'set params, roles and revenue-token settings',
    );
  }
  const row = (label: string, now: PublicKey | undefined, then: PublicKey): [string, string] => [
    label,
    now && now.equals(then) ? `${then.toBase58()} (unchanged)` : `${now?.toBase58() ?? '?'} → ${then.toBase58()}`,
  ];
  return {
    title: 'set_roles',
    summary: [
      row('admin', pool?.admin, next.admin),
      row('treasury', pool?.treasury, next.treasury),
      row('scorer', pool?.scorer, next.scorer),
    ],
    instructions: setRoles({
      programId: ctx.programId,
      admin: ctx.signer,
      treasury: next.treasury,
      scorer: next.scorer,
      newAdmin: next.admin,
    }),
    problems,
    warnings,
  };
}

/** `set_paused`: stops deposits, onboarding, advances, quotes and swaps, registrations, treasury claims and buybacks. */
export function planSetPaused(ctx: AdminContext, paused: boolean): Plan {
  const problems = requireAdmin(ctx);
  const warnings: string[] = [];
  if (ctx.pool && ctx.pool.paused === paused) warnings.push(`the pool is already ${paused ? 'paused' : 'running'}`);
  return {
    title: `set_paused: ${paused}`,
    summary: [
      ['pool', findPoolPda(ctx.programId)[0].toBase58()],
      ['now', ctx.pool ? (ctx.pool.paused ? 'paused' : 'running') : '?'],
      ['then', paused ? 'paused' : 'running'],
      [
        'paused stops',
        'deposit, onboard, request_advance, post_quote/open_swap, register_revenue_token, treasury claims, buybacks',
      ],
      ['still allowed', 'withdrawals, sweeps and repayments, release, redeem, close'],
    ],
    instructions: setPaused({ programId: ctx.programId, admin: ctx.signer, paused }),
    problems,
    warnings,
  };
}

/** Account names for the admin instructions. */
export function adminLabels(ctx: Pick<AdminContext, 'programId' | 'signer'>): Map<string, string> {
  const [pool] = findPoolPda(ctx.programId);
  return new Map([
    [ctx.signer.toBase58(), 'signer (you)'],
    [pool.toBase58(), 'pool'],
    [findVaultPda(ctx.programId, pool)[0].toBase58(), 'pool vault'],
    [SystemProgram.programId.toBase58(), 'system program'],
    [ctx.programId.toBase58(), 'Epoch program'],
  ]);
}
