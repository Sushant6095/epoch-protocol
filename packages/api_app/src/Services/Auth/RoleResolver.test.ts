import { ServiceUnavailableException } from '@epoch/exceptions';

import { RoleResolver } from './RoleResolver';

const WALLET = 'tFPVqpVspft3xEmA9cEYZ23zNt4aCKTkK9maKoVDBDFt';

describe('RoleResolver', () => {
  it('reads each role from chain, caches 60 s and shares one lookup between concurrent callers', async () => {
    let now = 0;
    const calls = { delegator: 0, lender: 0, operator: 0 };
    const resolver = new RoleResolver(
      {
        delegator: async () => {
          calls.delegator++;
          return true;
        },
        lender: async () => {
          calls.lender++;
          return true;
        },
        operator: async () => {
          calls.operator++;
          return false;
        },
      },
      undefined,
      () => now,
    );
    const [a, b] = await Promise.all([resolver.rolesOf(WALLET), resolver.rolesOf(WALLET)]);
    expect(a).toEqual(['delegator', 'lender']);
    expect(b).toEqual(a);
    expect(calls).toEqual({ delegator: 1, lender: 1, operator: 1 });
    now = 59_000;
    await resolver.rolesOf(WALLET);
    expect(calls.delegator).toBe(1);
    now = 61_000;
    await resolver.rolesOf(WALLET);
    expect(calls.delegator).toBe(2);
  });

  it('leaves out a role whose lookup fails or times out, and retries it sooner', async () => {
    let now = 0;
    let lenderCalls = 0;
    const resolver = new RoleResolver(
      {
        delegator: async () => true,
        lender: async () => {
          lenderCalls++;
          throw new ServiceUnavailableException('no program', 'PROGRAM_NOT_CONFIGURED');
        },
        operator: () => new Promise<boolean>(() => undefined), // never answers
      },
      { ttlMs: 60_000, failureTtlMs: 10_000, timeoutMs: 20, maxCached: 100 },
      () => now,
    );
    expect(await resolver.rolesOf(WALLET)).toEqual(['delegator']);
    now = 11_000;
    expect(await resolver.rolesOf(WALLET)).toEqual(['delegator']);
    expect(lenderCalls).toBe(2);
  });
});
