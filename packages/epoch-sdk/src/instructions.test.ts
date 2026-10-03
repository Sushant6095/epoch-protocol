import { type PublicKey, type TransactionInstruction } from '@solana/web3.js';

import { hex, key, type RustInstruction, sdkEnum, vectors } from './__fixtures__/vectors';
import { type PoolParams } from './accounts';
import { type Side, type Tranche } from './constants';
import { INSTRUCTION_DISCRIMINATORS, INSTRUCTION_NAMES, type InstructionName } from './discriminators';
import {
  accrue,
  cancelWithdraw,
  configureIndex,
  deposit,
  finalizeIndex,
  initializeIndex,
  initializePool,
  lamportsToSolString,
  markDefault,
  onboardValidator,
  onboardWithBond,
  openSwap,
  openSwaps,
  postBond,
  postIndex,
  postQuote,
  processWithdrawal,
  releaseValidator,
  requestAdvance,
  requestWithdraw,
  setCollectors,
  setPaused,
  setRoles,
  settleSwap,
  solToLamports,
  sweep,
  updateCommission,
  updateIdentity,
  updateParams,
  updateScore,
  vetoIndex,
  withdrawBond,
  withdrawQuote,
} from './instructions';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

type Args = Record<string, unknown>;

const acc = (v: RustInstruction, name: string): PublicKey => {
  const value = v.accounts[name];
  if (typeof value !== 'string') throw new Error(`${v.name}: no account ${name}`);
  return key(value);
};
const ctxKey = (v: RustInstruction, name: string): PublicKey => key(v.context[name] as string);
const big = (value: unknown): bigint => BigInt(value as string);
const bytes32 = (value: unknown): Uint8Array => new Uint8Array(Buffer.from(value as string, 'hex'));

function poolParams(raw: unknown): PoolParams {
  const p = raw as Args;
  return {
    seniorRateBpsPerEpoch: p.senior_rate_bps_per_epoch as number,
    protocolFeeBps: p.protocol_fee_bps as number,
    advanceBpsUnhedged: p.advance_bps_unhedged as number,
    advanceBpsHedged: p.advance_bps_hedged as number,
    bondMultiplier: p.bond_multiplier as number,
    feeBps: p.fee_bps as number,
    remitBps: p.remit_bps as number,
    minScore: p.min_score as number,
    scoreTtlEpochs: p.score_ttl_epochs as number,
    minAdvanceLamports: big(p.min_advance_lamports),
    maxAdvanceLamports: big(p.max_advance_lamports),
    maxPoolAssets: big(p.max_pool_assets),
    maxUtilizationBps: p.max_utilization_bps as number,
    minJuniorBps: p.min_junior_bps as number,
    juniorLockEpochs: p.junior_lock_epochs as number,
    maxAdvanceEpochs: p.max_advance_epochs as number,
    voteReserveLamports: big(p.vote_reserve_lamports),
    minCommissionBps: p.min_commission_bps as number,
  };
}

