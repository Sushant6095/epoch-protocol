import { Keypair, VersionedTransaction } from '@solana/web3.js';

import * as fx from './__fixtures__/responses';
import { PantaInputError } from './errors';
import { PantaBuyBuildSchema } from './schemas';
import {
  compileUnsignedTransaction,
  decodeTransaction,
  describeTransaction,
  messageHash,
  transactionSignature,
} from './transactions';

describe('compileUnsignedTransaction', () => {
  it('turns a primary-buy build into one unsigned v0 transaction the wallet pays for and signs', () => {
    const wallet = Keypair.generate();
    const build = PantaBuyBuildSchema.parse({
      ...fx.buyBuild,
      wallet: wallet.publicKey.toBase58(),
      instructions: [
        {
          ...fx.instruction,
          accounts: [
            { pubkey: wallet.publicKey.toBase58(), isSigner: true, isWritable: true },
            ...fx.instruction.accounts.slice(1),
          ],
        },
      ],
    });
    const unsigned = compileUnsignedTransaction({
      payer: build.wallet,
      recentBlockhash: build.recentBlockhash,
      instructions: build.instructions,
    });
    expect(unsigned).toMatchObject({
      feePayer: wallet.publicKey.toBase58(),
      requiredSigners: [wallet.publicKey.toBase58()],
      recentBlockhash: fx.BLOCKHASH,
      programIds: [fx.PANTA_PROGRAM],
      lookupTables: 0,
    });
    expect(unsigned.messageHash).toMatch(/^[0-9a-f]{64}$/);

    const tx = decodeTransaction(unsigned.transaction);
    expect(transactionSignature(tx)).toBeNull();
    expect(Buffer.from(tx.message.compiledInstructions[0].data)).toEqual(Buffer.from([1, 2, 3, 4]));

    // What the wallet signs is the same message: same hash, now with a signature.
    tx.sign([wallet]);
    const signed = VersionedTransaction.deserialize(tx.serialize());
    expect(messageHash(signed)).toBe(unsigned.messageHash);
    expect(transactionSignature(signed)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    expect(describeTransaction(signed).requiredSigners).toEqual([wallet.publicKey.toBase58()]);
  });

  it('refuses instructions that need another signer, and junk', () => {
    expect(() =>
      compileUnsignedTransaction({
        payer: fx.WALLET,
        recentBlockhash: fx.BLOCKHASH,
        instructions: [{ ...fx.instruction, accounts: [{ pubkey: fx.CREATOR, isSigner: true, isWritable: true }] }],
      }),
    ).toThrow(PantaInputError);
    expect(() =>
      compileUnsignedTransaction({ payer: 'nope', recentBlockhash: fx.BLOCKHASH, instructions: [fx.instruction] }),
    ).toThrow(PantaInputError);
    expect(() =>
      compileUnsignedTransaction({
        payer: fx.WALLET,
        recentBlockhash: fx.BLOCKHASH,
        instructions: [{ ...fx.instruction, programId: 'not-a-key' }],
      }),
    ).toThrow(PantaInputError);
    expect(() => decodeTransaction('AAAA')).toThrow(PantaInputError);
  });
});
