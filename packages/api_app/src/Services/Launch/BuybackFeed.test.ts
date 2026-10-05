import { type RevenueTokenAccount, REVENUE_TOKEN_FLAGS } from '@epoch/epoch-sdk';
import { PublicKey } from '@solana/web3.js';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { type ProgramEpochInfo } from '../../Sources/EpochProgramSource';
import { type EventQuery } from '../Program/ProgramEventStore';
import { BuybackFeed, type BuybackChainReader, buybackSchedule, toLaunchBuyback, treasuryClaims } from './BuybackFeed';

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const MINT = key(100);
const SOL = 1_000_000_000n;

const token = (overrides: Partial<RevenueTokenAccount> = {}): RevenueTokenAccount => ({
  pool: key(10),
  position: key(30),
  vote: key(20),
  operator: key(22),
  mint: MINT,
  tokenProgram: key(5),
  dbcPool: key(101),
  dbcConfig: key(102),
  dammPool: null,
  shareBps: 2_000,
  termEpochs: 52,
  registeredEpoch: 89n,
  startEpoch: 90n,
  termEndEpoch: 142n,
  advanceSeqAtRegistration: 0n,
  inflationCommissionBps: 500,
  blockCommissionBps: 1_000,
  bump: 255,
  escrowBump: 254,
  tokensBump: 253,
  wsolBump: 252,
  slicesPerEpoch: 12,
  windowSlots: 9_000,
  maxSlippageBps: 300,
  maxImpactBps: 100,
  flags: 0,
  status: 'curve',
  buybackEpoch: 100n,
  epochBudget: 12n * SOL,
  epochSpent: 2n * SOL,
  slicesDone: 0b11,
  lastShareEpoch: 100n,
  totalEscrowed: 24n * SOL,
  totalSpent: 14n * SOL,
  totalBought: 7_000_000_000n,
  totalBurned: 7_000_000_000n,
  totalRedeemed: 1_000_000n,
  totalRedeemedLamports: SOL / 10n,
  buybackCount: 14,
  ...overrides,
});

const info = (slotIndex: number, epoch = 100): ProgramEpochInfo => ({
  epoch,
  slotIndex,
  slotsInEpoch: 432_000,
  absoluteSlot: epoch * 432_000 + slotIndex,
});

const buyback = (slice: number, venue = 'dbc'): StoredProgramEvent => ({
  signature: `sig${slice}`,
  ix: 0,
  slot: 43_200_000 + slice,
  epoch: 100,
  blockTime: null,
  name: 'BuybackExecuted',
  data: {
    vote: key(20).toBase58(),
    mint: MINT.toBase58(),
    venue,
    epoch: '100',
    slice,
    lamportsIn: '500000000',
    tokensBought: '250000000',
    tokensBurned: '250000000',
    minAmountOut: '240000000',
    feeFreeOut: '252000000',
    escrowBalance: '9000000000',
  },
});

const TREASURY = key(140);
const treasuryClaim = (
  n: number,
  kind: string,
  lamportsToPool: string,
  tokensBurned: string,
  position = new PublicKey(new Uint8Array(32)).toBase58(),
): StoredProgramEvent => ({
  signature: `claim${n}`,
  ix: 0,
  slot: 43_300_000 + n,
  epoch: 101,
  blockTime: null,
  name: 'TreasuryClaimed',
  data: {
    pool: key(10).toBase58(),
    kind,
    mint: MINT.toBase58(),
    source: key(kind === 'lpFee' ? 104 : 101).toBase58(),
    position,
    cranker: key(7).toBase58(),
    lamportsClaimed: lamportsToPool,
    lamportsToPool,
    tokensClaimed: tokensBurned,
    tokensBurned,
    poolCash: '100000000000',
    incomeUnallocated: lamportsToPool,
  },
});
const CLAIMS = [
  treasuryClaim(4, 'lpFee', '2000000', '1500000', key(150).toBase58()),
  treasuryClaim(3, 'leftover', '0', '578372000000'),
  treasuryClaim(2, 'migrationFee', '3500000000', '0'),
  treasuryClaim(1, 'tradingFee', '81234567', '0'),
];

