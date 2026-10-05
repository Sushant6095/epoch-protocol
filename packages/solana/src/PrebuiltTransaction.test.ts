import { TransactionFailedException } from '@epoch/exceptions';
import {
  type Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

import { type ConnectionManager } from './ConnectionManager';
import {
  encodeBase58,
  PrebuiltTransactionSender,
  sendSignedTransaction,
  signatureState,
  signPrebuiltTransaction,
} from './PrebuiltTransaction';

const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();

/** An unsigned v0 transaction paid by `payer` (and also signed by `others`), as a partner API would return it. */
function unsigned(payer: PublicKey, others: PublicKey[] = []): string {
  const instructions = [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })];
  for (const other of others)
    instructions.push(SystemProgram.transfer({ fromPubkey: other, toPubkey: payer, lamports: 1 }));
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}

interface FakeChain {
  statuses: (null | { slot: number; err: unknown; confirmationStatus: string })[];
  heights: number[];
  sendErrors: unknown[];
}

function connections(chain: FakeChain) {
  const sent: { skipPreflight?: boolean }[] = [];
  const connection = {
    sendRawTransaction: jest.fn(async (_raw: Uint8Array, options: { skipPreflight?: boolean }) => {
      sent.push(options);
      const error = chain.sendErrors.shift();
      if (error) throw error;
      return 'sig';
    }),
    getSignatureStatuses: jest.fn(async () => ({ context: { slot: 1 }, value: [chain.statuses.shift() ?? null] })),
    getBlockHeight: jest.fn(async () => chain.heights.shift() ?? 0),
  };
  const manager = {
    withFailover: <T>(fn: (c: Connection) => Promise<T>) => fn(connection as unknown as Connection),
  } as unknown as ConnectionManager;
  return { manager, connection, sent };
}

const options = (extra: object = {}) => ({
  lastValidBlockHeight: 100,
  pollMs: 1,
  resendMs: 0,
  sleep: async () => undefined,
  ...extra,
});

describe('encodeBase58', () => {
  it('matches web3.js for keys and keeps leading zeros', () => {
    const key = Keypair.generate().publicKey;
    expect(encodeBase58(key.toBytes())).toBe(key.toBase58());
    expect(encodeBase58(new Uint8Array([0, 0, 1]))).toBe('112');
    expect(encodeBase58(new Uint8Array(32))).toBe('11111111111111111111111111111111');
  });
});

describe('signPrebuiltTransaction', () => {
  it('signs a transaction paid by the key, as built', () => {
    const payer = Keypair.generate();
    const signed = signPrebuiltTransaction(unsigned(payer.publicKey), payer);
    expect(signed.signature).toBe(encodeBase58(signed.transaction.signatures[0]));
    const again = VersionedTransaction.deserialize(Buffer.from(signed.signedBase64, 'base64'));
    expect(again.message.recentBlockhash).toBe(BLOCKHASH);
    expect(encodeBase58(again.signatures[0])).toBe(signed.signature);
  });

  it('refuses another payer, extra signers and junk', () => {
    const payer = Keypair.generate();
    const other = Keypair.generate();
    expect(() => signPrebuiltTransaction(unsigned(other.publicKey), payer)).toThrow(TransactionFailedException);
    expect(() => signPrebuiltTransaction(unsigned(payer.publicKey, [other.publicKey]), payer)).toThrow(
      'needs other signers',
    );
    expect(() => signPrebuiltTransaction('AAAA', payer)).toThrow(TransactionFailedException);
  });
});

describe('sendSignedTransaction', () => {
  const payer = Keypair.generate();
  const signed = () => signPrebuiltTransaction(unsigned(payer.publicKey), payer);

  it('broadcasts with preflight first, re-sends without, and returns once confirmed', async () => {
    const chain: FakeChain = {
      statuses: [
        null,
        { slot: 5, err: null, confirmationStatus: 'processed' },
        { slot: 6, err: null, confirmationStatus: 'confirmed' },
      ],
      heights: [90, 91],
      sendErrors: [],
    };
    const { manager, sent } = connections(chain);
    const tx = signed();
    expect(await sendSignedTransaction(manager, tx, options())).toBe(tx.signature);
    expect(sent.map((s) => s.skipPreflight)).toEqual([false, true, true]);
  });

  it('fails fast on a program error in preflight, and reports an on-chain failure', async () => {
    const preflight = new SendTransactionError({
      action: 'send',
      signature: 'x',
      transactionMessage: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1',
      logs: ['Program 11111111111111111111111111111111 failed: custom program error: 0x1'],
    });
    const first = connections({ statuses: [], heights: [], sendErrors: [preflight] });
    await expect(sendSignedTransaction(first.manager, signed(), options())).rejects.toThrow('preflight');

    const onChain = connections({
      statuses: [{ slot: 7, err: { InstructionError: [0, { Custom: 1 }] }, confirmationStatus: 'confirmed' }],
      heights: [],
      sendErrors: [],
    });
    await expect(sendSignedTransaction(onChain.manager, signed(), options())).rejects.toMatchObject({
      details: { err: { InstructionError: [0, { Custom: 1 }] } },
    });
  });

  it('keeps going through RPC hiccups, then reports expiry once the blockhash is dead', async () => {
    const chain: FakeChain = {
      statuses: [null, null, null],
      heights: [99, 101],
      sendErrors: [new Error('503 Service Unavailable')],
    };
    const { manager, sent } = connections(chain);
    const error = await sendSignedTransaction(manager, signed(), options()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransactionFailedException);
    expect(error).toMatchObject({ details: { expired: true } });
    expect(sent.length).toBeGreaterThanOrEqual(2);
  });
});

describe('PrebuiltTransactionSender', () => {
  it('signs with its key, reads states and re-broadcasts a stored transaction', async () => {
    const payer = Keypair.generate();
    const chain: FakeChain = {
      statuses: [
        { slot: 3, err: null, confirmationStatus: 'finalized' },
        { slot: 4, err: null, confirmationStatus: 'confirmed' },
      ],
      heights: [],
      sendErrors: [],
    };
    const { manager, connection } = connections(chain);
    const sender = new PrebuiltTransactionSender(manager, payer);
    expect(sender.payerKey.equals(payer.publicKey)).toBe(true);
    const tx = sender.sign(unsigned(payer.publicKey));
    expect(await sender.state(tx.signature)).toEqual({ status: 'confirmed', slot: 3 });
    expect(connection.getSignatureStatuses).toHaveBeenCalledWith([tx.signature], { searchTransactionHistory: true });
    expect(await sender.resend(tx.signedBase64, options())).toBe(tx.signature);
    expect(await signatureState(manager, tx.signature)).toEqual({ status: 'unknown' });
  });
});
