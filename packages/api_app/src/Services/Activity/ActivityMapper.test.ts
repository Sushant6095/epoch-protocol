import { readFileSync } from 'fs';
import { join } from 'path';

import { decodeEvent, eventToJson, hexToBytes } from '@epoch/epoch-sdk';

import { type StoredProgramEvent } from '../../Lib/EventBus';
import { ACTIVITY_EVENT_NAMES, predictCallToActivityEvent, toActivityEvent } from './ActivityMapper';
import { EMPTY_NAMES, nameIndex } from './ValidatorNames';

const VOTE = 'FzUNgBRnVxawDytN9GM7BFwxFfekuMs7BcAGybn4AmMk';
const OTHER_VOTE = 'Ccnj5tkFrPvRxbMy8GAyBgnuqUyZb1wKJLxZRAKvUYdj';
const NAMES = nameIndex([{ name: 'Kestrel Nodes', vote: VOTE, identity: 'id-kestrel' }]);

const stored = (name: StoredProgramEvent['name'], data: StoredProgramEvent['data'], ix = 0): StoredProgramEvent => ({
  signature: 'sig1',
  ix,
  slot: 100,
  epoch: 7,
  blockTime: '2026-10-03T00:00:00.000Z',
  name,
  data,
});

const row = (name: StoredProgramEvent['name'], data: StoredProgramEvent['data']) =>
  toActivityEvent(stored(name, data), NAMES);

