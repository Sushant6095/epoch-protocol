import {
  ACCOUNT_DISCRIMINATORS,
  base58Encode,
  decodeAdvance,
  decodeFeeIndex,
  decodePool,
  decodeSwapPosition,
  decodeValidatorPosition,
  decodeWithdrawRequest,
  findFeeIndexPda,
  findPoolPda,
  findWithdrawRequestPda,
} from '@epoch/epoch-sdk';
import { TransactionFailedException } from '@epoch/exceptions';
import { type ConnectionManager, type TransactionSender } from '@epoch/solana';
import { type Connection, Keypair, type PublicKey, TransactionInstruction } from '@solana/web3.js';

import {
  advance,
  feeIndex,
  finalizedIndex,
  key,
  pool,
  position,
  PROGRAM_ID,
  swap,
  withdrawRequest,
} from '../__fixtures__/accounts';
import {
  encodeAdvance,
  encodeFeeIndex,
  encodePool,
  encodeSwapPosition,
  encodeValidatorPosition,
  encodeWithdrawRequest,
} from '../__fixtures__/encode';
import { ProgramClient } from './ProgramClient';

const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys: [], data: Buffer.from([9]) });
const ANCHOR_LOG = 'Program log: AnchorError occurred. Error Code: AlreadySweptThisEpoch. Error Number: 6036.';

function fakeConnection(accounts: Map<string, { owner: PublicKey; data: Uint8Array }>) {
  return {
    getAccountInfo: jest.fn(async (address: PublicKey) => {
      const account = accounts.get(address.toBase58());
      return account ? { owner: account.owner, data: Buffer.from(account.data), lamports: 1, executable: false } : null;
    }),
    getProgramAccounts: jest.fn(async () =>
      [...accounts.entries()].map(([address, account]) => ({
        pubkey: { toBase58: () => address } as PublicKey,
        account: { data: Buffer.from(account.data) },
      })),
    ),
    getEpochInfo: jest.fn(async () => ({ epoch: 812, absoluteSlot: 350_000_123, slotIndex: 1, slotsInEpoch: 432_000 })),
  };
}

function client(
  accounts = new Map<string, { owner: PublicKey; data: Uint8Array }>(),
  sender: Partial<TransactionSender> = {},
  options: { dryRun?: boolean; scorer?: Keypair; now?: () => number } = {},
) {
  const connection = fakeConnection(accounts);
  const connections = {
    withFailover: <T>(fn: (c: Connection) => Promise<T>) => fn(connection as unknown as Connection),
  } as unknown as ConnectionManager;
  const fullSender = {
    payerKey: key(90),
    send: jest.fn(async () => 'sig1'),
    simulate: jest.fn(async () => ({ ok: true, err: null, logs: ['ok'], unitsConsumed: 5_000 })),
    ...sender,
  };
  const programClient = new ProgramClient({
    programId: PROGRAM_ID,
    connections,
    sender: fullSender as unknown as TransactionSender,
    scorer: options.scorer,
    computeUnitPriceMicroLamports: 25_000,
    dryRun: options.dryRun ?? false,
    now: options.now,
  });
  return { programClient, connection, sender: fullSender };
}

describe('test encoders', () => {
  it('round-trip through the epoch-sdk decoders', () => {
    const p = position({ openAdvance: key(80), revenue: [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n], revenueCount: 10 });
    expect(decodeValidatorPosition(encodeValidatorPosition(p))).toEqual(p);
    expect(decodeValidatorPosition(encodeValidatorPosition(position()))).toEqual(position());
    expect(decodePool(encodePool(pool()))).toEqual(pool());
    expect(decodeAdvance(encodeAdvance(advance()))).toEqual(advance());
    const index = finalizedIndex([1n, 2n, 3n]);
    expect(decodeFeeIndex(encodeFeeIndex(index))).toEqual(index);
    expect(decodeWithdrawRequest(encodeWithdrawRequest(withdrawRequest()))).toEqual(withdrawRequest());
    expect(decodeSwapPosition(encodeSwapPosition(swap({ pnl: -5n })))).toEqual(swap({ pnl: -5n }));
  });
});

describe('ProgramClient reads', () => {
  it('lists positions with the discriminator and size filters, skipping accounts that do not decode', async () => {
    const accounts = new Map([
      [key(120).toBase58(), { owner: PROGRAM_ID, data: encodeValidatorPosition(position({ vote: key(20) })) }],
      [key(121).toBase58(), { owner: PROGRAM_ID, data: new Uint8Array(415) }],
    ]);
    const { programClient, connection } = client(accounts);
    const positions = await programClient.positions();
    expect(positions.map((p) => p.account.vote.toBase58())).toEqual([key(20).toBase58()]);
    expect(connection.getProgramAccounts).toHaveBeenCalledWith(PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [
        { memcmp: { offset: 0, bytes: base58Encode(ACCOUNT_DISCRIMINATORS.ValidatorPosition) } },
        { dataSize: 415 },
      ],
    });
  });

  it('filters swaps by taker at its fixed offset', async () => {
    const { programClient, connection } = client();
    await programClient.swaps(key(22));
    const [, config] = connection.getProgramAccounts.mock.calls[0] as unknown as [PublicKey, { filters: unknown[] }];
    expect(config.filters[2]).toEqual({ memcmp: { offset: 40, bytes: key(22).toBase58() } });
  });

  it('reads the pool, fee index and queue entries at their PDAs; null when missing or not the program’s', async () => {
    const [poolPda] = findPoolPda(PROGRAM_ID);
    const [indexPda] = findFeeIndexPda(PROGRAM_ID, poolPda);
    const [requestPda] = findWithdrawRequestPda(PROGRAM_ID, poolPda, 3n);
    const accounts = new Map([
      [poolPda.toBase58(), { owner: PROGRAM_ID, data: encodePool(pool({ cash: 7n })) }],
      [indexPda.toBase58(), { owner: key(1), data: encodeFeeIndex(feeIndex()) }], // wrong owner
      [requestPda.toBase58(), { owner: PROGRAM_ID, data: encodeWithdrawRequest(withdrawRequest({ seq: 3n })) }],
    ]);
    const { programClient } = client(accounts);
    expect((await programClient.pool())?.account.cash).toBe(7n);
    expect(await programClient.feeIndex()).toBeNull();
    expect((await programClient.withdrawRequest(3n))?.seq).toBe(3n);
    expect(await programClient.withdrawRequest(4n)).toBeNull();
    expect(await programClient.clock()).toEqual({ epoch: 812n, slot: 350_000_123n });
  });
});

