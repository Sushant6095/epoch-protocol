/** Test doubles for real-money Predict: a scripted Panta API, a scripted mainnet, and in-memory stores. */
import {
  type BuyBuildRequest,
  type BuyQuoteRequest,
  type ListMarketsParams,
  type PantaApi,
  type PantaAttributedTrades,
  type PantaBuyBuild,
  type PantaBuyQuote,
  type PantaCategories,
  type PantaCreates,
  type PantaDashboard,
  type PantaInstruction,
  type PantaMarket,
  type PantaMarketList,
  type PantaMarketTrades,
  type PantaMetrics,
  type PantaPositions,
  type PantaReportTrade,
  type PantaReportTradeRequest,
  type PantaSubmit,
  type PantaVerify,
  type PantaWinClaim,
} from '@epoch/panta';
import { PublicKey } from '@solana/web3.js';

import { type ChainState, type PantaChain } from '../Services/Panta/PantaChain';
import {
  type IndexReads,
  type NewPantaTrade,
  type PantaMarketReader,
  type PantaMarketRow,
  type PantaMarketTotals,
  type PantaTradeRecord,
  type PantaTradeStore,
  type PantaTradeTotals,
} from '../Services/Panta/PantaStores';

export const pkey = (n: number): string => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
export const PANTA_PROGRAM = pkey(90);
export const BLOCKHASH = pkey(91);

export function pantaMarket(overrides: Partial<PantaMarket> = {}): PantaMarket {
  return {
    marketId: pkey(60),
    category: 'crypto',
    title: 'ETH above 5k?',
    description: 'Resolves from CoinGecko.',
    images: ['https://cdn.example.com/eth.webp'],
    phase: 'primary',
    marketType: 'standard',
    startTime: 1_790_000_000,
    endTime: 1_900_000_000,
    resolutionTime: 1_900_003_600,
    region: 'Global',
    resolved: false,
    status: 'open',
    volumeUsdc: '1200.00',
    volumeUsdcBase: null,
    totalVolumeUsdc: null,
    totalVolumeUsdcBase: null,
    creationFee: null,
    creatorAddress: null,
    oracle: null,
    campaignId: null,
    createdByPartner: false,
    yesPrice: '0.52',
    noPrice: '0.48',
    primaryYesPrice: '0.52',
    primaryNoPrice: '0.48',
    secondaryYesPrice: null,
    secondaryNoPrice: null,
    ...overrides,
  };
}

/** Panta's buy and claim builds: one instruction the wallet signs and pays. */
export const walletInstruction = (wallet: string): PantaInstruction => ({
  programId: PANTA_PROGRAM,
  data: Buffer.from([7, 7, 7]).toString('base64'),
  accounts: [
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: pkey(61), isSigner: false, isWritable: true },
  ],
});

const notUsed = (name: string) => async (): Promise<never> => {
  throw new Error(`FakePanta.${name} is not scripted`);
};

/** Panta, scripted per method. Set `failNext[method]` to make the next call throw. */
export class FakeApiPanta implements PantaApi {
  configured = true;
  readonly calls: { name: string; body: unknown }[] = [];
  readonly failNext: Record<string, Error | undefined> = {};
  markets = new Map<string, PantaMarket>();
  catalog: PantaMarket[] = [];
  positionsByWallet = new Map<string, PantaPositions['positions']>();
  reportStatus = 'processed';
  verifyStatus = 'confirmed';
  private sessions = 0;

  private record(name: string, body: unknown): void {
    this.calls.push({ name, body });
    const error = this.failNext[name];
    if (error) {
      this.failNext[name] = undefined;
      throw error;
    }
  }

  count(name: string): number {
    return this.calls.filter((call) => call.name === name).length;
  }

