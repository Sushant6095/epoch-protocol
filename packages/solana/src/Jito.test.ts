import accounts from './__fixtures__/jito-accounts.json';
import {
  claimStatusAddress,
  distributionAccountFilters,
  estimatedValidatorShare,
  JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID,
  JITO_TIP_ACCOUNTS,
  JITO_TIP_DISTRIBUTION_PROGRAM_ID,
  JITO_TIP_PAYMENT_PROGRAM_ID,
  parsePriorityFeeClaimStatus,
  parsePriorityFeeDistributionAccount,
  parseTipClaimStatus,
  parseTipDistributionAccount,
  priorityFeeDistributionAccountAddress,
  tipDistributionAccountAddress,
} from './Jito';
import { findProgramAddress } from './pubkeys';

/**
 * `__fixtures__/jito-accounts.json`: unmodified mainnet accounts read on 7 Oct 2026 (epoch 1051) through the public RPC
 * (see its `source`). The expected values below were read independently with a separate script during the probe.
 */
const bytes = (base64: string): Uint8Array => Uint8Array.from(Buffer.from(base64, 'base64'));
const VOTE = '3N7s9zXMZ4QqvHQR15t5GNHyqc89KduzMP7423eWiD5g';
const TIP_ROUTER_UPLOAD_AUTHORITY = '8F4jGUmxF36vQ6yabnsxX6AQVXdKBhs8kGSUuRKSg8Xt';

describe('Jito program ids and tip accounts', () => {
  it('matches the fixture', () => {
    expect(accounts.tipPaymentProgram).toBe(JITO_TIP_PAYMENT_PROGRAM_ID);
    expect(accounts.tipDistributionProgram).toBe(JITO_TIP_DISTRIBUTION_PROGRAM_ID);
    expect(accounts.priorityFeeDistributionProgram).toBe(JITO_PRIORITY_FEE_DISTRIBUTION_PROGRAM_ID);
  });

  it('lists the eight tip accounts as the PDAs ["TIP_ACCOUNT_i"] of the tip-payment program', () => {
    const derived = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
      findProgramAddress([Buffer.from(`TIP_ACCOUNT_${i}`)], JITO_TIP_PAYMENT_PROGRAM_ID),
    );
    expect(JITO_TIP_ACCOUNTS).toEqual(derived);
    expect(JITO_TIP_ACCOUNTS).toEqual(accounts.tipAccounts);
  });
});

describe('parseTipDistributionAccount', () => {
  it('reads a TDA whose merkle root is uploaded (epoch 1050)', () => {
    expect(parseTipDistributionAccount(bytes(accounts.tdaWithRoot.data))).toEqual({
      kind: 'tip',
      validatorVoteAccount: VOTE,
      merkleRootUploadAuthority: TIP_ROUTER_UPLOAD_AUTHORITY,
      merkleRoot: {
        root: '436fcb24268acd964d5fc737843379f5ea5448eb32d33a1939c0747712835778',
        maxTotalClaim: 164_413_744_343n,
        maxNumNodes: 1151n,
        totalFundsClaimed: 164_412_094_076n,
        numNodesClaimed: 940n,
      },
      epochCreatedAt: 1050n,
      validatorCommissionBps: 0,
      expiresAt: 1060n,
      totalLamportsTransferred: null,
      bump: 251,
    });
  });

  it('reads a TDA still collecting (epoch 1051, no root yet: every later field 64 bytes earlier)', () => {
    expect(parseTipDistributionAccount(bytes(accounts.tdaWithoutRoot.data))).toEqual({
      kind: 'tip',
      validatorVoteAccount: VOTE,
      merkleRootUploadAuthority: TIP_ROUTER_UPLOAD_AUTHORITY,
      merkleRoot: null,
      epochCreatedAt: 1051n,
      validatorCommissionBps: 0,
      expiresAt: 1061n,
      totalLamportsTransferred: null,
      bump: 255,
    });
  });

  it('reads the commission of other validators', () => {
    const tda700 = parseTipDistributionAccount(bytes(accounts.tda700.data));
    expect(tda700?.validatorCommissionBps).toBe(700);
    expect(tda700?.merkleRoot?.maxTotalClaim).toBe(106_700_426_062n);
    expect(tda700?.bump).toBe(254);
    expect(parseTipDistributionAccount(bytes(accounts.tda10000.data))?.validatorCommissionBps).toBe(10_000);
  });

  it('refuses other accounts', () => {
    expect(parseTipDistributionAccount(bytes(accounts.pfdaWithRoot.data))).toBeNull();
    expect(parseTipDistributionAccount(bytes(accounts.claimStatus700.data))).toBeNull();
    expect(parseTipDistributionAccount(bytes(accounts.tdaWithRoot.data).subarray(0, 167))).toBeNull();
    const badTag = bytes(accounts.tdaWithRoot.data);
    badTag[72] = 2;
    expect(parseTipDistributionAccount(badTag)).toBeNull();
  });
});

