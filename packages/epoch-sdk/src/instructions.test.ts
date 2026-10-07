import { type PublicKey, type TransactionInstruction } from '@solana/web3.js';

import { hex, key, type RustInstruction, sdkEnum, vectors } from './__fixtures__/vectors';
import { type PoolParams } from './accounts';
import { INSTRUCTIONS_SYSVAR_ID, METEORA, NATIVE_MINT, type Side, type Tranche } from './constants';
import { INSTRUCTION_DISCRIMINATORS, INSTRUCTION_NAMES, type InstructionName } from './discriminators';
import {
  accrue,
  addIndexOperator,
  burnLeftover,
  cancelWithdraw,
  castIndexVote,
  claimPartnerMigrationFee,
  claimPartnerSurplus,
  claimPartnerTradingFee,
  claimTreasuryLpFee,
  closeIndexBallot,
  closeRevenueToken,
  configureIndex,
  configureScoring,
  getSfi,
  configureRevenueToken,
  copyPriorityFeeDistribution,
  copyTipDistributionAccount,
  copyVoteAccount,
  deposit,
  executeBuyback,
  finalizeIndex,
  findMeteoraVaultPda,
  initializeIndex,
  initializeIndexOperators,
  initializePool,
  initValidatorHistory,
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
  redeem,
  refreshScore,
  registerRevenueToken,
  releaseValidator,
  removeIndexOperator,
  requestAdvance,
  requestWithdraw,
  resetIndexBallot,
  setCollectors,
  setIndexConsensus,
  setIndexOperatorWeight,
  setPaused,
  setRoles,
  settleSwap,
  solToLamports,
  submitIndexBallot,
  sweep,
  sweepPosition,
  syncRevenueTokenPool,
  updateCommission,
  updateIdentity,
  updateParams,
  updateScore,
  updateStakeInfo,
  vetoIndex,
  withdrawBond,
  withdrawQuote,
} from './instructions';
import {
  findDammPositionNftAccount,
  findFeeIndexPda,
  findIndexBallotPda,
  findIndexOperatorsPda,
  findPoolPda,
  findTreasuryTokensAddress,
} from './pda';

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
const optional = (v: RustInstruction, name: string): PublicKey | null => {
  const value = v.accounts[name];
  return typeof value === 'string' ? key(value) : null;
};
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
      revenueToken: optional(v, 'revenue_token'),
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
      revenueToken: optional(v, 'revenue_token'),
    }),
  update_commission: (v, programId) =>
    updateCommission({
      programId,
      operator: acc(v, 'operator'),
      vote: acc(v, 'vote_account'),
      kind: v.args.kind as number,
      commissionBps: v.args.commission_bps as number,
      revenueToken: optional(v, 'revenue_token'),
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
      // The sole-operator shortcut: the vector appends the registry as remaining_accounts[0].
      soleOperator: typeof v.context.index_operators === 'string',
    }),
  finalize_index: (v, programId) => finalizeIndex({ programId, cranker: acc(v, 'cranker') }),
  veto_index: (v, programId) => vetoIndex({ programId, admin: acc(v, 'admin') }),
  get_sfi: (v, programId) => getSfi({ programId, epoch: big(v.args.epoch) }),
  initialize_index_operators: (v, programId) =>
    initializeIndexOperators({
      programId,
      admin: acc(v, 'admin'),
      thresholdBps: v.args.threshold_bps as number,
      toleranceBps: v.args.tolerance_bps as number,
    }),
  add_index_operator: (v, programId) =>
    addIndexOperator({
      programId,
      admin: acc(v, 'admin'),
      operator: acc(v, 'operator'),
      weight: v.args.weight as number,
    }),
  remove_index_operator: (v, programId) =>
    removeIndexOperator({ programId, admin: acc(v, 'admin'), operator: acc(v, 'operator') }),
  set_index_operator_weight: (v, programId) =>
    setIndexOperatorWeight({
      programId,
      admin: acc(v, 'admin'),
      operator: acc(v, 'operator'),
      weight: v.args.weight as number,
    }),
  set_index_consensus: (v, programId) =>
    setIndexConsensus({
      programId,
      admin: acc(v, 'admin'),
      thresholdBps: v.args.threshold_bps as number,
      toleranceBps: v.args.tolerance_bps as number,
    }),
  cast_index_vote: (v, programId) =>
    castIndexVote({
      programId,
      operator: acc(v, 'operator'),
      payer: acc(v, 'payer'),
      epoch: big(v.args.epoch),
      value: big(v.args.value),
      inputsHash: bytes32(v.args.inputs_hash),
    }),
  submit_index_ballot: (v, programId) =>
    submitIndexBallot({ programId, cranker: acc(v, 'cranker'), epoch: big(v.context.epoch) }),
  reset_index_ballot: (v, programId) =>
    resetIndexBallot({ programId, admin: acc(v, 'admin'), epoch: big(v.context.epoch) }),
  close_index_ballot: (v, programId) =>
    closeIndexBallot({ programId, cranker: acc(v, 'cranker'), epoch: big(v.context.epoch), payer: acc(v, 'payer') }),
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
  register_revenue_token: (v, programId) =>
    registerRevenueToken({
      programId,
      operator: acc(v, 'operator'),
      vote: acc(v, 'vote_account'),
      mint: acc(v, 'mint'),
      dbcPool: acc(v, 'dbc_pool'),
      dbcConfig: acc(v, 'dbc_config'),
      shareBps: v.args.share_bps as number,
      termEpochs: v.args.term_epochs as number,
    }),
  sync_revenue_token_pool: (v, programId) =>
    syncRevenueTokenPool({
      programId,
      cranker: acc(v, 'cranker'),
      vote: ctxKey(v, 'vote'),
      dbcPool: acc(v, 'dbc_pool'),
      dammConfig: acc(v, 'damm_config'),
      dammPool: acc(v, 'damm_pool'),
    }),
  // The Meteora vaults are left to the SDK to derive (`["token_vault", mint, pool]`).
  execute_buyback: (v, programId) =>
    executeBuyback({
      programId,
      cranker: acc(v, 'cranker'),
      vote: ctxKey(v, 'vote'),
      mint: acc(v, 'mint'),
      dbcConfig: acc(v, 'dbc_config'),
      venue: { kind: sdkEnum<'dbc' | 'dammV2'>(v.context.venue), pool: acc(v, 'venue_pool') },
      slice: v.args.slice as number,
      minAmountOut: big(v.args.min_amount_out),
    }),
  redeem: (v, programId) =>
    redeem({
      programId,
      holder: acc(v, 'holder'),
      holderTokens: acc(v, 'holder_tokens'),
      vote: ctxKey(v, 'vote'),
      mint: acc(v, 'mint'),
      treasuryTokens: optional(v, 'treasury_tokens'),
      amount: big(v.args.amount),
    }),
  configure_revenue_token: (v, programId) => {
    const p = v.args.params as Args;
    return configureRevenueToken({
      programId,
      admin: acc(v, 'admin'),
      vote: ctxKey(v, 'vote'),
      params: {
        slicesPerEpoch: p.slices_per_epoch as number,
        windowSlots: p.window_slots as number,
        maxSlippageBps: p.max_slippage_bps as number,
        maxImpactBps: p.max_impact_bps as number,
        flags: p.flags as number,
      },
    });
  },
  close_revenue_token: (v, programId) =>
    closeRevenueToken({
      programId,
      cranker: acc(v, 'cranker'),
      vote: ctxKey(v, 'vote'),
      operator: acc(v, 'operator'),
      mint: acc(v, 'mint'),
    }),
  // Treasury claims: the SDK derives the treasury, its accounts and the Meteora vaults.
  claim_partner_trading_fee: (v, programId) =>
    claimPartnerTradingFee({
      programId,
      cranker: acc(v, 'cranker'),
      dbcPool: acc(v, 'dbc_pool'),
      dbcConfig: acc(v, 'dbc_config'),
      mint: acc(v, 'base_mint'),
    }),
  claim_partner_surplus: (v, programId) =>
    claimPartnerSurplus({
      programId,
      cranker: acc(v, 'cranker'),
      dbcPool: acc(v, 'dbc_pool'),
      dbcConfig: acc(v, 'dbc_config'),
    }),
  claim_partner_migration_fee: (v, programId) =>
    claimPartnerMigrationFee({
      programId,
      cranker: acc(v, 'cranker'),
      dbcPool: acc(v, 'dbc_pool'),
      dbcConfig: acc(v, 'dbc_config'),
    }),
  burn_leftover: (v, programId) =>
    burnLeftover({
      programId,
      cranker: acc(v, 'cranker'),
      dbcPool: acc(v, 'dbc_pool'),
      dbcConfig: acc(v, 'dbc_config'),
      mint: acc(v, 'base_mint'),
    }),
  claim_treasury_lp_fee: (v, programId) =>
    claimTreasuryLpFee({
      programId,
      cranker: acc(v, 'cranker'),
      dammPool: acc(v, 'damm_pool'),
      mint: acc(v, 'token_a_mint'),
      position: acc(v, 'position'),
      nftMint: ctxKey(v, 'nft_mint'),
    }),
  init_validator_history: (v, programId) =>
    initValidatorHistory({ programId, cranker: acc(v, 'payer'), vote: ctxKey(v, 'vote') }),
  copy_vote_account: (v, programId) =>
    copyVoteAccount({ programId, cranker: acc(v, 'cranker'), vote: ctxKey(v, 'vote') }),
  copy_tip_distribution_account: (v, programId) =>
    copyTipDistributionAccount({
      programId,
      cranker: acc(v, 'cranker'),
      vote: ctxKey(v, 'vote'),
      epoch: big(v.args.epoch),
    }),
  copy_priority_fee_distribution: (v, programId) =>
    copyPriorityFeeDistribution({
      programId,
      cranker: acc(v, 'cranker'),
      vote: ctxKey(v, 'vote'),
      epoch: big(v.args.epoch),
    }),
  update_stake_info: (v, programId) =>
    updateStakeInfo({
      programId,
      scorer: acc(v, 'scorer'),
      vote: ctxKey(v, 'vote'),
      info: {
        epoch: big(v.args.epoch),
        activatedStakeLamports: big(v.args.activated_stake_lamports),
        rank: v.args.rank as number,
        superminority: v.args.superminority as boolean,
      },
    }),
  refresh_score: (v, programId) =>
    refreshScore({
      programId,
      cranker: acc(v, 'cranker'),
      vote: ctxKey(v, 'vote'),
      operator: ctxKey(v, 'operator'),
      marketMaker: typeof v.context.market_maker === 'string' ? key(v.context.market_maker) : null,
      currentEpoch: big(v.context.current_epoch),
    }),
  configure_scoring: (v, programId) => {
    const p = v.args.params as Args;
    return configureScoring({
      programId,
      admin: acc(v, 'admin'),
      params: {
        marketMaker: typeof p.market_maker === 'string' ? key(p.market_maker) : null,
        creditsWindowEpochs: p.credits_window_epochs as number,
        countBlockCommission: p.count_block_commission as boolean,
        creditsReferenceBps: p.credits_reference_bps as number,
        maxCopyAgeSlots: p.max_copy_age_slots as number,
      },
    });
  },
};