/** Rust vector → the SDK call a client would make with the same inputs. */
const BUILDERS: Record<InstructionName, (v: RustInstruction, programId: PublicKey) => TransactionInstruction[]> = {
  initialize_pool: (v, programId) =>
    initializePool({
      programId,
      admin: acc(v, 'admin'),
      treasury: acc(v, 'treasury'),
      scorer: acc(v, 'scorer'),
      params: poolParams(v.args.params),
    }),
  update_params: (v, programId) =>
    updateParams({ programId, admin: acc(v, 'admin'), params: poolParams(v.args.params) }),
  set_paused: (v, programId) => setPaused({ programId, admin: acc(v, 'admin'), paused: v.args.paused as boolean }),
  set_roles: (v, programId) =>
    setRoles({
      programId,
      admin: acc(v, 'admin'),
      treasury: acc(v, 'treasury'),
      scorer: acc(v, 'scorer'),
      newAdmin: acc(v, 'new_admin'),
    }),
  deposit: (v, programId) =>
    deposit({
      programId,
      owner: acc(v, 'owner'),
      tranche: sdkEnum<Tranche>(v.args.tranche),
      lamports: big(v.args.assets),
    }),
  request_withdraw: (v, programId) =>
    requestWithdraw({
      programId,
      owner: acc(v, 'owner'),
      tranche: sdkEnum<Tranche>(v.context.tranche),
      shares: big(v.args.shares),
      withdrawTail: big(v.context.withdraw_tail),
    }),
  cancel_withdraw: (v, programId) =>
    cancelWithdraw({
      programId,
      owner: acc(v, 'owner'),
      tranche: sdkEnum<Tranche>(v.context.tranche),
      seq: big(v.context.seq),
    }),
  process_withdrawal: (v, programId) =>
    processWithdrawal({
      programId,
      cranker: acc(v, 'cranker'),
      owner: acc(v, 'owner'),
      tranche: sdkEnum<Tranche>(v.context.tranche),
      seq: big(v.context.seq),
    }),
  accrue: (v, programId) => accrue({ programId, cranker: acc(v, 'cranker'), treasury: acc(v, 'treasury') }),
  onboard_validator: (v, programId) =>
    onboardValidator({
      programId,
      operator: acc(v, 'operator'),
      currentWithdrawer: acc(v, 'current_withdrawer'),
      vote: acc(v, 'vote_account'),
      payout: acc(v, 'payout'),
    }),
  set_collectors: (v, programId) =>
    setCollectors({ programId, cranker: acc(v, 'cranker'), vote: acc(v, 'vote_account') }),
  update_score: (v, programId) => {
    const u = v.args.update as Args;
    return updateScore({
      programId,
      scorer: acc(v, 'scorer'),
      vote: ctxKey(v, 'vote'),
      update: {
        creditsRatioBps: u.credits_ratio_bps as number,
        commissionBps: u.commission_bps as number,
        epochsActive: u.epochs_active as number,
        delinquent: u.delinquent as boolean,
        superminority: u.superminority as boolean,
        hedged: u.hedged as boolean,
      },
    });
  },
  post_bond: (v, programId) =>
    postBond({ programId, operator: acc(v, 'operator'), vote: ctxKey(v, 'vote'), lamports: big(v.args.lamports) }),
  withdraw_bond: (v, programId) =>
    withdrawBond({ programId, operator: acc(v, 'operator'), vote: ctxKey(v, 'vote'), lamports: big(v.args.lamports) }),
  request_advance: (v, programId) =>
    requestAdvance({
      programId,
      operator: acc(v, 'operator'),
      vote: ctxKey(v, 'vote'),
      payout: acc(v, 'payout'),
      advanceSeq: big(v.context.advance_seq),
      lamports: big(v.args.amount),
    }),
  sweep: (v, programId) =>
    sweep({
      programId,
      cranker: acc(v, 'cranker'),
      vote: acc(v, 'vote_account'),
      payout: acc(v, 'payout'),
      openAdvance: v.accounts.advance ? key(v.accounts.advance) : null,
    }),
  mark_default: (v, programId) =>
    markDefault({ programId, cranker: acc(v, 'cranker'), vote: ctxKey(v, 'vote'), advance: acc(v, 'advance') }),
  release_validator: (v, programId) =>
    releaseValidator({
      programId,
      operator: acc(v, 'operator'),
      vote: acc(v, 'vote_account'),
      newWithdrawer: acc(v, 'new_withdrawer'),
      identity: acc(v, 'identity'),
    }),
  update_commission: (v, programId) =>
    updateCommission({
      programId,
      operator: acc(v, 'operator'),
      vote: acc(v, 'vote_account'),
      kind: v.args.kind as number,
      commissionBps: v.args.commission_bps as number,
    }),
  update_identity: (v, programId) =>
    updateIdentity({
      programId,
      operator: acc(v, 'operator'),
      vote: acc(v, 'vote_account'),
      newIdentity: acc(v, 'new_identity'),
    }),
  initialize_index: (v, programId) =>
    initializeIndex({
      programId,
      admin: acc(v, 'admin'),
      publisher: acc(v, 'publisher'),
      disputeWindowSlots: big(v.args.dispute_window_slots),
      maxMoveBps: v.args.max_move_bps as number,
    }),
  configure_index: (v, programId) =>
    configureIndex({
      programId,
      admin: acc(v, 'admin'),
      publisher: acc(v, 'publisher'),
      disputeWindowSlots: big(v.args.dispute_window_slots),
      maxMoveBps: v.args.max_move_bps as number,
    }),
  post_index: (v, programId) =>
    postIndex({
      programId,
      publisher: acc(v, 'publisher'),
      epoch: big(v.args.epoch),
      value: big(v.args.value),
      inputsHash: bytes32(v.args.inputs_hash),
    }),
  finalize_index: (v, programId) => finalizeIndex({ programId, cranker: acc(v, 'cranker') }),
  veto_index: (v, programId) => vetoIndex({ programId, admin: acc(v, 'admin') }),
  post_quote: (v, programId) =>
    postQuote({
      programId,
      maker: acc(v, 'maker'),
      epoch: big(v.args.epoch),
      fixedRate: big(v.args.fixed_rate),
      maxNotional: big(v.args.max_notional),
      maxMoveBps: v.args.max_move_bps as number,
      expirySlot: big(v.args.expiry_slot),
    }),
  withdraw_quote: (v, programId) => withdrawQuote({ programId, maker: acc(v, 'maker'), epoch: big(v.context.epoch) }),
  open_swap: (v, programId) =>
    openSwap({
      programId,
      taker: acc(v, 'taker'),
      quote: acc(v, 'quote'),
      side: sdkEnum<Side>(v.args.side),
      notionalLamports: big(v.args.notional),
    }),
  settle_swap: (v, programId) =>
    settleSwap({ programId, cranker: acc(v, 'cranker'), quote: acc(v, 'quote'), taker: acc(v, 'taker') }),
};

