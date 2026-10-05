import { type PublicKey } from '@solana/web3.js';

import { key, type RustPda, sdkEnum, vectors } from './__fixtures__/vectors';
import { type Tranche } from './constants';
import {
  findAdvancePda,
  findBuybackEscrowPda,
  findBuybackTokensPda,
  findBuybackWsolPda,
  findEscrowPda,
  findFeeIndexPda,
  findLenderPda,
  findPartnerTreasuryPda,
  findPoolPda,
  findPositionPda,
  findQuotePda,
  findRevenueTokenPda,
  findSwapPda,
  findTreasuryWsolPda,
  findVaultPda,
  findVoteAuthPda,
  findWithdrawRequestPda,
} from './pda';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

const programId = key(vectors.programId);

function derive(pda: RustPda): [PublicKey, number] {
  const i = pda.inputs;
  switch (pda.kind) {
    case 'pool':
      return findPoolPda(programId);
    case 'vault':
      return findVaultPda(programId, key(i.pool));
    case 'lender':
      return findLenderPda(programId, key(i.pool), key(i.owner), sdkEnum<Tranche>(i.tranche));
    case 'withdraw':
      return findWithdrawRequestPda(programId, key(i.pool), BigInt(i.seq));
    case 'position':
      return findPositionPda(programId, key(i.vote));
    case 'voteAuth':
      return findVoteAuthPda(programId, key(i.vote));
    case 'escrow':
      return findEscrowPda(programId, key(i.vote));
    case 'advance':
      return findAdvancePda(programId, key(i.vote), BigInt(i.seq));
    case 'feeIndex':
      return findFeeIndexPda(programId, key(i.pool));
    case 'quote':
      return findQuotePda(programId, key(i.maker), BigInt(i.epoch));
    case 'swap':
      return findSwapPda(programId, key(i.quote), key(i.taker));
    case 'revenueToken':
      return findRevenueTokenPda(programId, key(i.vote));
    case 'buyback':
      return findBuybackEscrowPda(programId, key(i.vote));
    case 'buybackWsol':
      return findBuybackWsolPda(programId, key(i.vote));
    case 'buybackTokens':
      return findBuybackTokensPda(programId, key(i.vote));
    case 'partnerTreasury':
      return findPartnerTreasuryPda(programId, key(i.pool));
    case 'treasuryWsol':
      return findTreasuryWsolPda(programId, key(i.pool));
    default:
      throw new Error(`unknown PDA kind ${pda.kind}`);
  }
}

describe('PDAs match Pubkey::find_program_address in the program crate', () => {
  it('covers every seed scheme', () => {
    expect(new Set(vectors.pdas.map((p) => p.kind))).toEqual(
      new Set([
        'pool',
        'vault',
        'lender',
        'withdraw',
        'position',
        'voteAuth',
        'escrow',
        'advance',
        'feeIndex',
        'quote',
        'swap',
        'revenueToken',
        'buyback',
        'buybackWsol',
        'buybackTokens',
        'partnerTreasury',
        'treasuryWsol',
      ]),
    );
  });

  it.each(vectors.pdas.map((p) => [`${p.kind} ${JSON.stringify(p.inputs)}`, p] as const))('%s', (_label, pda) => {
    const [address, bump] = derive(pda);
    expect(address.toBase58()).toBe(pda.address);
    expect(bump).toBe(pda.bump);
  });
});

describe('PDA inputs', () => {
  const pool = findPoolPda(programId)[0];
  const vote = key(vectors.pdas.find((p) => p.kind === 'position')!.inputs.vote);

  it('accepts safe-integer numbers and bigints for u64 seeds alike', () => {
    expect(findWithdrawRequestPda(programId, pool, 256)).toEqual(findWithdrawRequestPda(programId, pool, 256n));
    expect(findAdvancePda(programId, vote, 9)).toEqual(findAdvancePda(programId, vote, 9n));
    expect(findQuotePda(programId, vote, 813)).toEqual(findQuotePda(programId, vote, 813n));
  });

  it('rejects invalid tranches and u64 seeds', () => {
    expect(() => findLenderPda(programId, pool, vote, 'mezzanine' as Tranche)).toThrow(/Invalid tranche/);
    expect(() => findWithdrawRequestPda(programId, pool, -1n)).toThrow(RangeError);
    expect(() => findAdvancePda(programId, vote, 2 ** 64)).toThrow(RangeError);
    expect(() => findQuotePda(programId, vote, 1n << 64n)).toThrow(RangeError);
  });

  it('separates the tranches and programs', () => {
    expect(
      findLenderPda(programId, pool, vote, 'senior')[0].equals(findLenderPda(programId, pool, vote, 'junior')[0]),
    ).toBe(false);
    expect(findPoolPda(programId)[0].equals(findPoolPda(key(vectors.declaredProgramId))[0])).toBe(false);
  });
});
