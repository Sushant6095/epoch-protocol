/**
 * What a launch's parties can claim, and the transactions that claim it (ADR 0006, plan F13):
 *
 * - **Partner (Epoch's treasury, the DBC fee claimer):** the curve's trading fees, its share of any surplus over the
 *   raise, its share of the migration fee (0 in Epoch's preset), and the fees of the DAMM v2 LP position it holds
 *   permanently locked after graduation.
 * - **Creator (the validator):** the migration fee (70% of the raise: the upfront SOL), its share of the surplus and of
 *   the trading fees (0 in the preset), and the fees of any DAMM v2 position it holds.
 * - **Leftover receiver:** the supply the curve did not use, after graduation (permissionless to trigger).
 *
 * Amounts follow the DBC program's own arithmetic (`state/config.rs`, `state/virtual_pool.rs`): migration fee =
 * threshold − ⌈threshold × (100 − fee%) ÷ 100⌉, creator part ⌊fee × creator% ÷ 100⌋; surplus = quote reserve −
 * threshold, of which 80% goes to partner and creator (split like trading fees) and 20% to the protocol; leftover = base
 * vault − base fees − the protocol's migration fee in tokens. Each one-shot withdrawal is flagged on the pool, so a
 * claim never pays twice.
 */
import {
  derivePositionNftAccount,
  getTokenProgram as getDammTokenProgram,
  getUnClaimLpFee,
  type PoolState as DammPoolAccount,
  type PositionState,
} from '@meteora-ag/cp-amm-sdk';
import { type PoolConfig, type VirtualPool } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { type Connection, PublicKey, type Transaction } from '@solana/web3.js';
import BN from 'bn.js';

import { NATIVE_MINT, SOL_DECIMALS } from './constants';
import { cpAmmClient, dbcClient, graduatedDammPool, readCurveAccounts, readDammPoolAccount } from './pools';
import { fromBaseUnits, toBigInt } from './units';

export type ClaimKind =
  | 'partnerTradingFee'
  | 'creatorTradingFee'
  | 'partnerMigrationFee'
  | 'creatorMigrationFee'
  | 'partnerSurplus'
  | 'creatorSurplus'
  | 'leftover'
  | 'lpFee';

/** DBC `migration_fee_withdraw_status` bits (`state/virtual_pool.rs`). */
export const PARTNER_MIGRATION_FEE_MASK = 0b100;
export const CREATOR_MIGRATION_FEE_MASK = 0b010;
/** Share of a surplus that goes to partner and creator; the rest is the protocol's (`constants.rs`). */
export const PARTNER_AND_CREATOR_SURPLUS_SHARE = 80;
/** DBC `MigrationProgress::CreatedPool`: the DAMM v2 pool exists. */
const CREATED_POOL = 3;
const U64_MAX = new BN('18446744073709551615');

/** One thing someone can claim from a launch. */
export interface ClaimableItem {
  kind: ClaimKind;
  /** Who must sign the claim; null when anyone can trigger it (the leftover). */
  signer: string | null;
  /** Where the funds go. */
  receiver: string;
  /** Claimable now, base units (lamports for SOL). */
  lamports: bigint;
  tokens: bigint;
  /** Claimable now: preconditions met, not withdrawn yet, and more than zero. */
  available: boolean;
  /** A one-shot withdrawal that already happened (migration fee, surplus, leftover). */
  withdrawn: boolean;
  /** Why it is not available yet, when it is not. */
  reason: string | null;
  /** The DAMM v2 position, for `lpFee`. */
  position?: string;
}

/** A DAMM v2 position on the graduated pool. */
export interface DammPositionClaim {
  position: string;
  nftMint: string;
  /** The wallet holding the position NFT (null when the NFT account could not be read). */
  owner: string | null;
  /** fee claimer / pool creator / anyone else. */
  role: 'partner' | 'creator' | 'other';
  /** Liquidity units (u128 as decimal strings). */
  permanentLockedLiquidity: string;
  unlockedLiquidity: string;
  vestedLiquidity: string;
  /** Permanently locked share of this position's liquidity, %. */
  lockedPct: number;
  /** Fees claimable now (base units). */
  unclaimedLamports: bigint;
  unclaimedTokens: bigint;
  /** Fees claimed so far (base units). */
  claimedLamports: bigint;
  claimedTokens: bigint;
}

