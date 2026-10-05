import { isRateLimited } from '../../Sources/ProgramLogsSource';
import { fetchFullTransaction } from './LaunchLiveChain';

const URL = 'http://127.0.0.1:38899';
const SIGNATURE = 'P2r3JR57VBGMCntNMaGpGYo5gCiG915M12yNf9C3bq78ByEF6vSaAhAsFEwXZommPWPyYJvxEAgkX947QxHdu9n';

describe('fetchFullTransaction', () => {
  const fetchMock = jest.fn();
  const realFetch = global.fetch;
  beforeEach(() => {
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });
  const answer = (body: unknown, status = 200) =>
    ({
      ok: status === 200,
      status,
      statusText: status === 429 ? 'Too Many Requests' : 'OK',
      json: async () => body,
    }) as Response;
  const versionAsked = (call: number) =>
    JSON.parse(fetchMock.mock.calls[call][1].body).params[1].maxSupportedTransactionVersion;

  it('asks for the full JSON transaction, any version up to 1', async () => {
    fetchMock.mockResolvedValueOnce(answer({ jsonrpc: '2.0', id: 1, result: { slot: 3_443 } }));
    expect(await fetchFullTransaction(URL, SIGNATURE)).toEqual({ slot: 3_443 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({
      method: 'getTransaction',
      params: [SIGNATURE, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }],
    });
  });

  it('retries with the version the node names, and passes null (not found) through', async () => {
    fetchMock
      .mockResolvedValueOnce(
        answer({
          error: {
            code: -32015,
            message:
              'Transaction version (2) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 2',
          },
        }),
      )
      .mockResolvedValueOnce(answer({ result: null }));
    expect(await fetchFullTransaction(URL, SIGNATURE)).toBeNull();
    expect([versionAsked(0), versionAsked(1)]).toEqual([1, 2]);
  });

  it('surfaces a 429 so the ingester backs off', async () => {
    fetchMock.mockResolvedValueOnce(answer({}, 429));
    const error = await fetchFullTransaction(URL, SIGNATURE).catch((e: unknown) => e);
    expect(isRateLimited(error)).toBe(true);
  });
});