describe('treasuryClaims', () => {
  it('adds up SOL to lenders and tokens burned, in total and by kind, newest first', () => {
    const section = treasuryClaims(CLAIMS, 6, MINT.toBase58(), TREASURY, 2);
    expect(section.address).toBe(TREASURY.toBase58());
    expect(section.totals).toEqual({ toLendersSol: 3.583234567, tokensBurned: 578_373.5, claims: 4 });
    expect(section.byKind.migrationFee).toEqual({ toLendersSol: 3.5, tokensBurned: 0, claims: 1 });
    expect(section.byKind.leftover).toEqual({ toLendersSol: 0, tokensBurned: 578_372, claims: 1 });
    expect(section.byKind.surplus).toEqual({ toLendersSol: 0, tokensBurned: 0, claims: 0 });
    // Only the newest `listed` rows; the totals cover them all.
    expect(section.claims).toEqual([
      {
        kind: 'lpFee',
        epoch: 101,
        source: key(104).toBase58(),
        position: key(150).toBase58(),
        toLendersSol: 0.002,
        tokensBurned: 1.5,
        signature: 'claim4',
      },
      {
        kind: 'leftover',
        epoch: 101,
        source: key(101).toBase58(),
        position: null,
        toLendersSol: 0,
        tokensBurned: 578_372,
        signature: 'claim3',
      },
    ]);
    expect(section.claimable).toBe(`/v1/launches/${MINT.toBase58()}/fees`);
  });

  it('is empty without claims, and has no address without a program id', () => {
    expect(treasuryClaims([], 6, MINT.toBase58(), null, 200)).toMatchObject({
      address: null,
      totals: { toLendersSol: 0, tokensBurned: 0, claims: 0 },
      claims: [],
    });
  });
});

describe('buybackSchedule', () => {
  // The token is in its term (epochs 90–141) and epoch 100's share is swept (lastShareEpoch 100).
  it('points at the first slice not done this epoch, from its due slot', () => {
    // Slices 0 and 1 ran; slice 2 is due at slot 1,500.
    expect(buybackSchedule(token(), info(1_000), SOL).nextSlice).toEqual({
      epoch: 100,
      slice: 2,
      inSlots: 500,
      etaSeconds: 200,
      waitsForSweep: false,
    });
    // Already due: now.
    expect(buybackSchedule(token(), info(2_000), SOL).nextSlice).toMatchObject({ slice: 2, inSlots: 0 });
    expect(buybackSchedule(token(), info(2_000), SOL).slicesDoneThisEpoch).toBe(2);
  });

  it('rolls to slice 0 of the next epoch after the window, or when the bitmap is an older epoch’s', () => {
    // Epoch 101 is in the term: its slices wait for its sweep.
    expect(buybackSchedule(token(), info(9_000), SOL).nextSlice).toEqual({
      epoch: 101,
      slice: 0,
      inSlots: 423_000,
      etaSeconds: 169_200,
      waitsForSweep: true,
    });
    const fresh = buybackSchedule(token({ buybackEpoch: 99n }), info(10), SOL);
    expect(fresh.slicesDoneThisEpoch).toBe(0);
    expect(fresh.nextSlice).toMatchObject({ epoch: 100, slice: 0, inSlots: 0 });
  });

  it('before the term with an empty escrow: slice 0 of the start epoch, after its sweep (never "now")', () => {
    // rOPR on the stand-in: registered in epoch 0, term from epoch 1, nothing in the escrow, 5,750 slots into epoch 0.
    const notStarted = token({
      registeredEpoch: 0n,
      startEpoch: 1n,
      termEndEpoch: 11n,
      buybackEpoch: 0n,
      slicesDone: 0,
    });
    const early = { ...notStarted, lastShareEpoch: 0n };
    expect(buybackSchedule(early, info(5_750, 0), 0n)).toEqual({
      slicesPerEpoch: 12,
      windowSlots: 9_000,
      slicesDoneThisEpoch: 0,
      paused: false,
      nextSlice: { epoch: 1, slice: 0, inSlots: 426_250, etaSeconds: 170_500, waitsForSweep: true },
    });
    // Two epochs before the start: the countdown spans the epoch in between.
    expect(buybackSchedule({ ...early, startEpoch: 2n }, info(5_750, 0), 0n).nextSlice).toMatchObject({
      epoch: 2,
      inSlots: 426_250 + 432_000,
    });
    // SOL already in the escrow (sent by hand): the program buys with it before the term, so a slice is due now.
    expect(buybackSchedule(early, info(5_750, 0), SOL / 10n).nextSlice).toEqual({
      epoch: 0,
      slice: 0,
      inSlots: 0,
      etaSeconds: 0,
      waitsForSweep: false,
    });
  });

  it("in the term with an empty escrow: waits for this epoch's sweep, or the next epoch once the share is spent", () => {
    // Epoch 100's sweep has not run (the last share was epoch 99's): slice 2 is due at slot 1,500, after the sweep.
    expect(buybackSchedule(token({ lastShareEpoch: 99n }), info(1_000), 0n).nextSlice).toEqual({
      epoch: 100,
      slice: 2,
      inSlots: 500,
      etaSeconds: 200,
      waitsForSweep: true,
    });
    // Epoch 100's share is swept and spent: nothing to buy until epoch 101's share.
    expect(buybackSchedule(token(), info(1_000), 0n).nextSlice).toEqual({
      epoch: 101,
      slice: 0,
      inSlots: 431_000,
      etaSeconds: 172_400,
      waitsForSweep: true,
    });
    // The last epoch of the term (141), its share spent: nothing is left to buy.
    expect(
      buybackSchedule(token({ lastShareEpoch: 141n, buybackEpoch: 141n }), info(1_000, 141), 0n).nextSlice,
    ).toBeNull();
  });

  it('has no next slice once the term ended and the escrow is spent; reports a pause', () => {
    expect(buybackSchedule(token(), info(10, 150), 0n).nextSlice).toBeNull();
    // After the term, what is left in the escrow is still bought back, with no sweep to wait for.
    expect(buybackSchedule(token(), info(10, 150), SOL).nextSlice).toEqual({
      epoch: 150,
      slice: 0,
      inSlots: 0,
      etaSeconds: 0,
      waitsForSweep: false,
    });
    expect(buybackSchedule(token(), info(9_500, 150), SOL).nextSlice).toMatchObject({
      epoch: 151,
      waitsForSweep: false,
    });
    expect(buybackSchedule(token({ flags: REVENUE_TOKEN_FLAGS.buybacksPaused }), info(10), SOL).paused).toBe(true);
  });
});

