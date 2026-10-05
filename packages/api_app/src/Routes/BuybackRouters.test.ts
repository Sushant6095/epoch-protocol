import { type AddressInfo } from 'net';

import { createRouter, ExpressAppServer, handle } from '@epoch/common_http_server';
import { PublicKey } from '@solana/web3.js';

import { BuybackFeed } from '../Services/Launch/BuybackFeed';
import { setBuybackFeed } from '../Services/Launch/BuybackFeedService';
import { buybackRouter } from './BuybackRouters';

const MINT = new PublicKey(new Uint8Array(32).fill(100)).toBase58();

describe('GET /v1/launches/:mint/buybacks', () => {
  let server: ExpressAppServer;
  let base: string;

  beforeAll(async () => {
    setBuybackFeed(
      new BuybackFeed({
        chain: {
          network: 'devnet',
          revenueTokenByMint: async () => null,
          escrowAvailable: async () => 0n,
          decimals: async () => 6,
          epochInfo: async () => ({ epoch: 1, slotIndex: 0, slotsInEpoch: 432_000, absoluteSlot: 432_000 }),
          escrowAddress: (vote) => vote,
          treasuryAddress: () => null,
        },
        events: { query: async () => [] },
      }),
    );
    // The launch router is mounted first in index.ts: `/:mint` must not swallow `/:mint/buybacks`.
    server = new ExpressAppServer({ appName: 'buyback-routers-test', port: 0 })
      .route(
        '/v1/launches',
        createRouter().get(
          '/:mint',
          handle(async () => ({ launch: true })),
        ),
      )
      .route('/v1/launches', buybackRouter);
    await server.start();
    base = `http://127.0.0.1:${(server.httpServer?.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    setBuybackFeed(undefined);
    await server.stop();
  });

  it('serves the feed next to the launch detail route', async () => {
    const reply = await fetch(`${base}/v1/launches/${MINT}/buybacks`);
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('public, max-age=30');
    expect(await reply.json()).toMatchObject({
      data: {
        mint: MINT,
        revenueToken: null,
        buybacks: [],
        treasury: { address: null, claims: [], claimable: `/v1/launches/${MINT}/fees` },
      },
    });
    expect(await (await fetch(`${base}/v1/launches/${MINT}`)).json()).toMatchObject({ data: { launch: true } });
  });

  it('validates the mint', async () => {
    expect((await fetch(`${base}/v1/launches/rKEST/buybacks`)).status).toBe(400);
  });
});
