import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { LaunchRegistry, parseLaunchRegistry } from './LaunchRegistry';

const EXAMPLE = readFileSync(join(__dirname, '../../../launches.example.json'), 'utf8');

describe('parseLaunchRegistry', () => {
  it('accepts the example registry', () => {
    const entries = parseLaunchRegistry(EXAMPLE);
    expect(entries.map((entry) => entry.symbol)).toEqual(['rKEST', 'rSALT', 'rTIDE']);
    expect(entries[2]).toMatchObject({ opensAtEpoch: 1176, dbcPool: null, cluster: 'devnet' });
  });

  it('defaults a missing vote to null', () => {
    const [entry] = JSON.parse(EXAMPLE) as Record<string, unknown>[];
    const parsed = parseLaunchRegistry(JSON.stringify([{ ...entry, validator: { name: 'Kestrel Nodes' } }]));
    expect(parsed[0].validator).toEqual({ name: 'Kestrel Nodes', vote: null });
  });

  it('refuses bad keys and bad numbers with 503 LAUNCH_REGISTRY_INVALID, listing the issues', () => {
    const [entry] = JSON.parse(EXAMPLE) as Record<string, unknown>[];
    try {
      parseLaunchRegistry(
        JSON.stringify([
          { ...entry, mint: 'not-a-key', shareBps: 0 },
          { ...entry, cluster: 'testnet' },
        ]),
      );
      throw new Error('expected a failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'LAUNCH_REGISTRY_INVALID', statusCode: 503 });
      const issues = (error as { details: { issues: string[] } }).details.issues;
      expect(issues).toEqual([
        '0.mint: a base58 public key',
        expect.stringMatching(/^0\.shareBps: /),
        expect.stringMatching(/^1\.cluster: /),
      ]);
    }
    expect(() => parseLaunchRegistry('{ nope')).toThrow(expect.objectContaining({ code: 'LAUNCH_REGISTRY_INVALID' }));
    expect(() => parseLaunchRegistry('{}')).toThrow(expect.objectContaining({ code: 'LAUNCH_REGISTRY_INVALID' }));
  });

  it('refuses two launches of one mint', () => {
    const [entry] = JSON.parse(EXAMPLE) as Record<string, unknown>[];
    expect(() => parseLaunchRegistry(JSON.stringify([entry, entry]))).toThrow(
      expect.objectContaining({ details: { issues: ['1.mint: duplicate mint'] } }),
    );
  });
});

describe('LaunchRegistry', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'launches-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('serves nothing without a path, and an empty registry until the file exists', () => {
    expect(new LaunchRegistry(undefined).configured).toBe(false);
    expect(new LaunchRegistry(undefined).load()).toEqual([]);
    const registry = new LaunchRegistry(join(dir, 'launches.json'));
    expect(registry.configured).toBe(true);
    expect(registry.load()).toEqual([]);
  });

  it('re-reads the file when it changes', () => {
    const path = join(dir, 'launches.json');
    const [first, second] = JSON.parse(EXAMPLE) as unknown[];
    writeFileSync(path, JSON.stringify([first]));
    const registry = new LaunchRegistry(path);
    expect(registry.load()).toHaveLength(1);
    writeFileSync(path, JSON.stringify([first, second]));
    utimesSync(path, new Date(), new Date(Date.now() + 5_000));
    expect(registry.load()).toHaveLength(2);
  });
});
