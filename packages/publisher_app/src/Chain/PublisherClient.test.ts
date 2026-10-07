import { base64Encode, EVENT_DISCRIMINATORS, findFeeIndexPda, findPoolPda } from '@epoch/epoch-sdk';
import { TransactionFailedException } from '@epoch/exceptions';
import { type ConnectionManager, type TransactionSender } from '@epoch/solana';
import { type Connection, type PublicKey, TransactionInstruction } from '@solana/web3.js';

import { key, PROGRAM_ID } from '../__fixtures__/fakes';
import { PublisherClient } from './PublisherClient';

const ix = new TransactionInstruction({ programId: PROGRAM_ID, keys: [], data: Buffer.from([1]) });

/** The log lines of a post_index transaction: the IndexProposed event as `Program data:` (discriminator ++ borsh). */
function proposalLogs(inputsHash: Uint8Array): string[] {
  const data = Buffer.alloc(8 + 8 + 8 + 32 + 8);
  Buffer.from(EVENT_DISCRIMINATORS.IndexProposed).copy(data, 0);
  data.writeBigUInt64LE(1_172n, 8);
  data.writeBigUInt64LE(1_050n, 16);
  Buffer.from(inputsHash).copy(data, 24);
  data.writeBigUInt64LE(500n, 56);
  return [
    `Program ${PROGRAM_ID.toBase58()} invoke [1]`,
    'Program log: Instruction: PostIndex',
    `Program data: ${base64Encode(data)}`,
    `Program ${PROGRAM_ID.toBase58()} success`,
  ];
}

/** The log lines of a cast_index_vote transaction: its IndexVoteCast event (only operator and hash matter here). */
function voteLogs(operator: PublicKey, inputsHash: Uint8Array): string[] {
  // fee_index, epoch, round, operator, weight, value, inputs_hash, deviation_bps, agrees, changed, late,
  // median_value, agreeing_weight, total_weight, votes_cast, slot
  const data = Buffer.alloc(8 + 32 + 8 + 1 + 32 + 4 + 8 + 32 + 4 + 1 + 1 + 1 + 8 + 8 + 8 + 1 + 8);
  Buffer.from(EVENT_DISCRIMINATORS.IndexVoteCast).copy(data, 0);
  Buffer.from(operator.toBytes()).copy(data, 8 + 32 + 8 + 1);
  Buffer.from(inputsHash).copy(data, 8 + 32 + 8 + 1 + 32 + 4 + 8);
  return [`Program ${PROGRAM_ID.toBase58()} invoke [1]`, `Program data: ${base64Encode(data)}`];
}

function setup(connection: Record<string, jest.Mock> = {}, dryRun = false) {
  const connections = {
    withFailover: <T>(fn: (c: Connection) => Promise<T>) => fn(connection as unknown as Connection),
  } as unknown as ConnectionManager;
  const sender = {
    payerKey: key(5),
    send: jest.fn(async () => 'sig1'),
    simulate: jest.fn(async () => ({ ok: true, err: null, logs: [], unitsConsumed: 1 })),
  };
  const operator = {
    payerKey: key(60),
    send: jest.fn(async () => 'sigOperator'),
    simulate: jest.fn(async () => ({ ok: true, err: null, logs: [], unitsConsumed: 1 })),
  };
  const client = new PublisherClient({
    programId: PROGRAM_ID,
    connections,
    senders: { publisher: sender as unknown as TransactionSender },
    operators: [operator as unknown as TransactionSender],
    computeUnitPriceMicroLamports: 5_000,
    dryRun,
  });
  return { client, sender, operator };
}

