/**
 * Panta API answers for tests, copied from the documented examples (https://docs.panta.market/api-reference/…, read
 * 3 Oct 2026) with the elided values ("…") filled in by deterministic test keys, plus `live*` shapes taken from the
 * types of Panta's playground (github.com/Kaito-HQ/panta-api-playground, `src/lib/types.ts`), which was written against
 * the live API. Test data only: never served.
 */
import { base58Encode } from '@epoch/epoch-sdk';
import { PublicKey } from '@solana/web3.js';

export const key = (n: number): string => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
export const signature = (n: number): string => base58Encode(new Uint8Array(64).fill(n));

export const WALLET = key(1);
export const MARKET = key(2);
export const CREATOR = key(3);
export const PANTA_PROGRAM = key(9);
export const VAULT_AUTHORITY = key(10);
export const MARKET_CONFIG = key(11);
export const SIGNATURE = signature(7);
export const BLOCKHASH = key(77);
/** Never real: the tests assert it never appears anywhere but the X-Api-Key header. */
export const API_KEY = 'pk_test_FAKE0000000000000000secret';

/** GET /account/ · api-reference/account/get.md */
export const account = {
  userId: 'usr_epoch',
  email: 'you@example.com',
  name: 'Acme',
  status: 'active',
  canCreateMarkets: true,
  createdAt: '2026-09-04T12:00:00.000000Z',
  apiKeyId: 'key_abc',
};

/** GET /account/dashboard/ · api-reference/account/dashboard.md */
export const dashboard = {
  account,
  keys: { active: 1, revoked: 0, total: 1 },
  metrics: {
    creates: { total: 3, byStatus: { registered: 2, pending: 1 } },
    trades: { total: 5, volumeUsdcBase: 125000000, byKind: { buy: 4, claim: 1 } },
  },
  permissions: { canCreateMarkets: true },
};

/** GET /account/metrics/ · api-reference/account/metrics.md */
export const metrics = {
  summary: {
    creates: { total: 1, byStatus: { registered: 1 } },
    trades: { total: 2, volumeUsdcBase: 40000000, byKind: { buy: 2 } },
    keys: { active: 1, revoked: 0, total: 1 },
  },
  creates: [
    {
      createId: 'cr_abc123',
      wallet: CREATOR,
      eventPda: MARKET,
      signature: SIGNATURE,
      status: 'registered',
      paymentUsdc: '50.00',
      paymentUsdcBase: '50000000',
      createdAt: '2026-09-04T12:00:00.000000Z',
      updatedAt: '2026-09-04T12:05:00.000000Z',
    },
  ],
  trades: [
    {
      signature: SIGNATURE,
      wallet: WALLET,
      marketId: MARKET,
      side: 'yes',
      kind: 'buy',
      amountUsdc: '20.00',
      amountUsdcBase: '20000000',
      status: 'processed',
      createdAt: '2026-09-04T12:00:00.000000Z',
    },
  ],
};

/** GET /account/creates/ · api-reference/account/creates.md */
export const creates = {
  summary: { total: 1, byStatus: { registered: 1 } },
  items: [metrics.creates[0]],
};

/** GET /account/trades/ · api-reference/account/trades.md */
export const attributedTrades = {
  summary: { total: 2, volumeUsdcBase: 40000000, byKind: { buy: 2 } },
  items: metrics.trades,
};

/** A list row · api-reference/markets/list.md */
export const marketRow = {
  marketId: MARKET,
  category: 'crypto',
  title: 'ETH above 5k?',
  description: 'Resolves from CoinGecko.',
  images: ['https://cdn.example.com/markets/eth-5k-1024.webp'],
  phase: 'primary',
  marketType: 'standard',
  startTime: 1767225600,
  endTime: 1798761599,
  resolutionTime: 1798765199,
  region: 'Global',
  resolved: false,
  status: 'open',
  volumeUsdc: '1200.00',
  campaignId: null,
  createdByPartner: true,
  yesPrice: null,
  noPrice: null,
  primaryYesPrice: null,
  primaryNoPrice: null,
  secondaryYesPrice: null,
  secondaryNoPrice: null,
};

export const marketList = { items: [marketRow], nextCursor: key(4) };

/** GET /markets/{marketId}/ · api-reference/markets/get.md */
export const market = {
  ...marketRow,
  yesPrice: '0.52',
  noPrice: '0.48',
  primaryYesPrice: '0.52',
  primaryNoPrice: '0.48',
};

