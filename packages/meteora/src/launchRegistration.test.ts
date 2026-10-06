import { decodeDbcLaunchConfig } from '@epoch/epoch-sdk';
import { readFileSync } from 'fs';
import { join } from 'path';

import { PublicKey } from '@solana/web3.js';

import { NATIVE_MINT, revenueCurveConfig } from './index';
import { plannedLaunchConfig, registrationVerdict } from '../scripts/epochProgram';

const TREASURY = new PublicKey('CNZNCChW34nbLnrJy5YfQbZNytnkBNUFg3HvN7DPdXsA');
const WALLET = new PublicKey('GjMZo48qTs7nuowtcPYj7K6vtsMiXJbRUePgmK6RF1c1');
const preset = (fees: { tradingFeeBps?: number; dammFeeBps?: 25 | 30 | 100 | 200 | 400 | 600 } = {}) =>
  revenueCurveConfig({ bandLowSol: 1e-6, bandHighSol: 2e-6, supply: 1_000_000, decimals: 6, ...fees }).config;
const accounts = { quoteMint: NATIVE_MINT, feeClaimer: TREASURY, leftoverReceiver: TREASURY };

describe("the planned config through register_revenue_token's checks", () => {
  it("passes Epoch's 1%/1% preset with a 100 bps fee floor: slices may move the price 200 bps", () => {
    expect(registrationVerdict(plannedLaunchConfig(preset(), accounts), TREASURY)).toEqual({
      ok: true,
      feeFloorBps: 100,
      maxImpactBound: 200,
    });
    // The lowest venue fee bounds the impact: a 0.25% DAMM v2 pool after a 1% curve.
    expect(registrationVerdict(plannedLaunchConfig(preset({ dammFeeBps: 25 }), accounts), TREASURY)).toMatchObject({
      ok: true,
      feeFloorBps: 25,
      maxImpactBound: 50,
    });
  });

  it('names the error a config would hit: leftover elsewhere, unlocked liquidity, another fee claimer', () => {
    expect(
      registrationVerdict(plannedLaunchConfig(preset(), { ...accounts, leftoverReceiver: WALLET }), TREASURY),
    ).toMatchObject({ ok: false, error: 'NotTreasuryLeftoverReceiver' });
    expect(
      registrationVerdict(
        plannedLaunchConfig(
          { ...preset(), partnerPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 50 },
          accounts,
        ),
        TREASURY,
      ),
    ).toMatchObject({ ok: false, error: 'LiquidityNotLocked' });
    expect(
      registrationVerdict(plannedLaunchConfig(preset(), { ...accounts, feeClaimer: WALLET }), TREASURY),
    ).toMatchObject({ ok: false, error: 'InvalidDbcConfig' });
  });

  it("reads the planned fields the way the SDK decodes the rehearsal's real config account", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, '__fixtures__/rehearsal/account-dbc-config.json'), 'utf8')) as {
      data: string;
    };
    const onChain = decodeDbcLaunchConfig(Buffer.from(raw.data, 'base64'));
    // The rehearsal launched the same preset (1% curve, 1% DAMM v2, 100% locked with the partner, fixed supply).
    const planned = plannedLaunchConfig(preset(), {
      quoteMint: NATIVE_MINT,
      feeClaimer: onChain.feeClaimer,
      leftoverReceiver: onChain.leftoverReceiver,
    });
    expect({ ...planned, quoteMint: planned.quoteMint.toBase58(), feeClaimer: '', leftoverReceiver: '' }).toEqual({
      ...onChain,
      quoteMint: onChain.quoteMint.toBase58(),
      feeClaimer: '',
      leftoverReceiver: '',
    });
  });
});
