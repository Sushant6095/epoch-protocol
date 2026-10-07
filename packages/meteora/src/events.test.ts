import { readFileSync } from 'fs';
import { join } from 'path';

import { CpAmmIdl } from '@meteora-ag/cp-amm-sdk';
import { DynamicBondingCurveIdl } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey } from '@solana/web3.js';

import { base58Decode } from './base58';
import {
  DAMM_V2_PROGRAM,
  DBC_PROGRAM,
  decodeMeteoraEvents,
  launchFeeEventsFromTransaction,
  launchTradesFromTransaction,
  normalizeTransaction,
  type TradePoolInfo,
} from './events';

/** Transactions recorded in the rehearsal (docs/runbooks/meteora-devnet-rehearsal.md): Meteora's mainnet programs. */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '__fixtures__/rehearsal', `${name}.json`), 'utf8')) as unknown;
const record = fixture('launch-record') as { dbcPool: string; mint: string };
const DBC_POOL = record.dbcPool;
const DAMM_POOL = '849LsiGbYgC9vRSMiMi3SKrT7C3D3dYPCYX1HD1cGokj';
const POOLS = new Map<string, TradePoolInfo>([
  [DBC_POOL, { venue: 'dbc', baseDecimals: 6 }],
  [DAMM_POOL, { venue: 'damm-v2', baseDecimals: 6, baseIsTokenA: true }],
]);
const TREASURY = 'AQ3gcCLTPwTHsBhNBTFz94L2kxKevZuywYWobx9H9Mf8';
const VALIDATOR = 'GjMZo48qTs7nuowtcPYj7K6vtsMiXJbRUePgmK6RF1c1';

const trades = (name: string) => launchTradesFromTransaction(normalizeTransaction(fixture(name)), POOLS);
const feeEvents = (name: string) =>
  launchFeeEventsFromTransaction(
    normalizeTransaction(fixture(name)),
    new Set([DBC_POOL]),
    new Map([[DAMM_POOL, { baseIsTokenA: true }]]),
  );

describe('normalizeTransaction', () => {
  it('flattens top-level and inner instructions in execution order with their stack heights', () => {
    const tx = normalizeTransaction(fixture('dbc-buy'));
    expect(tx.signature).toBe(
      'P2r3JR57VBGMCntNMaGpGYo5gCiG915M12yNf9C3bq78ByEF6vSaAhAsFEwXZommPWPyYJvxEAgkX947QxHdu9n',
    );
    expect(tx.slot).toBe(3443);
    expect(tx.blockTime).toBe(1791034674);
    expect(tx.failed).toBe(false);
    expect(tx.feePayer).toBe('6MTBgCMiLQLbXrMXmWa172Hv2hE2q1wANkfPZD2QMTA5');
    expect(tx.instructions[0].stackHeight).toBe(1);
    const swap = tx.instructions.findIndex((ix) => ix.programId === DBC_PROGRAM && ix.stackHeight === 1);
    expect(swap).toBeGreaterThan(0);
    // The swap's own CPIs follow it, one level deeper.
    expect(tx.instructions[swap + 1].stackHeight).toBe(2);
    expect(tx.instructions.every((ix) => ix.data instanceof Uint8Array)).toBe(true);
  });

  it("reads web3.js's VersionedTransactionResponse shape (PublicKey keys, compiled instructions)", () => {
    const raw = fixture('damm-buy') as {
      transaction: {
        signatures: string[];
        message: {
          accountKeys: string[];
          instructions: { programIdIndex: number; accounts: number[]; data: string }[];
        };
      };
    } & Record<string, unknown>;
    const web3Shape = {
      ...raw,
      transaction: {
        signatures: raw.transaction.signatures,
        message: {
          staticAccountKeys: raw.transaction.message.accountKeys.map((key) => new PublicKey(key)),
          compiledInstructions: raw.transaction.message.instructions.map((ix) => ({
            programIdIndex: ix.programIdIndex,
            accountKeyIndexes: ix.accounts,
            data: base58Decode(ix.data),
          })),
        },
      },
    };
    expect(launchTradesFromTransaction(normalizeTransaction(web3Shape), POOLS)).toEqual(trades('damm-buy'));
  });

  it('marks failed transactions, which carry no events', () => {
    const raw = fixture('dbc-buy') as { meta: Record<string, unknown> };
    const failed = normalizeTransaction({
      ...raw,
      meta: { ...raw.meta, err: { InstructionError: [3, { Custom: 6001 }] } },
    });
    expect(failed.failed).toBe(true);
    expect(decodeMeteoraEvents(failed)).toEqual([]);
  });
});