const metas = (ix: TransactionInstruction) =>
  ix.keys.map((m) => ({ pubkey: m.pubkey.toBase58(), isSigner: m.isSigner, isWritable: m.isWritable }));

/**
 * Anchor's Rust client fills an absent optional account with the compile-time `declare_id!` (the 1111…1111
 * placeholder); the SDK passes the program id it was given, which is what the program compares against. Vectors with
 * a `None` account under another program id differ in exactly those slots (checked in 'optional accounts').
 */
const noneSlots = (v: RustInstruction): number[] =>
  Object.values(v.accounts).flatMap((value, i) => (value === null ? [i] : []));
const exact = vectors.instructions.filter(
  (v) => v.programId === vectors.declaredProgramId || noneSlots(v).length === 0,
);
const withNone = vectors.instructions.filter(
  (v) => v.programId !== vectors.declaredProgramId && noneSlots(v).length > 0,
);

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

  it.each(withNone.map((v) => [`${v.name} (${v.label})`, v] as const))(
    '%s: the program id in every None slot, the Rust metas elsewhere',
    (_label, v) => {
      const [ix] = BUILDERS[v.name as InstructionName](v, key(v.programId));
      expect(hex(ix.data)).toBe(v.data);
      const slots = noneSlots(v);
      const expected = v.metas.map((m, i) => {
        if (!slots.includes(i)) return m;
        expect(m.pubkey).toBe(vectors.declaredProgramId);
        return { pubkey: v.programId, isSigner: false, isWritable: false };
      });
      expect(metas(ix)).toEqual(expected);
    },
  );

  it('covers the revenue-token slots of sweep, release_validator, update_commission and redeem', () => {
    expect(new Set(withNone.map((v) => v.name))).toEqual(
      new Set(['sweep', 'release_validator', 'update_commission', 'redeem']),
    );
  });
});

