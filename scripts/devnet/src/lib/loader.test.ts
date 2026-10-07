import { Keypair, PublicKey } from '@solana/web3.js';

import {
  BPF_LOADER_UPGRADEABLE,
  deployedMatches,
  parseProgramAccount,
  parseProgramData,
  programDataAddress,
  soDeclaresId,
} from './loader';

function programData(slot: bigint, authority: PublicKey | null, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(45 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, slot, true);
  if (authority) {
    out[12] = 1;
    out.set(authority.toBytes(), 13);
  }
  out.set(body, 45);
  return out;
}

describe('loader', () => {
  const id = Keypair.generate().publicKey;
  const authority = Keypair.generate().publicKey;

  it('derives the program-data address like the loader', () => {
    const [expected] = PublicKey.findProgramAddressSync([id.toBuffer()], BPF_LOADER_UPGRADEABLE);
    expect(programDataAddress(id).equals(expected)).toBe(true);
  });

  it('parses Program and ProgramData accounts', () => {
    const pd = programDataAddress(id);
    const program = new Uint8Array(36);
    new DataView(program.buffer).setUint32(0, 2, true);
    program.set(pd.toBytes(), 4);
    expect(parseProgramAccount(program).equals(pd)).toBe(true);
    expect(() => parseProgramAccount(new Uint8Array(36))).toThrow(/Program account/);

    const info = parseProgramData(programData(77n, authority, Uint8Array.from([1, 2, 3])));
    expect(info.slot).toBe(77n);
    expect(info.authority?.equals(authority)).toBe(true);
    expect(Array.from(info.bytes)).toEqual([1, 2, 3]);
    expect(parseProgramData(programData(1n, null, new Uint8Array(1))).authority).toBeNull();
  });

  it('matches a deployed program padded with zeros to max-len, and nothing else', () => {
    const so = Uint8Array.from([9, 8, 7]);
    expect(deployedMatches(Uint8Array.from([9, 8, 7, 0, 0]), so)).toBe(true);
    expect(deployedMatches(Uint8Array.from([9, 8, 7, 0, 1]), so)).toBe(false);
    expect(deployedMatches(Uint8Array.from([9, 8, 6, 0, 0]), so)).toBe(false);
    expect(deployedMatches(Uint8Array.from([9, 8]), so)).toBe(false);
  });

  it('finds the declared id stored as 32 raw bytes', () => {
    const so = new Uint8Array(100);
    so.set(id.toBytes(), 40);
    expect(soDeclaresId(so, id)).toBe(true);
    expect(soDeclaresId(so, authority)).toBe(false);
  });

  it('finds the declared id loaded as four lddw immediates, and not with a word missing', () => {
    const bytes = id.toBytes();
    const lddw = (words: number[]): Uint8Array => {
      const so = new Uint8Array(16 * 8);
      words.forEach((w, k) => {
        const at = 16 * (2 * k + 1); // 8-byte aligned, with unrelated instructions in between
        so[at] = 0x18;
        so.set(bytes.subarray(w * 8, w * 8 + 4), at + 4);
        so.set(bytes.subarray(w * 8 + 4, w * 8 + 8), at + 12);
      });
      return so;
    };
    expect(soDeclaresId(lddw([0, 1, 2, 3]), id)).toBe(true);
    expect(soDeclaresId(lddw([3, 1, 0, 2]), id)).toBe(true);
    expect(soDeclaresId(lddw([0, 1, 2]), id)).toBe(false);
    expect(soDeclaresId(lddw([0, 1, 2, 3]), authority)).toBe(false);
  });
});