/** Everything claimable from one launch, in base units, with UI totals for the page. */
export interface LaunchClaimsState {
  dbcPool: string;
  config: string;
  partner: string;
  creator: string;
  leftoverReceiver: string;
  baseDecimals: number;
  curveComplete: boolean;
  migrated: boolean;
  dammPool: string | null;
  tradingFees: {
    partner: { totalLamports: bigint; claimedLamports: bigint; unclaimedLamports: bigint };
    creator: { totalLamports: bigint; claimedLamports: bigint; unclaimedLamports: bigint };
  };
  migrationFee: {
    totalLamports: bigint;
    partner: { lamports: bigint; withdrawn: boolean };
    creator: { lamports: bigint; withdrawn: boolean };
  };
  surplus: {
    totalLamports: bigint;
    partner: { lamports: bigint; withdrawn: boolean };
    creator: { lamports: bigint; withdrawn: boolean };
    protocol: { lamports: bigint; withdrawn: boolean };
  };
  leftover: { tokens: bigint; withdrawn: boolean };
  positions: DammPositionClaim[];
  /** Every claim, available or not. */
  items: ClaimableItem[];
}

/** The DBC program's migration fee split for a config (exact). */
export function migrationFeeSplit(config: {
  migrationQuoteThreshold: bigint | BN;
  migrationFeePercentage: number;
  creatorMigrationFeePercentage: number;
}): { total: bigint; partner: bigint; creator: bigint } {
  const threshold = toBigInt(config.migrationQuoteThreshold);
  const quoteAmount = (threshold * BigInt(100 - config.migrationFeePercentage) + 99n) / 100n;
  const total = threshold - quoteAmount;
  const creator = (total * BigInt(config.creatorMigrationFeePercentage)) / 100n;
  return { total, partner: total - creator, creator };
}

/** The DBC program's surplus split (exact): 80% to partner and creator, split like trading fees, the rest to the protocol. */
export function surplusSplit(
  quoteReserve: bigint,
  threshold: bigint,
  creatorTradingFeePercentage: number,
): { total: bigint; partner: bigint; creator: bigint; protocol: bigint } {
  const total = quoteReserve > threshold ? quoteReserve - threshold : 0n;
  const shared = (total * BigInt(PARTNER_AND_CREATOR_SURPLUS_SHARE)) / 100n;
  const creator = creatorTradingFeePercentage === 0 ? 0n : (shared * BigInt(creatorTradingFeePercentage)) / 100n;
  return { total, partner: shared - creator, creator, protocol: total - shared };
}

const item = (
  kind: ClaimKind,
  signer: string | null,
  receiver: string,
  amounts: { lamports?: bigint; tokens?: bigint },
  state: { ready: boolean; withdrawn?: boolean; notReady?: string },
): ClaimableItem => {
  const lamports = amounts.lamports ?? 0n;
  const tokens = amounts.tokens ?? 0n;
  const withdrawn = state.withdrawn ?? false;
  const positive = lamports > 0n || tokens > 0n;
  const reason = withdrawn
    ? 'already withdrawn'
    : !state.ready
      ? (state.notReady ?? 'not available yet')
      : positive
        ? null
        : 'nothing to claim';
  return { kind, signer, receiver, lamports, tokens, available: reason === null, withdrawn, reason };
};

/**
 * The claims of a launch from its DBC pool and config (pure). `baseVaultAmount` (the curve's token vault balance)
 * prices the leftover; pass the DAMM v2 positions read for the graduated pool.
 */