describe('ProgramClient transactions', () => {
  it('sends with the configured priority fee and reports the signature', async () => {
    const { programClient, sender } = client();
    await expect(programClient.execute('accrue 1', [ix], 'crank')).resolves.toEqual({
      status: 'sent',
      signature: 'sig1',
    });
    expect(sender.send).toHaveBeenCalledWith(
      [ix],
      [],
      expect.objectContaining({ computeUnitPriceMicroLamports: 25_000, retries: 2 }),
    );
  });

  it('co-signs scorer transactions and refuses them without a scorer key', async () => {
    const scorer = Keypair.generate();
    const { programClient, sender } = client(undefined, {}, { scorer });
    await programClient.execute('update_score x', [ix], 'scorer');
    expect((sender.send.mock.calls[0] as unknown[])[1]).toEqual([scorer]);
    expect(programClient.keyOf('scorer')?.equals(scorer.publicKey)).toBe(true);
    await expect(client().programClient.execute('update_score x', [ix], 'scorer')).rejects.toThrow(
      'SCORER_KEYPAIR_PATH',
    );
  });

  it('turns failures into readable program errors; anything else is transient', async () => {
    const failing = client(undefined, {
      send: jest.fn(async () => {
        throw new TransactionFailedException('Transaction failed after retries', {
          error: 'SendTransactionError: Simulation failed',
          logs: [ANCHOR_LOG],
        });
      }),
    });
    const result = await failing.programClient.execute('sweep x', [ix], 'crank');
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 6036, name: 'AlreadySweptThisEpoch' },
      transient: false,
    });

    const anchorConstraint = client(undefined, {
      send: jest.fn(async () => {
        throw new TransactionFailedException('Transaction failed after retries', {
          error: 'SendTransactionError: Simulation failed',
          logs: [
            'Program log: AnchorError caused by account: advance. Error Code: AccountNotInitialized. Error Number: 3012.',
            `Program ${PROGRAM_ID.toBase58()} failed: custom program error: 0xbc4`,
          ],
        });
      }),
    });
    // Not an Epoch error, but the instruction ran and failed: deterministic, not worth retrying every tick.
    await expect(anchorConstraint.programClient.execute('sweep x', [ix], 'crank')).resolves.toMatchObject({
      status: 'failed',
      error: undefined,
      transient: false,
    });

    const flaky = client(undefined, {
      send: jest.fn(async () => {
        throw new TransactionFailedException('Transaction failed after retries', { error: 'fetch failed', logs: [] });
      }),
    });
    await expect(flaky.programClient.execute('sweep x', [ix], 'crank')).resolves.toMatchObject({
      status: 'failed',
      error: undefined,
      transient: true,
      message: 'fetch failed',
    });
  });

  it('tells the sender not to retry program errors', async () => {
    const { programClient, sender } = client();
    await programClient.execute('sweep x', [ix], 'crank');
    const { shouldRetry } = (sender.send.mock.calls[0] as unknown[])[2] as { shouldRetry: (e: unknown) => boolean };
    expect(shouldRetry(Object.assign(new Error('Simulation failed'), { logs: [ANCHOR_LOG] }))).toBe(false);
    expect(shouldRetry(new Error('custom program error: 0x179c'))).toBe(false); // 6044
    expect(shouldRetry(new Error('block height exceeded'))).toBe(true);
  });

  it('simulates without sending, parsing a failed simulation', async () => {
    const { programClient, sender } = client(undefined, {
      simulate: jest.fn(async () => ({
        ok: false,
        err: { InstructionError: [1, { Custom: 6038 }] },
        logs: [],
      })),
    });
    await expect(programClient.simulate('mark_default x', [ix], 'crank')).resolves.toMatchObject({
      status: 'failed',
      error: { name: 'NotDefaultable' },
      transient: false,
    });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('under DRY_RUN simulates instead of sending, once per action per half hour', async () => {
    let now = 0;
    const { programClient, sender } = client(undefined, {}, { dryRun: true, now: () => now });
    await expect(programClient.execute('settle_swap a', [ix], 'crank')).resolves.toMatchObject({
      status: 'simulated',
      unitsConsumed: 5_000,
    });
    await programClient.execute('settle_swap a', [ix], 'crank');
    await programClient.execute('settle_swap b', [ix], 'crank');
    expect(sender.simulate).toHaveBeenCalledTimes(2);
    now += 31 * 60_000;
    await programClient.execute('settle_swap a', [ix], 'crank');
    expect(sender.simulate).toHaveBeenCalledTimes(3);
    expect(sender.send).not.toHaveBeenCalled();
  });
});
