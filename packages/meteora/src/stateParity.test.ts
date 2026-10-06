import { readFileSync } from 'fs';
import { join } from 'path';

import { type PoolConfig, type VirtualPool } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { type AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';

import { launchClaimsFromState } from './claims';
import { DBC_PROGRAM } from './events';
import { dbcClient, mapLaunchPool } from './pools';

/**
 * Our curve progress and trading-fee split against the DBC SDK's own state helpers (`getPoolQuoteTokenCurveProgress`,
 * `getPoolFeeBreakdown`), on the rehearsal's real DBC pool and config accounts served through a fake connection.
 */
const account = (name: string): { address: string; data: Buffer } => {
  const raw = JSON.parse(readFileSync(join(__dirname, '__fixtures__/rehearsal', `${name}.json`), 'utf8')) as {
    address: string;
    data: string;
  };
  return { address: raw.address, data: Buffer.from(raw.data, 'base64') };
};
const POOL = account('account-dbc-pool');
const CONFIG = account('account-dbc-config');
const coder = dbcClient(new Connection('http://127.0.0.1:1')).state.getProgram().coder.accounts;
const decodePool = (data: Buffer) => coder.decode('virtualPool', data) as VirtualPool;
const decodeConfig = (data: Buffer) => coder.decode('poolConfig', data) as PoolConfig;

/** A connection whose account reads answer from `accounts` (the only RPC the SDK's state helpers make). */
function servedBy(accounts: Map<string, Buffer>): Connection {
  const connection = new Connection('http://127.0.0.1:1', 'confirmed');
  const info = (key: PublicKey): AccountInfo<Buffer> | null => {
    const data = accounts.get(key.toBase58());
    return data ? { data, owner: new PublicKey(DBC_PROGRAM), lamports: 1, executable: false, rentEpoch: 0 } : null;
  };
  Object.assign(connection, {
    getAccountInfo: async (key: PublicKey) => info(key),
    getAccountInfoAndContext: async (key: PublicKey) => ({ context: { slot: 1 }, value: info(key) }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(info),
  });
  return connection;
}

/**
 * The rehearsal's accounts for the SDK: served byte for byte through the fake connection, or, when a test changes a
 * field, handed to the SDK's own readers already decoded (Anchor's coder cannot re-encode a 1,048-byte config).
 */
async function served(change?: { pool?: (pool: VirtualPool) => void; config?: (config: PoolConfig) => void }) {
  const pool = decodePool(POOL.data);
  const config = decodeConfig(CONFIG.data);
  const state = dbcClient(
    servedBy(
      new Map([
        [POOL.address, POOL.data],
        [CONFIG.address, CONFIG.data],
      ]),
    ),
  ).state;
  if (change) {
    change.pool?.(pool);
    change.config?.(config);
    Object.assign(state, { getPool: async () => pool, getPoolConfig: async () => config });
  }
  return { pool, config, state };
}

describe("our reads against the DBC SDK's state helpers", () => {
  it.each([
    ['the graduated rehearsal pool', undefined],
    ['37% of the raise in', 0.37],
    ['an empty curve', 0],
  ])('curve progress: %s', async (_label, fraction) => {
    const { pool, config, state } = await served(
      fraction === undefined
        ? undefined
        : {
            pool: (p) => {
              const threshold = decodeConfig(CONFIG.data).migrationQuoteThreshold;
              p.poolState.quoteReserve = threshold.muln(Math.round(fraction * 1000)).divn(1000);
              p.poolState.isMigrated = 0;
              p.poolState.migrationProgress = 0;
            },
          },
    );
    const sdk = await state.getPoolQuoteTokenCurveProgress(POOL.address);
    const ours = mapLaunchPool(POOL.address, pool, config).curveProgressPct / 100;
    expect(ours).toBeCloseTo(sdk, 12);
    if (fraction !== undefined) expect(sdk).toBeCloseTo(fraction, 3);
  });

  it.each([0, 25])('trading fees split with the creator at %i%%: total, claimed and unclaimed', async (creatorPct) => {
    const { pool, config, state } = await served({
      config: (c) => {
        c.creatorTradingFeePercentage = creatorPct;
      },
      // Some fees unclaimed on both sides, so claimed = total − unclaimed is not trivially zero.
      pool: (p) => {
        p.poolState.partnerQuoteFee = new BN(1_234_567);
        p.poolState.creatorQuoteFee = new BN(creatorPct ? 89_000 : 0);
      },
    });
    const sdk = await state.getPoolFeeBreakdown(POOL.address);
    const ours = launchClaimsFromState({ dbcPool: POOL.address, pool, config, baseVaultAmount: null }).tradingFees;
    const asStrings = (side: { totalLamports: bigint; claimedLamports: bigint; unclaimedLamports: bigint }) => ({
      total: side.totalLamports.toString(),
      claimed: side.claimedLamports.toString(),
      unclaimed: side.unclaimedLamports.toString(),
    });
    const sdkSide = (side: { totalQuoteFee: BN; claimedQuoteFee: BN; unclaimedQuoteFee: BN }) => ({
      total: side.totalQuoteFee.toString(),
      claimed: side.claimedQuoteFee.toString(),
      unclaimed: side.unclaimedQuoteFee.toString(),
    });
    expect(asStrings(ours.partner)).toEqual(sdkSide(sdk.partner));
    expect(asStrings(ours.creator)).toEqual(sdkSide(sdk.creator));
    // Quote-token fee collection: nothing is charged in the token.
    expect(sdk.partner.totalBaseFee.isZero() && sdk.creator.totalBaseFee.isZero()).toBe(true);
  });
});