describe('toActivityEvent', () => {
  it('maps sweeps: repaid at source when something was remitted, else the gross sweep', () => {
    expect(row('Swept', { vote: VOTE, epoch: '1044', gross: '20000000000', remitted: '10000000000' })).toEqual({
      id: 'sig1:0',
      kind: 'sweep',
      text: 'Kestrel Nodes · repaid at source',
      amountSol: 10,
      value: null,
      unit: 'SOL',
      signature: 'sig1',
    });
    expect(row('Swept', { vote: OTHER_VOTE, gross: '1500000000', remitted: '0' })).toMatchObject({
      text: 'Ccnj…UYdj · swept, nothing owed',
      amountSol: 1.5,
    });
  });

  it('maps deposits and withdrawals by tranche', () => {
    expect(row('Deposited', { tranche: 'senior', assets: '25000000000' })).toMatchObject({
      kind: 'deposit',
      text: 'Senior tranche · deposit',
      amountSol: 25,
      unit: 'SOL',
    });
    expect(row('Deposited', { tranche: 'junior', assets: '30000000000' })?.text).toBe('Junior tranche · deposit');
    expect(row('WithdrawProcessed', { tranche: 'junior', assets: '20000000000', shares: '1' })).toMatchObject({
      kind: 'withdraw',
      text: 'Junior tranche · queue paid',
      amountSol: 20,
    });
    expect(row('WithdrawRequested', { tranche: 'senior', shares: '5000000000000' })).toMatchObject({
      kind: 'withdraw',
      text: 'Senior tranche · withdrawal queued',
      amountSol: null,
      value: null,
    });
    expect(row('WithdrawCancelled', { reason: 1, seq: '4' })).toMatchObject({
      kind: 'withdraw',
      text: 'Junior tranche · withdrawal bounced at the floor',
      amountSol: null,
    });
    // An owner cancelling their own request is not shown.
    expect(row('WithdrawCancelled', { reason: 0, seq: '4' })).toBeNull();
  });

  it('maps the credit lifecycle with validator names, falling back to the short vote key', () => {
    expect(row('AdvanceOpened', { vote: VOTE, principal: '120000000000', fee: '1' })).toMatchObject({
      kind: 'advance',
      text: 'Kestrel Nodes · drew credit',
      amountSol: 120,
    });
    expect(row('AdvanceRepaid', { vote: VOTE, epoch: '1050' })).toMatchObject({
      kind: 'advance',
      text: 'Kestrel Nodes · advance repaid',
      amountSol: null,
    });
    expect(
      row('AdvanceDefaulted', { vote: OTHER_VOTE, principalLost: '9000000000', bondApplied: '4000000000' }),
    ).toMatchObject({ kind: 'advance', text: 'Ccnj…UYdj · defaulted, bond applied', amountSol: 4 });
    expect(row('ValidatorOnboarded', { vote: VOTE, epoch: '1040' })).toMatchObject({
      kind: 'advance',
      text: 'Kestrel Nodes · onboarded',
      amountSol: null,
    });
    expect(toActivityEvent(stored('AdvanceRepaid', { vote: VOTE }), EMPTY_NAMES)?.text).toBe(
      'FzUN…AmMk · advance repaid',
    );
  });

  it('maps the Fee Index in µL/CU', () => {
    expect(row('IndexProposed', { epoch: '1043', value: '1330', slot: '9' })).toEqual({
      id: 'sig1:0',
      kind: 'index',
      text: 'Epoch 1043 Fee Index proposed',
      amountSol: null,
      value: 1330,
      unit: 'µL/CU',
      signature: 'sig1',
    });
    expect(row('IndexFinalized', { epoch: '1042', value: '1284', slot: '9' })?.text).toBe('Epoch 1042 Fee Index final');
    expect(row('IndexVetoed', { epoch: '1043', value: '1330' })).toMatchObject({
      text: 'Epoch 1043 Fee Index vetoed',
      value: 1330,
    });
  });

  it('maps swaps: the side and notional when opened, the taker P&L (signed) when settled', () => {
    expect(row('SwapOpened', { side: 'payFixed', epoch: '1045', notional: '5000000000' })).toMatchObject({
      kind: 'swap',
      text: 'Pay fixed · epoch 1045',
      amountSol: 5,
    });
    expect(row('SwapOpened', { side: 'receiveFixed', epoch: '1046', notional: '2500000000' })?.text).toBe(
      'Receive fixed · epoch 1046',
    );
    expect(row('SwapSettled', { epoch: '1042', indexValue: '1284', takerPnl: '-193000000' })).toMatchObject({
      kind: 'swap',
      text: 'Swap settled · epoch 1042',
      amountSol: -0.193,
    });
  });

  it('maps the revenue-token lifecycle as buybacks', () => {
    expect(
      row('BuybackExecuted', { vote: VOTE, venue: 'dbc', lamportsIn: '125660849', tokensBurned: '5711541835' }),
    ).toEqual({
      id: 'sig1:0',
      kind: 'buyback',
      text: 'Kestrel Nodes · bought back and burned on the curve',
      amountSol: 0.125660849,
      value: null,
      unit: 'SOL',
      signature: 'sig1',
      mint: null,
    });
    // Request #29: buyback events carry the mint they name.
    const MINT = 'EUdJ2RLs9NxeiaJfwTJsqTwX7iA1H7put7fcAVoRiDs1';
    expect(row('BuybackExecuted', { vote: VOTE, mint: MINT, venue: 'dbc', lamportsIn: '1' })?.mint).toBe(MINT);
    expect(row('RevenueTokenRedeemed', { vote: VOTE, mint: MINT, lamportsOut: '1' })?.mint).toBe(MINT);
    expect(row('Swept', { vote: VOTE, gross: '1', remitted: '0' })).not.toHaveProperty('mint');
    expect(row('BuybackExecuted', { vote: VOTE, venue: 'dammV2', lamportsIn: '1000000000' })).toMatchObject({
      text: 'Kestrel Nodes · bought back and burned on DAMM v2',
      amountSol: 1,
    });
    expect(row('RevenueTokenRegistered', { vote: VOTE, shareBps: 2000, termEpochs: 52 })).toMatchObject({
      kind: 'buyback',
      text: 'Kestrel Nodes · revenue token: 20% of revenue for 52 epochs',
      amountSol: null,
    });
    expect(row('RevenueShareSwept', { vote: OTHER_VOTE, share: '2000000000' })).toMatchObject({
      text: 'Ccnj…UYdj · revenue share to the buyback escrow',
      amountSol: 2,
    });
    expect(row('RevenueTokenRedeemed', { vote: VOTE, lamportsOut: '224432500' })).toMatchObject({
      amountSol: 0.2244325,
    });
    expect(row('RevenueTokenPoolSynced', { vote: VOTE })?.text).toBe(
      'Kestrel Nodes · revenue token graduated to DAMM v2',
    );
    expect(row('RevenueTokenClosed', { vote: VOTE })?.text).toBe('Kestrel Nodes · revenue token term closed');
    expect(row('RevenueTokenConfigured', { vote: VOTE, slicesPerEpoch: 12 })).toBeNull();
  });

  it("maps the partner treasury's claims: SOL to lenders, tokens burned", () => {
    const mint = 'EUdJ2RLs9NxeiaJfwTJsqTwX7iA1H7put7fcAVoRiDs1';
    expect(row('TreasuryClaimed', { mint, kind: 'tradingFee', lamportsToPool: '81234567', tokensBurned: '0' })).toEqual(
      {
        id: 'sig1:0',
        kind: 'buyback',
        text: 'EUdJ…iDs1 · treasury: curve trading fees to lenders',
        amountSol: 0.081234567,
        value: null,
        unit: 'SOL',
        signature: 'sig1',
        mint,
      },
    );
    expect(row('TreasuryClaimed', { mint, kind: 'lpFee', lamportsToPool: '1000000', tokensBurned: '42' })?.text).toBe(
      'EUdJ…iDs1 · treasury: DAMM v2 LP fees to lenders, tokens burned',
    );
    expect(row('TreasuryClaimed', { mint, kind: 'migrationFee', lamportsToPool: '3500000000' })).toMatchObject({
      text: 'EUdJ…iDs1 · treasury: migration fee to lenders',
      amountSol: 3.5,
    });
    expect(
      row('TreasuryClaimed', { mint, kind: 'leftover', lamportsToPool: '0', tokensBurned: '578372' }),
    ).toMatchObject({ text: 'EUdJ…iDs1 · treasury: unsold supply burned', amountSol: null });
  });

  it('skips events the feed does not show', () => {
    for (const name of ['Accrued', 'ScoreUpdated', 'BondPosted', 'QuotePosted', 'PauseToggled'] as const) {
      expect(row(name, { epoch: '1' })).toBeNull();
    }
  });

  it('uses the event position in its transaction for the id', () => {
    expect(toActivityEvent(stored('Deposited', { tranche: 'senior', assets: '1' }, 3), NAMES)?.id).toBe('sig1:3');
  });

  it('handles the real event bytes of every event the Rust program emits', () => {
    // packages/epoch-sdk/src/__fixtures__/rust-vectors.json: `Event::data` written by the program crate itself.
    const vectors = JSON.parse(
      readFileSync(join(__dirname, '../../../../epoch-sdk/src/__fixtures__/rust-vectors.json'), 'utf8'),
    ) as { events: { name: string; label: string; data: string }[] };
    expect(vectors.events.length).toBeGreaterThanOrEqual(52);
    const shown = new Set<string>(ACTIVITY_EVENT_NAMES);
    for (const vector of vectors.events) {
      const event = decodeEvent(hexToBytes(vector.data));
      expect(event?.name).toBe(vector.name);
      if (!event) continue;
      const activity = toActivityEvent(stored(event.name, eventToJson(event).data), NAMES);
      const expectShown = shown.has(vector.name) && !(vector.name === 'WithdrawCancelled' && vector.label === 'b');
      expect([vector.name, vector.label, activity !== null]).toEqual([vector.name, vector.label, expectShown]);
      if (activity) {
        expect(activity.text).not.toMatch(/undefined|NaN/);
        expect(activity.amountSol === null || Number.isFinite(activity.amountSol)).toBe(true);
        expect(activity.value === null || Number.isFinite(activity.value)).toBe(true);
      }
    }
  });
});

describe('predictCallToActivityEvent', () => {
  it('shows a call in points, with no transaction', () => {
    const call = {
      id: 42,
      marketId: 'fi-1045-1500',
      label: 'Fee Index above 1,500 · epoch 1045',
      address: 'wallet',
      side: 'yes' as const,
      points: 100,
      createdAt: '2026-10-03T00:00:00.000Z',
    };
    expect(predictCallToActivityEvent(call)).toEqual({
      id: 'predict:42',
      kind: 'predict',
      text: 'Fee Index above 1,500 · epoch 1045 · YES',
      amountSol: null,
      value: 100,
      unit: 'points',
      signature: null,
    });
    expect(predictCallToActivityEvent({ ...call, side: 'no' }).text).toBe('Fee Index above 1,500 · epoch 1045 · NO');
  });
});
