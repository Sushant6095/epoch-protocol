import { type ConnectionManager } from '@epoch/solana';
import { type Connection, type PublicKey } from '@solana/web3.js';

import { key } from '../__fixtures__/accounts';
import { MainnetData } from './MainnetData';

function connectionsWith(connection: Partial<Record<keyof Connection, jest.Mock>>): ConnectionManager {
  return {
    withFailover: <T>(fn: (c: Connection) => Promise<T>) => fn(connection as unknown as Connection),
  } as unknown as ConnectionManager;
}

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status === 200, status, json: async () => body }) as unknown as Response;

describe('MainnetData', () => {
  it('reads Jito MEV commissions, null for validators not running Jito', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        validators: [
          { vote_account: 'a', mev_commission_bps: 800, running_jito: true },
          { vote_account: 'b', mev_commission_bps: 1_000, running_jito: false },
          { vote_account: 'c', mev_commission_bps: null, running_jito: true },
        ],
      }),
    );
    const data = new MainnetData(connectionsWith({}), 'https://kobe.example/', fetchImpl as unknown as typeof fetch);
    const mev = await data.mevCommissions();
    expect(mev).toEqual(
      new Map([
        ['a', 800],
        ['b', null],
        ['c', null],
      ]),
    );
    expect(fetchImpl).toHaveBeenCalledWith('https://kobe.example/api/v1/validators', expect.anything());
  });

  it('fails (so the scorer retries) when Kobe is down', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, 503));
    const data = new MainnetData(connectionsWith({}), 'https://kobe.example', fetchImpl as unknown as typeof fetch);
    await expect(data.mevCommissions()).rejects.toThrow('HTTP 503');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  }, 15_000);

  it('reads vote accounts 100 at a time; a missing or unreadable one is null', async () => {
    const getMultipleAccountsInfo = jest.fn(async (keys: PublicKey[]) =>
      keys.map((k, i) => (i % 2 === 0 ? null : { data: Buffer.from([0, 0, 0, 0]), owner: k })),
    );
    const data = new MainnetData(connectionsWith({ getMultipleAccountsInfo }), 'https://kobe.example');
    const votes = Array.from({ length: 150 }, (_, i) => key(i % 250));
    const states = await data.voteStates(votes);
    expect(getMultipleAccountsInfo).toHaveBeenCalledTimes(2);
    expect((getMultipleAccountsInfo.mock.calls[0] as unknown[])[0]).toHaveLength(100);
    expect([...states.values()].every((s) => s === null)).toBe(true);
  });

  it('snapshots the epoch and the vote accounts', async () => {
    const data = new MainnetData(
      connectionsWith({
        getEpochInfo: jest.fn(async () => ({ epoch: 1_047 })),
        getVoteAccounts: jest.fn(async () => ({ current: [{ votePubkey: 'a' }], delinquent: [] })),
      }),
      'https://kobe.example',
    );
    await expect(data.voters()).resolves.toEqual({ epoch: 1_047, current: [{ votePubkey: 'a' }], delinquent: [] });
  });
});
