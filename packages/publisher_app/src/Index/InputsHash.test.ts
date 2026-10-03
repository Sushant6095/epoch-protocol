import { createHash } from 'crypto';

import { PublicKey } from '@solana/web3.js';

import { key, slotRows } from '../__fixtures__/fakes';
import { computeInputsHash, INPUTS_HASH_DOMAIN, InputsHasher, sameHash, SLOT_RECORD_SIZE } from './InputsHash';
import { programEpochFor } from './EpochMapping';

/** The documented serialization, written out by hand: anyone can recompute the hash this way. */
function referenceHash(epoch: number, rows: ReturnType<typeof slotRows>): string {
  const parts = [Buffer.from('epoch-fee-index-inputs-v1', 'ascii')];
  const epochBytes = Buffer.alloc(8);
  epochBytes.writeBigUInt64LE(BigInt(epoch));
  parts.push(epochBytes);
  for (const row of rows) {
    const record = Buffer.alloc(52);
    record.writeBigUInt64LE(BigInt(row.slot), 0);
    new PublicKey(row.leader).toBuffer().copy(record, 8);
    record.writeBigUInt64LE(BigInt(row.medianCuPrice), 40);
    record.writeUInt32LE(row.txCount, 48);
    parts.push(record);
  }
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}

describe('inputs hash', () => {
  it('is SHA-256 over the documented canonical serialization', () => {
    expect(INPUTS_HASH_DOMAIN).toHaveLength(25);
    expect(SLOT_RECORD_SIZE).toBe(52);
    const rows = slotRows(1_047, 5);
    expect(Buffer.from(computeInputsHash(1_047, rows)).toString('hex')).toBe(referenceHash(1_047, rows));
  });

  it('is pinned for a fixed input (changing the format must change this test)', () => {
    // Same value as the Python one-liner in the README (leader = 32 bytes of 0x07).
    const rows = [{ slot: 452_304_000, leader: key(7).toBase58(), medianCuPrice: 12_345, txCount: 678 }];
    expect(Buffer.from(computeInputsHash(1_047, rows)).toString('hex')).toBe(
      '7982b9d4b3332e217dd3352d9402554bcbb48da40e4ee5ece4ac6e1a026c8a68',
    );
  });

  it('is the same whatever the batch size, and counts the slots', () => {
    const rows = slotRows(900, 10);
    const hasher = new InputsHasher(900);
    hasher.update(rows.slice(0, 3)).update([]).update(rows.slice(3));
    const { hash, slots } = hasher.digest();
    expect(slots).toBe(10);
    expect(sameHash(hash, computeInputsHash(900, rows))).toBe(true);
  });

  it('commits to the epoch, every field and the order', () => {
    const rows = slotRows(900, 3);
    const base = computeInputsHash(900, rows);
    expect(sameHash(base, computeInputsHash(901, rows))).toBe(false);
    expect(sameHash(base, computeInputsHash(900, [{ ...rows[0], txCount: 1 }, ...rows.slice(1)]))).toBe(false);
    expect(sameHash(base, computeInputsHash(900, rows.slice(1)))).toBe(false);
    expect(() => computeInputsHash(900, [rows[1], rows[0]])).toThrow('ascending');
    expect(() => computeInputsHash(900, [{ ...rows[0], leader: 'not-a-key' }])).toThrow();
  });
});

describe('programEpochFor', () => {
  it('adds the offset, or takes the program cluster epoch − 1 in auto mode', () => {
    expect(programEpochFor(1_047, 0, 1_048n)).toBe(1_047n);
    expect(programEpochFor(1_047, 125, 1_173n)).toBe(1_172n);
    expect(programEpochFor(1_047, -3, 0n)).toBe(1_044n);
    expect(programEpochFor(1_047, 'auto', 1_173n)).toBe(1_172n);
  });
});