describe('decodeMeteoraEvents', () => {
  it('decodes DBC CPI events and names the instruction that emitted them', () => {
    const events = decodeMeteoraEvents(normalizeTransaction(fixture('dbc-buy-completes-curve')));
    expect(events.map((event) => [event.program, event.name, event.index, event.parent?.name])).toEqual([
      ['dbc', 'EvtSwap', 0, 'swap2'],
      ['dbc', 'EvtSwap2', 1, 'swap2'],
      ['dbc', 'EvtCurveComplete', 2, 'swap2'],
    ]);
    const swap2 = events[1];
    expect(swap2.data.pool).toBe(DBC_POOL);
    expect(swap2.data.tradeDirection).toBe(1); // QuoteToBase: a buy
    expect(swap2.data.quoteReserveAmount).toBe(750_000_387n);
    expect(swap2.data.migrationThreshold).toBe(750_000_386n);
    expect(swap2.parent?.accounts.payer).toBe('CuioAkwCMnBr7gb4wCSqFi9baBEkpv6uj4VuyHwhqaWu');
  });

  it('decodes the DAMM v2 events of the migration CPI (pool, position, permanent lock)', () => {
    const events = decodeMeteoraEvents(normalizeTransaction(fixture('migrate-damm-v2')));
    expect(events.map((event) => `${event.program}:${event.name}`)).toEqual([
      'damm-v2:EvtCreatePosition',
      'damm-v2:EvtInitializePool',
      'damm-v2:EvtPermanentLockPosition',
    ]);
    const init = events[1].data;
    expect(init.pool).toBe(DAMM_POOL);
    expect(init.tokenAMint).toBe(record.mint);
    expect(init.tokenBMint).toBe('So11111111111111111111111111111111111111112');
    const lock = events[2].data;
    expect(lock.totalPermanentLockedLiquidity).toBe(lock.lockLiquidityAmount);
    expect(DAMM_V2_PROGRAM).toBe('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
  });
});

describe('launchTradesFromTransaction', () => {
  it('a curve buy: SOL paid with the 1% fee, tokens received, execution and post-trade prices', () => {
    expect(trades('dbc-buy')).toEqual([
      {
        signature: 'P2r3JR57VBGMCntNMaGpGYo5gCiG915M12yNf9C3bq78ByEF6vSaAhAsFEwXZommPWPyYJvxEAgkX947QxHdu9n',
        slot: 3443,
        blockTime: 1791034674,
        ix: 1,
        venue: 'dbc',
        pool: DBC_POOL,
        side: 'buy',
        trader: '6MTBgCMiLQLbXrMXmWa172Hv2hE2q1wANkfPZD2QMTA5',
        solAmount: 200_000_000n,
        tokenAmount: 89_402_418_317n,
        fee: 2_000_000n,
        feeInToken: false,
        priceSol: expect.closeTo(0.198 / 89_402.418317, 15),
        postPriceSol: expect.closeTo(0.00000236471, 10),
        quoteReserve: 217_800_000n,
      },
    ]);
  });

  it("counts DBC's legacy EvtSwap twin once (swap2 and the first buy's swap emit both)", () => {
    expect(trades('dbc-buy')).toHaveLength(1);
    const firstBuy = trades('launch-create-pool-first-buy');
    expect(firstBuy).toHaveLength(1);
    expect(firstBuy[0]).toMatchObject({ side: 'buy', solAmount: 20_000_000n, tokenAmount: 9_610_866_785n, ix: 2 });
  });

  it('a curve sell: SOL received after the fee, priced before it', () => {
    const [sell] = trades('dbc-sell');
    expect(sell).toMatchObject({ side: 'sell', solAmount: 75_281_111n, tokenAmount: 30_000_000_000n, fee: 760_416n });
    // Gross SOL out (after-fee amount + fee) over the tokens sold.
    expect(sell.priceSol).toBeCloseTo((75_281_111 + 760_416) / 1e9 / 30_000, 15);
  });

  it('the buy that completes the raise: PartialFill uses only what the threshold needs', () => {
    const [buy] = trades('dbc-buy-completes-curve');
    expect(buy).toMatchObject({ side: 'buy', solAmount: 464_385_772n, quoteReserve: 750_000_387n });
  });

  it('DAMM v2 buys and sells after graduation, oriented around the token (token A)', () => {
    expect(trades('damm-buy')).toEqual([
      expect.objectContaining({
        venue: 'damm-v2',
        pool: DAMM_POOL,
        side: 'buy',
        solAmount: 100_000_000n,
        tokenAmount: 21_207_205_771n,
        fee: 1_000_000n,
        feeInToken: false,
        quoteReserve: 323_550_116n,
      }),
    ]);
    expect(trades('damm-sell')).toEqual([
      expect.objectContaining({
        venue: 'damm-v2',
        side: 'sell',
        solAmount: 162_926_566n,
        tokenAmount: 50_000_000_000n,
      }),
    ]);
  });

  it('ignores pools it does not know', () => {
    expect(launchTradesFromTransaction(normalizeTransaction(fixture('dbc-buy')), new Map())).toEqual([]);
  });
});

describe('launchFeeEventsFromTransaction', () => {
  it('curve completion and the DAMM v2 pool created at graduation', () => {
    expect(feeEvents('dbc-buy-completes-curve')).toEqual([
      expect.objectContaining({ kind: 'curveComplete', pool: DBC_POOL, solAmount: 750_000_387n, ix: 2 }),
    ]);
    expect(feeEvents('migrate-damm-v2')).toEqual([
      expect.objectContaining({
        kind: 'dammPoolCreated',
        pool: DAMM_POOL,
        solAmount: 224_550_116n,
        tokenAmount: 69_309_029_363n,
      }),
    ]);
  });

  it('claims: partner trading fee, the 70% migration fee, the leftover and the locked LP fees', () => {
    expect(feeEvents('claim-partner-trading-fee')).toEqual([
      expect.objectContaining({ kind: 'partnerTradingFee', solAmount: 7_283_420n, tokenAmount: 0n, owner: TREASURY }),
    ]);
    expect(feeEvents('claim-creator-migration-fee')).toEqual([
      expect.objectContaining({ kind: 'creatorMigrationFee', solAmount: 525_000_270n, owner: VALIDATOR }),
    ]);
    expect(feeEvents('withdraw-leftover')).toEqual([
      expect.objectContaining({ kind: 'leftover', solAmount: 0n, tokenAmount: 639_263_000_567n, owner: TREASURY }),
    ]);
    expect(feeEvents('claim-lp-fee')).toEqual([
      expect.objectContaining({
        kind: 'lpFee',
        pool: DAMM_POOL,
        solAmount: 2_862_904n,
        tokenAmount: 0n,
        owner: TREASURY,
      }),
    ]);
  });

  it('has nothing for a plain trade', () => {
    expect(feeEvents('dbc-buy')).toEqual([]);
  });
});

describe('the events we read exist in the pinned SDKs’ IDLs', () => {
  interface IdlEvents {
    events: { name: string }[];
    types: { name: string; type: { fields?: { name: string }[] } }[];
  }
  const dbcIdl = DynamicBondingCurveIdl as unknown as IdlEvents;
  const cpAmmIdl = CpAmmIdl as unknown as IdlEvents;
  const names = (idl: IdlEvents) => idl.events.map((e) => e.name);
  const fields = (idl: IdlEvents, event: string) =>
    idl.types.find((t) => t.name === event)?.type.fields?.map((f) => f.name) ?? [];

  // A renamed or removed event would never match the switch in events.ts and drop trades or claims silently.
  it('has every DBC event events.ts maps', () => {
    expect(names(dbcIdl)).toEqual(
      expect.arrayContaining([
        'EvtSwap',
        'EvtSwap2',
        'EvtClaimTradingFee',
        'EvtClaimCreatorTradingFee',
        'EvtWithdrawMigrationFee',
        'EvtPartnerWithdrawSurplus',
        'EvtCreatorWithdrawSurplus',
        'EvtWithdrawLeftover',
        'EvtCurveComplete',
      ]),
    );
  });

  it('has every DAMM v2 event events.ts maps, with the fields it reads', () => {
    expect(names(cpAmmIdl)).toEqual(expect.arrayContaining(['EvtSwap2', 'EvtClaimPositionFee', 'EvtInitializePool']));
    expect(fields(cpAmmIdl, 'EvtClaimPositionFee')).toEqual(
      expect.arrayContaining(['owner', 'fee_a_claimed', 'fee_b_claimed']),
    );
    expect(fields(cpAmmIdl, 'EvtInitializePool')).toEqual(
      expect.arrayContaining(['creator', 'token_a_amount', 'token_b_amount']),
    );
  });
});
