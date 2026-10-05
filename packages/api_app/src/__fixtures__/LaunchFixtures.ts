/**
 * Test-only: the Meteora rehearsal's recorded transactions and accounts (packages/meteora/src/__fixtures__/rehearsal,
 * docs/runbooks/meteora-devnet-rehearsal.md) as the Launch page's inputs — the launch record, the decoded curve, DAMM
 * v2 pool and claims state after graduation and every claim, and the raw getTransaction answers the ingester reads.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  base58Decode,
  cpAmmClient,
  dammPositionClaim,
  type DammPoolState,
  dbcClient,
  type HolderLabels,
  launchClaimsFromState,
  type LaunchClaimsState,
  type LaunchPoolState,
  type LaunchRef,
  type LaunchRegistryEntry,
  type LaunchTradeQuote,
  mapDammPool,
  mapLaunchPool,
  type TokenMintInfo,
  type TopHolder,
  type TradeSide,
} from '@epoch/meteora';
import { type SubscribeUpdateTransaction } from '@epoch/solana';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

import { type LaunchChainReader } from '../Services/Launch/LaunchChain';
import { type LaunchLiveChain } from '../Services/Launch/LaunchLiveChain';
import { LaunchPageService, type LaunchPageServiceOptions } from '../Services/Launch/LaunchPageService';
import { MemoryLaunchPriceStore } from '../Services/Launch/LaunchPriceStore';
import { LaunchRegistry } from '../Services/Launch/LaunchRegistry';
import { LaunchService } from '../Services/Launch/LaunchService';
import { MemoryLaunchTradeStore, type StoredLaunchTrade } from '../Services/Launch/LaunchTradeStore';
import { ProgramRevenueTokenSource, type RevenueTokenChain } from '../Services/Launch/RevenueTokenSource';

const DIR = join(__dirname, '../../../meteora/src/__fixtures__/rehearsal');

export const rehearsalFixture = (name: string): unknown => JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8'));

/** The launch record the launch script wrote (devnet stand-in: a local validator with Meteora's mainnet programs). */
export const REHEARSAL = rehearsalFixture('launch-record') as LaunchRegistryEntry;
export const DBC_POOL = REHEARSAL.dbcPool as string;
export const DAMM_POOL = '849LsiGbYgC9vRSMiMi3SKrT7C3D3dYPCYX1HD1cGokj';
export const TREASURY = 'AQ3gcCLTPwTHsBhNBTFz94L2kxKevZuywYWobx9H9Mf8';
export const VALIDATOR = 'GjMZo48qTs7nuowtcPYj7K6vtsMiXJbRUePgmK6RF1c1';

/** The rehearsal's transactions in chain order, with the pools each one touches. */
export const REHEARSAL_TXS = [
  'launch-create-pool-first-buy',
  'dbc-buy',
  'dbc-sell',
  'dbc-buy-completes-curve',
  'migrate-damm-v2',
  'damm-buy',
  'damm-sell',
  'claim-partner-trading-fee',
  'claim-creator-migration-fee',
  'withdraw-leftover',
  'claim-lp-fee',
].map((name) => {
  const raw = rehearsalFixture(name) as {
    slot: number;
    blockTime: number;
    transaction: { signatures: string[]; message: { accountKeys: string[] } };
  };
  return {
    name,
    raw: raw as unknown,
    signature: raw.transaction.signatures[0],
    slot: raw.slot,
    blockTime: raw.blockTime,
    accounts: raw.transaction.message.accountKeys,
  };
});
export type RehearsalTx = (typeof REHEARSAL_TXS)[number];

interface RpcInstruction {
  programIdIndex: number;
  accounts: number[];
  data: string;
  stackHeight?: number | null;
}

/**
 * A rehearsal transaction as Yellowstone gRPC streams it (`SubscribeUpdateTransaction`: keys, signatures and
 * instruction data as bytes), rebuilt from its recorded JSON-RPC form.
 */