describe('revenue tokens', () => {
  const sweepSome = vectors.instructions.find((v) => v.name === 'sweep' && v.label === 'advance_some')!;
  const programId = key(sweepSome.programId);

  it('sweep passes the revenue token and its buyback escrow, writable, when the position has one', () => {
    const [ix] = BUILDERS.sweep(sweepSome, programId);
    expect(metas(ix).slice(11)).toEqual([
      { pubkey: sweepSome.accounts.revenue_token, isSigner: false, isWritable: true },
      { pubkey: sweepSome.accounts.buyback_escrow, isSigner: false, isWritable: true },
    ]);
  });

  it('sweepPosition takes payout, advance and revenue token from the decoded position', () => {
    const position = {
      vote: acc(sweepSome, 'vote_account'),
      payout: acc(sweepSome, 'payout'),
      openAdvance: acc(sweepSome, 'advance'),
      revenueToken: acc(sweepSome, 'revenue_token'),
    };
    const [ix] = sweepPosition({ programId, cranker: acc(sweepSome, 'cranker'), position });
    expect(metas(ix)).toEqual(sweepSome.metas);
    const [none] = sweepPosition({ programId, cranker: position.vote, position: { ...position, revenueToken: null } });
    expect(
      metas(none)
        .slice(11)
        .map((m) => m.pubkey),
    ).toEqual([programId.toBase58(), programId.toBase58()]);
  });

  it('derives the Meteora vaults like the mainnet pools hold them', () => {
    // DBC pool 2k7BV8… (mainnet) and the DAMM v2 pool it graduated to, F3s7gr…: vaults read from the accounts.
    const mint = key('3SLNKtp6yyumAcKEZ5SvA92vF76boHQKMnjKqLCiTUNd');
    const dbcPool = key('2k7BV8AJ2SdAVK6ePyCRVre6Y4NuNLQHUiAUgZ8BRwtt');
    const dammPool = key('F3s7grue6Lpi1JKE5CqFv6YGMELFg6KfT2an3XiJsAbe');
    expect(findMeteoraVaultPda(METEORA.DBC_PROGRAM_ID, mint, dbcPool).toBase58()).toBe(
      'HnmJqLkRjdE1nXwtNEMcgV519y3aTcHbBc5krptgY5Vw',
    );
    expect(findMeteoraVaultPda(METEORA.DBC_PROGRAM_ID, NATIVE_MINT, dbcPool).toBase58()).toBe(
      '2ePcacrPfMUNyzfKpddPzZsyE76D64JLnCdVNRn9nHSM',
    );
    expect(findMeteoraVaultPda(METEORA.CP_AMM_PROGRAM_ID, mint, dammPool).toBase58()).toBe(
      'Gt3rHeZgG49ShZj42yDobrncAB5m9hcG5r6WfA8j7Yd3',
    );
    expect(findMeteoraVaultPda(METEORA.CP_AMM_PROGRAM_ID, NATIVE_MINT, dammPool).toBase58()).toBe(
      '5WTdcTpgrDZMBt1DJNzLKQyoEGfacQjSgDgqLRorCYCa',
    );
  });

  it('execute_buyback forwards the instructions sysvar only on request, as the one remaining account', () => {
    const v = vectors.instructions.find((i) => i.name === 'execute_buyback')!;
    const [plain] = BUILDERS.execute_buyback(v, key(v.programId));
    expect(plain.keys).toHaveLength(17);
    const [withSysvar] = executeBuyback({
      programId: key(v.programId),
      cranker: acc(v, 'cranker'),
      vote: ctxKey(v, 'vote'),
      mint: acc(v, 'mint'),
      dbcConfig: acc(v, 'dbc_config'),
      venue: {
        kind: 'dbc',
        pool: acc(v, 'venue_pool'),
        tokenVault: acc(v, 'venue_token_vault'),
        quoteVault: acc(v, 'venue_quote_vault'),
      },
      slice: 0,
      minAmountOut: 1n,
      withInstructionsSysvar: true,
    });
    expect(metas(withSysvar).slice(0, 17)).toEqual(v.metas);
    expect(metas(withSysvar)[17]).toEqual({
      pubkey: INSTRUCTIONS_SYSVAR_ID.toBase58(),
      isSigner: false,
      isWritable: false,
    });
  });

  it('rejects arguments outside their Rust types', () => {
    const k = programId;
    expect(() =>
      registerRevenueToken({
        programId,
        operator: k,
        vote: k,
        mint: k,
        dbcPool: k,
        dbcConfig: k,
        shareBps: 70_000,
        termEpochs: 1,
      }),
    ).toThrow(/shareBps/);
    expect(() =>
      executeBuyback({
        programId,
        cranker: k,
        vote: k,
        mint: k,
        dbcConfig: k,
        venue: { kind: 'dbc', pool: k },
        slice: 256,
        minAmountOut: 1n,
      }),
    ).toThrow(/slice/);
    expect(() =>
      configureRevenueToken({
        programId,
        admin: k,
        vote: k,
        params: { slicesPerEpoch: 12, windowSlots: 2 ** 32, maxSlippageBps: 300, maxImpactBps: 100, flags: 0 },
      }),
    ).toThrow(/windowSlots/);
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

describe('treasury claims', () => {
  const find = (name: InstructionName) => vectors.instructions.find((v) => v.name === name)!;

  it('name the treasury, its one-claim wrapped-SOL account and its associated token account', () => {
    const v = find('claim_partner_trading_fee');
    const programId = key(v.programId);
    expect(findTreasuryTokensAddress(programId, acc(v, 'base_mint')).toBase58()).toBe(v.accounts.treasury_tokens);
    expect(find('burn_leftover').accounts.treasury_tokens).toBe(v.accounts.treasury_tokens);
    expect(find('claim_treasury_lp_fee').accounts.treasury_wsol).toBe(v.accounts.treasury_wsol);
    expect(find('claim_partner_surplus').accounts.treasury).toBe(v.accounts.treasury);
  });

  it('derive the position NFT account from the NFT mint, and take an explicit one', () => {
    const v = find('claim_treasury_lp_fee');
    const nft = findDammPositionNftAccount(ctxKey(v, 'nft_mint'));
    expect(nft.toBase58()).toBe(v.accounts.position_nft_account);
    const [ix] = claimTreasuryLpFee({
      programId: key(v.programId),
      cranker: acc(v, 'cranker'),
      dammPool: acc(v, 'damm_pool'),
      mint: acc(v, 'token_a_mint'),
      position: acc(v, 'position'),
      nftMint: ctxKey(v, 'nft_mint'),
      positionNftAccount: acc(v, 'cranker'),
    });
    expect(ix.keys[8].pubkey.toBase58()).toBe(v.accounts.cranker);
  });

  it('surplus and migration fee share one account list and differ only in the discriminator', () => {
    const surplus = find('claim_partner_surplus');
    const fee = find('claim_partner_migration_fee');
    expect(fee.metas).toEqual(surplus.metas);
    expect(fee.data).not.toBe(surplus.data);
  });
});

describe('Fee Index consensus builders', () => {
  const find = (name: InstructionName, label = 'default') =>
    vectors.instructions.find((v) => v.name === name && v.label === label)!;
  const programId = key(vectors.programId);
  const feeIndex = findFeeIndexPda(programId, findPoolPda(programId)[0])[0];
  const hash = new Uint8Array(32).fill(7);

  it('castIndexVote charges the operator when no payer is given, one key in both signer slots', () => {
    const operator = key(find('cast_index_vote', 'operator_pays').accounts.operator as string);
    const [ix] = castIndexVote({ programId, operator, epoch: 813n, value: 1_000n, inputsHash: hash });
    expect(metas(ix).slice(0, 2)).toEqual([
      { pubkey: operator.toBase58(), isSigner: true, isWritable: true },
      { pubkey: operator.toBase58(), isSigner: true, isWritable: false },
    ]);
    expect(ix.keys[4].pubkey.equals(findIndexBallotPda(programId, feeIndex, 813n)[0])).toBe(true);
  });

  it('postIndex keeps the legacy two accounts unless the signer is the sole operator', () => {
    const v = find('post_index');
    const input = {
      programId,
      publisher: acc(v, 'publisher'),
      epoch: big(v.args.epoch),
      value: big(v.args.value),
      inputsHash: bytes32(v.args.inputs_hash),
    };
    const [legacy] = postIndex(input);
    expect(metas(legacy)).toEqual(v.metas);
    const [sole] = postIndex({ ...input, soleOperator: true });
    expect(hex(sole.data)).toBe(hex(legacy.data));
    expect(metas(sole)).toEqual([
      ...v.metas,
      { pubkey: findIndexOperatorsPda(programId, feeIndex)[0].toBase58(), isSigner: false, isWritable: false },
    ]);
  });

  it('submit, reset and close name the ballot of the epoch they are given', () => {
    const cranker = programId;
    for (const epoch of [0n, 813n, 2n ** 64n - 1n]) {
      const [ballot] = findIndexBallotPda(programId, feeIndex, epoch);
      expect(submitIndexBallot({ programId, cranker, epoch })[0].keys[3].pubkey.equals(ballot)).toBe(true);
      expect(resetIndexBallot({ programId, admin: cranker, epoch })[0].keys[4].pubkey.equals(ballot)).toBe(true);
      const [close] = closeIndexBallot({ programId, cranker, epoch, payer: cranker });
      expect(close.keys[2].pubkey.equals(ballot)).toBe(true);
      expect(close.keys[3]).toEqual({ pubkey: cranker, isSigner: false, isWritable: true });
    }
  });

  it('rejects out-of-range arguments before building', () => {
    expect(() => addIndexOperator({ programId, admin: programId, operator: programId, weight: -1 })).toThrow();
    expect(() => setIndexConsensus({ programId, admin: programId, thresholdBps: 70_000, toleranceBps: 0 })).toThrow();
    expect(() => submitIndexBallot({ programId, cranker: programId, epoch: -1n })).toThrow();
  });
});
