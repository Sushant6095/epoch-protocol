import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

import { key } from './__fixtures__/accounts';
import {
  addSignature,
  buildPartlySigned,
  decodeTransaction,
  describeTransaction,
  encodeTransaction,
  signatureStatus,
  submitProblems,
} from './Offline';

const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(3)).toBase58();

/** An instruction that needs two signers, like onboard_validator (operator + current withdrawer). */
function twoSigner(operator: PublicKey, withdrawer: PublicKey) {
  const ix = SystemProgram.transfer({ fromPubkey: operator, toPubkey: key(9), lamports: 1 });
  ix.keys.push({ pubkey: withdrawer, isSigner: true, isWritable: false });
  return ix;
}

describe('offline signing', () => {
  const operator = Keypair.generate();
  const withdrawer = Keypair.generate();

  it('operator signs, the withdrawer adds its signature offline, then it is complete', () => {
    const tx = buildPartlySigned({
      instructions: [twoSigner(operator.publicKey, withdrawer.publicKey)],
      signer: operator,
      lifetime: { kind: 'blockhash', blockhash: BLOCKHASH, lastValidBlockHeight: 100 },
      priorityFeeMicroLamports: 10_000,
    });
    const travelled = decodeTransaction(`${encodeTransaction(tx)}\n`);
    expect(signatureStatus(travelled).map((s) => [s.key.toBase58(), s.signed])).toEqual([
      [operator.publicKey.toBase58(), true],
      [withdrawer.publicKey.toBase58(), false],
    ]);
    expect(submitProblems(travelled)).toEqual([`missing the signature of ${withdrawer.publicKey.toBase58()}`]);
    expect(describeTransaction(travelled)).toContain('MISSING');

    const signed = decodeTransaction(encodeTransaction(addSignature(travelled, withdrawer)));
    expect(submitProblems(signed)).toEqual([]);
    expect(signed.verifySignatures(true)).toBe(true);
    // The compute-unit price comes first, then the instruction.
    expect(signed.instructions.map((ix) => ix.programId.toBase58())).toEqual([
      'ComputeBudget111111111111111111111111111111',
      SystemProgram.programId.toBase58(),
    ]);
  });

  it('refuses a key the transaction does not ask for, and a tampered transaction', () => {
    const tx = buildPartlySigned({
      instructions: [twoSigner(operator.publicKey, withdrawer.publicKey)],
      signer: operator,
      lifetime: { kind: 'blockhash', blockhash: BLOCKHASH, lastValidBlockHeight: 100 },
      priorityFeeMicroLamports: 0,
    });
    expect(() => addSignature(decodeTransaction(encodeTransaction(tx)), Keypair.generate())).toThrow(
      /is not a signer of this transaction/,
    );
    const signed = addSignature(decodeTransaction(encodeTransaction(tx)), withdrawer);
    const bytes = signed.serialize();
    bytes[bytes.length - 1] ^= 1; // flip a data bit after both signed
    expect(submitProblems(Transaction.from(bytes))).toEqual([
      'a signature does not match the transaction (it was changed after signing)',
    ]);
    expect(() => decodeTransaction('not base64!')).toThrow(/not base64/);
  });

  it('with a durable nonce, AdvanceNonceAccount comes first and the nonce is the blockhash', () => {
    const nonceAccount = key(50);
    const tx = buildPartlySigned({
      instructions: [twoSigner(operator.publicKey, withdrawer.publicKey)],
      signer: operator,
      lifetime: { kind: 'nonce', account: nonceAccount, nonce: BLOCKHASH, authority: operator.publicKey },
      priorityFeeMicroLamports: 10_000,
    });
    const travelled = decodeTransaction(encodeTransaction(tx));
    expect(travelled.instructions[0].programId.equals(SystemProgram.programId)).toBe(true);
    expect(travelled.instructions[0].data.readUInt32LE(0)).toBe(4); // AdvanceNonceAccount
    expect(travelled.instructions[0].keys[0].pubkey.equals(nonceAccount)).toBe(true);
    expect(travelled.recentBlockhash).toBe(BLOCKHASH);
    expect(describeTransaction(travelled)).toContain('blockhash');
  });
});
