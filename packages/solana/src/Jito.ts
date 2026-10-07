import { addressToBytes, bytesToAddress, findProgramAddress } from './pubkeys';

/**
 * Jito's MEV programs on mainnet, read from their public account layouts (no Jito code is used or linked):
 *
 * - **tip-payment** (`T1pyya…`): searchers tip by transferring lamports to one of eight PDA tip accounts; at a leader's
 *   first bundle the validator moves them to its tip receiver, its TipDistributionAccount for the epoch.
 * - **tip-distribution** (`4R3gSG…`): one TipDistributionAccount (TDA) per validator per epoch. After the epoch the
 *   merkle root upload authority (Jito's TipRouter NCN) uploads a root over every claimant's share; the claim crank then
 *   creates a ClaimStatus PDA per claimed node. The validator's commission node has the vote account as claimant.
 * - **priority-fee-distribution** (`Priority6we…`): the same shape for priority fees a validator chooses to share.
 *
 * Layouts (Anchor accounts, Borsh after an 8-byte discriminator; `Option<MerkleRoot>` is 1 byte when None and 65 when
 * Some, so every later offset moves by 64), from jito-programs `mev-programs/programs/tip-distribution/src/state.rs`
 * and `priority-fee-distribution/src/state.rs`, sizes and discriminators from jito-tip-router `tip_distribution_sdk`
 * and `priority_fee_distribution_sdk`, and checked against real mainnet accounts (epoch 1050/1051) in the tests:
 *
 * ```text
 * TipDistributionAccount (168 bytes)        PriorityFeeDistributionAccount (176 bytes)
 *   0  discriminator [8]                      same as the TDA up to expires_at, then
 *   8  validator_vote_account [32]              u64 total_lamports_transferred
 *  40  merkle_root_upload_authority [32]        u8  bump
 *  72  Option<MerkleRoot> tag
 *      Some: root [32] max_total_claim u64 max_num_nodes u64 total_funds_claimed u64 num_nodes_claimed u64
 *  73 | 137  epoch_created_at u64
 *  81 | 145  validator_commission_bps u16
 *  83 | 147  expires_at u64
 *  91 | 155  bump u8 (the rest of the 168 bytes is zero padding)
 *
 * ClaimStatus, tip-distribution (104 bytes): is_claimed bool, claimant [32], claim_status_payer [32],
 *   slot_claimed_at u64, amount u64, expires_at u64, bump u8
 * ClaimStatus, priority-fee-distribution (48 bytes): claim_status_payer [32], expires_at u64 (existence = claimed)
 * ```
 */
export const JITO_TIP_PAYMENT_PROGRAM_ID = 'T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt';
export const JITO_TIP_DISTRIBUTION_PROGRAM_ID = '4R3gSG8BpU4t19KYj8CfnbtRpnT8gtk4dvTHxVRwc2r7';
export const JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID = 'Priority6weCZ5HwDn29NxLFpb7TDp2iLZ6XKc5e8d3';

/**
 * The eight tip-payment accounts, PDAs `["TIP_ACCOUNT_0"]` … `["TIP_ACCOUNT_7"]` under the tip-payment program
 * (written out so importing this module derives nothing; a test re-derives them).
 */
export const JITO_TIP_ACCOUNTS: readonly string[] = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

export const TIP_DISTRIBUTION_ACCOUNT_SIZE = 168;
export const PRIORITY_FEE_DISTRIBUTION_ACCOUNT_SIZE = 176;
export const TIP_CLAIM_STATUS_SIZE = 104;
export const PRIORITY_FEE_CLAIM_STATUS_SIZE = 48;

const TIP_DISTRIBUTION_DISCRIMINATOR = Buffer.from('554071c6ea5e787b', 'hex');
const PRIORITY_FEE_DISTRIBUTION_DISCRIMINATOR = Buffer.from('a3b7fe0c7989eb1b', 'hex');
/** `sha256("account:ClaimStatus")[..8]`: the same name, so the same discriminator, in both programs. */
const CLAIM_STATUS_DISCRIMINATOR = Buffer.from('16b7f99df75f9660', 'hex');

/** Offset of the `Option<MerkleRoot>` tag, and how far the fields after it move when the root is present. */
export const MERKLE_ROOT_TAG_OFFSET = 72;
const MERKLE_ROOT_SIZE = 32 + 8 * 4;
const BPS = 10_000n;

export type DistributionKind = 'tip' | 'priority-fee';