export function rehearsalGrpcUpdate(name: string): SubscribeUpdateTransaction {
  const raw = rehearsalFixture(name) as {
    slot: number;
    meta: {
      fee: number;
      innerInstructions: { index: number; instructions: RpcInstruction[] }[];
      loadedAddresses?: { writable: string[]; readonly: string[] };
      logMessages?: string[];
    };
    transaction: {
      signatures: string[];
      message: {
        accountKeys: string[];
        header: {
          numRequiredSignatures: number;
          numReadonlySignedAccounts: number;
          numReadonlyUnsignedAccounts: number;
        };
        recentBlockhash: string;
        instructions: RpcInstruction[];
      };
    };
  };
  const bytes = (key: string) => base58Decode(key);
  const instruction = (ix: RpcInstruction) => ({
    programIdIndex: ix.programIdIndex,
    accounts: Uint8Array.from(ix.accounts),
    data: base58Decode(ix.data),
  });
  const message = raw.transaction.message;
  return {
    slot: String(raw.slot),
    transaction: {
      signature: bytes(raw.transaction.signatures[0]),
      isVote: false,
      index: '0',
      transaction: {
        signatures: raw.transaction.signatures.map(bytes),
        message: {
          header: message.header,
          accountKeys: message.accountKeys.map(bytes),
          recentBlockhash: bytes(message.recentBlockhash),
          instructions: message.instructions.map(instruction),
          versioned: false,
          addressTableLookups: [],
        },
      },
      meta: {
        err: undefined,
        fee: String(raw.meta.fee),
        preBalances: [],
        postBalances: [],
        innerInstructions: raw.meta.innerInstructions.map((group) => ({
          index: group.index,
          instructions: group.instructions.map((ix) => ({
            ...instruction(ix),
            stackHeight: ix.stackHeight ?? undefined,
          })),
        })),
        innerInstructionsNone: false,
        logMessages: raw.meta.logMessages ?? [],
        logMessagesNone: false,
        preTokenBalances: [],
        postTokenBalances: [],
        rewards: [],
        loadedWritableAddresses: (raw.meta.loadedAddresses?.writable ?? []).map(bytes),
        loadedReadonlyAddresses: (raw.meta.loadedAddresses?.readonly ?? []).map(bytes),
        returnData: undefined,
        returnDataNone: true,
      },
    },
  };
}
export const rehearsalTx = (name: string): RehearsalTx => {
  const tx = REHEARSAL_TXS.find((candidate) => candidate.name === name);
  if (!tx) throw new Error(`no rehearsal transaction ${name}`);
  return tx;
};

const account = (name: string) => {
  const json = rehearsalFixture(`account-${name}`) as { address: string; data: string };
  return { address: json.address, data: Buffer.from(json.data, 'base64') };
};

interface Coder {
  decode(name: string, data: Buffer): unknown;
}
const offline = new Connection('http://127.0.0.1:1');
const dbcCoder = (): Coder => dbcClient(offline).state.getProgram().coder.accounts as Coder;
const dammCoder = (): Coder =>
  (cpAmmClient(offline) as unknown as { _program: { coder: { accounts: Coder } } })._program.coder.accounts;

type VirtualPool = Parameters<typeof mapLaunchPool>[1];
type PoolConfig = Parameters<typeof mapLaunchPool>[2];
type DammPoolAccount = Parameters<typeof mapDammPool>[1];
type PositionAccount = Parameters<typeof dammPositionClaim>[0]['state'];

const decodedCurve = () => ({
  pool: dbcCoder().decode('virtualPool', account('dbc-pool').data) as VirtualPool,
  config: dbcCoder().decode('poolConfig', account('dbc-config').data) as PoolConfig,
});

/** The curve after graduation (migrated, 70% withdrawn, leftover withdrawn). */
export function rehearsalCurve(): LaunchPoolState {
  const { pool, config } = decodedCurve();
  return mapLaunchPool(DBC_POOL, pool, config);
}

/** The curve as it was mid-raise: 40% of the raise in, trading on the curve. */
export function curveMidRaise(): LaunchPoolState {
  const graduated = rehearsalCurve();
  return {
    ...graduated,
    quoteReserveSol: 0.3,
    curveProgressPct: 40,
    priceSol: 0.0000031,
    curveComplete: false,
    migrated: false,
    migrationProgress: 'preBondingCurve',
    dammPool: null,
    finishCurveTime: null,
  };
}

/** The DAMM v2 pool after the rehearsal's trades (vault balances as the rehearsal left them, rounded). */
export function rehearsalDamm(): DammPoolState {
  const state = dammCoder().decode('pool', account('damm-pool').data) as DammPoolAccount;
  return mapDammPool(DAMM_POOL, state, {
    vaultA: 90_516_235_134n,
    vaultB: 159_000_000n,
    decimalsA: 6,
    decimalsB: 9,
  });
}

/** Every claim made: the state the fee job and GET /fees read after the rehearsal. */
export function rehearsalClaims(): LaunchClaimsState {
  const { pool, config } = decodedCurve();
  const position = account('position');
  const lp = dammPositionClaim({
    position: new PublicKey(position.address),
    state: dammCoder().decode('position', position.data) as PositionAccount,
    pool: dammCoder().decode('pool', account('damm-pool').data) as Parameters<typeof dammPositionClaim>[0]['pool'],
    owner: TREASURY,
    partner: TREASURY,
    creator: VALIDATOR,
    baseIsTokenA: true,
  });
  return launchClaimsFromState({
    dbcPool: DBC_POOL,
    pool,
    config,
    baseVaultAmount: 139_000_000n,
    dammPool: DAMM_POOL,
    positions: [lp],
  });
}

