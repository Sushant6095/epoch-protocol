import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import * as meteora from './index';

/** The agreed public API (the Launch page and api_app are written against these names; request #23). */
const REQUIRED = [
  'readLaunchPool',
  'readDammPool',
  'quoteTrade',
  'buildTradeTx',
  'curvePointsForBand',
  'revenueCurveConfig',
  'launchBand',
  'curveBand',
  'shareRevenuePerEpochSol',
  'shareValueSol',
  'impliedYieldPctPerEpoch',
  'backingRatio',
  'marketCapSol',
  'epochsLeft',
  'endEpochOf',
  'upfrontToValidatorSol',
  'readTokenMint',
  'countTokenHolders',
  'parseLaunchConfig',
  'planLaunch',
  'registryEntryFor',
  'LaunchTradeError',
  'toBaseUnits',
  'fromBaseUnits',
] as const;

// Compile-time: the contract's LaunchTradeQuote shape (handover contracts/epoch-data.ts).
const quote: meteora.LaunchTradeQuote = {
  side: 'buy',
  amountIn: 1,
  amountOut: 1,
  minimumOut: 1,
  priceImpactPct: 0,
  tradingFeeSol: 0,
  venue: 'damm-v2',
};

describe('public API', () => {
  it.each(REQUIRED)('exports %s', (name) => {
    expect((meteora as Record<string, unknown>)[name]).toBeDefined();
  });

  it('keeps the contract quote shape', () => {
    expect(Object.keys(quote).sort()).toEqual(
      ['amountIn', 'amountOut', 'minimumOut', 'priceImpactPct', 'side', 'tradingFeeSol', 'venue'].sort(),
    );
  });
});

describe('browser safety', () => {
  const sources = readdirSync(__dirname)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => ({ file, text: readFileSync(join(__dirname, file), 'utf8') }));

  it('scans every source file', () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining(['curve.ts', 'index.ts', 'math.ts', 'pools.ts', 'token.ts', 'trade.ts', 'units.ts']),
    );
  });

  it.each(['crypto', 'fs', 'path', 'os', 'util', 'stream', 'child_process', 'http', 'https', 'net', 'zlib', 'buffer'])(
    'never imports the Node built-in %s',
    (mod) => {
      for (const { file, text } of sources) {
        expect({ file, hit: new RegExp(`from '(node:)?${mod}'`).test(text) }).toEqual({ file, hit: false });
      }
    },
  );

  it('uses no Node globals, no require and no app packages', () => {
    for (const { file, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect({ file, require: /\brequire\(/.test(code) }).toEqual({ file, require: false });
      expect({ file, process: /\bprocess\./.test(code) }).toEqual({ file, process: false });
      expect({ file, buffer: /\bBuffer\b/.test(code) }).toEqual({ file, buffer: false });
      expect({ file, app: /from '@epoch\//.test(code) }).toEqual({ file, app: false });
    }
  });
});
