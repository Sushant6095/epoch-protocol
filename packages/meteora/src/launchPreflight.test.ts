import { readFileSync } from 'fs';
import { join } from 'path';

import { type PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, PublicKey } from '@solana/web3.js';

import {
  checkCluster,
  checkEpochPool,
  checkExistingConfig,
  checkInitialBuy,
  checkLeftoverReceiver,
  checkMetadataJson,
  checkPayerBalance,
  checkProgram,
  checkRegistrableConfig,
  checkRegistrableMint,
  checkRegistry,
  checkRevenueTokenTerms,
  checkStartEpoch,
  checkValidatorPosition,
  GENESIS_HASH,
  summarizePreflight,
  treasuryMismatch,
} from './launchPreflight';
import { dbcClient } from './pools';
import { type LaunchRegistryEntry } from './registry';
import { revenueCurveConfig } from './curve';

const entry = (overrides: Partial<LaunchRegistryEntry>): LaunchRegistryEntry => ({
  mint: 'mint',
  symbol: 'rKEST',
  name: 'Kestrel',
  validator: { name: 'Kestrel', vote: 'vote-1' },
  shareBps: 500,
  termEpochs: 100,
  startEpoch: 1_000,
  supply: 100_000,
  decimals: 6,
  cluster: 'mainnet',
  ...overrides,
});