describe('parsePriorityFeeDistributionAccount', () => {
  it('reads a PFDA (176 bytes, total_lamports_transferred after expires_at)', () => {
    expect(parsePriorityFeeDistributionAccount(bytes(accounts.pfdaWithRoot.data))).toEqual({
      kind: 'priority-fee',
      validatorVoteAccount: 'J1to2NAwajc8hD6E6kujdQiPn1Bbt2mGKKZLY9kSQKdB',
      merkleRootUploadAuthority: expect.any(String),
      merkleRoot: {
        root: expect.any(String),
        maxTotalClaim: 0n,
        maxNumNodes: 1812n,
        totalFundsClaimed: 0n,
        numNodesClaimed: 0n,
      },
      epochCreatedAt: 1050n,
      validatorCommissionBps: 5000,
      expiresAt: 1060n,
      totalLamportsTransferred: 0n,
      bump: 254,
    });
  });

  it('refuses a TDA', () => {
    expect(parsePriorityFeeDistributionAccount(bytes(accounts.tdaWithRoot.data))).toBeNull();
  });
});

describe('parseTipClaimStatus', () => {
  it('reads the validator node claim (700 bps: amount = ⌊tips × 7 %⌋, claimant = the vote account)', () => {
    const status = parseTipClaimStatus(bytes(accounts.claimStatus700.data));
    expect(status).toEqual({
      isClaimed: true,
      claimant: 'CcaHc2L43ZWjwCHART3oZoJvHLAe9hzT2DJNUpBzoTN1',
      claimStatusPayer: expect.any(String),
      slotClaimedAt: 454_050_628n,
      amount: 7_469_029_824n,
      expiresAt: 1060n,
      bump: expect.any(Number),
    });
    expect(estimatedValidatorShare(106_700_426_062n, 700)).toBe(status?.amount);
  });

  it('shows the estimate is an upper bound at 100 % commission (the protocol fee is paid first)', () => {
    const status = parseTipClaimStatus(bytes(accounts.claimStatus10000.data));
    expect(status?.amount).toBe(105_425_182_231n);
    expect(estimatedValidatorShare(108_786_690_982n, 10_000)).toBe(108_786_690_982n);
    expect(status!.amount < estimatedValidatorShare(108_786_690_982n, 10_000)).toBe(true);
  });

  it('refuses a TDA', () => {
    expect(parseTipClaimStatus(bytes(accounts.tda700.data))).toBeNull();
  });
});

describe('parsePriorityFeeClaimStatus', () => {
  it('reads payer and expiry from 48 bytes', () => {
    const data = Buffer.alloc(48);
    Buffer.from('16b7f99df75f9660', 'hex').copy(data, 0);
    data.fill(7, 8, 40);
    data.writeBigUInt64LE(1060n, 40);
    expect(parsePriorityFeeClaimStatus(data)).toEqual({ claimStatusPayer: expect.any(String), expiresAt: 1060n });
    expect(parsePriorityFeeClaimStatus(data.subarray(0, 47))).toBeNull();
  });
});

describe('PDAs', () => {
  it('derives the TDA of a vote account and epoch', () => {
    expect(tipDistributionAccountAddress(VOTE, 1050)).toBe(accounts.tdaWithRoot.address);
    expect(tipDistributionAccountAddress(VOTE, 1051n)).toBe(accounts.tdaWithoutRoot.address);
  });

  it('derives the validator node ClaimStatus from the vote account and the TDA', () => {
    expect(claimStatusAddress('CcaHc2L43ZWjwCHART3oZoJvHLAe9hzT2DJNUpBzoTN1', accounts.tda700.address)).toBe(
      accounts.claimStatus700.address,
    );
  });

  it('derives the PFDA', () => {
    expect(priorityFeeDistributionAccountAddress('J1to2NAwajc8hD6E6kujdQiPn1Bbt2mGKKZLY9kSQKdB', 1050)).toBe(
      accounts.pfdaWithRoot.address,
    );
  });
});

describe('distributionAccountFilters', () => {
  const at = (data: Uint8Array, filter: ReturnType<typeof distributionAccountFilters>[number]): boolean =>
    'dataSize' in filter
      ? data.length === filter.dataSize
      : Buffer.from(data)
          .subarray(filter.memcmp.offset, filter.memcmp.offset + Buffer.from(filter.memcmp.bytes, 'base64').length)
          .equals(Buffer.from(filter.memcmp.bytes, 'base64'));

  it('selects an epoch with or without the root, as getProgramAccounts would', () => {
    const withRoot = bytes(accounts.tdaWithRoot.data);
    const withoutRoot = bytes(accounts.tdaWithoutRoot.data);
    expect(distributionAccountFilters('tip', 1050, true).every((f) => at(withRoot, f))).toBe(true);
    expect(distributionAccountFilters('tip', 1050, false).every((f) => at(withRoot, f))).toBe(false);
    expect(distributionAccountFilters('tip', 1051, false).every((f) => at(withoutRoot, f))).toBe(true);
    expect(distributionAccountFilters('tip', 1050, false).every((f) => at(withoutRoot, f))).toBe(false);
    expect(
      distributionAccountFilters('priority-fee', 1050, true).every((f) => at(bytes(accounts.pfdaWithRoot.data), f)),
    ).toBe(true);
  });
});

describe('estimatedValidatorShare', () => {
  it('is 0 without commission and floors', () => {
    expect(estimatedValidatorShare(1_000n, 0)).toBe(0n);
    expect(estimatedValidatorShare(999n, 1)).toBe(0n);
    expect(estimatedValidatorShare(10_001n, 5_000)).toBe(5_000n);
  });
});