const metas = (ix: TransactionInstruction) =>
  ix.keys.map((m) => ({ pubkey: m.pubkey.toBase58(), isSigner: m.isSigner, isWritable: m.isWritable }));

const exact = vectors.instructions.filter((v) => !(v.name === 'sweep' && v.label === 'advance_none'));

describe('instruction builders match the program crate byte for byte', () => {
  it('has a vector for every instruction in lib.rs', () => {
    expect(new Set(vectors.instructions.map((v) => v.name))).toEqual(new Set(INSTRUCTION_NAMES));
  });

  it.each(exact.map((v) => [`${v.name} (${v.label})`, v] as const))('%s', (_label, v) => {
    const ixs = BUILDERS[v.name as InstructionName](v, key(v.programId));
    expect(ixs).toHaveLength(1);
    const [ix] = ixs;
    expect(ix.programId.toBase58()).toBe(v.programId);
    expect(hex(ix.data)).toBe(v.data);
    expect(hex(ix.data.subarray(0, 8))).toBe(hex(INSTRUCTION_DISCRIMINATORS[v.name as InstructionName]));
    expect(metas(ix)).toEqual(v.metas);
  });
});

describe('optional accounts', () => {
  const none = vectors.instructions.find((v) => v.name === 'sweep' && v.label === 'advance_none')!;
  const some = vectors.instructions.find((v) => v.name === 'sweep' && v.label === 'advance_some')!;

  it('passes the program ID for an absent advance; Rust clients use the compile-time declare_id! instead', () => {
    const [ix] = BUILDERS.sweep(none, key(none.programId));
    const sdk = metas(ix);
    // The program reads `advance` as None when its key equals the *executing* program id.
    expect(sdk[8]).toEqual({ pubkey: none.programId, isSigner: false, isWritable: false });
    // Anchor's generated Rust client hard-codes `crate::ID` (the 1111…1111 placeholder) in that slot.
    expect(none.metas[8]).toEqual({ pubkey: vectors.declaredProgramId, isSigner: false, isWritable: false });
    // Every other account is identical.
    expect(sdk.filter((_m, i) => i !== 8)).toEqual(none.metas.filter((_m, i) => i !== 8));
  });

  it('marks a present advance writable, like #[account(mut)]', () => {
    const [ix] = BUILDERS.sweep(some, key(some.programId));
    expect(metas(ix)[8]).toEqual({ pubkey: some.accounts.advance, isSigner: false, isWritable: true });
  });
});