describe('toLaunchBuyback', () => {
  it('converts lamports and raw token units, and names the venue like the contract', () => {
    expect(toLaunchBuyback(buyback(3, 'dammV2'), 12, 6)).toEqual({
      epoch: 100,
      slice: 3,
      slices: 12,
      solIn: 0.5,
      tokensBurned: 250,
      priceSol: 0.002,
      venue: 'damm-v2',
      signature: 'sig3',
    });
    expect(toLaunchBuyback(buyback(0), 12, 6).venue).toBe('dbc');
  });
});

describe('BuybackFeed', () => {
  const chain = (found: RevenueTokenAccount | null, epoch = info(1_000)): BuybackChainReader => ({
    network: 'devnet',
    revenueTokenByMint: async () => (found ? { address: key(130), account: found } : null),
    escrowAvailable: async () => 9n * SOL,
    decimals: async () => 6,
    epochInfo: async () => epoch,
    escrowAddress: () => key(131),
    treasuryAddress: () => TREASURY,
  });
  const queries: EventQuery[] = [];
  const events = {
    query: async (query?: EventQuery) => {
      queries.push(query ?? {});
      return query?.names?.includes('TreasuryClaimed') ? CLAIMS : [buyback(1), buyback(0)];
    },
  };
  const now = () => new Date('2026-10-04T03:30:00Z');

  it('reads the token, its escrow, schedule, totals and buyback history for the mint', async () => {
    const feed = await new BuybackFeed({ chain: chain(token()), events, now }).get(MINT.toBase58());
    expect(queries.slice(-2)).toEqual([
      { names: ['TreasuryClaimed'], where: { mint: MINT.toBase58() }, limit: 10_000 },
      { names: ['BuybackExecuted'], where: { mint: MINT.toBase58() }, limit: 200 },
    ]);
    expect(feed).toMatchObject({
      schemaVersion: 1,
      kind: 'real',
      asOf: '2026-10-04T09:00:00+05:30',
      network: 'devnet',
      mint: MINT.toBase58(),
      revenueToken: key(130).toBase58(),
      vote: key(20).toBase58(),
      venue: 'dbc',
      term: { shareBps: 2_000, termEpochs: 52, startEpoch: 90, endEpoch: 141 },
      escrow: { address: key(131).toBase58(), balanceSol: 9, mode: 'buyback' },
      totals: { escrowedSol: 24, spentSol: 14, burned: 7_000, redeemed: 1, redeemedSol: 0.1, buybacks: 14 },
    });
    expect(feed.buybacks.map((b) => b.slice)).toEqual([1, 0]);
    expect(feed.schedule?.nextSlice?.slice).toBe(2);
    expect(feed.treasury).toMatchObject({ address: TREASURY.toBase58(), totals: { claims: 4 } });
    expect(feed.treasury.claims).toHaveLength(4);
  });

  it('switches to DAMM v2 after graduation and to redeem mode once holders can redeem', async () => {
    const graduated = token({ dammPool: key(104), status: 'graduated', flags: REVENUE_TOKEN_FLAGS.redeemDuringTerm });
    const feed = await new BuybackFeed({ chain: chain(graduated), events, now }).get(MINT.toBase58());
    expect(feed.venue).toBe('damm-v2');
    expect(feed.escrow.mode).toBe('redeem');
  });

  it('answers an empty feed for a mint no validator registered', async () => {
    const feed = await new BuybackFeed({ chain: chain(null), events, now }).get(MINT.toBase58());
    expect(feed).toMatchObject({ revenueToken: null, venue: null, schedule: null, buybacks: [] });
    expect(feed.note).toMatch(/No validator/);
    // The treasury claims a launch whether or not a validator registered it.
    expect(feed.treasury.totals).toEqual({ toLendersSol: 3.583234567, tokensBurned: 578_373.5, claims: 4 });
  });

  it('refuses a string that is not a public key', async () => {
    await expect(new BuybackFeed({ chain: chain(null), events, now }).get('notakey0')).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});
