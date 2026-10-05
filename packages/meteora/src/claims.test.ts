import { readFileSync } from 'fs';
import { join } from 'path';

import { type PoolConfig, type VirtualPool } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

import {
  CREATOR_MIGRATION_FEE_MASK,
  dammPositionClaim,
  launchClaimsFromState,
  migrationFeeSplit,
  PARTNER_MIGRATION_FEE_MASK,
  surplusSplit,
} from './claims';
import { cpAmmClient, dbcClient } from './pools';

/** Raw accounts recorded after the rehearsal's claims (docs/runbooks/meteora-devnet-rehearsal.md). */
const account = (name: string) => {
  const json = JSON.parse(readFileSync(join(__dirname, '__fixtures__/rehearsal', `account-${name}.json`), 'utf8')) as {
    address: string;
    data: string;
  };
  return { address: json.address, data: Uint8Array.from(atob(json.data), (char) => char.charCodeAt(0)) };
};
const connection = new Connection('http://127.0.0.1:1');
const dbcCoder = dbcClient(connection).state.getProgram().coder.accounts;
const dammCoder = (cpAmmClient(connection) as unknown as { _program: { coder: { accounts: typeof dbcCoder } } })
  ._program.coder.accounts;
const decoded = () => ({
  pool: dbcCoder.decode('virtualPool', Buffer.from(account('dbc-pool').data)) as VirtualPool,
  config: dbcCoder.decode('poolConfig', Buffer.from(account('dbc-config').data)) as PoolConfig,
  damm: dammCoder.decode('pool', Buffer.from(account('damm-pool').data)),
  position: dammCoder.decode('position', Buffer.from(account('position').data)),
});

const TREASURY = 'AQ3gcCLTPwTHsBhNBTFz94L2kxKevZuywYWobx9H9Mf8';
const VALIDATOR = 'GjMZo48qTs7nuowtcPYj7K6vtsMiXJbRUePgmK6RF1c1';

describe('migrationFeeSplit and surplusSplit (the DBC program arithmetic)', () => {
  it('70% of the raise to the creator, the rest seeds DAMM v2 (quote amount rounded up)', () => {
    // The rehearsal's raise: 750,000,386 lamports; the creator withdrew exactly 525,000,270.
    expect(
      migrationFeeSplit({
        migrationQuoteThreshold: new BN(750_000_386),
        migrationFeePercentage: 70,
        creatorMigrationFeePercentage: 100,
      }),
    ).toEqual({
      total: 525_000_270n,
      partner: 0n,
      creator: 525_000_270n,
    });
    expect(
      migrationFeeSplit({
        migrationQuoteThreshold: 5_000_000_000n,
        migrationFeePercentage: 70,
        creatorMigrationFeePercentage: 50,
      }),
    ).toEqual({
      total: 3_500_000_000n,
      partner: 1_750_000_000n,
      creator: 1_750_000_000n,
    });
  });

  it('a surplus: 80% to partner and creator (split like trading fees), 20% to the protocol', () => {
    expect(surplusSplit(1_100_000_000n, 1_000_000_000n, 0)).toEqual({
      total: 100_000_000n,
      partner: 80_000_000n,
      creator: 0n,
      protocol: 20_000_000n,
    });
    expect(surplusSplit(1_100_000_000n, 1_000_000_000n, 25)).toEqual({
      total: 100_000_000n,
      partner: 60_000_000n,
      creator: 20_000_000n,
      protocol: 20_000_000n,
    });
    expect(surplusSplit(999n, 1_000n, 0).total).toBe(0n);
  });
});

