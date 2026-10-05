import { instructionNameOf } from '@epoch/epoch-sdk';

import { key, pool, poolParamsJson, PROGRAM_ID } from './__fixtures__/accounts';
import { adminLabels, parsePoolParams, planInitPool, planSetPaused, planSetRoles } from './Admin';

const ADMIN = key(70);
const names = (plan: { instructions: { data: Buffer }[] }) => plan.instructions.map((ix) => instructionNameOf(ix.data));
const adminPool = (overrides = {}) => ({ ...pool(), admin: ADMIN, treasury: key(71), scorer: key(72), ...overrides });

describe('pool-admin plans', () => {
  it('parses a params file and refuses what PoolParams::validate refuses', () => {
    const ok = parsePoolParams(JSON.stringify(poolParamsJson));
    expect(ok.problems).toEqual([]);
    expect(ok.params).toMatchObject({ remitBps: 5_000, maxPoolAssets: 5_000_000_000_000n, bondMultiplier: 4 });

    expect(parsePoolParams('{').problems[0]).toContain('not JSON');
    expect(parsePoolParams('[]').problems).toEqual(['the params file must be a JSON object']);
    const { remitBps: _drop, ...missing } = poolParamsJson;
    expect(parsePoolParams(JSON.stringify(missing)).problems).toEqual(['remitBps is missing']);
    expect(parsePoolParams(JSON.stringify({ ...poolParamsJson, extra: 1 })).problems).toEqual([
      'unknown fields: extra',
    ]);
    expect(parsePoolParams(JSON.stringify({ ...poolParamsJson, bondMultiplier: 256 })).problems).toEqual([
      'bondMultiplier must be an integer from 0 to 255',
    ]);
    expect(parsePoolParams(JSON.stringify({ ...poolParamsJson, maxPoolAssets: -1 })).problems).toEqual([
      'maxPoolAssets must be a u64 (lamports)',
    ]);
    expect(parsePoolParams(JSON.stringify({ ...poolParamsJson, feeBps: 10_001 })).problems).toEqual([
      'feeBps is above 10,000 bps (BpsOutOfRange)',
    ]);
    expect(
      parsePoolParams(JSON.stringify({ ...poolParamsJson, advanceBpsHedged: 100, remitBps: 0, maxAdvanceEpochs: 0 }))
        .problems,
    ).toEqual([
      'remitBps must be above 0 (InvalidParams)',
      'advanceBpsHedged must be at least advanceBpsUnhedged (InvalidParams)',
      'maxAdvanceEpochs must be above 0 (InvalidParams)',
    ]);
  });

  it('init-pool: initialize_pool once, the signer as admin', () => {
    const { params } = parsePoolParams(JSON.stringify(poolParamsJson));
    const plan = planInitPool({ programId: PROGRAM_ID, signer: ADMIN, pool: null }, params, [], key(71), key(72));
    expect(names(plan)).toEqual(['initialize_pool']);
    expect(plan.problems).toEqual([]);
    expect(plan.instructions[0].keys[0]).toEqual({ pubkey: ADMIN, isSigner: true, isWritable: true });
    expect(plan.summary.find(([label]) => label === 'pool cap')?.[1]).toBe('5000 SOL');

    const again = planInitPool(
      { programId: PROGRAM_ID, signer: ADMIN, pool: adminPool() },
      params,
      [],
      key(71),
      key(72),
    );
    expect(again.problems).toEqual([expect.stringContaining('already exists')]);
    const bad = planInitPool(
      { programId: PROGRAM_ID, signer: ADMIN, pool: null },
      null,
      ['remitBps is missing'],
      key(71),
      ADMIN,
    );
    expect(bad.instructions).toEqual([]);
    expect(bad.problems).toEqual(['remitBps is missing']);
    expect(bad.warnings).toEqual([expect.stringContaining('the scorer is the admin key')]);
  });

  it('set-roles keeps the roles not given and refuses a signer that is not the admin', () => {
    const ctx = { programId: PROGRAM_ID, signer: ADMIN, pool: adminPool() };
    const plan = planSetRoles(ctx, { newAdmin: key(80) });
    expect(names(plan)).toEqual(['set_roles']);
    // Accounts: admin (signer), pool, treasury, scorer, new admin.
    expect(plan.instructions[0].keys.map((k) => k.pubkey)).toEqual([
      ADMIN,
      expect.anything(),
      key(71),
      key(72),
      key(80),
    ]);
    expect(plan.warnings[0]).toContain('the admin moves to');
    expect(plan.summary[1][1]).toContain('(unchanged)');
    expect(planSetRoles({ ...ctx, signer: key(99) }, { scorer: key(81) }).problems).toEqual([
      expect.stringContaining('NotAdmin'),
    ]);
    expect(planSetRoles({ ...ctx, pool: null }, { scorer: key(81) }).problems[0]).toContain('run init-pool first');
  });

  it('set-paused: one set_paused, says what pausing stops', () => {
    const ctx = { programId: PROGRAM_ID, signer: ADMIN, pool: adminPool() };
    const plan = planSetPaused(ctx, true);
    expect(names(plan)).toEqual(['set_paused']);
    expect(plan.instructions[0].data[8]).toBe(1);
    expect(plan.summary.find(([label]) => label === 'paused stops')?.[1]).toContain('buybacks');
    expect(planSetPaused(ctx, false).warnings).toEqual(['the pool is already running']);
    expect(adminLabels(ctx).get(ADMIN.toBase58())).toBe('signer (you)');
  });
});
