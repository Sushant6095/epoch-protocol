import { type GetProgramAccountsFilter, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import * as sdk from './index';

// web3.js loads its websocket client at import time (rpc-websockets → ESM-only uuid), which jest's CommonJS runtime
// cannot parse. The SDK never opens a websocket, so a stub is enough; everything else is the real web3.js.
jest.mock('rpc-websockets', () => ({ CommonClient: class {}, WebSocket: () => undefined }), { virtual: true });

/** The agreed public API (other packages are written against these names). */
const REQUIRED = [
  // constants
  'SEEDS',
  'VOTE_PROGRAM_ID',
  'PROGRAM_CONSTANTS',
  'RAW_SHARES_PER_UI_SHARE',
  'sharePriceE9ToSol',
  'rawSharesToUi',
  'METEORA',
  'NATIVE_MINT',
  'TOKEN_PROGRAM_ID',
  'REVENUE_TOKEN_FLAGS',
  // pda
  'findPoolPda',
  'findVaultPda',
  'findLenderPda',
  'findWithdrawRequestPda',
  'findPositionPda',
  'findVoteAuthPda',
  'findEscrowPda',
  'findAdvancePda',
  'findFeeIndexPda',
  'findQuotePda',
  'findSwapPda',
  'findRevenueTokenPda',
  'findBuybackEscrowPda',
  'findBuybackWsolPda',
  'findBuybackTokensPda',
  'findPartnerTreasuryPda',
  'findTreasuryWsolPda',
  'findTreasuryTokensAddress',
  'findAssociatedTokenAddress',
  'findDammPositionPda',
  'findDammPositionNftAccount',
  'findDbcPoolPda',
  // accounts
  'decodePool',
  'decodeLenderShares',
  'decodeWithdrawRequest',
  'decodeValidatorPosition',
  'decodeAdvance',
  'decodeFeeIndex',
  'decodeFeeQuote',
  'decodeSwapPosition',
  'decodeRevenueToken',
  'revenueTokenInTerm',
  'revenueTokenTermActive',
  'revenueTokenRedeemOpen',
  'revenueTokenMaxImpactBound',
  'revenueTokenBuybacksPaused',
  'revenueTokenCloseMode',
  'decodeAccount',
  'ACCOUNT_DISCRIMINATORS',
  'ACCOUNT_SIZES',
  'FIELD_OFFSETS',
  'accountFilters',
  'fieldFilter',
  'feeIndexHistory',
  'feeIndexValueFor',
  'revenueHistory',
  'trailingRevenue',
  // events
  'EVENT_DISCRIMINATORS',
  'decodeEvent',
  'parseEventsFromLogs',
  'eventToJson',
  // instructions
  'INSTRUCTION_DISCRIMINATORS',
  'initializePool',
  'updateParams',
  'setPaused',
  'setRoles',
  'deposit',
  'requestWithdraw',
  'cancelWithdraw',
  'processWithdrawal',
  'accrue',
  'onboardValidator',
  'setCollectors',
  'postBond',
  'withdrawBond',
  'onboardWithBond',
  'requestAdvance',
  'sweep',
  'markDefault',
  'releaseValidator',
  'updateCommission',
  'updateIdentity',
  'updateScore',
  'initializeIndex',
  'configureIndex',
  'postIndex',
  'finalizeIndex',
  'vetoIndex',
  'postQuote',
  'withdrawQuote',
  'openSwap',
  'openSwaps',
  'settleSwap',
  'sweepPosition',
  'registerRevenueToken',
  'syncRevenueTokenPool',
  'executeBuyback',
  'redeem',
  'configureRevenueToken',
  'closeRevenueToken',
  'claimPartnerTradingFee',
  'claimPartnerSurplus',
  'claimPartnerMigrationFee',
  'burnLeftover',
  'claimTreasuryLpFee',
  'findMeteoraVaultPda',
  'solToLamports',
  // errors
  'EPOCH_ERRORS',
  'epochErrorFromCode',
  'parseEpochError',
  // math
  'bpsOf',
  'bpsOfCeil',
  'mulDiv',
  'assetsToShares',
  'sharesToAssets',
  'sharePriceE9',
  'creditLimit',
  'splitSweep',
  'attributeRepayment',
  'distributeIncome',
  'juniorRatioBps',
  'absorbLoss',
  'takerPnl',
  'swapCollateral',
  'computeScore',
  'splitSweepWithShare',
  'sliceDueSlot',
  'sliceTiming',
  'sliceBudget',
  'redeemPayout',
  'circulatingSupply',
  'dbcMinBaseFeeNumerator',
  'dbcMigratedFeeBps',
  'venueFeeFloorBps',
  'maxImpactBound',
  'FEE_NUMERATOR_PER_BPS',
  'checkLaunchConfig',
  'decodeDbcLaunchConfig',
  'decodeDbcPoolHead',
  'DBC_POOL_CONFIG_DISCRIMINATOR',
  'DBC_POOL_CONFIG_LEN',
  'minOutFloor',
  'impactTargetSqrtPrice',
  'planBuybackSlice',
  'dbcPartnerPart',
  'dbcPartnerSurplus',
  'dbcPartnerMigrationFee',
  'dbcLeftover',
] as const;

// Compile-time: the agreed type names exist and have the agreed shapes.
type _Types = [
  sdk.Tranche,
  sdk.Side,
  sdk.PositionStatus,
  sdk.AdvanceState,
  sdk.AccountName,
  sdk.EventName,
  sdk.InstructionName,
  sdk.EpochEvent,
  sdk.PoolParams,
  sdk.PoolAccount,
  sdk.LenderSharesAccount,
  sdk.WithdrawRequestAccount,
  sdk.ValidatorPositionAccount,
  sdk.AdvanceAccount,
  sdk.IndexPoint,
  sdk.FeeIndexAccount,
  sdk.FeeQuoteAccount,
  sdk.SwapPositionAccount,
  sdk.RevenueTokenAccount,
  sdk.BuybackVenueState,
  sdk.BuybackSlicePlan,
];
const _shapes: {
  pda: [PublicKey, number];
  filters: GetProgramAccountsFilter[];
  filter: GetProgramAccountsFilter;
  ixs: TransactionInstruction[];
  deposited: Extract<sdk.EpochEvent, { name: 'Deposited' }>['data'];
  json: { name: sdk.EventName; data: Record<string, string | number | boolean> };
  error: { code: number; name: string; message: string } | undefined;
  errors: readonly { code: number; name: string; message: string }[];
  history: sdk.IndexPoint[];
  value: bigint | null;
  decoded: { name: sdk.AccountName; account: unknown } | null;
} = {
  pda: sdk.findPoolPda(PublicKey.default),
  filters: sdk.accountFilters('Pool'),
  filter: sdk.fieldFilter('Advance', 'vote', PublicKey.default),
  ixs: sdk.finalizeIndex({ programId: PublicKey.default, cranker: PublicKey.default }),
  deposited: {
    pool: PublicKey.default,
    owner: PublicKey.default,
    tranche: 'junior',
    assets: 1n,
    shares: 1n,
    sharePriceE9: 1n,
  },
  json: { name: 'Deposited', data: {} },
  error: sdk.parseEpochError(null),
  errors: sdk.EPOCH_ERRORS,
  history: [],
  value: null,
  decoded: sdk.decodeAccount(new Uint8Array(8)),
};

describe('public API', () => {
  it.each(REQUIRED)('exports %s', (name) => {
    expect((sdk as Record<string, unknown>)[name]).toBeDefined();
  });

  it('keeps the agreed shapes', () => {
    const types: _Types | undefined = undefined;
    expect(types).toBeUndefined();
    expect(_shapes.filters).toHaveLength(2);
    expect(_shapes.ixs).toHaveLength(1);
    expect(sdk.SEEDS.voteAuth).toBe('vote_auth');
    expect(sdk.PROGRAM_CONSTANTS.VIRTUAL_SHARES).toBe(1000n);
    expect(sdk.RAW_SHARES_PER_UI_SHARE).toBe(1_000_000_000_000n);
  });
});

describe('browser safety', () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }));

  it('scans the SDK sources', () => {
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining([
        'accounts.ts',
        'borsh.ts',
        'events.ts',
        'index.ts',
        'instructions.ts',
        'math.ts',
        'pda.ts',
      ]),
    );
  });

  it.each(['crypto', 'fs', 'path', 'os', 'util', 'stream', 'child_process', 'http', 'https', 'net', 'zlib'])(
    'never imports the Node built-in %s',
    (mod) => {
      for (const { file, text } of sources) {
        expect({ file, hit: new RegExp(`from '(node:)?${mod}'`).test(text) }).toEqual({ file, hit: false });
      }
    },
  );

  it('uses no Node globals, no require, no Anchor runtime, no app packages', () => {
    for (const { file, text } of sources) {
      const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect({ file, require: /\brequire\(/.test(code) }).toEqual({ file, require: false });
      expect({ file, process: /\bprocess\./.test(code) }).toEqual({ file, process: false });
      expect({ file, node: /from 'node:/.test(code) }).toEqual({ file, node: false });
      expect({ file, anchor: /@coral-xyz\/anchor|@anchor-lang\//.test(code) }).toEqual({ file, anchor: false });
      expect({ file, app: /from '@epoch\//.test(code) }).toEqual({ file, app: false });
      // No `buffer` import (bundlers resolve it only as a declared dependency); the one Buffer, for
      // TransactionInstruction.data, is web3.js's own class.
      expect({ file, bufferImport: /from '(node:)?buffer'/.test(code) }).toEqual({ file, bufferImport: false });
      if (file !== 'instructions.ts')
        expect({ file, buffer: /\bBuffer\b/.test(code) }).toEqual({ file, buffer: false });
    }
  });
});
