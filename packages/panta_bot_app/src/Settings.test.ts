import { loadConfig, PantaBotConfigSchema } from '@epoch/config-sdk';
import { findFeeIndexPda, findPoolPda } from '@epoch/epoch-sdk';
import { Logger } from '@epoch/logger';
import { Keypair } from '@solana/web3.js';

import { dryRunReasons, feeIndexAccountOf, isPublicHttps, lifecycleConfig } from './Settings';
import { TickLoop } from './TickLoop';

const PROGRAM = Keypair.generate().publicKey.toBase58();

const live = {
  PANTA_API_KEY: 'pk_live_example',
  PANTA_BOT_KEYPAIR_PATH: '/keys/panta-bot.json',
  PANTA_MARKET_IMAGE_URL: 'https://cdn.epoch.example/fee-index.png',
  PUBLIC_API_URL: 'https://api.epoch.example',
  EPOCH_PROGRAM_ID: PROGRAM,
  EPOCH_CLUSTER: 'mainnet',
};

describe('Settings', () => {
  it('accepts only public https URLs for what Panta must open', () => {
    expect(isPublicHttps('https://api.epoch.example')).toBe(true);
    for (const bad of ['http://api.epoch.example', 'https://localhost:4000', 'https://127.0.0.1', 'nope', undefined]) {
      expect(isPublicHttps(bad)).toBe(false);
    }
  });

  it('derives the FeeIndex account from the program id', () => {
    const programId = Keypair.generate().publicKey;
    const [pool] = findPoolPda(programId);
    expect(feeIndexAccountOf({ EPOCH_PROGRAM_ID: programId.toBase58(), EPOCH_CLUSTER: 'devnet' })).toEqual({
      address: findFeeIndexPda(programId, pool)[0].toBase58(),
      cluster: 'devnet',
    });
    expect(feeIndexAccountOf({ EPOCH_PROGRAM_ID: undefined, EPOCH_CLUSTER: 'devnet' })).toBeNull();
    expect(
      feeIndexAccountOf({ EPOCH_PROGRAM_ID: 'not-a-key-but-long-enough-0000000000', EPOCH_CLUSTER: 'devnet' }),
    ).toBeNull();
  });

  it('dry-runs until everything a real market needs is configured', () => {
    expect(dryRunReasons(loadConfig(PantaBotConfigSchema, live), true)).toEqual([]);
    const bare = dryRunReasons(loadConfig(PantaBotConfigSchema, {}), false);
    expect(bare.join(' | ')).toEqual(
      [
        'PANTA_API_KEY is unset',
        'PANTA_BOT_KEYPAIR_PATH is unset',
        'PANTA_MARKET_IMAGE_URL must be a public https URL',
        'PUBLIC_API_URL must be the public https API that markets resolve from (/v1/index/epochs/{N})',
        'EPOCH_PROGRAM_ID is unset or invalid: a market is final only once the program finalizes its value',
        'DATABASE_URL is unset (thresholds and idempotency need Postgres)',
      ].join(' | '),
    );
    expect(dryRunReasons(loadConfig(PantaBotConfigSchema, { ...live, PANTA_DRY_RUN: 'true' }), true)).toEqual([
      'PANTA_DRY_RUN=true',
    ]);
  });

  it('converts the environment into lifecycle settings', () => {
    const settings = lifecycleConfig(
      loadConfig(PantaBotConfigSchema, {
        ...live,
        PANTA_MAX_CREATE_USDC_PER_DAY: '75.5',
        PANTA_MIN_TRADING_HOURS: '4',
      }),
      [],
    );
    expect(settings).toMatchObject({
      dryRun: false,
      marketsPerEpoch: 1,
      epochsAhead: 2,
      maxCreateUsdcBasePerDay: 75_500_000,
      maxLamportsPerCreate: 50_000_000,
      publicApiUrl: 'https://api.epoch.example',
      graceHours: 48,
      creatorFeeCheckMs: 6 * 3_600_000,
      maxAttempts: 3,
    });
    expect(settings.schedule).toMatchObject({
      minimumStartDelaySec: 3_600,
      closeBeforeEpochSec: 3_600,
      minTradingSec: 4 * 3_600,
      resolutionBufferSec: 6 * 3_600,
    });
    expect(settings.feeIndexAccount?.cluster).toBe('mainnet');
    expect(lifecycleConfig(loadConfig(PantaBotConfigSchema, live), ['x']).dryRun).toBe(true);
  });
});

describe('TickLoop', () => {
  it('ticks until stopped and survives a failing tick', async () => {
    const errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let ticks = 0;
    const loop = new TickLoop(
      async () => {
        ticks++;
        if (ticks === 1) throw new Error('RPC down');
      },
      1,
      () => new Promise((resolve) => setTimeout(resolve, 1)),
    );
    const stop = loop.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    await stop();
    const after = ticks;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ticks).toBe(after);
    expect(ticks).toBeGreaterThan(1);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