const tapeRow = {
  id: 'trd_1',
  marketId: MARKET,
  wallet: WALLET,
  isPrimary: true,
  yesAmount: '10.00',
  noAmount: '0',
  feePaid: '0.05',
  blockTime: 1767225600,
  signature: SIGNATURE,
  quoteAsset: 'USDC',
};

/** GET /markets/{marketId}/trades/ · api-reference/markets/trades.md */
export const marketTrades = { marketId: MARKET, items: [tapeRow] };

/** live (playground `MarketCatalogItem`): the detail carries volume totals, the creation fee, creator and oracle. */
export const liveMarket = {
  ...market,
  volumeUsdc: '8.60',
  volumeUsdcBase: '8600000',
  totalVolumeUsdc: '1250.40',
  totalVolumeUsdcBase: 1250400000,
  creationFee: 50,
  creatorAddress: CREATOR,
  oracle: 'https://api.example.com/v1/index/epochs/1051',
};

/** live (playground `CatalogTradeRow`): share and fee amounts in 1e6 base units, optional fields, kind and side. */
export const liveTapeRow = {
  marketId: MARKET,
  wallet: WALLET,
  isPrimary: true,
  yesAmount: '38420000',
  noAmount: 0,
  feePaid: '400000',
  blockTime: 1767225600,
  signature: SIGNATURE,
  quoteAsset: 'USDC',
  kind: 'buy',
  side: 'YES',
  amountUsdc: '20.00',
  amountUsdcBase: 20000000,
};
export const liveMarketTrades = { marketId: MARKET, items: [liveTapeRow, { blockTime: null }] };

/** GET /wallets/{wallet}/trades/ · api-reference/markets/wallet-trades.md */
export const walletTrades = { wallet: WALLET, items: [tapeRow] };

/** GET /categories/ · api-reference/markets/categories.md */
export const categories = {
  categories: ['sports', 'crypto', 'politics', 'entertainment', 'finance', 'science', 'world', 'other'],
};

/** POST /markets/create/quote/ · api-reference/markets/quote.md */
export const createQuote = {
  createId: 'cr_abc123',
  expectedEventPda: MARKET,
  paymentUsdc: '50000000',
  liquidityInjectionUsdc: '10000000',
  platformRevenueUsdc: '40000000',
  marketType: 'standard',
  expiresAt: '2026-09-04T16:30:00.000000Z',
  blockhashExpiryHintSec: 60,
};

/** POST /markets/create/build/ · api-reference/markets/build.md (`transaction` is set per test). */
export const createBuild = {
  createId: 'cr_abc123',
  expectedEventPda: MARKET,
  transaction: 'AQ==',
  recentBlockhash: BLOCKHASH,
  lastValidBlockHeight: 123456789,
  blockhashExpiryHintSec: 60,
  buildFingerprint: 'abc',
  paymentUsdc: '50000000',
  liquidityInjectionUsdc: '10000000',
  platformRevenueUsdc: '40000000',
  marketType: 'standard',
  derived: { event: MARKET, vaultAuthority: VAULT_AUTHORITY, marketConfig: MARKET_CONFIG },
  expiresAt: '2026-09-04T16:26:00.000000Z',
};

/** POST /markets/register/ · api-reference/markets/register.md */
export const register = {
  createId: 'cr_abc123',
  marketId: MARKET,
  status: 'registered',
  signature: SIGNATURE,
  category: 'crypto',
  title: 'ETH above 5k?',
  images: ['https://cdn.example.com/markets/eth-5k-1024.webp'],
};

/** POST /primaryorderquote/ · api-reference/orders/quote.md */
export const buyQuote = {
  quoteId: 'qt_abc123',
  marketId: MARKET,
  side: 'yes',
  amountUsdc: '20.00',
  shares: '38.42',
  avgPrice: '0.520800',
  feeUsdc: '0.40',
  expiresAt: '2026-09-04T16:27:00.000000Z',
  blockhashExpiryHintSec: 60,
};

/** A primary_order_usdc-shaped instruction: the wallet signs and pays. */
export const instruction = {
  programId: PANTA_PROGRAM,
  data: Buffer.from([1, 2, 3, 4]).toString('base64'),
  accounts: [
    { pubkey: WALLET, isSigner: true, isWritable: true },
    { pubkey: MARKET, isSigner: false, isWritable: true },
    { pubkey: VAULT_AUTHORITY, isSigner: false, isWritable: false },
  ],
};

