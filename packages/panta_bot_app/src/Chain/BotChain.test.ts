import { type ConnectionManager } from '@epoch/solana';
import {
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { associatedTokenAddress, LiveBotChain, SpendGuardError, tokenAmount } from './BotChain';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

/** An SPL token account's bytes with `amount` at offset 64. */
function tokenAccount(amount: number): Buffer {
  const data = Buffer.alloc(165);
  data.writeBigUInt64LE(BigInt(amount), 64);
  return data;
}

/** An unsigned create as Panta would return it: paid by `payer`, plus extra signers if asked. */
function unsignedCreate(payer: PublicKey, extraSigner?: PublicKey, blockhash = BLOCKHASH): string {
  const instructions = [
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
  ];
  if (extraSigner) instructions.push(SystemProgram.transfer({ fromPubkey: extraSigner, toPubkey: payer, lamports: 1 }));
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

interface Scenario {
  usdcBefore: number;
  usdcAfter: number;
  lamportsBefore: number;
  lamportsAfter: number;
  err?: unknown;
}

function chainWith(keypair: Keypair | undefined, scenario: Scenario) {
  const simulate = jest.fn(async () => ({
    context: { slot: 1 },
    value: {
      err: scenario.err ?? null,
      logs: ['Program log: create'],
      accounts: [
        { data: [tokenAccount(scenario.usdcAfter).toString('base64'), 'base64'], lamports: 2_039_280 },
        { data: ['', 'base64'], lamports: scenario.lamportsAfter },
      ],
    },
  }));
  const connection = {
    getMultipleAccountsInfo: jest.fn(async () => [
      { data: tokenAccount(scenario.usdcBefore), lamports: 2_039_280 },
      { data: Buffer.alloc(0), lamports: scenario.lamportsBefore },
    ]),
    simulateTransaction: simulate,
    getEpochInfo: jest.fn(async () => ({
      epoch: 1_050,
      slotIndex: 100_000,
      slotsInEpoch: 432_000,
      absoluteSlot: 453_700_000,
    })),
    getRecentPerformanceSamples: jest.fn(async () => [
      { numSlots: 150, samplePeriodSecs: 63, numTransactions: 1, slot: 1 },
    ]),
    getBlockHeight: jest.fn(async () => 777),
  };
  const connections = {
    withFailover: <T>(fn: (c: Connection) => Promise<T>) => fn(connection as unknown as Connection),
  } as unknown as ConnectionManager;
  const chain = new LiveBotChain({
    connections,
    keypair,
    usdcMint: USDC,
    computeUnitPriceMicroLamports: 10_000,
    now: () => 1_000,
  });
  return { chain, connection, simulate };
}

const ok: Scenario = { usdcBefore: 80_000_000, usdcAfter: 30_000_000, lamportsBefore: 1e9, lamportsAfter: 1e9 - 5e6 };
const limits = { maxUsdcBase: 50_000_000, maxLamports: 50_000_000, recentBlockhash: BLOCKHASH };

describe('LiveBotChain spend guard', () => {
  const bot = Keypair.generate();

  it('signs a create that takes no more than the quoted fee, after simulating it', async () => {
    const { chain, simulate } = chainWith(bot, ok);
    const signed = await chain.guardAndSign(unsignedCreate(bot.publicKey), limits);
    expect(signed).toMatchObject({ usdcSpentBase: 50_000_000, lamportsSpent: 5_000_000 });
    const tx = VersionedTransaction.deserialize(Buffer.from(signed.signedBase64, 'base64'));
    expect(tx.signatures[0].some((byte) => byte !== 0)).toBe(true);
    const [, config] = simulate.mock.calls[0] as unknown as [VersionedTransaction, Record<string, unknown>];
    expect(config).toMatchObject({
      sigVerify: false,
      accounts: {
        encoding: 'base64',
        addresses: [associatedTokenAddress(bot.publicKey, new PublicKey(USDC)).toBase58(), bot.publicKey.toBase58()],
      },
    });
  });

  it('refuses a create that would take more USDC or SOL than allowed', async () => {
    const greedy = chainWith(bot, { ...ok, usdcAfter: 29_999_999 });
    await expect(greedy.chain.guardAndSign(unsignedCreate(bot.publicKey), limits)).rejects.toThrow(
      'more USDC than quoted',
    );
    const thirsty = chainWith(bot, { ...ok, lamportsAfter: 1e9 - 60_000_000 });
    await expect(thirsty.chain.guardAndSign(unsignedCreate(bot.publicKey), limits)).rejects.toThrow('more SOL');
  });

  it('refuses what is not the creator’s own create', async () => {
    const { chain } = chainWith(bot, ok);
    const other = Keypair.generate().publicKey;
    await expect(chain.guardAndSign(unsignedCreate(other), limits)).rejects.toThrow('not paid by the creator');
    await expect(chain.guardAndSign(unsignedCreate(bot.publicKey, other), limits)).rejects.toThrow(
      'more than the creator signature',
    );
    await expect(
      chain.guardAndSign(unsignedCreate(bot.publicKey, undefined, Keypair.generate().publicKey.toBase58()), limits),
    ).rejects.toThrow('blockhash');
    await expect(chain.guardAndSign('AAAA', limits)).rejects.toBeInstanceOf(SpendGuardError);
    const failing = chainWith(bot, { ...ok, err: { InstructionError: [0, { Custom: 1 }] } });
    await expect(failing.chain.guardAndSign(unsignedCreate(bot.publicKey), limits)).rejects.toThrow(
      'fails in simulation',
    );
    const keyless = chainWith(undefined, ok);
    expect(keyless.chain.wallet).toBeNull();
    await expect(keyless.chain.guardAndSign(unsignedCreate(bot.publicKey), limits)).rejects.toThrow(
      'No creator keypair',
    );
    expect(await keyless.chain.balances()).toBeNull();
  });

  it('reads the mainnet clock with the measured slot time, and balances', async () => {
    const { chain } = chainWith(bot, ok);
    expect(await chain.clock()).toEqual({
      epoch: 1_050,
      slotIndex: 100_000,
      slotsInEpoch: 432_000,
      absoluteSlot: 453_700_000,
      secondsPerSlot: 0.42,
      nowMs: 1_000,
    });
    expect(await chain.balances()).toEqual({ usdcBase: 80_000_000, lamports: 1e9 });
    expect(await chain.blockHeight()).toBe(777);
    expect(tokenAmount(tokenAccount(12_345))).toBe(12_345);
    expect(tokenAmount(Buffer.alloc(10))).toBe(0);
  });
});