describe('PublisherClient', () => {
  it('finds its own post_index by the inputs hash in the publisher key’s history', async () => {
    const wanted = new Uint8Array(32).fill(9);
    const getSignaturesForAddress = jest.fn(async () => [
      { signature: 'failed', err: { InstructionError: [0, 'x'] } },
      { signature: 'other', err: null },
      { signature: 'ours', err: null },
    ]);
    const getTransaction = jest.fn(async (signature: string) => ({
      meta: { logMessages: signature === 'ours' ? proposalLogs(wanted) : proposalLogs(new Uint8Array(32)) },
    }));
    const { client } = setup({ getSignaturesForAddress, getTransaction });
    await expect(client.findProposalSignature(wanted)).resolves.toBe('ours');
    expect((getSignaturesForAddress.mock.calls[0] as unknown[])[0]).toEqual(key(5));
    expect(getTransaction).toHaveBeenCalledTimes(2); // the failed one is not fetched
    await expect(client.findProposalSignature(new Uint8Array(32).fill(3))).resolves.toBeNull();
  });

  it('lists one maker’s quotes with the maker filter', async () => {
    const getProgramAccounts = jest.fn(async () => []);
    const { client } = setup({ getProgramAccounts });
    await client.quotes(key(6));
    const [programId, config] = getProgramAccounts.mock.calls[0] as unknown as [PublicKey, { filters: unknown[] }];
    expect(programId).toEqual(PROGRAM_ID);
    expect(config.filters[2]).toEqual({ memcmp: { offset: 40, bytes: key(6).toBase58() } });
  });

  it('reads the first slot of an epoch from the cluster schedule, once', async () => {
    const getEpochSchedule = jest.fn(async () => ({ getFirstSlotInEpoch: (epoch: number) => epoch * 432_000 }));
    const { client } = setup({ getEpochSchedule });
    await expect(client.firstSlotOfEpoch(1_173n)).resolves.toBe(1_173n * 432_000n);
    await client.firstSlotOfEpoch(1_174n);
    expect(getEpochSchedule).toHaveBeenCalledTimes(1);
  });

  it('sends with the role’s key and reads program errors out of failures', async () => {
    const { client, sender } = setup();
    await expect(client.execute('post_index 1', [ix], 'publisher')).resolves.toEqual({
      status: 'sent',
      signature: 'sig1',
    });
    sender.send.mockRejectedValueOnce(
      new TransactionFailedException('Transaction failed after retries', {
        error: 'Simulation failed: custom program error: 0x179b',
        logs: [],
      }),
    );
    await expect(client.execute('post_index 1', [ix], 'publisher')).resolves.toMatchObject({
      status: 'failed',
      error: { name: 'IndexMoveTooLarge' },
      transient: false,
    });
    await expect(client.execute('post_quote 1', [ix], 'maker')).rejects.toThrow('no keypair configured for the maker');
  });

  it('only simulates under DRY_RUN, once per action per half hour', async () => {
    const { client, sender } = setup({}, true);
    await expect(client.execute('post_index 1', [ix], 'publisher')).resolves.toMatchObject({ status: 'simulated' });
    await client.execute('post_index 1', [ix], 'publisher');
    expect(sender.simulate).toHaveBeenCalledTimes(1);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('signs a vote with the operator key itself, and refuses a key it does not hold', async () => {
    const { client, sender, operator } = setup();
    expect(client.operatorKeys()).toEqual([key(60)]);
    await expect(client.execute('cast_index_vote 1', [ix], key(60))).resolves.toEqual({
      status: 'sent',
      signature: 'sigOperator',
    });
    expect(operator.send).toHaveBeenCalledTimes(1);
    expect(sender.send).not.toHaveBeenCalled();
    await expect(client.execute('cast_index_vote 1', [ix], key(61))).rejects.toThrow(
      `no keypair configured for operator ${key(61).toBase58()}`,
    );
  });

  it('lists the FeeIndex’s ballots with the IndexBallot and fee_index filters', async () => {
    const getProgramAccounts = jest.fn(async () => []);
    const { client } = setup({ getProgramAccounts });
    await expect(client.indexBallots()).resolves.toEqual([]);
    const { filters } = (getProgramAccounts.mock.calls[0] as unknown[])[1] as {
      filters: { memcmp?: { offset: number; bytes: string }; dataSize?: number }[];
    };
    const feeIndex = findFeeIndexPda(PROGRAM_ID, findPoolPda(PROGRAM_ID)[0])[0];
    expect(filters).toContainEqual({ memcmp: { offset: 8, bytes: feeIndex.toBase58() } });
    expect(filters).toContainEqual({ dataSize: 936 });
  });

  it('finds an operator’s own vote by its inputs hash in that key’s history', async () => {
    const wanted = new Uint8Array(32).fill(7);
    const getSignaturesForAddress = jest.fn(async () => [
      { signature: 'otherHash', err: null },
      { signature: 'ours', err: null },
    ]);
    const getTransaction = jest.fn(async (signature: string) => ({
      meta: { logMessages: voteLogs(key(60), signature === 'ours' ? wanted : new Uint8Array(32)) },
    }));
    const { client } = setup({ getSignaturesForAddress, getTransaction });
    await expect(client.findVoteSignature(key(60), wanted)).resolves.toBe('ours');
    expect((getSignaturesForAddress.mock.calls[0] as unknown[])[0]).toEqual(key(60));
    await expect(client.findVoteSignature(key(61), wanted)).resolves.toBeNull(); // another operator's event
  });
});
