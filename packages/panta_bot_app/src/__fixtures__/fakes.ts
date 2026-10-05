/** Test doubles for the Panta bot: an in-memory store, a scripted chain and a scripted Panta API. */
import { TransactionFailedException } from '@epoch/exceptions';
import {
  type PantaApi,
  type PantaCreateBuild,
  type PantaCreateQuote,
  type PantaCreateQuoteRequest,
  type PantaCreatorFeeClaim,
  type PantaInstruction,
  type PantaMarket,
  type PantaMarketList,
  type PantaRegister,
} from '@epoch/panta';
import { PublicKey } from '@solana/web3.js';

import { type BotChain, type GuardLimits, type SignedCreate } from '../Chain/BotChain';
import { type ClockSnapshot } from '../Markets/EpochSchedule';
import {
  COMMITTED_STATUSES,
  type IndexHistory,
  type MarketPatch,
  type MarketRecord,
  type MarketStatus,
  type MarketStore,
  type NewMarket,
} from '../Store/MarketStore';

export const key = (n: number): string => new PublicKey(new Uint8Array(32).fill(n)).toBase58();
export const BOT_WALLET = key(21);
export const SLOTS = 432_000;
/** 3 Oct 2026, 17:30 IST. */
export const NOW = Date.parse('2026-10-03T12:00:00Z');

/** Mainnet epoch 1050, 100,000 slots in, 0.4 s per slot: 1051 starts in ~36.9 h. */
export const clockAt = (overrides: Partial<ClockSnapshot> = {}): ClockSnapshot => ({
  epoch: 1_050,
  slotIndex: 100_000,
  slotsInEpoch: SLOTS,
  absoluteSlot: 1_050 * SLOTS + 100_000,
  secondsPerSlot: 0.4,
  nowMs: NOW,
  ...overrides,
});

/** `panta_markets` in memory, with the same semantics as PgMarketStore (unique epoch+threshold, compare-and-set). */
export class MemoryMarketStore implements MarketStore {
  readonly rows: MarketRecord[] = [];
  private nextId = 1;

  constructor(private readonly now: () => number = () => NOW) {}

  async forEpochs(epochs: readonly number[]): Promise<MarketRecord[]> {
    return this.rows.filter((row) => epochs.includes(row.epoch)).map((row) => ({ ...row }));
  }

  async plan(market: NewMarket): Promise<MarketRecord | null> {
    if (this.rows.some((row) => row.epoch === market.epoch && row.threshold === market.threshold)) return null;
    const row = blankRecord({ ...market, id: this.nextId++, createdAt: new Date(this.now()) });
    this.rows.push(row);
    return { ...row };
  }

  async withStatus(statuses: readonly MarketStatus[]): Promise<MarketRecord[]> {
    return this.rows
      .filter((row) => statuses.includes(row.status as MarketStatus))
      .sort((a, b) => a.epoch - b.epoch || a.id - b.id)
      .map((row) => ({ ...row }));
  }

  async transition(id: number, from: MarketStatus, patch: MarketPatch): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.status !== from) return false;
    Object.assign(row, patch, { updatedAt: new Date(this.now()) });
    return true;
  }

  async committedSince(since: Date): Promise<number> {
    return this.rows
      .filter((row) => (COMMITTED_STATUSES as string[]).includes(row.status) && row.signedAt && row.signedAt >= since)
      .reduce((sum, row) => sum + (row.quotedUsdcBase ?? 0), 0);
  }

  /** Test setup: a row in any state. */
  insert(fields: Partial<MarketRecord> & Pick<MarketRecord, 'epoch' | 'threshold' | 'status'>): MarketRecord {
    const row = blankRecord({ question: `q ${fields.epoch} ${fields.threshold}`, ...fields, id: this.nextId++ });
    this.rows.push(row);
    return row;
  }

  byEpoch(epoch: number): MarketRecord[] {
    return this.rows.filter((row) => row.epoch === epoch);
  }
}

function blankRecord(fields: Partial<MarketRecord> & Pick<MarketRecord, 'id' | 'epoch' | 'threshold'>): MarketRecord {
  return {
    question: '',
    title: '',
    description: '',
    resolutionRule: '',
    sourcesOfTruth: [],
    imageUrl: null,
    status: 'planned',
    startTime: null,
    endTime: null,
    resolutionTime: null,
    createId: null,
    createExpiresAt: null,
    expectedEventPda: null,
    marketId: null,
    createSignature: null,
    signedTx: null,
    lastValidBlockHeight: null,
    quotedUsdcBase: null,
    liquidityUsdcBase: null,
    platformUsdcBase: null,
    paidUsdcBase: null,
    creatorFeesClaimedUsdcBase: 0,
    lastCreatorFeeSignature: null,
    creatorFeesCheckedAt: null,
    attempts: 0,
    error: null,
    signedAt: null,
    registeredAt: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...fields,
  };
}