export interface JitoMerkleRoot {
  /** Hex. */
  root: string;
  /** Everything the tree can pay out: the epoch's tips (TDA) or shared priority fees (PFDA), less nothing. */
  maxTotalClaim: bigint;
  maxNumNodes: bigint;
  totalFundsClaimed: bigint;
  numNodesClaimed: bigint;
}

export interface DistributionAccount {
  kind: DistributionKind;
  validatorVoteAccount: string;
  merkleRootUploadAuthority: string;
  /** Null until the upload authority posts the epoch's root (a few hours into the next epoch). */
  merkleRoot: JitoMerkleRoot | null;
  /** The epoch the account collects for. */
  epochCreatedAt: bigint;
  /** The validator's MEV commission (TDA) or priority-fee commission (PFDA), 0–10,000. */
  validatorCommissionBps: number;
  /** Last epoch in which nodes can still be claimed; the account is closed after it. */
  expiresAt: bigint;
  /** PFDA only: lamports the validator transferred in; null for a TDA. */
  totalLamportsTransferred: bigint | null;
  bump: number;
}

export interface TipClaimStatus {
  isClaimed: boolean;
  claimant: string;
  claimStatusPayer: string;
  slotClaimedAt: bigint;
  amount: bigint;
  expiresAt: bigint;
  bump: number;
}

export interface PriorityFeeClaimStatus {
  claimStatusPayer: string;
  expiresAt: bigint;
}

const view = (data: Uint8Array) => Buffer.from(data.buffer, data.byteOffset, data.byteLength);
const startsWith = (data: Buffer, prefix: Buffer) => data.length >= prefix.length && data.subarray(0, 8).equals(prefix);

function parseDistribution(data: Uint8Array, kind: DistributionKind): DistributionAccount | null {
  const buf = view(data);
  const size = kind === 'tip' ? TIP_DISTRIBUTION_ACCOUNT_SIZE : PRIORITY_FEE_DISTRIBUTION_ACCOUNT_SIZE;
  const discriminator = kind === 'tip' ? TIP_DISTRIBUTION_DISCRIMINATOR : PRIORITY_FEE_DISTRIBUTION_DISCRIMINATOR;
  if (buf.length !== size || !startsWith(buf, discriminator)) return null;
  const tag = buf[MERKLE_ROOT_TAG_OFFSET];
  if (tag !== 0 && tag !== 1) return null;
  let o = MERKLE_ROOT_TAG_OFFSET + 1;
  let merkleRoot: JitoMerkleRoot | null = null;
  if (tag === 1) {
    merkleRoot = {
      root: buf.subarray(o, o + 32).toString('hex'),
      maxTotalClaim: buf.readBigUInt64LE(o + 32),
      maxNumNodes: buf.readBigUInt64LE(o + 40),
      totalFundsClaimed: buf.readBigUInt64LE(o + 48),
      numNodesClaimed: buf.readBigUInt64LE(o + 56),
    };
    o += MERKLE_ROOT_SIZE;
  }
  const epochCreatedAt = buf.readBigUInt64LE(o);
  const validatorCommissionBps = buf.readUInt16LE(o + 8);
  const expiresAt = buf.readBigUInt64LE(o + 10);
  o += 18;
  let totalLamportsTransferred: bigint | null = null;
  if (kind === 'priority-fee') {
    totalLamportsTransferred = buf.readBigUInt64LE(o);
    o += 8;
  }
  if (validatorCommissionBps > Number(BPS)) return null;
  return {
    kind,
    validatorVoteAccount: bytesToAddress(buf.subarray(8, 40)),
    merkleRootUploadAuthority: bytesToAddress(buf.subarray(40, 72)),
    merkleRoot,
    epochCreatedAt,
    validatorCommissionBps,
    expiresAt,
    totalLamportsTransferred,
    bump: buf[o],
  };
}

/** A TipDistributionAccount, or null when the bytes are not one (wrong size or discriminator, bad tag). */
export const parseTipDistributionAccount = (data: Uint8Array): DistributionAccount | null =>
  parseDistribution(data, 'tip');

/** A PriorityFeeDistributionAccount, or null when the bytes are not one. */
export const parsePriorityFeeDistributionAccount = (data: Uint8Array): DistributionAccount | null =>
  parseDistribution(data, 'priority-fee');

