import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StateStore, stateFile } from './state';

describe('StateStore', () => {
  let dir: string;
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devnet-kit-state-'))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs a step once and resumes from disk', async () => {
    const a = new StateStore(dir, 'seed', 'localnet', 'GENESIS1xyz', 'PROG');
    let calls = 0;
    const first = await a.step('deposit', async () => {
      calls++;
      return { signature: 'sig1', epoch: 3 };
    });
    expect(first).toMatchObject({ signature: 'sig1', epoch: 3 });
    const b = new StateStore(dir, 'seed', 'localnet', 'GENESIS1xyz', 'PROG');
    await b.step('deposit', async () => {
      calls++;
    });
    expect(calls).toBe(1);
    expect(b.done('deposit')?.signature).toBe('sig1');
    expect(b.movedAside).toBeNull();
  });

  it('does not record a step that throws', async () => {
    const s = new StateStore(dir, 'seed', 'localnet', 'G', 'P');
    await expect(s.step('x', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(s.done('x')).toBeUndefined();
  });

  it('moves aside state from another ledger or program', () => {
    const s = new StateStore(dir, 'seed', 'localnet', 'GENESIS1xyz', 'PROG');
    s.record('a');
    const other = new StateStore(dir, 'seed', 'localnet', 'GENESIS1xyz', 'OTHER');
    expect(other.movedAside).toMatch(/\.stale$/);
    expect(other.done('a')).toBeUndefined();
    expect(fs.existsSync(stateFile(dir, 'seed', 'GENESIS1xyz'))).toBe(false);
  });

  it('keys the file to the genesis hash prefix', () => {
    expect(stateFile('/s', 'cp1', 'EtWTRABZaYq6iMfe')).toBe('/s/cp1-EtWTRABZ.json');
  });
});