/** POST /primaryorderbuild/ · api-reference/orders/build.md */
export const buyBuild = {
  orderId: 'ord_abc123',
  quoteId: 'qt_abc123',
  wallet: WALLET,
  marketId: MARKET,
  side: 'yes',
  amountUsdc: '20.00',
  expectedShares: '38.40',
  feeUsdc: '0.40',
  status: 'built',
  instructions: [instruction],
  derived: { event: MARKET, vaultAuthority: VAULT_AUTHORITY },
  recentBlockhash: BLOCKHASH,
  lastValidBlockHeight: 123,
  expiresAt: '2026-09-04T16:28:00.000000Z',
  blockhashExpiryHintSec: 60,
};

/** live (playground `PrimaryBuildResponse`): `lastValidBlockHeight` and `derived` may be missing. */
export const liveBuyBuild = (({ lastValidBlockHeight: _height, derived: _derived, ...rest }) => rest)(buyBuild);

/** POST /primaryordersubmit/ · api-reference/orders/submit.md */
export const submit = { orderId: 'ord_abc123', status: 'submitted', signature: SIGNATURE };

/** POST /primaryorderverify/ · api-reference/orders/verify.md (amountUsdc is base units here). */
export const verify = {
  orderId: 'ord_abc123',
  status: 'confirmed',
  signature: SIGNATURE,
  marketId: MARKET,
  side: 'yes',
  amountUsdc: 20000000,
};

/** GET /positions/?wallet= · api-reference/positions.md */
export const positions = {
  wallet: WALLET,
  positions: [
    {
      marketId: MARKET,
      category: 'crypto',
      side: 'yes',
      shares: '38.40',
      phase: 'primary',
      claimable: false,
      claimed: false,
      outcome: null,
    },
  ],
};

/** POST /claim/build/ · api-reference/claims/build.md */
export const winClaim = {
  wallet: WALLET,
  marketId: MARKET,
  outcome: 'YES',
  winningShares: '38',
  instructions: [instruction],
  derived: { winClaim: key(12), positionPda: key(13), vaultAuthority: VAULT_AUTHORITY },
  recentBlockhash: BLOCKHASH,
  lastValidBlockHeight: 123,
};

/** POST /claim/creator-fees/build/ · api-reference/claims/creator-fees.md */
export const creatorFees = {
  wallet: CREATOR,
  marketId: MARKET,
  claimableFeesUsdc: '2500000',
  instructions: [
    {
      ...instruction,
      accounts: [{ pubkey: CREATOR, isSigner: true, isWritable: true }, ...instruction.accounts.slice(1)],
    },
  ],
  derived: {
    creatorFeeVault: key(14),
    creatorFeeVaultTokenAccount: key(15),
    creatorTokenAccount: key(16),
    marketConfig: MARKET_CONFIG,
  },
  recentBlockhash: BLOCKHASH,
  lastValidBlockHeight: 123,
};

/** POST /trades/ · api-reference/trades/report.md */
export const report = {
  signature: SIGNATURE,
  status: 'processed',
  marketId: MARKET,
  wallet: WALLET,
  side: 'yes',
  kind: 'buy',
};

/** GET /trades/{signature}/ · api-reference/trades/status.md */
export const tradeStatus = { signature: SIGNATURE, status: 'processed', marketId: MARKET, wallet: WALLET };

/** guides/errors.md */
export const errorEnvelope = {
  code: 'INVALID_MARKET_PARAMS',
  message: 'startTime must be at least 3600s ahead of now',
  field: 'startTime',
};
export const fieldErrors = {
  code: 'INVALID_MARKET_PARAMS',
  message: 'imageUrl: This field is required.',
  fields: { imageUrl: ['This field is required.'] },
};

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error | 'hang';

/** A `fetch` double: answers queued replies in order and records every request. */
export class FakeFetch {
  readonly calls: RecordedCall[] = [];
  private readonly replies: Reply[] = [];

  reply(status: number, body?: unknown, headers: Record<string, string> = {}): this {
    this.replies.push({ status, body, headers });
    return this;
  }
  replyText(status: number, text: string): this {
    this.replies.push({ status, text });
    return this;
  }
  fail(error: Error = new TypeError('fetch failed')): this {
    this.replies.push(error);
    return this;
  }
  /** Never answers; the request's timeout signal aborts it. */
  hang(): this {
    this.replies.push('hang');
    return this;
  }

  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>));
    this.calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error(`FakeFetch: no reply queued for ${String(input)}`);
    if (reply instanceof Error) throw reply;
    if (reply === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
}