describe('multi-instruction helpers', () => {
  const v = vectors.instructions.find((i) => i.name === 'onboard_validator')!;
  const programId = key(v.programId);
  const input = {
    programId,
    operator: acc(v, 'operator'),
    currentWithdrawer: acc(v, 'current_withdrawer'),
    vote: acc(v, 'vote_account'),
    payout: acc(v, 'payout'),
  };

  it('onboardWithBond = [onboard_validator, set_collectors (cranker = operator), post_bond]', () => {
    const ixs = onboardWithBond({ ...input, bondLamports: 5_000_000_000n });
    expect(ixs).toHaveLength(3);
    expect(metas(ixs[0])).toEqual(v.metas);
    expect(hex(ixs[0].data)).toBe(v.data);
    expect(ixs[1]).toEqual(setCollectors({ programId, cranker: input.operator, vote: input.vote })[0]);
    expect(ixs[2]).toEqual(
      postBond({ programId, operator: input.operator, vote: input.vote, lamports: 5_000_000_000n })[0],
    );
    // Only the operator and the current withdrawer sign.
    const signers = new Set(ixs.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())));
    expect(signers).toEqual(new Set([input.operator.toBase58(), input.currentWithdrawer.toBase58()]));
  });

  it('onboardWithBond omits post_bond for a zero bond and set_collectors on request', () => {
    expect(onboardWithBond({ ...input, bondLamports: 0n }).map((ix) => hex(ix.data.subarray(0, 8)))).toEqual([
      hex(INSTRUCTION_DISCRIMINATORS.onboard_validator),
      hex(INSTRUCTION_DISCRIMINATORS.set_collectors),
    ]);
    expect(onboardWithBond({ ...input, bondLamports: 1n, setCollectors: false })).toHaveLength(2);
    expect(() => onboardWithBond({ ...input, bondLamports: -1n })).toThrow(RangeError);
  });

  it('openSwaps = one open_swap per leg, in order', () => {
    const rust = vectors.instructions.filter((i) => i.name === 'open_swap');
    const legs = rust.map((r) => ({
      quote: acc(r, 'quote'),
      side: sdkEnum<Side>(r.args.side),
      notionalLamports: big(r.args.notional),
    }));
    const ixs = openSwaps({ programId: key(rust[0].programId), taker: acc(rust[0], 'taker'), swaps: legs });
    expect(ixs.map((ix) => hex(ix.data))).toEqual(rust.map((r) => r.data));
    expect(ixs.map(metas)).toEqual(rust.map((r) => r.metas));
    expect(openSwaps({ programId, taker: input.operator, swaps: [] })).toEqual([]);
  });
});

describe('argument validation', () => {
  const programId = key(vectors.programId);
  const k = key(vectors.declaredProgramId);

  it('rejects values outside the Rust argument types', () => {
    expect(() => deposit({ programId, owner: k, tranche: 'senior', lamports: -1n })).toThrow(RangeError);
    expect(() => deposit({ programId, owner: k, tranche: 'senior', lamports: 1n << 64n })).toThrow(RangeError);
    expect(() => deposit({ programId, owner: k, tranche: 'senior', lamports: 5 as unknown as bigint })).toThrow(
      TypeError,
    );
    expect(() => deposit({ programId, owner: k, tranche: 'mezzanine' as Tranche, lamports: 1n })).toThrow(/tranche/);
    expect(() => openSwap({ programId, taker: k, quote: k, side: 'long' as Side, notionalLamports: 1n })).toThrow(
      /side/,
    );
    expect(() => postIndex({ programId, publisher: k, epoch: 1n, value: 1n, inputsHash: new Uint8Array(31) })).toThrow(
      /inputsHash/,
    );
    expect(() => updateCommission({ programId, operator: k, vote: k, kind: 256, commissionBps: 1 })).toThrow(/kind/);
    expect(() => updateCommission({ programId, operator: k, vote: k, kind: 0, commissionBps: 70_000 })).toThrow(
      /commissionBps/,
    );
    expect(() => accrue({ programId: 'not a key' as unknown as PublicKey, cranker: k, treasury: k })).toThrow(
      /programId must be a PublicKey/,
    );
  });
});

