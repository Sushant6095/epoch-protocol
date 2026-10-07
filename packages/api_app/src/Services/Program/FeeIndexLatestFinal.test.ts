import { type AddressInfo } from 'net';

import { ExpressAppServer } from '@epoch/common_http_server';
import { type FeeIndexAccount, findFeeIndexPda, findPoolPda } from '@epoch/epoch-sdk';
import { Keypair, type PublicKey } from '@solana/web3.js';

import { feeIndexRouter } from '../../Routes/FeeIndexRouter';
import { latestFinal, type LatestFinalReader, setLatestFinalReader } from './FeeIndexLatestFinal';

const PROGRAM = Keypair.generate().publicKey;
const FEE_INDEX = findFeeIndexPda(PROGRAM, findPoolPda(PROGRAM)[0])[0].toBase58();
const NOW = Date.parse('2026-10-07T10:00:00Z');

/** The fields latestFinal reads; the rest of the account does not matter to it. */
function account(fields: Partial<FeeIndexAccount>): FeeIndexAccount {
  return {
    epoch: 0n,
    value: 0n,
    inputsHash: new Uint8Array(32),
    finalizedSlot: 0n,
    hasProposal: false,
    ...fields,
  } as FeeIndexAccount;
}

function reader(index: FeeIndexAccount | null, programId: PublicKey | null = PROGRAM): LatestFinalReader {
  return {
    configured: programId !== null,
    programId: programId ?? undefined,
    cluster: 'devnet',
    feeIndex: async () => (index ? { address: FEE_INDEX, account: index } : null),
  };
}

const FINAL = account({
  epoch: 1_176n,
  value: 1_400n,
  inputsHash: Uint8Array.from({ length: 32 }, (_, i) => i),
  finalizedSlot: 451_000_123n,
  // A newer proposal inside its window never shows: only the final point does.
  hasProposal: true,
  proposedEpoch: 1_177n,
  proposedValue: 9_999n,
});

describe('latestFinal (GET /v1/index/latest-final)', () => {
  it('answers the FeeIndex account’s last final point, not its pending proposal', async () => {
    expect(await latestFinal(reader(FINAL), NOW)).toEqual({
      schemaVersion: 1,
      kind: 'real',
      asOf: '2026-10-07T15:30:00+05:30',
      source: "The Epoch program's FeeIndex account",
      epoch: 1_176,
      value: 1_400,
      unit: 'µL/CU',
      finalizedSlot: 451_000_123,
      inputsHash: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
      cluster: 'devnet',
      programId: PROGRAM.toBase58(),
      feeIndexAccount: FEE_INDEX,
      methodology: expect.stringContaining('FEE_INDEX_METHODOLOGY.md'),
    });
  });

  it('is 404 until a value is final and 503 without the program', async () => {
    await expect(latestFinal(reader(null))).rejects.toMatchObject({ statusCode: 404 });
    const proposedOnly = account({ hasProposal: true, proposedEpoch: 1_176n, proposedValue: 1_400n });
    await expect(latestFinal(reader(proposedOnly))).rejects.toMatchObject({ statusCode: 404 });
    await expect(latestFinal(reader(FINAL, null))).rejects.toMatchObject({
      statusCode: 503,
      code: 'PROGRAM_NOT_CONFIGURED',
    });
  });
});

describe('GET /v1/index/latest-final', () => {
  let server: ExpressAppServer;
  let base: string;

  beforeAll(async () => {
    server = new ExpressAppServer({ appName: 'fee-index-latest-final-test', port: 0 }).route(
      '/v1/index',
      feeIndexRouter,
    );
    await server.start();
    base = `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setLatestFinalReader(undefined);
    await server.stop();
  });

  it('serves the final point with a short cache, and 404 before there is one', async () => {
    setLatestFinalReader(reader(FINAL));
    const res = await fetch(`${base}/v1/index/latest-final`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=15');
    expect(((await res.json()) as { data: unknown }).data).toMatchObject({
      epoch: 1_176,
      value: 1_400,
      feeIndexAccount: FEE_INDEX,
    });

    setLatestFinalReader(reader(null));
    const missing = await fetch(`${base}/v1/index/latest-final`);
    expect(missing.status).toBe(404);
  });
});