  async listMarkets(params: ListMarketsParams = {}): Promise<PantaMarketList> {
    this.record('listMarkets', params);
    const items = this.catalog.filter(
      (m) => (!params.category || m.category === params.category) && (params.createdBy !== 'me' || m.createdByPartner),
    );
    const start = params.cursor ? items.findIndex((m) => m.marketId === params.cursor) + 1 : 0;
    const limit = params.limit ?? 20;
    const page = items.slice(start, start + limit);
    const more = start + limit < items.length;
    return {
      // List rows carry no prices (api-reference/markets/list.md).
      items: page.map((m) => ({
        ...m,
        yesPrice: null,
        noPrice: null,
        primaryYesPrice: null,
        primaryNoPrice: null,
        secondaryYesPrice: null,
        secondaryNoPrice: null,
      })),
      nextCursor: more ? (page.at(-1)?.marketId ?? null) : null,
    };
  }
  async getMarket(marketId: string): Promise<PantaMarket> {
    this.record('getMarket', marketId);
    const market = this.markets.get(marketId);
    if (!market) throw new Error(`FakePanta: no market ${marketId}`);
    return market;
  }
  async marketTrades(marketId: string): Promise<PantaMarketTrades> {
    this.record('marketTrades', marketId);
    return {
      marketId,
      items: [
        // live format (Panta's playground): share and fee amounts in 1e6 base units.
        {
          id: '1',
          marketId,
          wallet: pkey(70),
          isPrimary: true,
          yesAmount: '10000000',
          noAmount: '0',
          feePaid: '50000',
          blockTime: 1_790_000_100,
          signature: 'sig-tape',
          quoteAsset: 'USDC',
          kind: 'buy',
          side: 'yes',
          amountUsdc: null,
          amountUsdcBase: '10200000',
        },
      ],
    };
  }
  async categories(): Promise<PantaCategories> {
    this.record('categories', null);
    return { categories: ['sports', 'crypto', 'politics', 'entertainment', 'finance', 'science', 'world', 'other'] };
  }
  async quoteBuy(body: BuyQuoteRequest): Promise<PantaBuyQuote> {
    this.record('quoteBuy', body);
    this.sessions++;
    return {
      quoteId: `qt_${this.sessions}`,
      marketId: body.marketId,
      side: body.side,
      amountUsdc: body.amountUsdc,
      shares: '38.42',
      avgPrice: '0.520800',
      feeUsdc: '0.40',
      expiresAt: '2026-10-03T12:01:30.000Z',
      blockhashExpiryHintSec: 60,
    };
  }
  async buildBuy(body: BuyBuildRequest): Promise<PantaBuyBuild> {
    this.record('buildBuy', body);
    this.sessions++;
    return {
      orderId: `ord_${this.sessions}`,
      quoteId: body.quoteId,
      wallet: body.wallet,
      marketId: pkey(60),
      side: 'yes',
      amountUsdc: '20.00',
      expectedShares: '38.40',
      feeUsdc: '0.40',
      status: 'built',
      instructions: [walletInstruction(body.wallet)],
      derived: {},
      recentBlockhash: BLOCKHASH,
      lastValidBlockHeight: 5_000,
      expiresAt: '2026-10-03T12:02:00.000Z',
      blockhashExpiryHintSec: 60,
    };
  }
  async submitBuy(body: { orderId: string; signature: string; wallet?: string }): Promise<PantaSubmit> {
    this.record('submitBuy', body);
    return { orderId: body.orderId, status: 'submitted', signature: body.signature };
  }
  async verifyBuy(body: { orderId: string; signature?: string }): Promise<PantaVerify> {
    this.record('verifyBuy', body);
    return {
      orderId: body.orderId,
      status: this.verifyStatus,
      signature: body.signature ?? null,
      marketId: null,
      side: null,
      amountUsdc: null,
    };
  }
  async positions(wallet: string): Promise<PantaPositions> {
    this.record('positions', wallet);
    return { wallet, positions: this.positionsByWallet.get(wallet) ?? [] };
  }
  async buildWinClaim(body: { wallet: string; marketId: string }): Promise<PantaWinClaim> {
    this.record('buildWinClaim', body);
    return {
      wallet: body.wallet,
      marketId: body.marketId,
      outcome: 'yes',
      winningShares: '38',
      instructions: [walletInstruction(body.wallet)],
      derived: {},
      recentBlockhash: BLOCKHASH,
      lastValidBlockHeight: 5_000,
    };
  }
  async reportTrade(body: PantaReportTradeRequest): Promise<PantaReportTrade> {
    this.record('reportTrade', body);
    return {
      signature: body.signature,
      status: this.reportStatus,
      marketId: body.marketId,
      wallet: body.wallet,
      side: 'yes',
      kind: 'buy',
    };
  }
  async metrics(): Promise<PantaMetrics> {
    this.record('metrics', null);
    return {
      summary: {
        creates: { total: 2, byStatus: { registered: 2 } },
        trades: { total: 3, volumeUsdcBase: '60000000', byKind: { buy: 2, claim: 1 } },
      },
      creates: [],
      trades: [],
    };
  }