export class MemoryIndexHistory implements IndexHistory {
  /** `finals`: the epochs whose values the program has finalized (all of them unless set). */
  constructor(
    public values: { epoch: number; value: number }[] = [],
    public finals: Set<number> | null = null,
  ) {}

  async recent(beforeEpoch: number, limit: number): Promise<{ epoch: number; value: number }[]> {
    return this.values
      .filter((point) => point.epoch < beforeEpoch)
      .sort((a, b) => b.epoch - a.epoch)
      .slice(0, limit);
  }

  async recentFinal(beforeEpoch: number, limit: number): Promise<{ epoch: number; value: number }[]> {
    const finals = this.finals;
    return (await this.recent(beforeEpoch, Number.MAX_SAFE_INTEGER))
      .filter((point) => finals === null || finals.has(point.epoch))
      .slice(0, limit);
  }
}

export type SendOutcome = 'confirmed' | 'expired' | 'failed' | 'rpc-error';

/** A scripted mainnet: the clock, signature states, and what each broadcast does. */
export class FakeBotChain implements BotChain {
  wallet: string | null = BOT_WALLET;
  snapshot: ClockSnapshot = clockAt();
  height = 1_000;
  states = new Map<string, 'confirmed' | 'failed' | 'unknown'>();
  sendOutcomes: SendOutcome[] = [];
  guardError?: Error;
  readonly signed: { base64: string; limits: GuardLimits }[] = [];
  readonly sent: string[] = [];
  readonly instructions: PantaInstruction[][] = [];
  private counter = 0;

  async clock(): Promise<ClockSnapshot> {
    return { ...this.snapshot };
  }
  async balances(): Promise<{ usdcBase: number; lamports: number } | null> {
    return { usdcBase: 500_000_000, lamports: 1_000_000_000 };
  }
  async guardAndSign(unsignedBase64: string, limits: GuardLimits): Promise<SignedCreate> {
    if (this.guardError) throw this.guardError;
    this.signed.push({ base64: unsignedBase64, limits });
    this.counter++;
    return {
      signature: `sig${this.counter}`,
      signedBase64: `signed:${unsignedBase64}`,
      usdcSpentBase: limits.maxUsdcBase,
      lamportsSpent: 5_000,
    };
  }
  async send(signed: { signedBase64: string; signature: string }): Promise<void> {
    this.sent.push(signed.signature);
    const outcome = this.sendOutcomes.shift() ?? 'confirmed';
    if (outcome === 'confirmed') {
      this.states.set(signed.signature, 'confirmed');
      return;
    }
    if (outcome === 'expired') {
      throw new TransactionFailedException('expired', { signature: signed.signature, expired: true });
    }
    if (outcome === 'failed') {
      throw new TransactionFailedException('failed on chain', { signature: signed.signature, err: { Custom: 1 } });
    }
    throw new Error('RPC unreachable');
  }
  async state(signature: string): Promise<'confirmed' | 'failed' | 'unknown'> {
    return this.states.get(signature) ?? 'unknown';
  }
  async blockHeight(): Promise<number> {
    return this.height;
  }
  async sendInstructions(instructions: readonly PantaInstruction[]): Promise<string> {
    this.instructions.push([...instructions]);
    return `claim${this.instructions.length}`;
  }
}

const notUsed = (name: string) => async (): Promise<never> => {
  throw new Error(`FakePanta.${name} is not scripted`);
};

/** Panta's create, register, catalog and creator-fee routes, scripted. Unused routes throw. */
export class FakePanta implements PantaApi {
  readonly configured = true;
  readonly calls: { name: string; body: unknown }[] = [];
  /** Throw this from the next quote (once). */
  quoteErrors: Error[] = [];
  registerErrors: Error[] = [];
  fee = '50000000';
  markets = new Map<string, PantaMarket>();
  mine: PantaMarket[] = [];
  creatorFees = '2500000';
  creatorFeeError?: Error;
  private sessions = 0;