describe('pre-flight checks', () => {
  it('cluster: the genesis hash must be the cluster asked for', () => {
    expect(checkCluster('mainnet', GENESIS_HASH.mainnet).status).toBe('pass');
    expect(checkCluster('mainnet', GENESIS_HASH.devnet)).toMatchObject({
      status: 'fail',
      detail: 'the RPC serves devnet, not mainnet',
    });
    expect(checkCluster('mainnet', 'local', true).status).toBe('fail'); // never a stand-in for mainnet
    expect(checkCluster('devnet', 'local').status).toBe('fail');
    expect(checkCluster('devnet', 'local', true).status).toBe('warn');
  });

  it('programs, balance, initial buy', () => {
    expect(checkProgram('DBC', { executable: true }).status).toBe('pass');
    expect(checkProgram('DBC', null).status).toBe('fail');
    expect(checkProgram('DBC', { executable: false }).status).toBe('fail');
    expect(checkPayerBalance(100_000_000, 55_000_000).status).toBe('pass');
    expect(checkPayerBalance(60_000_000, 55_000_000).status).toBe('fail'); // under cost + 0.01 SOL margin
    expect(checkPayerBalance(null, 55_000_000).status).toBe('warn');
    // The operator's balance before register_revenue_token (rent 0.00732192 SOL, 0.001 SOL margin).
    expect(
      checkPayerBalance(4_968_235_000, 7_321_920, 1_000_000, { name: 'Operator balance', step: 'registration' }),
    ).toEqual({
      name: 'Operator balance',
      status: 'pass',
      detail: '4.968235 SOL, registration needs about 0.007322 SOL',
    });
    expect(checkInitialBuy(undefined, 3).status).toBe('pass');
    expect(checkInitialBuy(3, 3).status).toBe('fail');
    expect(checkInitialBuy(1, 3).status).toBe('warn');
    expect(checkInitialBuy(0.1, 3).status).toBe('pass');
  });

  it('registry: one symbol per cluster, one live revenue token per vote account', () => {
    const entries = [
      entry({ symbol: 'rKEST', validator: { name: 'K', vote: 'vote-1' }, startEpoch: 1_000, termEpochs: 100 }),
    ];
    const launch = { symbol: 'rkest', vote: 'vote-1', cluster: 'mainnet' as const, currentEpoch: 1_050 };
    expect(checkRegistry(entries, launch).map((check) => check.status)).toEqual(['fail', 'fail']);
    expect(
      checkRegistry(entries, { ...launch, symbol: 'rNEW', currentEpoch: 1_200 }).map((check) => check.status),
    ).toEqual(['pass', 'pass']);
    expect(checkRegistry(entries, { ...launch, cluster: 'devnet' }).map((check) => check.status)).toEqual([
      'pass',
      'pass',
    ]);
  });

  it('metadata URI: name, symbol and image must match (a warning on devnet, a failure on mainnet)', () => {
    const launch = { name: 'Kestrel revenue token', symbol: 'rKEST', cluster: 'mainnet' as const };
    expect(
      checkMetadataJson(
        { ok: true, json: { name: 'Kestrel revenue token', symbol: 'rKEST', image: 'https://x/y.png' } },
        launch,
      ).status,
    ).toBe('pass');
    expect(checkMetadataJson({ ok: true, json: { name: 'Other', symbol: 'rKEST' } }, launch)).toMatchObject({
      status: 'fail',
    });
    expect(checkMetadataJson({ ok: false, status: 404 }, { ...launch, cluster: 'devnet' })).toMatchObject({
      status: 'warn',
      detail: 'not reachable (HTTP 404)',
    });
  });

  it('an existing config is reused only when it matches the plan and pays Epoch', () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '__fixtures__/rehearsal/account-dbc-config.json'), 'utf8'),
    ) as { data: string };
    const onChain = dbcClient(new Connection('http://127.0.0.1:1'))
      .state.getProgram()
      .coder.accounts.decode('poolConfig', Buffer.from(fixture.data, 'base64')) as PoolConfig;
    const partner = {
      feeClaimer: onChain.feeClaimer.toBase58(),
      leftoverReceiver: onChain.leftoverReceiver.toBase58(),
    };
    const planned = {
      ...revenueCurveConfig({ bandLowSol: 1e-6, bandHighSol: 2e-6, supply: 1_000_000, decimals: 6 }).config,
      migrationQuoteThreshold: onChain.migrationQuoteThreshold,
      sqrtStartPrice: onChain.sqrtStartPrice,
      curve: onChain.curve.filter((point) => !point.liquidity.isZero()),
    };
    expect(checkExistingConfig(onChain, planned, partner).status).toBe('pass');
    expect(checkExistingConfig(onChain, planned, { ...partner, feeClaimer: PublicKey.default.toBase58() }).status).toBe(
      'fail',
    );
    const other = revenueCurveConfig({ bandLowSol: 1e-6, bandHighSol: 2e-6, supply: 1_000_000, decimals: 6 }).config;
    expect(checkExistingConfig(onChain, other, partner).detail).toContain('migrationQuoteThreshold');
    expect(checkExistingConfig(null, planned, partner).status).toBe('fail');
  });

  describe('the Epoch program (register_revenue_token)', () => {
    const TREASURY = 'TreasuryPda1111111111111111111111111111111';
    const LIMITS = { minShareBps: 1, maxShareBps: 5_000, minTermEpochs: 10, maxTermEpochs: 1_000 };
    const position = {
      address: 'position',
      status: 'active',
      operator: 'operator',
      revenueToken: null,
      authorityHeld: true,
    };

    it('EPOCH_TREASURY may only repeat the treasury PDA', () => {
      expect(treasuryMismatch(undefined, TREASURY)).toBeNull();
      expect(treasuryMismatch(TREASURY, TREASURY)).toBeNull();
      expect(treasuryMismatch('SomeWallet', TREASURY)).toMatch(/must be the Epoch program's treasury PDA/);
    });

    it("terms: the program's limits (1–5,000 bps, 10–1,000 epochs)", () => {
      expect(checkRevenueTokenTerms({ shareBps: 500, termEpochs: 100 }, LIMITS).status).toBe('pass');
      expect(checkRevenueTokenTerms({ shareBps: 5_001, termEpochs: 100 }, LIMITS)).toMatchObject({
        status: 'fail',
        detail: expect.stringContaining('share 5001 bps is outside 1–5000'),
      });
      expect(checkRevenueTokenTerms({ shareBps: 500, termEpochs: 9 }, LIMITS).detail).toContain('term 9 epochs');
    });

    it('the Pool exists and is not paused', () => {
      expect(checkEpochPool({ address: 'pool', exists: true, paused: false }).status).toBe('pass');
      expect(checkEpochPool({ address: 'pool', exists: true, paused: true }).status).toBe('fail');
      expect(checkEpochPool({ address: 'pool', exists: false, paused: null }).status).toBe('fail');
    });

    it('the validator can register: onboarded, Active, no token, authority held, the right operator key', () => {
      const devnet = { cluster: 'devnet' as const, vote: 'vote', operatorKey: null };
      expect(checkValidatorPosition(position, devnet).map((check) => check.status)).toEqual(['pass']);
      // Not onboarded: a warning on devnet (onboard, then register), a failure on mainnet and when registering now.
      expect(checkValidatorPosition(null, devnet)[0].status).toBe('warn');
      expect(checkValidatorPosition(null, { ...devnet, cluster: 'mainnet' })[0].status).toBe('fail');
      expect(checkValidatorPosition(null, { ...devnet, registeringNow: true })[0].status).toBe('fail');
      expect(checkValidatorPosition({ ...position, status: 'late' }, devnet)[0]).toMatchObject({
        status: 'warn',
        detail: expect.stringContaining('late'),
      });
      expect(checkValidatorPosition({ ...position, revenueToken: 'other' }, devnet)[0].status).toBe('fail');
      expect(checkValidatorPosition({ ...position, authorityHeld: false }, devnet)[0].status).toBe('warn');
      expect(checkValidatorPosition(position, { ...devnet, operatorKey: 'someone' })[1]).toMatchObject({
        name: 'Operator key',
        status: 'fail',
      });
      expect(checkValidatorPosition(position, { ...devnet, vote: null })[0].status).toBe('fail');
    });

    it('leftover receiver and start epoch', () => {
      expect(checkLeftoverReceiver(TREASURY, TREASURY).status).toBe('pass');
      expect(checkLeftoverReceiver('wallet', TREASURY).status).toBe('warn');
      expect(checkStartEpoch(undefined, 801).status).toBe('pass');
      expect(checkStartEpoch(801, 801).status).toBe('pass');
      expect(checkStartEpoch(900, 801)).toMatchObject({ status: 'warn', detail: expect.stringContaining('(801') });
    });

    it('a launched config and mint the program accepts', () => {
      const config = {
        feeClaimer: TREASURY,
        quoteMint: 'So11111111111111111111111111111111111111112',
        migrationOption: 1,
        tokenType: 0,
      };
      expect(checkRegistrableConfig(config, TREASURY).status).toBe('pass');
      // The rehearsal's config named a wallet as fee claimer: the program refuses it.
      expect(checkRegistrableConfig({ ...config, feeClaimer: 'wallet' }, TREASURY).detail).toContain(
        'is not the treasury PDA',
      );
      expect(checkRegistrableConfig({ ...config, migrationOption: 0, tokenType: 1 }, TREASURY).detail).toMatch(
        /DAMM v2.*Token-2022/,
      );
      expect(checkRegistrableConfig(null, TREASURY).status).toBe('fail');
      const mint = {
        tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        supply: 1_000_000_000_000n,
        mintAuthority: null,
        freezeAuthority: null,
      };
      expect(checkRegistrableMint(mint).status).toBe('pass');
      expect(checkRegistrableMint({ ...mint, freezeAuthority: 'x' }).detail).toContain('freeze authority');
      expect(
        checkRegistrableMint({ ...mint, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }).status,
      ).toBe('fail');
      expect(checkRegistrableMint(null).status).toBe('fail');
    });
  });

  it('summarizes: any failure blocks the launch', () => {
    const summary = summarizePreflight([
      { name: 'a', status: 'pass', detail: '' },
      { name: 'b', status: 'warn', detail: '' },
      { name: 'c', status: 'fail', detail: '' },
    ]);
    expect(summary.ok).toBe(false);
    expect(summary.failures.map((check) => check.name)).toEqual(['c']);
    expect(summary.warnings.map((check) => check.name)).toEqual(['b']);
  });
});
