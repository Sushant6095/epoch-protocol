import { fetchTransactionLogs, isRateLimited, RpcAnswerError } from './ProgramLogsSource';

const URL = 'https://rpc.example/devnet';

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, statusText: status === 429 ? 'Too Many Requests' : 'OK' });

describe('fetchTransactionLogs', () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  afterAll(() => fetchMock.mockRestore());

  const sentConfig = (call: number) => JSON.parse(String(fetchMock.mock.calls[call][1]?.body)).params[1];

  it('asks for base64 and version 1, and reads only the meta', async () => {
    fetchMock.mockResolvedValueOnce(
      answer({
        result: {
          slot: 495_746_836,
          blockTime: 1_788_976_993,
          version: 1,
          transaction: ['AQID', 'base64'],
          meta: { err: null, logMessages: ['Program 1111 invoke [1]', 'Program 1111 success'], fee: 5000 },
        },
      }),
    );
    expect(await fetchTransactionLogs(URL, 'sig')).toEqual({
      slot: 495_746_836,
      blockTime: 1_788_976_993,
      meta: { err: null, logMessages: ['Program 1111 invoke [1]', 'Program 1111 success'] },
    });
    expect(sentConfig(0)).toEqual({ encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 1 });
  });

  it('asks again with the version the node names for a newer transaction', async () => {
    fetchMock.mockClear();
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
      .mockResolvedValueOnce(answer({ result: { slot: 7, blockTime: null, meta: { err: null, logMessages: [] } } }));
    expect(await fetchTransactionLogs(URL, 'sig')).toEqual({
      slot: 7,
      blockTime: null,
      meta: { err: null, logMessages: [] },
    });
    expect(sentConfig(1).maxSupportedTransactionVersion).toBe(2);
  });

  it('returns null for an unknown transaction and tells answers from 429s', async () => {
    fetchMock.mockResolvedValueOnce(answer({ result: null }));
    expect(await fetchTransactionLogs(URL, 'sig')).toBeNull();

    fetchMock.mockResolvedValueOnce(answer({ error: { code: -32009, message: 'Slot 5 was skipped' } }));
    const skipped = await fetchTransactionLogs(URL, 'sig').catch((error: unknown) => error);
    expect(skipped).toBeInstanceOf(RpcAnswerError);
    expect(skipped).toMatchObject({ code: -32009 });

    fetchMock.mockResolvedValueOnce(answer({}, 429));
    const limited = await fetchTransactionLogs(URL, 'sig').catch((error: unknown) => error);
    expect(limited).not.toBeInstanceOf(RpcAnswerError);
    expect(isRateLimited(limited)).toBe(true);
    // The URL's path (an API key, often) stays out of the message.
    expect(String(limited)).toBe('Error: 429 Too Many Requests from rpc.example');
  });
});