  /** The account endpoints behind GET /v1/predict/panta/stats (traction). */
  attributed: PantaAttributedTrades['items'] = [];
  async dashboard(): Promise<PantaDashboard> {
    this.record('dashboard', null);
    return {
      account: { userId: 'usr_epoch', name: 'Epoch', status: 'active', canCreateMarkets: true, apiKeyId: 'key_1' },
      keys: { active: 1, revoked: 0, total: 1 },
      metrics: {
        creates: { total: 3, byStatus: { registered: 2, pending: 1 } },
        trades: { total: 3, volumeUsdcBase: '60000000', byKind: { buy: 2, claim: 1 } },
      },
      permissions: { canCreateMarkets: true },
    };
  }
  async creates(): Promise<PantaCreates> {
    this.record('creates', null);
    return { summary: { total: 3, byStatus: { registered: 2, pending: 1 } }, items: [] };
  }
  async attributedTrades(): Promise<PantaAttributedTrades> {
    this.record('attributedTrades', null);
    return {
      summary: { total: 3, volumeUsdcBase: '60000000', byKind: { buy: 2, claim: 1 } },
      items: this.attributed,
    };
  }

  account = notUsed('account');
  walletTrades = notUsed('walletTrades');
  quoteCreate = notUsed('quoteCreate');
  buildCreate = notUsed('buildCreate');
  registerMarket = notUsed('registerMarket');
  buildCreatorFeeClaim = notUsed('buildCreatorFeeClaim');
  tradeStatus = notUsed('tradeStatus');
}

/** Mainnet, scripted: what each signature did, the block height, what broadcasts do. */
export class FakePantaChain implements PantaChain {
  readonly broadcasts: Uint8Array[] = [];
  states = new Map<string, ChainState>();
  height = 4_000;
  broadcastError?: Error;

  async broadcast(signedTransaction: Uint8Array): Promise<void> {
    this.broadcasts.push(signedTransaction);
    if (this.broadcastError) throw this.broadcastError;
  }
  async statuses(signatures: readonly string[]): Promise<Map<string, ChainState>> {
    return new Map(signatures.map((signature) => [signature, this.states.get(signature) ?? 'unknown']));
  }
  async blockHeight(): Promise<number> {
    return this.height;
  }
}

/** panta_trades in memory, with PgPantaTradeStore's semantics. */
export class MemoryPantaTradeStore implements PantaTradeStore {
  readonly rows = new Map<string, PantaTradeRecord>();

  async insert(trade: NewPantaTrade): Promise<void> {
    const now = new Date();
    this.rows.set(trade.id, {
      ...trade,
      signature: null,
      status: 'built',
      reportStatus: 'pending',
      reportError: null,
      reportAttempts: 0,
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
      confirmedAt: null,
      reportedAt: null,
    });
  }
  async get(id: string): Promise<PantaTradeRecord | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }
  async markSubmitted(id: string, signature: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'built') return false;
    if ([...this.rows.values()].some((other) => other.signature === signature)) return false;
    Object.assign(row, { status: 'submitted', signature, submittedAt: new Date() });
    return true;
  }
  async settle(id: string, status: 'confirmed' | 'failed' | 'expired'): Promise<void> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'submitted') return;
    row.status = status;
    if (status === 'confirmed') row.confirmedAt = new Date();
    else Object.assign(row, { reportStatus: 'failed', reportError: `transaction ${status}` });
  }
  async recordReport(
    id: string,
    result: { status: 'processed' | 'failed' | 'pending'; error?: string },
  ): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    Object.assign(row, {
      reportStatus: result.status,
      reportError: result.error ?? null,
      reportAttempts: row.reportAttempts + 1,
      reportedAt: result.status === 'processed' ? new Date() : row.reportedAt,
    });
  }
  async pending(since: Date, limit: number): Promise<PantaTradeRecord[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          ['submitted', 'confirmed'].includes(row.status) &&
          row.reportStatus === 'pending' &&
          row.signature &&
          row.createdAt >= since,
      )
      .slice(0, limit)
      .map((row) => ({ ...row }));
  }
  async totals(): Promise<PantaTradeTotals> {
    const rows = [...this.rows.values()].filter((row) => ['submitted', 'confirmed'].includes(row.status));
    return {
      trades: rows.length,
      buys: rows.filter((r) => r.kind === 'buy').length,
      claims: rows.filter((r) => r.kind === 'claim').length,
      uniqueWallets: new Set(rows.map((r) => r.wallet)).size,
      volumeUsdcBase: rows
        .filter((r) => r.kind === 'buy' && r.status === 'confirmed')
        .reduce((sum, r) => sum + (r.amountUsdcBase ?? 0), 0),
      attributed: rows.filter((r) => r.reportStatus === 'processed').length,
      pendingAttribution: rows.filter((r) => r.reportStatus === 'pending').length,
      firstTradeAt: rows[0]?.createdAt ?? null,
      lastTradeAt: rows.at(-1)?.createdAt ?? null,
    };
  }
  async wallets(limit: number): Promise<string[]> {
    const rows = [...this.rows.values()].filter((row) => ['submitted', 'confirmed'].includes(row.status));
    return [...new Set(rows.map((row) => row.wallet))].slice(0, limit);
  }
}

