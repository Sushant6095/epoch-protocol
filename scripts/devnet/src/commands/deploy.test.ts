import { Keypair } from '@solana/web3.js';

import { lastJson } from '../lib/run';
import { bufferKeyName, buildCommand, declaredId } from './deploy';

describe('deploy helpers', () => {
  it('reads declare_id! from lib.rs', () => {
    expect(declaredId('use x;\ndeclare_id!("11111111111111111111111111111111");\n')).toBe(
      '11111111111111111111111111111111',
    );
    expect(() => declaredId('fn main() {}')).toThrow(/declare_id/);
  });

  it('wraps the SBF build in flock with one job only when a lock is given', () => {
    const plain = buildCommand(undefined);
    expect(plain.cmd).toBe('cargo-build-sbf');
    expect(plain.args).toEqual(['--manifest-path', expect.stringMatching(/programs\/epoch\/Cargo\.toml$/)]);
    const locked = buildCommand('/tmp/sbf.lock');
    expect(locked.cmd).toBe('flock');
    expect(locked.args.slice(0, 4)).toEqual(['/tmp/sbf.lock', 'env', 'CARGO_BUILD_JOBS=1', 'cargo-build-sbf']);
    expect(locked.env.CARGO_BUILD_JOBS).toBe('1');
  });

  it('names the buffer key after the program, as a valid key name', () => {
    const id = Keypair.generate().publicKey;
    expect(bufferKeyName(id)).toMatch(/^buffer-[0-9a-f]{12}$/);
    expect(bufferKeyName(id)).toBe(bufferKeyName(id));
    expect(bufferKeyName(Keypair.generate().publicKey)).not.toBe(bufferKeyName(id));
  });

  it('parses the JSON a CLI prints after progress lines', () => {
    expect(lastJson<{ a: number }>('Writing...\n{"a": 1}\n')).toEqual({ a: 1 });
    expect(lastJson<{ b: string }>('{"b":"x"}')).toEqual({ b: 'x' });
    expect(() => lastJson('no json')).toThrow(/expected JSON/);
  });
});
