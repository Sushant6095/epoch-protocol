import { addressToBytes, bytesToAddress } from '@epoch/solana';

import { recordedBlocks } from '../__fixtures__/mainnetBlocks';
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  decodeSetComputeUnitPrice,
  isSimpleVote,
  priorityFeeOf,
  VOTE_PROGRAM_ID,
} from './PriorityFee';
import { parseWireTransaction, WireFormatError } from './WireTransaction';

const CB = addressToBytes(COMPUTE_BUDGET_PROGRAM_ID);
const OTHER = addressToBytes('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const PAYER = new Uint8Array(32).fill(7);

const priceIx = (price: bigint) => {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(price, 1);
  return data;
};
const limitIx = (units: number) => {
  const data = Buffer.alloc(5);
  data[0] = 2;
  data.writeUInt32LE(units, 1);
  return data;
};

describe('decodeSetComputeUnitPrice', () => {
  it('reads discriminator 3 and a u64 LE price, nothing else', () => {
    expect(decodeSetComputeUnitPrice(priceIx(12_345n))).toBe(12_345n);
    expect(decodeSetComputeUnitPrice(priceIx(18_446_744_073_709_551_615n))).toBe(18_446_744_073_709_551_615n);
    expect(decodeSetComputeUnitPrice(limitIx(200_000))).toBeNull();
    expect(decodeSetComputeUnitPrice(priceIx(1n).subarray(0, 8))).toBeNull();
  });
});

describe('priorityFeeOf (legacy and v0 messages)', () => {
  const keys = [PAYER, OTHER, CB];
  it('prices a SetComputeUnitPrice invoked from a static key, alongside SetComputeUnitLimit', () => {
    const price = priorityFeeOf({
      accountKeys: keys,
      instructions: [
        { programIdIndex: 2, data: limitIx(300_000) },
        { programIdIndex: 2, data: priceIx(50_000n) },
        { programIdIndex: 1, data: priceIx(9n) },
      ],
    });
    expect(price).toEqual({ cuPrice: 50_000, status: 'priced' });
  });

  it('treats no price, a zero price, a duplicate and malformed data as unpriced', () => {
    const run = (instructions: { programIdIndex: number; data: Uint8Array }[]) =>
      priorityFeeOf({ accountKeys: keys, instructions }).status;
    expect(run([{ programIdIndex: 2, data: limitIx(1) }])).toBe('none');
    expect(run([{ programIdIndex: 2, data: priceIx(0n) }])).toBe('zero');
    expect(
      run([
        { programIdIndex: 2, data: priceIx(5n) },
        { programIdIndex: 2, data: priceIx(6n) },
      ]),
    ).toBe('duplicate');
    expect(run([{ programIdIndex: 2, data: Buffer.from([3, 1, 2]) }])).toBe('malformed');
  });

  it('ignores an instruction whose program index points past the static keys (a lookup-table address)', () => {
    expect(
      priorityFeeOf({ accountKeys: [PAYER, OTHER], instructions: [{ programIdIndex: 5, data: priceIx(99n) }] }),
    ).toEqual({ cuPrice: null, status: 'none' });
  });

  it('caps an absurd price at the largest safe integer', () => {
    expect(
      priorityFeeOf({ accountKeys: keys, instructions: [{ programIdIndex: 2, data: priceIx(2n ** 62n) }] }).cuPrice,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('priorityFeeOf (v1 / SIMD-0385 messages)', () => {
  const v1 = (config: { priorityFeeLamports?: bigint; computeUnitLimit?: number }) =>
    priorityFeeOf({
      accountKeys: [PAYER, CB],
      // Ignored for v1: the runtime reads the budget from the message, never from ComputeBudget instructions.
      instructions: [{ programIdIndex: 1, data: priceIx(1_000_000n) }],
      v1Config: config,
    });

  it('converts the total priority fee to a price per requested CU', () => {
    // 1,408 lamports over 1,000,000 CU = 1,408 µL/CU.
    expect(v1({ priorityFeeLamports: 1_408n, computeUnitLimit: 1_000_000 })).toEqual({
      cuPrice: 1_408,
      status: 'priced',
    });
    expect(v1({ priorityFeeLamports: 100_000n, computeUnitLimit: 3 })).toEqual({
      cuPrice: 33_333_333_333,
      status: 'priced',
    });
  });

  it('has no per-CU price without a fee, with a zero fee or a zero limit, or under 1 µL/CU', () => {
    expect(v1({ computeUnitLimit: 200_000 }).status).toBe('v1-no-fee');
    expect(v1({ priorityFeeLamports: 0n, computeUnitLimit: 200_000 }).status).toBe('zero');
    expect(v1({ priorityFeeLamports: 100_000n }).status).toBe('v1-zero-limit');
    expect(v1({ priorityFeeLamports: 100_000n, computeUnitLimit: 0 }).status).toBe('v1-zero-limit');
    expect(v1({ priorityFeeLamports: 1n, computeUnitLimit: 1_400_000 }).status).toBe('zero');
  });
});

describe('real mainnet transactions (legacy, v0 and v1)', () => {
  const { blocks } = recordedBlocks();

  it('parses every recorded transaction and agrees with the independent decoder on payer, price and version', () => {
    let checked = 0;
    const versions = new Set<string>();
    for (const recorded of blocks) {
      for (const sample of recorded.reference.samples) {
        const entry = recorded.block.transactions[sample.index];
        const view = parseWireTransaction(Buffer.from(entry.transaction[0], 'base64'));
        versions.add(String(view.version));
        expect(view.version).toBe(sample.version);
        expect(bytesToAddress(view.accountKeys[0])).toBe(sample.feePayer);
        const price = priorityFeeOf({
          accountKeys: view.accountKeys,
          instructions: view.instructions,
          v1Config: view.version === 1 ? (view.config ?? {}) : undefined,
        });
        expect(price.cuPrice).toBe(sample.cuPrice !== null && sample.cuPrice > 0 ? sample.cuPrice : null);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect([...versions].sort()).toEqual(['0', '1', 'legacy']);
  });

  it('recognises the simple vote transactions Yellowstone flags as votes', () => {
    const recorded = blocks[0];
    const votes = recorded.block.transactions
      .map((entry) => parseWireTransaction(Buffer.from(entry.transaction[0], 'base64')))
      .filter(isSimpleVote);
    expect(votes).toHaveLength(recorded.reference.simpleVotes);
    expect(bytesToAddress(votes[0].accountKeys[votes[0].instructions[0].programIdIndex])).toBe(VOTE_PROGRAM_ID);
  });

  it('rejects truncated and trailing bytes instead of guessing', () => {
    const raw = Buffer.from(blocks[0].block.transactions[0].transaction[0], 'base64');
    expect(() => parseWireTransaction(raw.subarray(0, raw.length - 1))).toThrow(WireFormatError);
    expect(() => parseWireTransaction(Buffer.concat([raw, Buffer.from([0])]))).toThrow('trailing');
    expect(() => parseWireTransaction(new Uint8Array(0))).toThrow(WireFormatError);
  });
});