/** Epoch's market rows (what panta_bot_app wrote). */
export class MemoryPantaMarketReader implements PantaMarketReader {
  constructor(public rows: PantaMarketRow[] = []) {}

  async recent(limit: number): Promise<PantaMarketRow[]> {
    return this.rows
      .filter((row) => row.status === 'registered' && row.marketId)
      .sort((a, b) => b.epoch - a.epoch)
      .slice(0, limit);
  }
  async forEpoch(epoch: number): Promise<PantaMarketRow[]> {
    return this.rows
      .filter((row) => row.epoch === epoch && row.status === 'registered' && row.marketId)
      .sort((a, b) => a.threshold - b.threshold);
  }
  async byMarketId(marketId: string): Promise<PantaMarketRow | null> {
    return this.rows.find((row) => row.marketId === marketId) ?? null;
  }
  async totals(): Promise<PantaMarketTotals> {
    return {
      created: this.rows.filter((r) => r.paidUsdcBase !== null).length,
      live: this.rows.filter((r) => r.status === 'registered').length,
      creationFeesPaidBase: this.rows.reduce((sum, r) => sum + (r.paidUsdcBase ?? 0), 0),
      creatorFeesClaimedBase: this.rows.reduce((sum, r) => sum + r.creatorFeesClaimedUsdcBase, 0),
    };
  }
}

export class MemoryIndexReads implements IndexReads {
  constructor(
    public values: { epoch: number; value: number }[] = [],
    public live: { epoch: number; value: number; slots: number } | null = null,
  ) {}

  async history(limit: number): Promise<{ epoch: number; value: number }[]> {
    return [...this.values].sort((a, b) => b.epoch - a.epoch).slice(0, limit);
  }
  async running(): Promise<{ epoch: number; value: number; slots: number } | null> {
    return this.live;
  }
}

/** One of Epoch's Fee Index markets as panta_markets holds it once registered. */
export function feeIndexRow(epoch: number, threshold: number, marketId: string): PantaMarketRow {
  const now = new Date('2026-10-03T12:00:00Z');
  return {
    id: epoch,
    epoch,
    threshold,
    question: `Will the Solana Fee Index for epoch ${epoch} close above ${threshold.toLocaleString('en-US')} micro-lamports per CU?`,
    title: `Solana Fee Index above ${threshold.toLocaleString('en-US')} µL/CU in epoch ${epoch}`,
    description: 'Epoch publishes the Solana Fee Index every epoch…',
    resolutionRule: `Resolves YES if the final Solana Fee Index for Solana mainnet epoch ${epoch} is strictly greater than ${threshold}…`,
    sourcesOfTruth: [`https://api.epoch.example/v1/index/epochs/${epoch}`, 'https://github.com/x/methodology'],
    imageUrl: 'https://cdn.epoch.example/fee-index.png',
    status: 'registered',
    startTime: new Date('2026-10-03T13:10:00Z'),
    endTime: new Date('2026-10-04T23:00:00Z'),
    resolutionTime: new Date('2026-10-06T12:00:00Z'),
    createId: 'cr_1',
    createExpiresAt: null,
    expectedEventPda: marketId,
    marketId,
    createSignature: 'sigCreate',
    signedTx: null,
    lastValidBlockHeight: null,
    quotedUsdcBase: 50_000_000,
    liquidityUsdcBase: 10_000_000,
    platformUsdcBase: 40_000_000,
    paidUsdcBase: 50_000_000,
    creatorFeesClaimedUsdcBase: 0,
    lastCreatorFeeSignature: null,
    creatorFeesCheckedAt: null,
    attempts: 0,
    error: null,
    signedAt: now,
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