describe('solToLamports', () => {
  it.each([
    ['0.1', 100_000_000n],
    ['1', 1_000_000_000n],
    ['1.5', 1_500_000_000n],
    ['0.000000001', 1n],
    ['123456789.123456789', 123_456_789_123_456_789n],
    ['.5', 500_000_000n],
    ['5.', 5_000_000_000n],
    ['+2', 2_000_000_000n],
    ['  3.25  ', 3_250_000_000n],
    ['007.000', 7_000_000_000n],
    ['1.000000000000', 1_000_000_000n],
    ['0', 0n],
    ['-0', 0n],
    ['1e-9', 1n],
    ['2.5E3', 2_500_000_000_000n],
    ['18446744073.709551615', 18_446_744_073_709_551_615n],
  ] as const)('%s → %s', (input, expected) => {
    expect(solToLamports(input)).toBe(expected);
  });

  it('converts numbers through their shortest decimal form', () => {
    expect(solToLamports(0.1)).toBe(100_000_000n);
    expect(solToLamports(0.3)).toBe(300_000_000n);
    expect(solToLamports(1e-7)).toBe(100n);
    expect(solToLamports(42)).toBe(42_000_000_000n);
    expect(() => solToLamports(0.1 + 0.2)).toThrow(/more than 9 decimal places/); // 0.30000000000000004
  });

  it('rejects what lamports cannot represent', () => {
    expect(() => solToLamports('0.0000000001')).toThrow(/more than 9 decimal places/);
    expect(() => solToLamports('1.5e-9')).toThrow(/more than 9 decimal places/);
    expect(() => solToLamports('-1')).toThrow(/negative/);
    expect(() => solToLamports('18446744073.709551616')).toThrow(/u64/);
    expect(() => solToLamports('1e400')).toThrow(/u64/);
    expect(() => solToLamports('1e1000000000')).toThrow(/u64/);
    expect(() => solToLamports(Number.NaN)).toThrow(/finite/);
    expect(() => solToLamports(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    for (const bad of ['', '.', 'e5', 'abc', '1,5', '1_000', '0x10', '1.2.3', '--1']) {
      expect(() => solToLamports(bad)).toThrow(/not a decimal number/);
    }
  });

  it('lamportsToSolString is its exact inverse', () => {
    for (const s of ['0', '0.1', '1', '1.5', '0.000000001', '123456789.123456789', '18446744073.709551615']) {
      expect(lamportsToSolString(solToLamports(s))).toBe(s);
    }
    expect(lamportsToSolString(-1_500_000_000n)).toBe('-1.5');
  });
});

describe('TransactionInstruction.data', () => {
  it("is a real Buffer of web3.js's own class, not a view onto shared memory", () => {
    const programId = key(vectors.programId);
    const [a] = finalizeIndex({ programId, cranker: programId });
    const [b] = finalizeIndex({ programId, cranker: programId });
    expect(Buffer.isBuffer(a.data)).toBe(true);
    expect(a.data.toString('hex')).toBe(hex(INSTRUCTION_DISCRIMINATORS.finalize_index));
    a.data[0] ^= 0xff;
    expect(hex(b.data)).toBe(hex(INSTRUCTION_DISCRIMINATORS.finalize_index));
  });
});