/** A tip-distribution ClaimStatus, or null when the bytes are not one. */
export function parseTipClaimStatus(data: Uint8Array): TipClaimStatus | null {
  const buf = view(data);
  if (buf.length !== TIP_CLAIM_STATUS_SIZE || !startsWith(buf, CLAIM_STATUS_DISCRIMINATOR)) return null;
  if (buf[8] > 1) return null;
  return {
    isClaimed: buf[8] === 1,
    claimant: bytesToAddress(buf.subarray(9, 41)),
    claimStatusPayer: bytesToAddress(buf.subarray(41, 73)),
    slotClaimedAt: buf.readBigUInt64LE(73),
    amount: buf.readBigUInt64LE(81),
    expiresAt: buf.readBigUInt64LE(89),
    bump: buf[97],
  };
}

/** A priority-fee-distribution ClaimStatus (its existence means the node was claimed), or null. */
export function parsePriorityFeeClaimStatus(data: Uint8Array): PriorityFeeClaimStatus | null {
  const buf = view(data);
  if (buf.length !== PRIORITY_FEE_CLAIM_STATUS_SIZE || !startsWith(buf, CLAIM_STATUS_DISCRIMINATOR)) return null;
  return { claimStatusPayer: bytesToAddress(buf.subarray(8, 40)), expiresAt: buf.readBigUInt64LE(40) };
}

const u64Le = (value: number | bigint): Buffer => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
};

/** The validator's TipDistributionAccount for `epoch`: `["TIP_DISTRIBUTION_ACCOUNT", vote, epoch u64 LE]`. */
export const tipDistributionAccountAddress = (
  vote: string,
  epoch: number | bigint,
  programId: string = JITO_TIP_DISTRIBUTION_PROGRAM_ID,
): string =>
  findProgramAddress([Buffer.from('TIP_DISTRIBUTION_ACCOUNT'), addressToBytes(vote), u64Le(epoch)], programId);

/** The validator's PriorityFeeDistributionAccount for `epoch`: `["PF_DISTRIBUTION_ACCOUNT", vote, epoch u64 LE]`. */
export const priorityFeeDistributionAccountAddress = (
  vote: string,
  epoch: number | bigint,
  programId: string = JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID,
): string =>
  findProgramAddress([Buffer.from('PF_DISTRIBUTION_ACCOUNT'), addressToBytes(vote), u64Le(epoch)], programId);

/**
 * A node's ClaimStatus: `["CLAIM_STATUS", claimant, distribution account]` under the distribution program. For the
 * validator's commission node the claimant is its vote account.
 */
export const claimStatusAddress = (
  claimant: string,
  distributionAccount: string,
  programId: string = JITO_TIP_DISTRIBUTION_PROGRAM_ID,
): string =>
  findProgramAddress(
    [Buffer.from('CLAIM_STATUS'), addressToBytes(claimant), addressToBytes(distributionAccount)],
    programId,
  );

/** A `getProgramAccounts` filter (bytes base64, which every Agave RPC accepts). */
export type ProgramAccountsFilter =
  { dataSize: number } | { memcmp: { offset: number; bytes: string; encoding: 'base64' } };

/**
 * Filters that select one epoch's distribution accounts in one call. Borsh moves `epoch_created_at` by 64 bytes when
 * the merkle root is present, so a whole epoch takes two calls: `rootUploaded` true and false.
 */
export function distributionAccountFilters(
  kind: DistributionKind,
  epoch: number | bigint,
  rootUploaded: boolean,
): ProgramAccountsFilter[] {
  const epochOffset = MERKLE_ROOT_TAG_OFFSET + 1 + (rootUploaded ? MERKLE_ROOT_SIZE : 0);
  return [
    { dataSize: kind === 'tip' ? TIP_DISTRIBUTION_ACCOUNT_SIZE : PRIORITY_FEE_DISTRIBUTION_ACCOUNT_SIZE },
    {
      memcmp: {
        offset: MERKLE_ROOT_TAG_OFFSET,
        bytes: Buffer.from([rootUploaded ? 1 : 0]).toString('base64'),
        encoding: 'base64',
      },
    },
    { memcmp: { offset: epochOffset, bytes: u64Le(epoch).toString('base64'), encoding: 'base64' } },
  ];
}

/**
 * The validator's commission node before it is claimed: ⌊tips × bps ÷ 10,000⌋, as jito-tip-router builds it. An
 * upper bound: when commission and the NCN protocol fee together exceed the tips (100 % commission) the protocol fee is
 * paid first and the validator gets less. The ClaimStatus `amount` is the exact figure.
 */
export function estimatedValidatorShare(maxTotalClaim: bigint, commissionBps: number): bigint {
  if (commissionBps <= 0) return 0n;
  return (maxTotalClaim * BigInt(Math.min(commissionBps, Number(BPS)))) / BPS;
}
