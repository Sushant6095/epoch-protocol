import { randomBytes, randomInt } from 'crypto';

import { base58Encode } from '@epoch/epoch-sdk';
import { alertDeliveries, alertPrefs, PostgresConnectionManager, runMigrations } from '@epoch/pg_models';
import { eq, inArray } from 'drizzle-orm';

import { type StakeAccountInfo, U64_MAX } from '../../Lib/StakeLayouts';
import { AlertJob } from './AlertJob';
import { type AlertMessage, type ValidatorFacts } from './AlertRules';
import { type AlertChannel, type AlertSender } from './AlertSenders';

const newKey = (): string => base58Encode(randomBytes(32));

const TEST_DB = process.env.TEST_DATABASE_URL;

(TEST_DB ? describe : describe.skip)('AlertJob with fake senders (TEST_DATABASE_URL)', () => {
  const db = () => PostgresConnectionManager.getDb();
  const wallets: string[] = [];
  const sent: { channel: AlertChannel; to: string; message: AlertMessage }[] = [];
  const failing = new Set<AlertChannel>();
  const stakes = new Map<string, StakeAccountInfo[]>();
  const rewardReads: { addresses: string[]; epoch: number }[] = [];
  let now = Date.parse('2026-10-03T00:00:00Z');
  let table: { epoch: { epoch: number; slotIndex: number }; rows: ValidatorFacts[] } = {
    epoch: { epoch: 900, slotIndex: 5_000 },
    rows: [],
  };

  const sender = (channel: AlertChannel, configured = true): AlertSender => ({
    channel,
    configured,
    send: async (to, message) => {
      if (failing.has(channel)) throw new Error('Bad Request: chat not found');
      sent.push({ channel, to, message });
    },
  });
  const makeJob = (emailConfigured = true) =>
    new AlertJob({
      db,
      validators: async () => table,
      stakeAccounts: async (address) => stakes.get(address) ?? [],
      inflationRewards: async (addresses, epoch) => {
        rewardReads.push({ addresses, epoch });
        return addresses.map(() => ({ epoch, effectiveSlot: 1, amount: 9_446_000, postBalance: 0 }));
      },
      senders: { email: sender('email', emailConfigured), telegram: sender('telegram') },
      appUrl: 'https://app.epoch.test',
      intervalMs: 5 * 60_000,
      now: () => now,
    });

  const account = (owner: string, voter: string, deactivationEpoch: bigint = U64_MAX): StakeAccountInfo => ({
    pubkey: newKey(),
    lamports: 10_002_282_880n,
    state: 'delegated',
    rentExemptReserve: 2_282_880n,
    staker: owner,
    withdrawer: owner,
    lockupUnixTimestamp: 0n,
    lockupEpoch: 0n,
    custodian: '11111111111111111111111111111111',
    voter,
    stakeLamports: 10_000_000_000n,
    activationEpoch: 800n,
    deactivationEpoch,
    creditsObserved: 0n,
  });

  /** A wallet with both channels (unique recipients per run) and rules on. */
  async function newWallet(reminders: { epoch: number; stakeAccount: string }[] = []) {
    const address = newKey();
    wallets.push(address);
    const email = `${address.slice(0, 8)}@example.com`;
    const telegram = String(randomInt(1_000_000, 2_000_000_000));
    await db()
      .insert(alertPrefs)
      .values({
        address,
        rules: { offline: true, feeUp: true, losingMoney: true, rewardsLanded: true },
        email,
        telegram,
        reminders: reminders.map((r) => ({ kind: 'move-step-2' as const, ...r })),
        state: {},
      });
    const mine = () => sent.filter((s) => s.to === email || s.to === telegram);
    return { address, email, telegram, mine };
  }

  const deliveries = async (address: string) =>
    (await db().select().from(alertDeliveries).where(eq(alertDeliveries.address, address)))
      .map((d) => `${d.channel} ${d.dedupeKey} ${d.status}${d.error ? ` (${d.error})` : ''}`)
      .sort();

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DB;
    await runMigrations();
  });

  afterAll(async () => {
    if (wallets.length) {
      await db().delete(alertDeliveries).where(inArray(alertDeliveries.address, wallets));
      await db().delete(alertPrefs).where(inArray(alertPrefs.address, wallets));
    }
    await PostgresConnectionManager.close();
  });

  it('applies the rules, waits 10 minutes for offline, sends reminders, never sends twice', async () => {
    const [offline, raiser, loser, gone] = [newKey(), newKey(), newKey(), newKey()];
    const stepTwo = newKey();
    const w = await newWallet([
      { epoch: 900, stakeAccount: stepTwo },
      { epoch: 902, stakeAccount: stepTwo },
    ]);
    stakes.set(w.address, [
      account(w.address, offline),
      account(w.address, raiser),
      account(w.address, loser),
      account(w.address, gone, 850n), // deactivated long ago: not watched
    ]);
    const rows = (patch: Record<string, Partial<ValidatorFacts>> = {}): ValidatorFacts[] =>
      [
        {
          vote: offline,
          name: 'Kestrel Nodes',
          commissionPct: 5,
          mevCommissionPct: 8,
          healthPerEpochSol: 3,
          delinquent: true,
        },
        {
          vote: raiser,
          name: 'Northwind',
          commissionPct: 5,
          mevCommissionPct: 8,
          healthPerEpochSol: 2,
          delinquent: false,
        },
        {
          vote: loser,
          name: 'Saltmarsh',
          commissionPct: 0,
          mevCommissionPct: null,
          healthPerEpochSol: -0.5,
          delinquent: false,
        },
        {
          vote: gone,
          name: 'Gone',
          commissionPct: 100,
          mevCommissionPct: 100,
          healthPerEpochSol: -9,
          delinquent: true,
        },
      ].map((row) => ({ ...row, ...patch[row.vote] }));
    const job = makeJob();

    // Run 1: losing money and the due reminder go out; offline is only first seen; fees and the epoch are recorded.
    table = { epoch: { epoch: 900, slotIndex: 5_000 }, rows: rows() };
    await job.runOnce();
    expect(
      w
        .mine()
        .map((s) => `${s.channel} ${s.message.dedupeKey}`)
        .sort(),
    ).toEqual([
      `email breakeven:${loser}:900`,
      `email reminder:${stepTwo}:900`,
      `telegram breakeven:${loser}:900`,
      `telegram reminder:${stepTwo}:900`,
    ]);
    const email = w.mine().find((s) => s.channel === 'email' && s.message.kind === 'breakeven');
    expect(email?.message.link).toBe(`https://app.epoch.test/validators/${loser}`);
    let [prefs] = await db().select().from(alertPrefs).where(eq(alertPrefs.address, w.address));
    expect(prefs.reminders).toEqual([{ kind: 'move-step-2', epoch: 902, stakeAccount: stepTwo }]);
    expect(prefs.state).toMatchObject({
      rewardsEpoch: 900,
      fees: {
        [raiser]: { commissionPct: 5, mevCommissionPct: 8 },
        [loser]: { commissionPct: 0, mevCommissionPct: null },
      },
    });
    expect(rewardReads).toEqual([]);

    // Run 2, 10 minutes later: offline (two checks 10 min apart) and the raised fee; losing money is not repeated.
    now += 10 * 60_000;
    table = { epoch: { epoch: 900, slotIndex: 6_000 }, rows: rows({ [raiser]: { commissionPct: 7 } }) };
    const summary = await job.runOnce();
    expect(summary.epoch).toBe(900);
    expect(
      w
        .mine()
        .slice(4)
        .map((s) => `${s.channel} ${s.message.dedupeKey}`)
        .sort(),
    ).toEqual([
      `email fee:${raiser}:900`,
      `email offline:${offline}:900`,
      `telegram fee:${raiser}:900`,
      `telegram offline:${offline}:900`,
    ]);
    expect(w.mine().find((s) => s.message.kind === 'fee')?.message.body).toBe(
      'Northwind raised its commission from 5% to 7%. You keep less of what your stake earns there.',
    );

    // Run 3: same data, nothing new.
    now += 5 * 60_000;
    await job.runOnce();
    expect(w.mine()).toHaveLength(8);

    // A new epoch: rewards wait until the epoch is ~1,000 slots in, then land once.
    const healthy = rows({
      [offline]: { delinquent: false },
      [raiser]: { commissionPct: 7 },
      [loser]: { healthPerEpochSol: 0.1 },
    });
    table = { epoch: { epoch: 901, slotIndex: 400 }, rows: healthy };
    await job.runOnce();
    expect(rewardReads).toEqual([]);
    table = { epoch: { epoch: 901, slotIndex: 1_200 }, rows: healthy };
    await job.runOnce();
    await job.runOnce();
    expect(rewardReads).toHaveLength(1);
    expect(rewardReads[0]).toMatchObject({ epoch: 900 });
    expect(rewardReads[0].addresses).toHaveLength(4);
    const rewards = w.mine().filter((s) => s.message.kind === 'rewards');
    expect(rewards.map((s) => [s.channel, s.message.body])).toEqual([
      ['email', 'Rewards landed: 0.037784 SOL for epoch 900.'],
      ['telegram', 'Rewards landed: 0.037784 SOL for epoch 900.'],
    ]);

    // A failed channel is recorded with its reason and not retried; the reminder still counts as delivered.
    // (Epoch 902 also brings epoch 901's rewards.)
    failing.add('telegram');
    table = { epoch: { epoch: 902, slotIndex: 9_000 }, rows: healthy };
    await job.runOnce();
    await job.runOnce();
    failing.delete('telegram');
    expect(
      w
        .mine()
        .filter((s) => s.message.kind === 'reminder')
        .map((s) => [s.channel, s.message.dedupeKey]),
    ).toEqual([
      ['email', `reminder:${stepTwo}:900`],
      ['telegram', `reminder:${stepTwo}:900`],
      ['email', `reminder:${stepTwo}:902`],
    ]);
    [prefs] = await db().select().from(alertPrefs).where(eq(alertPrefs.address, w.address));
    expect(prefs.reminders).toEqual([]);
    expect(await deliveries(w.address)).toEqual(
      [
        `email breakeven:${loser}:900 sent`,
        `email fee:${raiser}:900 sent`,
        `email offline:${offline}:900 sent`,
        `email reminder:${stepTwo}:900 sent`,
        `email reminder:${stepTwo}:902 sent`,
        'email rewards:900 sent',
        'email rewards:901 sent',
        `telegram breakeven:${loser}:900 sent`,
        `telegram fee:${raiser}:900 sent`,
        `telegram offline:${offline}:900 sent`,
        `telegram reminder:${stepTwo}:900 sent`,
        `telegram reminder:${stepTwo}:902 failed (Bad Request: chat not found)`,
        'telegram rewards:900 sent',
        'telegram rewards:901 failed (Bad Request: chat not found)',
      ].sort(),
    );
  });

  it('skips a channel the API has no credentials for, and wallets with every rule off', async () => {
    const stepTwo = newKey();
    const w = await newWallet([{ epoch: 950, stakeAccount: stepTwo }]);
    const quiet = await newWallet([]);
    await db()
      .update(alertPrefs)
      .set({ rules: { offline: false, feeUp: false, losingMoney: false, rewardsLanded: false } })
      .where(eq(alertPrefs.address, quiet.address));
    stakes.set(quiet.address, [account(quiet.address, newKey())]);
    table = { epoch: { epoch: 950, slotIndex: 9_000 }, rows: [] };
    await makeJob(false).runOnce();
    expect(w.mine().map((s) => s.channel)).toEqual(['telegram']);
    expect(await deliveries(w.address)).toEqual([`telegram reminder:${stepTwo}:950 sent`]);
    expect(quiet.mine()).toEqual([]);
    expect(await deliveries(quiet.address)).toEqual([]);
  });
});