/**
 * The RevenueToken the launch CLI registered on the local stand-in (rLOC, the merged program, docs/runbooks/
 * meteora-devnet-rehearsal.md part 2), with its escrow topped up by hand: the program's account bytes, as read.
 */
export const RLOC = JSON.parse(readFileSync(join(__dirname, 'revenue-token-rloc.json'), 'utf8')) as {
  programId: string;
  address: string;
  owner: string;
  lamports: number;
  data: string;
  escrow: { address: string; lamports: number };
};

// ── The Launch page's services over fakes ───────────────────────────────────────────────────────────

const key = (seed: number): PublicKey => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey;

/** A stand-in Epoch program id (the revenue-token and buyback-escrow PDAs derive from it). */
export const PROGRAM_ID = key(7);
export const TRADER = key(9).toBase58();
export const BLOCKHASH = key(3).toBase58();
export const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM';
export const DAMM_V2_POOL_AUTHORITY = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC';
/** The rehearsal launch's live revenue estimate (SOL per epoch, the validator table's inflation + MEV). */
export const LIVE_REVENUE_SOL = 1.99;

/** A launch that has no pool yet. */
export const UPCOMING: LaunchRegistryEntry = {
  mint: key(11).toBase58(),
  symbol: 'rUPC',
  name: 'Upcoming revenue token',
  validator: { name: 'Tidewater Stake', vote: key(12).toBase58() },
  shareBps: 1_500,
  termEpochs: 60,
  startEpoch: 40,
  opensAtEpoch: 40,
  supply: 100_000,
  decimals: 6,
  cluster: 'devnet',
  avgRevenueSol: 8,
  raiseTargetSol: 3,
};

/** What the chain holds for the rehearsal launch; tests change it. */
export interface LaunchChainState {
  curve: LaunchPoolState | null;
  damm: DammPoolState | null;
}

export function fakeLaunchReader(state: LaunchChainState) {
  return {
    epochInfo: jest.fn().mockResolvedValue({ epoch: 5, slotIndex: 1_000, slotsInEpoch: 432_000, absoluteSlot: 3_917 }),
    launchPool: jest.fn(async (dbcPool: string) => (dbcPool === DBC_POOL ? state.curve : null)),
    dammPool: jest.fn(async (pool: string) => (pool === DAMM_POOL ? state.damm : null)),
    mint: jest.fn(async (address: string) =>
      address === REHEARSAL.mint
        ? ({
            mint: address,
            tokenProgram: 'token-program',
            uiSupply: 1_000_000,
            decimals: 6,
            mintAuthority: null,
          } as unknown as TokenMintInfo)
        : null,
    ),
    holders: jest.fn().mockResolvedValue({ holders: 7, holdersExcluding: 4 }),
    escrowSol: jest.fn().mockResolvedValue(0),
  } satisfies LaunchChainReader;
}

/** The largest accounts after the rehearsal (labels as the page service passes them). */
export function rehearsalHolders(labels: HolderLabels): TopHolder[] {
  return [
    {
      owner: TREASURY,
      tokenAccount: 'TreasuryAta',
      amount: '639263000567',
      uiAmount: 639_263.000567,
      sharePct: 63.9263000567,
    },
    { owner: TRADER, tokenAccount: 'TraderAta', amount: '150000000000', uiAmount: 150_000, sharePct: 15 },
    {
      owner: DAMM_V2_POOL_AUTHORITY,
      tokenAccount: 'DammVaultA',
      amount: '90516235134',
      uiAmount: 90_516.235134,
      sharePct: 9.0516235134,
    },
    { owner: DBC_POOL_AUTHORITY, tokenAccount: 'CurveVault', amount: '139000000', uiAmount: 139, sharePct: 0.0139 },
  ].map((holder) => ({ ...holder, label: (holder.owner && labels[holder.owner]) || null }));
}

export function fakeQuote(side: TradeSide, amount: number, venue: LaunchTradeQuote['venue'] = 'dbc'): LaunchTradeQuote {
  const out = side === 'buy' ? (amount * 0.99) / 0.0000031 : amount * 0.0000031 * 0.99;
  return {
    side,
    amountIn: amount,
    amountOut: Math.round(out * 1e6) / 1e6,
    minimumOut: Math.round(out * 0.99 * 1e6) / 1e6,
    priceImpactPct: 1.2,
    tradingFeeSol: side === 'buy' ? amount * 0.01 : amount * 0.0000031 * 0.01,
    venue,
  };
}