export function launchClaimsFromState(input: {
  dbcPool: string;
  pool: VirtualPool;
  config: PoolConfig;
  baseVaultAmount: bigint | null;
  dammPool?: string | null;
  positions?: DammPositionClaim[];
}): LaunchClaimsState {
  const { pool, config } = input;
  const state = pool.poolState;
  const partner = config.feeClaimer.toBase58();
  const creator = state.creator.toBase58();
  const leftoverReceiver = config.leftoverReceiver.toBase58();
  const threshold = toBigInt(config.migrationQuoteThreshold);
  const quoteReserve = toBigInt(state.quoteReserve);
  const migrated = state.isMigrated === 1;
  const curveComplete = migrated || (threshold > 0n && quoteReserve >= threshold);

  const totalTradingQuote = toBigInt(state.metrics.totalTradingQuoteFee);
  const creatorTotal = (totalTradingQuote * BigInt(config.creatorTradingFeePercentage)) / 100n;
  const partnerTotal = totalTradingQuote - creatorTotal;
  const partnerUnclaimed = toBigInt(state.partnerQuoteFee);
  const creatorUnclaimed = toBigInt(state.creatorQuoteFee);

  const fee = migrationFeeSplit(config);
  const status = state.migrationFeeWithdrawStatus;
  const partnerFeeWithdrawn = (status & PARTNER_MIGRATION_FEE_MASK) !== 0;
  const creatorFeeWithdrawn = (status & CREATOR_MIGRATION_FEE_MASK) !== 0;

  const surplus = curveComplete
    ? surplusSplit(quoteReserve, threshold, config.creatorTradingFeePercentage)
    : { total: 0n, partner: 0n, creator: 0n, protocol: 0n };

  const fixedSupply = config.fixedTokenSupplyFlag === 1;
  const leftoverWithdrawn = state.isWithdrawLeftover === 1;
  const baseFees = toBigInt(state.protocolBaseFee) + toBigInt(state.partnerBaseFee) + toBigInt(state.creatorBaseFee);
  const leftoverTokens =
    input.baseVaultAmount === null || leftoverWithdrawn || state.migrationProgress !== CREATED_POOL
      ? 0n
      : input.baseVaultAmount - baseFees - toBigInt(state.protocolMigrationBaseFeeAmount);

  const notComplete = 'the curve is not complete yet';
  const items: ClaimableItem[] = [
    item(
      'partnerTradingFee',
      partner,
      partner,
      { lamports: partnerUnclaimed, tokens: toBigInt(state.partnerBaseFee) },
      {
        ready: true,
      },
    ),
    item(
      'creatorTradingFee',
      creator,
      creator,
      { lamports: creatorUnclaimed, tokens: toBigInt(state.creatorBaseFee) },
      {
        ready: true,
      },
    ),
    item(
      'partnerMigrationFee',
      partner,
      partner,
      { lamports: fee.partner },
      {
        ready: curveComplete,
        withdrawn: partnerFeeWithdrawn,
        notReady: notComplete,
      },
    ),
    item(
      'creatorMigrationFee',
      creator,
      creator,
      { lamports: fee.creator },
      {
        ready: curveComplete,
        withdrawn: creatorFeeWithdrawn,
        notReady: notComplete,
      },
    ),
    item(
      'partnerSurplus',
      partner,
      partner,
      { lamports: surplus.partner },
      {
        ready: curveComplete,
        withdrawn: state.isPartnerWithdrawSurplus === 1,
        notReady: notComplete,
      },
    ),
    item(
      'creatorSurplus',
      creator,
      creator,
      { lamports: surplus.creator },
      {
        ready: curveComplete,
        withdrawn: state.isCreatorWithdrawSurplus === 1,
        notReady: notComplete,
      },
    ),
    item(
      'leftover',
      null,
      leftoverReceiver,
      { tokens: leftoverTokens < 0n ? 0n : leftoverTokens },
      {
        ready: fixedSupply && state.migrationProgress === CREATED_POOL && input.baseVaultAmount !== null,
        withdrawn: leftoverWithdrawn,
        notReady: !fixedSupply ? 'not a fixed-supply launch' : 'the token has not graduated yet',
      },
    ),
  ];
  for (const position of input.positions ?? []) {
    items.push({
      ...item(
        'lpFee',
        position.owner,
        position.owner ?? '',
        { lamports: position.unclaimedLamports, tokens: position.unclaimedTokens },
        { ready: position.owner !== null, notReady: 'the position owner is unknown' },
      ),
      position: position.position,
    });
  }

  return {
    dbcPool: input.dbcPool,
    config: state.config.toBase58(),
    partner,
    creator,
    leftoverReceiver,
    baseDecimals: config.tokenDecimal,
    curveComplete,
    migrated,
    dammPool: input.dammPool ?? null,
    tradingFees: {
      partner: {
        totalLamports: partnerTotal,
        claimedLamports: partnerTotal > partnerUnclaimed ? partnerTotal - partnerUnclaimed : 0n,
        unclaimedLamports: partnerUnclaimed,
      },
      creator: {
        totalLamports: creatorTotal,
        claimedLamports: creatorTotal > creatorUnclaimed ? creatorTotal - creatorUnclaimed : 0n,
        unclaimedLamports: creatorUnclaimed,
      },
    },
    migrationFee: {
      totalLamports: fee.total,
      partner: { lamports: fee.partner, withdrawn: partnerFeeWithdrawn },
      creator: { lamports: fee.creator, withdrawn: creatorFeeWithdrawn },
    },
    surplus: {
      totalLamports: surplus.total,
      partner: { lamports: surplus.partner, withdrawn: state.isPartnerWithdrawSurplus === 1 },
      creator: { lamports: surplus.creator, withdrawn: state.isCreatorWithdrawSurplus === 1 },
      protocol: { lamports: surplus.protocol, withdrawn: state.isProtocolWithdrawSurplus === 1 },
    },
    leftover: { tokens: leftoverTokens < 0n ? 0n : leftoverTokens, withdrawn: leftoverWithdrawn },
    positions: input.positions ?? [],
    items,
  };
}