describe('launchClaimsFromState (recorded accounts after the rehearsal claims)', () => {
  const { pool, config, damm, position } = decoded();
  const lp = dammPositionClaim({
    position: new PublicKey(account('position').address),
    state: position,
    pool: damm,
    owner: TREASURY,
    partner: TREASURY,
    creator: VALIDATOR,
    baseIsTokenA: true,
  });
  const state = launchClaimsFromState({
    dbcPool: account('dbc-pool').address,
    pool,
    config,
    baseVaultAmount: 139_000_000n,
    dammPool: account('damm-pool').address,
    positions: [lp],
  });

  it('names the parties and the graduation', () => {
    expect(state).toMatchObject({
      partner: TREASURY,
      creator: VALIDATOR,
      leftoverReceiver: TREASURY,
      curveComplete: true,
      migrated: true,
      baseDecimals: 6,
    });
  });

  it('every claim made: trading fees claimed in full, the 70% and the leftover flagged as withdrawn', () => {
    expect(state.tradingFees.partner).toEqual({
      totalLamports: 7_283_420n,
      claimedLamports: 7_283_420n,
      unclaimedLamports: 0n,
    });
    expect(state.migrationFee).toEqual({
      totalLamports: 525_000_270n,
      partner: { lamports: 0n, withdrawn: false },
      creator: { lamports: 525_000_270n, withdrawn: true },
    });
    expect(state.leftover).toEqual({ tokens: 0n, withdrawn: true });
    expect(state.surplus.totalLamports).toBe(1n); // the completing buy overshot the threshold by one lamport
    expect(state.items.filter((item) => item.available)).toEqual([]);
    expect(state.items.find((item) => item.kind === 'creatorMigrationFee')).toMatchObject({
      withdrawn: true,
      reason: 'already withdrawn',
      signer: VALIDATOR,
    });
    expect(state.items.find((item) => item.kind === 'leftover')).toMatchObject({ signer: null, receiver: TREASURY });
  });

  it("the treasury's DAMM v2 position: 100% permanently locked, its fees claimed", () => {
    expect(lp).toMatchObject({
      owner: TREASURY,
      role: 'partner',
      lockedPct: 100,
      unlockedLiquidity: '0',
      vestedLiquidity: '0',
      claimedLamports: 2_862_904n,
      unclaimedLamports: 0n,
    });
    expect(BigInt(lp.permanentLockedLiquidity)).toBeGreaterThan(0n);
  });

  it('before the claims: what the job would claim, and what waits', () => {
    const before = {
      poolState: {
        ...pool.poolState,
        partnerQuoteFee: new BN(7_283_420),
        migrationFeeWithdrawStatus: 0,
        isWithdrawLeftover: 0,
      },
    } as VirtualPool;
    const protocolTokens = BigInt(pool.poolState.protocolMigrationBaseFeeAmount.toString());
    const fresh = launchClaimsFromState({
      dbcPool: 'pool',
      pool: before,
      config,
      baseVaultAmount: 639_263_000_567n + protocolTokens,
    });
    const available = Object.fromEntries(
      fresh.items.filter((item) => item.available).map((item) => [item.kind, [item.lamports, item.tokens]]),
    );
    expect(available).toEqual({
      partnerTradingFee: [7_283_420n, 0n],
      creatorMigrationFee: [525_000_270n, 0n],
      // The base vault less the protocol's migration fee in tokens (139 tokens stay for the protocol).
      leftover: [0n, 639_263_000_567n],
    });
    expect(PARTNER_MIGRATION_FEE_MASK | CREATOR_MIGRATION_FEE_MASK).toBe(0b110);
  });

  it('nothing is due before the curve completes', () => {
    const early = {
      poolState: {
        ...pool.poolState,
        quoteReserve: new BN(300_000_000),
        isMigrated: 0,
        migrationProgress: 0,
        migrationFeeWithdrawStatus: 0,
        isWithdrawLeftover: 0,
      },
    } as VirtualPool;
    const state = launchClaimsFromState({ dbcPool: 'pool', pool: early, config, baseVaultAmount: 1n });
    expect(state.curveComplete).toBe(false);
    expect(state.items.find((item) => item.kind === 'creatorMigrationFee')).toMatchObject({
      available: false,
      reason: 'the curve is not complete yet',
    });
    expect(state.items.find((item) => item.kind === 'leftover')).toMatchObject({
      available: false,
      reason: 'the token has not graduated yet',
    });
  });
});
