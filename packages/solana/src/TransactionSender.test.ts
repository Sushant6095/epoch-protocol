import {
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js';

import { type ConnectionManager } from './ConnectionManager';
import { errorLogs, isExecutionFailure, TransactionSender } from './TransactionSender';

jest.mock('@solana/web3.js', () => ({
  ...jest.requireActual('@solana/web3.js'),
  sendAndConfirmTransaction: jest.fn(),
}));

const sendMock = sendAndConfirmTransaction as jest.MockedFunction<typeof sendAndConfirmTransaction>;
const programId = new PublicKey(new Uint8Array(32).fill(42));
const ix = new TransactionInstruction({ programId, keys: [], data: Buffer.from([1, 2, 3]) });

function senderWith(connection: Partial<Connection>): TransactionSender {
  const connections = {
    withFailover: <T>(fn: (c: Connection) => Promise<T>) => fn(connection as Connection),
  } as unknown as ConnectionManager;
  return new TransactionSender(connections, Keypair.generate());
}

describe('TransactionSender.simulate', () => {
  it('simulates the same instructions send would build, unsigned, with a replaced blockhash', async () => {
    const simulateTransaction = jest.fn(async () => ({
      context: { slot: 1 },
      value: { err: null, logs: ['Program log: ok'], unitsConsumed: 1_234, accounts: null },
    }));
    const sender = senderWith({ simulateTransaction } as unknown as Partial<Connection>);
    const result = await sender.simulate([ix], { computeUnitPriceMicroLamports: 77 });
    expect(result).toEqual({ ok: true, err: null, logs: ['Program log: ok'], unitsConsumed: 1_234 });

    const [tx, config] = simulateTransaction.mock.calls[0] as unknown as [VersionedTransaction, object];
    expect(config).toEqual({ sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
    const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
    expect(keys[0]).toBe(sender.payerKey.toBase58());
    const programs = tx.message.compiledInstructions.map((c) => keys[c.programIdIndex]);
    expect(programs).toEqual([ComputeBudgetProgram.programId.toBase58(), programId.toBase58()]);
    expect(Buffer.from(tx.message.compiledInstructions[1].data)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('reports a failed simulation with its logs', async () => {
    const err = { InstructionError: [1, { Custom: 6036 }] };
    const simulateTransaction = jest.fn(async () => ({
      context: { slot: 1 },
      value: { err, logs: null, accounts: null },
    }));
    const result = await senderWith({ simulateTransaction } as unknown as Partial<Connection>).simulate([ix]);
    expect(result).toEqual({ ok: false, err, logs: [], unitsConsumed: undefined });
  });
});

describe('TransactionSender.send', () => {
  beforeEach(() => sendMock.mockReset());

  it('returns the signature', async () => {
    sendMock.mockResolvedValueOnce('sig1');
    await expect(senderWith({}).send([ix])).resolves.toBe('sig1');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('fails fast when shouldRetry rejects the error, keeping the program logs', async () => {
    const failure = Object.assign(new Error('Simulation failed'), {
      logs: ['Program log: AnchorError ... Error Number: 6036.'],
    });
    sendMock.mockRejectedValue(failure);
    const sender = senderWith({});
    await expect(sender.send([ix], [], { retries: 3, shouldRetry: () => false })).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      details: { logs: ['Program log: AnchorError ... Error Number: 6036.'] },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('retries errors shouldRetry accepts', async () => {
    sendMock.mockRejectedValueOnce(new Error('blockhash not found')).mockResolvedValueOnce('sig2');
    await expect(senderWith({}).send([ix], [], { retries: 2, shouldRetry: () => true })).resolves.toBe('sig2');
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});

describe('errorLogs', () => {
  it('reads a logs array and ignores anything else', () => {
    expect(errorLogs({ logs: ['a', 1, 'b'] })).toEqual(['a', 'b']);
    expect(errorLogs(new Error('x'))).toEqual([]);
    expect(errorLogs(undefined)).toEqual([]);
  });
});

describe('isExecutionFailure', () => {
  it('recognises an instruction that ran and failed', () => {
    expect(isExecutionFailure({ err: { InstructionError: [0, { Custom: 3012 }] } })).toBe(true);
    expect(isExecutionFailure({ logs: [`Program ${'1'.repeat(32)} failed: custom program error: 0xbc4`] })).toBe(true);
    expect(
      isExecutionFailure({
        message:
          'Simulation failed. Message: Transaction simulation failed: Error processing Instruction 1: custom program error: 0x1770.',
      }),
    ).toBe(true);
    expect(
      isExecutionFailure({
        logs: ['Program log: AnchorError occurred. Error Code: AccountNotInitialized. Error Number: 3012.'],
        message: 'x',
      }),
    ).toBe(true);
    expect(isExecutionFailure({ message: 'AnchorError ... Error Number: 3012.' })).toBe(true);
  });

  it('leaves RPC, network, blockhash and funding problems retryable', () => {
    expect(isExecutionFailure({ message: 'fetch failed' })).toBe(false);
    expect(isExecutionFailure({ message: 'TransactionExpiredBlockheightExceededError: block height exceeded' })).toBe(
      false,
    );
    expect(isExecutionFailure({ err: 'BlockhashNotFound' })).toBe(false);
    expect(isExecutionFailure({ err: 'InsufficientFundsForFee', logs: [] })).toBe(false);
    expect(isExecutionFailure({})).toBe(false);
  });
});
