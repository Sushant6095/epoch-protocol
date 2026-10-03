import { SendTransactionError } from '@solana/web3.js';

import { vectors } from './__fixtures__/vectors';
import { EPOCH_ERRORS, epochErrorFromCode, parseEpochError } from './errors';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

const EPOCH = vectors.programId;

describe('EPOCH_ERRORS', () => {
  it('equals the program table: name, code (6000 + declaration index) and #[msg] verbatim', () => {
    expect(vectors.errorCodeOffset).toBe(6000);
    const rust = [...vectors.errors].sort((a, b) => a.code - b.code);
    expect(EPOCH_ERRORS.map((e) => ({ name: e.name, code: e.code, message: e.message }))).toEqual(rust);
    EPOCH_ERRORS.forEach((e, i) => expect(e.code).toBe(6000 + i));
    expect(EPOCH_ERRORS).toHaveLength(54);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(EPOCH_ERRORS)).toBe(true);
    expect(Object.isFrozen(EPOCH_ERRORS[0])).toBe(true);
  });

  it('epochErrorFromCode looks codes up', () => {
    expect(epochErrorFromCode(6000)?.name).toBe('Paused');
    expect(epochErrorFromCode(6053)?.name).toBe('NotMaker');
    expect(epochErrorFromCode(6054)).toBeUndefined();
    expect(epochErrorFromCode(2006)).toBeUndefined();
  });
});

describe('parseEpochError', () => {
  const failedLogs = [
    `Program ${EPOCH} invoke [1]`,
    'Program log: Instruction: Deposit',
    'Program log: AnchorError thrown in programs/epoch/src/instructions/pool/deposit.rs:40. Error Code: ZeroAmount. Error Number: 6007. Error Message: Amount must be greater than zero.',
    `Program ${EPOCH} consumed 5123 of 200000 compute units`,
    `Program ${EPOCH} failed: custom program error: 0x1777`,
  ];

  it('reads a TransactionError', () => {
    expect(parseEpochError({ InstructionError: [0, { Custom: 6000 }] })?.name).toBe('Paused');
    expect(parseEpochError({ InstructionError: [2, { Custom: 6032 }] })?.name).toBe('OverLimit');
  });

  it('reads confirmation and simulation results', () => {
    expect(parseEpochError({ err: { InstructionError: [0, { Custom: 6036 }] } })?.name).toBe('AlreadySweptThisEpoch');
    expect(parseEpochError({ context: { slot: 1 }, value: { err: null, logs: failedLogs } })?.name).toBe('ZeroAmount');
    expect(parseEpochError({ value: { err: { InstructionError: [0, { Custom: 6007 }] }, logs: null } })?.code).toBe(
      6007,
    );
  });

  it('reads web3.js SendTransactionError (logs and message)', () => {
    const withLogs = new SendTransactionError({
      action: 'simulate',
      signature: '',
      transactionMessage: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1777',
      logs: failedLogs,
    });
    expect(parseEpochError(withLogs)?.name).toBe('ZeroAmount');

    const messageOnly = new SendTransactionError({
      action: 'send',
      signature: '5x',
      transactionMessage: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1782',
    });
    expect(parseEpochError(messageOnly)?.code).toBe(6018);
    expect(parseEpochError(messageOnly)?.name).toBe('UnsupportedVoteState');
  });

  it('reads plain Errors, strings, log arrays, RPC errors and Anchor client errors', () => {
    expect(
      parseEpochError(
        new Error(
          'failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1770',
        ),
      )?.name,
    ).toBe('Paused');
    expect(
      parseEpochError('Error Code: NotMaker. Error Number: 6053. Error Message: Signer is not the quote maker.')?.name,
    ).toBe('NotMaker');
    expect(parseEpochError(failedLogs)?.name).toBe('ZeroAmount');
    expect(
      parseEpochError({
        code: -32002,
        message: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1771',
        data: { err: { InstructionError: [0, { Custom: 6001 }] }, logs: [] },
      })?.name,
    ).toBe('NotAdmin');
    expect(parseEpochError({ error: { errorCode: { code: 'Paused', number: 6000 } }, logs: [] })?.name).toBe('Paused');
    expect(parseEpochError({ code: 6052, msg: 'Swap already settled' })?.name).toBe('AlreadySettled');
    expect(parseEpochError(`Transaction 3x failed ({"err":{"InstructionError":[1,{"Custom":6047}]}})`)?.name).toBe(
      'IndexMissing',
    );
    expect(parseEpochError(6010)?.name).toBe('InsufficientLiquidity');
    expect(parseEpochError({ error: new Error('custom program error: 0x1774') })?.name).toBe('BpsOutOfRange');
  });

  it('returns undefined for errors that are not the Epoch program’s', () => {
    expect(parseEpochError(undefined)).toBeUndefined();
    expect(parseEpochError(null)).toBeUndefined();
    expect(parseEpochError({})).toBeUndefined();
    expect(parseEpochError(42)).toBeUndefined();
    expect(parseEpochError(new Error('Blockhash not found'))).toBeUndefined();
    expect(parseEpochError({ InstructionError: [0, { Custom: 1 }] })).toBeUndefined(); // system program: insufficient funds
    expect(parseEpochError({ InstructionError: [0, 'InvalidAccountData'] })).toBeUndefined();
    expect(
      parseEpochError(
        'AnchorError caused by account: pool. Error Code: ConstraintSeeds. Error Number: 2006. Error Message: A seeds constraint was violated.',
      ),
    ).toBeUndefined();
  });

  it('survives cycles', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { error: a };
    a.cause = b;
    expect(parseEpochError(a)).toBeUndefined();
    b.logs = ['Program log: … Error Number: 6005. Error Message: Pool parameters are inconsistent.'];
    expect(parseEpochError(a)?.name).toBe('InvalidParams');
  });
});