/** A DAMM v2 position's claim view (pure): owner role, liquidity split, fees in SOL and tokens. */
export function dammPositionClaim(input: {
  position: PublicKey;
  state: PositionState;
  pool: DammPoolAccount;
  owner: string | null;
  partner: string;
  creator: string;
  /** The revenue token is the pool's token A (true for DBC graduations). */
  baseIsTokenA: boolean;
}): DammPositionClaim {
  const { state, pool, owner } = input;
  const unclaimed = getUnClaimLpFee(pool, state);
  const [unclaimedTokens, unclaimedLamports] = input.baseIsTokenA
    ? [toBigInt(unclaimed.feeTokenA), toBigInt(unclaimed.feeTokenB)]
    : [toBigInt(unclaimed.feeTokenB), toBigInt(unclaimed.feeTokenA)];
  const [claimedTokens, claimedLamports] = input.baseIsTokenA
    ? [toBigInt(state.metrics.totalClaimedAFee), toBigInt(state.metrics.totalClaimedBFee)]
    : [toBigInt(state.metrics.totalClaimedBFee), toBigInt(state.metrics.totalClaimedAFee)];
  const locked = toBigInt(state.permanentLockedLiquidity);
  const total = locked + toBigInt(state.unlockedLiquidity) + toBigInt(state.vestedLiquidity);
  return {
    position: input.position.toBase58(),
    nftMint: state.nftMint.toBase58(),
    owner,
    role: owner === input.partner ? 'partner' : owner === input.creator ? 'creator' : 'other',
    permanentLockedLiquidity: locked.toString(),
    unlockedLiquidity: toBigInt(state.unlockedLiquidity).toString(),
    vestedLiquidity: toBigInt(state.vestedLiquidity).toString(),
    lockedPct: total === 0n ? 0 : Number((locked * 1_000_000n) / total) / 10_000,
    unclaimedLamports,
    unclaimedTokens,
    claimedLamports,
    claimedTokens,
  };
}

const ownerOfTokenAccount = (data: Uint8Array): string => new PublicKey(data.subarray(32, 64)).toBase58();

/** Every position on a DAMM v2 pool with its owner (one getProgramAccounts on the pool, one read of the NFT accounts). */
export async function readDammPositions(params: {
  connection: Connection;
  pool: PublicKey | string;
  partner: string;
  creator: string;
  baseMint: PublicKey | string;
}): Promise<DammPositionClaim[]> {
  const { connection } = params;
  const pool = new PublicKey(params.pool);
  const poolState = await readDammPoolAccount(connection, pool);
  if (!poolState) return [];
  const positions = await cpAmmClient(connection).getAllPositionsByPool(pool);
  if (positions.length === 0) return [];
  const nftAccounts = positions.map(({ account }) => derivePositionNftAccount(account.nftMint));
  const infos = await connection.getMultipleAccountsInfo(nftAccounts, 'confirmed');
  const baseIsTokenA = poolState.tokenAMint.equals(new PublicKey(params.baseMint));
  return positions.map(({ publicKey, account }, i) =>
    dammPositionClaim({
      position: publicKey,
      state: account,
      pool: poolState,
      owner: infos[i] ? ownerOfTokenAccount(infos[i]!.data) : null,
      partner: params.partner,
      creator: params.creator,
      baseIsTokenA,
    }),
  );
}

/**
 * Reads everything claimable from a launch: the DBC pool and config, the curve's token vault, and after graduation the
 * DAMM v2 pool's positions. Null when the DBC pool does not exist.
 */