export function fakeLiveChain(claims: () => LaunchClaimsState | null = rehearsalClaims) {
  return {
    signatures: jest.fn().mockResolvedValue([]),
    transaction: jest.fn().mockResolvedValue(null),
    topHolders: jest.fn(async (_mint: string, _decimals: number, labels: HolderLabels) => rehearsalHolders(labels)),
    claims: jest.fn(async () => claims()),
    quote: jest.fn(async (launch: LaunchRef, side: TradeSide, amount: number) =>
      fakeQuote(side, amount, launch.dammPool ? 'damm-v2' : 'dbc'),
    ),
    build: jest.fn(
      async (_launch: LaunchRef, _side: TradeSide, _amount: number, _slippageBps: number, owner: string) => {
        const payer = new PublicKey(owner);
        return new Transaction({ feePayer: payer, blockhash: BLOCKHASH, lastValidBlockHeight: 4_200 }).add(
          SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(TREASURY), lamports: 1 }),
        );
      },
    ),
  } satisfies LaunchLiveChain;
}

/** A stored trade at minute `n` after `start` (unix ms). */
export function storedTrade(n: number, start: number, overrides: Partial<StoredLaunchTrade> = {}): StoredLaunchTrade {
  return {
    signature: `5${'z'.repeat(60)}${'abcdefghijkmnopqrstuvwxyz'[n % 25]}${'abcdefghijkmnopqrstuvwxyz'[Math.floor(n / 25)]}`,
    ix: 1,
    mint: REHEARSAL.mint,
    pool: DBC_POOL,
    venue: 'dbc',
    side: n % 3 === 2 ? 'sell' : 'buy',
    trader: TRADER,
    slot: 3_000 + n,
    blockTime: new Date(start + n * 60_000),
    solLamports: 200_000_000n,
    tokenAmount: 89_402_418_317n,
    feeAmount: 2_000_000n,
    feeInToken: false,
    priceSol: 0.0000022 + n * 1e-8,
    postPriceSol: 0.0000023 + n * 1e-8,
    quoteReserveLamports: 217_800_000n,
    ...overrides,
  };
}

export interface LaunchPageHarness {
  page: LaunchPageService;
  launches: LaunchService;
  /** What LaunchService's board reads, and what the page's market block reads. */
  boardReader: ReturnType<typeof fakeLaunchReader>;
  pageReader: ReturnType<typeof fakeLaunchReader>;
  live: ReturnType<typeof fakeLiveChain>;
  store: MemoryLaunchTradeStore;
  prices: MemoryLaunchPriceStore;
  state: LaunchChainState;
  /** The program's cluster as the revenue-token source reads it (the token is not registered unless a test says so). */
  revenueChain: jest.Mocked<RevenueTokenChain>;
  clock: { now: number };
  cleanup: () => void;
}

/**
 * The rehearsal launch (and an upcoming one) behind `LaunchService` and `LaunchPageService`, on fakes: the chain state
 * starts mid-raise; `clock.now` drives every cache.
 */
export function launchPageHarness(
  options: { state?: Partial<LaunchChainState>; page?: Partial<LaunchPageServiceOptions>; now?: number } = {},
): LaunchPageHarness {
  const dir = mkdtempSync(join(tmpdir(), 'launch-page-'));
  const path = join(dir, 'launches.json');
  writeFileSync(path, JSON.stringify([REHEARSAL, UPCOMING]));
  const clock = { now: options.now ?? Date.parse('2026-10-03T14:00:00Z') };
  const now = () => clock.now;
  const state: LaunchChainState = { curve: curveMidRaise(), damm: null, ...options.state };
  const boardReader = fakeLaunchReader(state);
  const pageReader = fakeLaunchReader(state);
  const prices = new MemoryLaunchPriceStore();
  const launches = new LaunchService({
    registry: new LaunchRegistry(path),
    reader: boardReader,
    revenue: async (vote) => ({ avgRevenueSol: vote === REHEARSAL.validator.vote ? LIVE_REVENUE_SOL : 8, note: null }),
    prices,
    network: 'devnet',
    cacheMs: 60_000,
    holdersCacheMs: 600_000,
    now,
  });
  const live = fakeLiveChain();
  const store = new MemoryLaunchTradeStore();
  const revenueChain: jest.Mocked<RevenueTokenChain> = {
    accounts: jest.fn(async (addresses: readonly PublicKey[]) => addresses.map(() => null)),
    rentExemptMinimum: jest.fn(async () => 890_880),
    epoch: jest.fn(async () => 5),
  };
  const page = new LaunchPageService({
    launches,
    reader: pageReader,
    live,
    store,
    prices,
    solUsd: async () => 150,
    revenueTokens: new ProgramRevenueTokenSource(PROGRAM_ID, revenueChain, now),
    ingester: null,
    network: 'devnet',
    explorer: { cluster: 'devnet', customRpc: null },
    marketCacheMs: 60_000,
    staleMs: 120_000,
    maxBuySol: 10,
    now,
    ...options.page,
  });
  return {
    page,
    launches,
    boardReader,
    pageReader,
    live,
    store,
    prices,
    state,
    revenueChain,
    clock,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