  async quoteCreate(body: PantaCreateQuoteRequest): Promise<PantaCreateQuote> {
    this.calls.push({ name: 'quoteCreate', body });
    const error = this.quoteErrors.shift();
    if (error) throw error;
    this.sessions++;
    return {
      createId: `cr_${this.sessions}`,
      expectedEventPda: key(100 + this.sessions),
      paymentUsdc: this.fee,
      liquidityInjectionUsdc: '10000000',
      platformRevenueUsdc: '40000000',
      marketType: 'standard',
      expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
      blockhashExpiryHintSec: 60,
    };
  }
  async buildCreate(body: { createId: string; wallet?: string }): Promise<PantaCreateBuild> {
    this.calls.push({ name: 'buildCreate', body });
    return {
      createId: body.createId,
      expectedEventPda: null,
      transaction: `tx:${body.createId}`,
      recentBlockhash: key(77),
      lastValidBlockHeight: 1_150,
      blockhashExpiryHintSec: 60,
      buildFingerprint: 'fp',
      paymentUsdc: this.fee,
      liquidityInjectionUsdc: null,
      platformRevenueUsdc: null,
      marketType: 'standard',
      derived: {},
      expiresAt: null,
    };
  }
  async registerMarket(body: { createId: string; signature: string }): Promise<PantaRegister> {
    this.calls.push({ name: 'registerMarket', body });
    const error = this.registerErrors.shift();
    if (error) throw error;
    const marketId = key(100 + Number(body.createId.replace('cr_', '')));
    return {
      createId: body.createId,
      marketId,
      status: 'registered',
      signature: body.signature,
      category: 'crypto',
      title: null,
      images: [],
    };
  }
  async getMarket(marketId: string): Promise<PantaMarket> {
    this.calls.push({ name: 'getMarket', body: marketId });
    const market = this.markets.get(marketId);
    if (!market) throw new Error(`no market ${marketId}`);
    return market;
  }
  async listMarkets(params?: unknown): Promise<PantaMarketList> {
    this.calls.push({ name: 'listMarkets', body: params });
    return { items: this.mine, nextCursor: null };
  }
  async buildCreatorFeeClaim(body: { wallet: string; marketId: string }): Promise<PantaCreatorFeeClaim> {
    this.calls.push({ name: 'buildCreatorFeeClaim', body });
    if (this.creatorFeeError) throw this.creatorFeeError;
    return {
      wallet: body.wallet,
      marketId: body.marketId,
      claimableFeesUsdc: this.creatorFees,
      instructions: [
        { programId: key(9), data: 'AQ==', accounts: [{ pubkey: body.wallet, isSigner: true, isWritable: true }] },
      ],
      derived: {},
      recentBlockhash: key(77),
      lastValidBlockHeight: 1_150,
    };
  }

  count(name: string): number {
    return this.calls.filter((call) => call.name === name).length;
  }

  account = notUsed('account');
  dashboard = notUsed('dashboard');
  metrics = notUsed('metrics');
  creates = notUsed('creates');
  attributedTrades = notUsed('attributedTrades');
  marketTrades = notUsed('marketTrades');
  categories = notUsed('categories');
  walletTrades = notUsed('walletTrades');
  quoteBuy = notUsed('quoteBuy');
  buildBuy = notUsed('buildBuy');
  submitBuy = notUsed('submitBuy');
  verifyBuy = notUsed('verifyBuy');
  positions = notUsed('positions');
  buildWinClaim = notUsed('buildWinClaim');
  reportTrade = notUsed('reportTrade');
  tradeStatus = notUsed('tradeStatus');
}

/** A catalog row as GET /markets/{id}/ returns it. */
export function pantaMarket(overrides: Partial<PantaMarket> = {}): PantaMarket {
  return {
    marketId: key(200),
    category: 'crypto',
    title: 'Solana Fee Index above 1,300 µL/CU in epoch 1051',
    description: null,
    images: [],
    phase: 'primary',
    marketType: 'standard',
    startTime: null,
    endTime: null,
    resolutionTime: null,
    region: 'Global',
    resolved: false,
    status: 'open',
    volumeUsdc: '0',
    campaignId: null,
    createdByPartner: true,
    yesPrice: '0.5',
    noPrice: '0.5',
    primaryYesPrice: null,
    primaryNoPrice: null,
    secondaryYesPrice: null,
    secondaryNoPrice: null,
    ...overrides,
  };
}