export async function readLaunchClaims(params: {
  connection: Connection;
  dbcPool: PublicKey | string;
  dbcConfig?: PublicKey | string | null;
  /** The DAMM v2 pool; derived from the curve when omitted. */
  dammPool?: PublicKey | string | null;
}): Promise<LaunchClaimsState | null> {
  const { connection } = params;
  const accounts = await readCurveAccounts(connection, params.dbcPool, params.dbcConfig);
  if (!accounts) return null;
  const { address, pool, config } = accounts;
  const vault = await connection.getAccountInfo(pool.poolState.baseVault, 'confirmed');
  const baseVaultAmount = vault
    ? new DataView(vault.data.buffer, vault.data.byteOffset, vault.data.byteLength).getBigUint64(64, true)
    : null;
  const damm = params.dammPool ? new PublicKey(params.dammPool) : graduatedDammPool(pool, config);
  const positions =
    damm && pool.poolState.isMigrated === 1
      ? await readDammPositions({
          connection,
          pool: damm,
          partner: config.feeClaimer.toBase58(),
          creator: pool.poolState.creator.toBase58(),
          baseMint: pool.poolState.baseMint,
        })
      : [];
  return launchClaimsFromState({
    dbcPool: address.toBase58(),
    pool,
    config,
    baseVaultAmount,
    dammPool: damm?.toBase58() ?? null,
    positions,
  });
}

/** UI amounts of a claim item (SOL and tokens). */
export const claimAmountsUi = (claim: ClaimableItem, baseDecimals: number): { sol: number; tokens: number } => ({
  sol: fromBaseUnits(claim.lamports, SOL_DECIMALS),
  tokens: fromBaseUnits(claim.tokens, baseDecimals),
});

/**
 * The unsigned transaction for one claim. `signer` must be the claim's signer (fee claimer, creator or position owner);
 * `payer` pays the fee and any account rent (default: the signer). SOL arrives unwrapped in the signer's wallet (the
 * leftover goes to the leftover receiver's token account). Blockhash and fee payer are set.
 */
export async function buildClaimTx(params: {
  connection: Connection;
  claim: ClaimableItem;
  dbcPool: PublicKey | string;
  /** The DAMM v2 pool, for `lpFee`. */
  dammPool?: PublicKey | string | null;
  signer: PublicKey;
  payer?: PublicKey;
}): Promise<Transaction> {
  const { connection, claim, signer } = params;
  const payer = params.payer ?? signer;
  const pool = new PublicKey(params.dbcPool);
  const dbc = dbcClient(connection);
  let tx: Transaction;
  switch (claim.kind) {
    case 'partnerTradingFee':
      tx = await dbc.partner.claimPartnerTradingFee({
        feeClaimer: signer,
        payer,
        pool,
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
      });
      break;
    case 'creatorTradingFee':
      tx = await dbc.creator.claimCreatorTradingFee({
        creator: signer,
        payer,
        pool,
        maxBaseAmount: U64_MAX,
        maxQuoteAmount: U64_MAX,
      });
      break;
    case 'partnerMigrationFee':
      tx = await dbc.partner.partnerWithdrawMigrationFee({ pool, sender: signer });
      break;
    case 'creatorMigrationFee':
      tx = await dbc.creator.creatorWithdrawMigrationFee({ pool, sender: signer });
      break;
    case 'partnerSurplus':
      tx = await dbc.partner.partnerWithdrawSurplus({ feeClaimer: signer, pool });
      break;
    case 'creatorSurplus':
      tx = await dbc.creator.creatorWithdrawSurplus({ creator: signer, pool });
      break;
    case 'leftover':
      tx = await dbc.migration.withdrawLeftover({ payer, pool });
      break;
    case 'lpFee': {
      if (!claim.position || !params.dammPool)
        throw new Error('an LP fee claim needs the position and the DAMM v2 pool');
      const dammPool = new PublicKey(params.dammPool);
      const state = await readDammPoolAccount(connection, dammPool);
      if (!state) throw new Error(`DAMM v2 pool ${dammPool.toBase58()} not found`);
      const client = cpAmmClient(connection);
      const position = new PublicKey(claim.position);
      const positionState = await client.fetchPositionState(position);
      tx = await client.claimPositionFee({
        owner: signer,
        position,
        pool: dammPool,
        positionNftAccount: derivePositionNftAccount(positionState.nftMint),
        tokenAMint: state.tokenAMint,
        tokenBMint: state.tokenBMint,
        tokenAVault: state.tokenAVault,
        tokenBVault: state.tokenBVault,
        tokenAProgram: getDammTokenProgram(state.tokenAFlag),
        tokenBProgram: getDammTokenProgram(state.tokenBFlag),
        feePayer: payer,
      });
      break;
    }
    default:
      throw new Error(`unknown claim ${String((claim as { kind: unknown }).kind)}`);
  }
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = payer;
  return tx;
}

/** Whether the quote side of a launch is SOL (Epoch launches always are). */
export const isSolQuoted = (config: PoolConfig): boolean => config.quoteMint.equals(NATIVE_MINT);
