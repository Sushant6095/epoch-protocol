/**
 * Borsh encoders for the accounts the client tests read, written field for field from `programs/epoch/src/state/*`
 * (the inverse of epoch-sdk's decoders, which are verified byte for byte against the program). Each account is
 * written into its full on-chain allocation (`ACCOUNT_SIZES`), discriminator first.
 */
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_SIZES,
  type AccountName,
  ADVANCE_STATES,
  type AdvanceAccount,
  type FeeIndexAccount,
  type PoolAccount,
  POSITION_STATUSES,
  SIDES,
  type SwapPositionAccount,
  TRANCHES,
  type ValidatorPositionAccount,
  type WithdrawRequestAccount,
} from '@epoch/epoch-sdk';
import { type PublicKey } from '@solana/web3.js';

class Writer {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private at = 0;
  constructor(name: AccountName) {
    this.bytes = new Uint8Array(ACCOUNT_SIZES[name]);
    this.view = new DataView(this.bytes.buffer);
    this.raw(ACCOUNT_DISCRIMINATORS[name]);
  }
  raw(data: Uint8Array): this {
    this.bytes.set(data, this.at);
    this.at += data.length;
    return this;
  }
  u8(v: number): this {
    this.view.setUint8(this.at, v);
    this.at += 1;
    return this;
  }
  u16(v: number): this {
    this.view.setUint16(this.at, v, true);
    this.at += 2;
    return this;
  }
  u32(v: number): this {
    this.view.setUint32(this.at, v, true);
    this.at += 4;
    return this;
  }
  u64(v: bigint): this {
    this.view.setBigUint64(this.at, v, true);
    this.at += 8;
    return this;
  }
  i64(v: bigint): this {
    this.view.setBigInt64(this.at, v, true);
    this.at += 8;
    return this;
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  key(k: PublicKey): this {
    return this.raw(k.toBytes());
  }
}

export function encodePool(p: PoolAccount): Uint8Array {
  const w = new Writer('Pool').key(p.admin).key(p.treasury).key(p.scorer);
  const q = p.params;
  w.u16(q.seniorRateBpsPerEpoch).u16(q.protocolFeeBps).u16(q.advanceBpsUnhedged).u16(q.advanceBpsHedged);
  w.u8(q.bondMultiplier).u16(q.feeBps).u16(q.remitBps).u16(q.minScore).u16(q.scoreTtlEpochs);
  w.u64(q.minAdvanceLamports).u64(q.maxAdvanceLamports).u64(q.maxPoolAssets);
  w.u16(q.maxUtilizationBps).u16(q.minJuniorBps).u16(q.juniorLockEpochs).u16(q.maxAdvanceEpochs);
  w.u64(q.voteReserveLamports).u16(q.minCommissionBps);
  w.u8(p.bump).u8(p.vaultBump).bool(p.paused);
  w.u64(p.cash).u64(p.outstandingPrincipal).u64(p.expectedFees).u64(p.incomeUnallocated).u64(p.bondTotal);
  w.u64(p.seniorAssets).u64(p.seniorShares).u64(p.juniorAssets).u64(p.juniorShares);
  w.u64(p.seniorPendingShares).u64(p.juniorPendingShares).u64(p.withdrawHead).u64(p.withdrawTail);
  w.u64(p.lastAccruedEpoch).u32(p.validators).u32(p.openAdvances);
  w.u64(p.totalAdvanced).u64(p.totalRepaid).u64(p.totalDefaulted);
  return w.bytes;
}

export function encodeValidatorPosition(p: ValidatorPositionAccount): Uint8Array {
  const w = new Writer('ValidatorPosition');
  w.key(p.pool).key(p.vote).key(p.identity).key(p.operator).key(p.payout).key(p.originalWithdrawer);
  w.u8(p.bump).u8(p.voteAuthBump).u8(p.escrowBump).u8(POSITION_STATUSES.indexOf(p.status)).bool(p.hedged);
  w.u16(p.score).u64(p.lastScoredEpoch);
  p.revenue.forEach((r) => w.u64(r));
  w.u8(p.revenueHead).u8(p.revenueCount).u64(p.lastSweptEpoch).u64(p.totalSwept).u64(p.totalRemitted);
  w.u64(p.bondLamports);
  if (p.openAdvance) w.u8(1).key(p.openAdvance);
  else w.u8(0);
  w.u64(p.advanceSeq).u8(p.lateEpochs).u16(p.inflationCommissionBps).u16(p.blockCommissionBps).u64(p.onboardedEpoch);
  return w.bytes;
}

export function encodeAdvance(a: AdvanceAccount): Uint8Array {
  const w = new Writer('Advance').key(a.pool).key(a.vote).key(a.position);
  w.u64(a.seq).u64(a.principal).u64(a.fee).u64(a.totalDue).u64(a.repaid).u64(a.principalRepaid).u64(a.feeRepaid);
  w.u16(a.remitBps).u64(a.openedEpoch).u64(a.closedEpoch).u8(ADVANCE_STATES.indexOf(a.state)).u8(a.bump);
  return w.bytes;
}

export function encodeFeeIndex(f: FeeIndexAccount): Uint8Array {
  const w = new Writer('FeeIndex').key(f.pool).key(f.publisher).u8(f.bump);
  w.u64(f.epoch).u64(f.value).raw(f.inputsHash).u64(f.finalizedSlot);
  w.bool(f.hasProposal).u64(f.proposedEpoch).u64(f.proposedValue).raw(f.proposedInputsHash).u64(f.proposedSlot);
  w.u64(f.disputeWindowSlots).u16(f.maxMoveBps);
  f.history.forEach((p) => w.u64(p.epoch).u64(p.value));
  w.u8(f.historyHead).u8(f.historyCount);
  return w.bytes;
}

export function encodeWithdrawRequest(r: WithdrawRequestAccount): Uint8Array {
  const w = new Writer('WithdrawRequest').key(r.pool).key(r.owner).u8(TRANCHES.indexOf(r.tranche));
  w.u64(r.shares).u64(r.seq).u64(r.requestedEpoch).bool(r.cancelled).u8(r.bump);
  return w.bytes;
}

export function encodeSwapPosition(s: SwapPositionAccount): Uint8Array {
  const w = new Writer('SwapPosition').key(s.quote).key(s.taker).u64(s.epoch).u8(SIDES.indexOf(s.side));
  w.u64(s.notional).u64(s.fixedRate).u16(s.maxMoveBps).u64(s.collateral).bool(s.settled).i64(s.pnl).u8(s.bump);
  return w.bytes;
}
