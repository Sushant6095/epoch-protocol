/**
 * Pool parameters from a JSON file (lamport amounts as strings, like `pnpm operator init-pool --params`), checked
 * against the program's own `PoolParams::validate` rules before anything is sent, and compared field by field with
 * what is on chain so `init` can tell "already right" from "needs update_params".
 */
import fs from 'node:fs';
import path from 'node:path';

import type * as sdk from '@epoch/epoch-sdk';

import { KitError } from './errors';

export const DEFAULT_PARAMS_FILE = path.resolve(__dirname, '../../config/params.devnet.json');

const LAMPORT_FIELDS = ['minAdvanceLamports', 'maxAdvanceLamports', 'maxPoolAssets', 'voteReserveLamports'] as const;
const NUMBER_FIELDS = [
  'seniorRateBpsPerEpoch',
  'protocolFeeBps',
  'advanceBpsUnhedged',
  'advanceBpsHedged',
  'bondMultiplier',
  'feeBps',
  'remitBps',
  'minScore',
  'scoreTtlEpochs',
  'maxUtilizationBps',
  'minJuniorBps',
  'juniorLockEpochs',
  'maxAdvanceEpochs',
  'minCommissionBps',
] as const;
const BPS_FIELDS = [
  'protocolFeeBps',
  'advanceBpsUnhedged',
  'advanceBpsHedged',
  'feeBps',
  'remitBps',
  'minScore',
  'maxUtilizationBps',
  'minJuniorBps',
  'minCommissionBps',
] as const;
const U64_MAX = (1n << 64n) - 1n;

export const PARAM_FIELDS: (keyof sdk.PoolParams)[] = [...NUMBER_FIELDS, ...LAMPORT_FIELDS];

/** Parse and validate; throws `BAD_ARGS` naming the first bad field. */
export function parseParams(raw: unknown): sdk.PoolParams {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new KitError('BAD_ARGS', 'params must be an object');
  const obj = raw as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((k) => !(PARAM_FIELDS as string[]).includes(k));
  if (unknown.length) throw new KitError('BAD_ARGS', `unknown params: ${unknown.join(', ')}`);
  const out: Record<string, number | bigint> = {};
  for (const f of NUMBER_FIELDS) {
    const v = obj[f];
    const max = f === 'bondMultiplier' ? 0xff : 0xffff; // u8; every other number field is a u16
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
      throw new KitError('BAD_ARGS', `params.${f} must be an integer 0–${max}, got ${JSON.stringify(v)}`);
    }
    out[f] = v;
  }
  for (const f of LAMPORT_FIELDS) {
    const v = obj[f];
    if (typeof v !== 'string' || !/^\d+$/.test(v) || BigInt(v) > U64_MAX) {
      throw new KitError('BAD_ARGS', `params.${f} must be lamports as a decimal string, got ${JSON.stringify(v)}`);
    }
    out[f] = BigInt(v);
  }
  const p = out as unknown as sdk.PoolParams;
  // The program's PoolParams::validate, mirrored so a bad file fails here and not in a transaction.
  for (const f of BPS_FIELDS) {
    if (p[f] > 10_000) throw new KitError('BAD_ARGS', `params.${f} is above 10,000 bps`);
  }
  if (p.remitBps === 0) throw new KitError('BAD_ARGS', 'params.remitBps must be > 0');
  if (p.maxUtilizationBps === 0) throw new KitError('BAD_ARGS', 'params.maxUtilizationBps must be > 0');
  if (p.advanceBpsHedged < p.advanceBpsUnhedged) {
    throw new KitError('BAD_ARGS', 'params.advanceBpsHedged must be ≥ advanceBpsUnhedged');
  }
  if (p.maxAdvanceLamports < p.minAdvanceLamports) {
    throw new KitError('BAD_ARGS', 'params.maxAdvanceLamports must be ≥ minAdvanceLamports');
  }
  if (p.maxAdvanceEpochs === 0) throw new KitError('BAD_ARGS', 'params.maxAdvanceEpochs must be > 0');
  return p;
}

export function loadParams(file = DEFAULT_PARAMS_FILE): sdk.PoolParams {
  if (!fs.existsSync(file)) throw new KitError('BAD_ARGS', `params file ${file} does not exist`);
  return parseParams(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export interface ParamDiff {
  field: keyof sdk.PoolParams;
  onChain: string;
  wanted: string;
}

/** Fields where the pool on chain differs from the file. */
export function diffParams(onChain: sdk.PoolParams, wanted: sdk.PoolParams): ParamDiff[] {
  return PARAM_FIELDS.filter((f) => BigInt(onChain[f]) !== BigInt(wanted[f])).map((f) => ({
    field: f,
    onChain: String(onChain[f]),
    wanted: String(wanted[f]),
  }));
}
