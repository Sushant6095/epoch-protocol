import { readFileSync } from 'fs';
import { join } from 'path';

import { PublicKey } from '@solana/web3.js';

import {
  LaunchConfigError,
  launchRecordFor,
  parseLaunchConfig,
  planLaunch,
  registryEntryFor,
  withRegistration,
} from './launch';
import { appendRegistryEntry } from './registry';

const example = JSON.parse(readFileSync(join(__dirname, '../scripts/launch-config.example.json'), 'utf8')) as unknown;
const VOTE = new PublicKey(new Uint8Array(32).fill(3)).toBase58();

describe('parseLaunchConfig', () => {
  it('accepts the example config', () => {
    expect(parseLaunchConfig(example)).toEqual({
      validator: { name: 'Kestrel Nodes', vote: null },
      symbol: 'rKEST',
      name: 'Kestrel Nodes revenue token',
      uri: 'https://example.invalid/rkest.json',
      shareBps: 500,
      termEpochs: 100,
      avgRevenueSol: 20.8,
      supply: 100_000,
      decimals: 6,
      raiseTargetSol: 5,
      tradingFeeBps: 100,
      dammFeeBps: 100,
      curvePoints: undefined,
      startEpoch: undefined,
      creator: undefined,
    });
  });

  it('lists every problem at once', () => {
    try {
      parseLaunchConfig({
        validator: { name: '', vote: 'not-a-key' },
        symbol: 'TOOLONGSYMBOL',
        shareBps: 0,
        decimals: 5,
      });
      throw new Error('expected a LaunchConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(LaunchConfigError);
      const problems = (error as LaunchConfigError).problems;
      expect(problems).toEqual(
        expect.arrayContaining([
          'validator.name: a string of 1–64 characters',
          'validator.vote: a base58 vote account or null',
          'symbol: a string of 1–10 characters',
          'name: a string of 1–32 characters',
          'uri: a string of 1–200 characters',
          'shareBps: an integer from 1 to 10000',
          'termEpochs: an integer from 1 to 10000',
          'supply: an integer from 1 to 1000000000000',
          'decimals: an integer from 6 to 9',
        ]),
      );
    }
  });

  it('needs the revenue or a vote account to read it from', () => {
    const { avgRevenueSol: _avg, ...withoutRevenue } = example as Record<string, unknown>;
    expect(() => parseLaunchConfig(withoutRevenue)).toThrow(/avgRevenueSol: required/);
    expect(
      parseLaunchConfig({ ...withoutRevenue, validator: { name: 'Kestrel Nodes', vote: VOTE } }).validator.vote,
    ).toBe(VOTE);
  });

  it('checks the optional fields', () => {
    expect(() => parseLaunchConfig({ ...(example as object), dammFeeBps: 50 })).toThrow(/dammFeeBps/);
    expect(() => parseLaunchConfig({ ...(example as object), creator: 'nope' })).toThrow(/creator/);
    expect(() => parseLaunchConfig({ ...(example as object), raiseTargetSol: -1 })).toThrow(/raiseTargetSol/);
    expect(() => parseLaunchConfig(null)).toThrow(/expected a JSON object/);
  });

  it("reads the creator's initial buy and the leftover receiver", () => {
    const parsed = parseLaunchConfig({ ...(example as object), initialBuySol: 0.05, leftoverReceiver: VOTE });
    expect(parsed.initialBuySol).toBe(0.05);
    expect(parsed.leftoverReceiver).toBe(VOTE);
    expect(parseLaunchConfig(example)).not.toHaveProperty('initialBuySol');
    expect(() => parseLaunchConfig({ ...(example as object), initialBuySol: -1 })).toThrow(/initialBuySol/);
    expect(() => parseLaunchConfig({ ...(example as object), leftoverReceiver: 'x' })).toThrow(/leftoverReceiver/);
  });
});

describe('planLaunch', () => {
  const plan = planLaunch({ config: parseLaunchConfig(example), avgRevenueSol: 20.8, startEpoch: 1043 });

  it('prices the share and builds the curve for the raise target', () => {
    expect(plan.endEpoch).toBe(1142);
    expect(plan.cluster).toBe('devnet');
    expect(plan.band.bandLowSol).toBeCloseTo(0.000624, 15);
    expect(plan.band.bandHighSol).toBeCloseTo(0.000988, 15);
    expect(plan.curve.migrationThresholdSol).toBeGreaterThanOrEqual(5);
    expect(plan.curve.migrationThresholdSol).toBeLessThan(5.001);
    expect(plan.curve.leftoverTokens).toBeGreaterThan(90_000);
  });

  it('refuses a launch with no revenue to price it from', () => {
    expect(() => planLaunch({ config: parseLaunchConfig(example), avgRevenueSol: 0, startEpoch: 1 })).toThrow(
      /revenue must be positive/,
    );
  });

  it('describes the registry entry the API reads', () => {
    const entry = registryEntryFor(
      plan,
      { mint: 'mint-1', dbcPool: 'pool-1', dbcConfig: 'config-1' },
      '2026-10-03T10:00:00+05:30',
    );
    expect(entry).toEqual({
      mint: 'mint-1',
      symbol: 'rKEST',
      name: 'Kestrel Nodes revenue token',
      validator: { name: 'Kestrel Nodes', vote: null },
      shareBps: 500,
      termEpochs: 100,
      startEpoch: 1043,
      opensAtEpoch: null,
      dbcPool: 'pool-1',
      dbcConfig: 'config-1',
      dammPool: null,
      escrow: null,
      supply: 100_000,
      decimals: 6,
      burned: 0,
      cluster: 'devnet',
      avgRevenueSol: 20.8,
      raiseTargetSol: plan.curve.migrationThresholdSol,
      graduatedEpoch: null,
      launchedAt: '2026-10-03T10:00:00+05:30',
    });
    expect(appendRegistryEntry([], entry)).toEqual([entry]);
    expect(() => appendRegistryEntry([entry], entry)).toThrow(/already has a launch/);
  });

  it('the launch record adds the parties and the signatures (public data only)', () => {
    const record = launchRecordFor(plan, {
      mint: 'mint-1',
      dbcPool: 'pool-1',
      dbcConfig: 'config-1',
      creator: 'validator-wallet',
      feeClaimer: 'treasury',
      leftoverReceiver: 'treasury',
      signatures: { createConfig: 'sig-1', createPool: 'sig-2' },
      launchedAt: '2026-10-07T10:00:00+05:30',
    });
    expect(record).toMatchObject({
      mint: 'mint-1',
      creator: 'validator-wallet',
      feeClaimer: 'treasury',
      leftoverReceiver: 'treasury',
      signatures: { createConfig: 'sig-1', createPool: 'sig-2' },
      launchedAt: '2026-10-07T10:00:00+05:30',
    });
    expect(JSON.stringify(record)).not.toMatch(/secret|\[\d+(,\d+){20,}\]/);
  });

  it("records the Epoch program's accounts, and the program's term once registered", () => {
    const receipt = {
      mint: 'mint-1',
      dbcPool: 'pool-1',
      dbcConfig: 'config-1',
      creator: 'validator-wallet',
      feeClaimer: 'treasury-pda',
      leftoverReceiver: 'treasury-pda',
      signatures: { launch: 'sig-1' },
      program: { programId: 'program', revenueToken: 'revenue-token-pda', escrow: 'escrow-pda' },
    };
    // Launched, not registered yet: the PDAs are known, the term's start is the plan's estimate.
    const launched = launchRecordFor(plan, receipt);
    expect(launched).toMatchObject({
      programId: 'program',
      revenueToken: 'revenue-token-pda',
      escrow: 'escrow-pda',
      registeredEpoch: null,
      startEpoch: plan.startEpoch,
    });
    // Registered in the same run: the program's term (registration epoch + 1).
    const registered = launchRecordFor(plan, { ...receipt, registered: { epoch: 2_000, startEpoch: 2_001 } });
    expect(registered).toMatchObject({ registeredEpoch: 2_000, startEpoch: 2_001 });
    // Registered later by the operator (the register script).
    const later = withRegistration(launched, {
      programId: 'program',
      revenueToken: 'revenue-token-pda',
      escrow: 'escrow-pda',
      epoch: 2_010,
      startEpoch: 2_011,
      signature: 'sig-register',
    });
    expect(later).toMatchObject({
      registeredEpoch: 2_010,
      startEpoch: 2_011,
      signatures: { launch: 'sig-1', registerRevenueToken: 'sig-register' },
    });
    // Found registered already (no signature from this run): the signatures stay as they were.
    const found = withRegistration(launched, {
      programId: 'program',
      revenueToken: 'revenue-token-pda',
      escrow: 'escrow-pda',
      epoch: 2_010,
      startEpoch: 2_011,
    });
    expect(found.signatures).toEqual({ launch: 'sig-1' });
  });
});
