/**
 * `pnpm devnet init --url devnet --keys <dir> [--params <json>] [--program-id <id>] [--deployer <path>]
 *    [--admin|--scorer|--publisher|--cranker|--maker <keypair path>] [--treasury <pubkey>]
 *    [--dispute-window-slots 1500] [--index-max-move-bps 2000] [--index-operators 3] [--apply-changes] [--yes]`
 *
 * The pool with its params, the Fee Index and the roles, idempotently:
 *   - role wallets get a fee float from the deployer (only the shortfall);
 *   - `initialize_pool` / `initialize_index` when missing;
 *   - an existing pool or index is compared field by field; a difference is reported and fixed with `update_params`,
 *     `set_roles` or `configure_index` only with `--apply-changes` (the admin key must be the pool's admin).
 * Fee Index operator consensus: `--index-operators N` (default 3, 0 = keep the single publisher) registers
 * `<keys>/index-operator-<i>.json`, weight 1 each, two-thirds threshold, 1% tolerance (`initialize_index_operators` +
 * `add_index_operator`, one transaction); the Fee Index's publisher becomes the registry and publisher_app votes with
 * those keys (`INDEX_OPERATOR_KEYPAIR_PATHS`). An existing registry is checked, never changed.
 * Roles: admin, treasury and scorer live on the pool, the publisher on the Fee Index; the cranker and the maker are
 * permissionless wallets (sweeps, accrual, quotes) that get funded here. Tranche shares are `LenderShares` accounts,
 * not SPL mints, so there is no mint to create; revenue-token mints come from the seed's Meteora launch.
 * Keys default to `<keys>/<role>.json` (created on first use, 0600).
 */
import * as sdk from '@epoch/epoch-sdk';
import { type Keypair, PublicKey } from '@solana/web3.js';

import { perByteFromRentOfZero, rentFromPerByte, sol } from '../lib/budget';
import { explorerUrl } from '../lib/cluster';
import { type Context } from '../lib/context';
import { KitError } from '../lib/errors';
import { feeFloat, type FundTarget, fundFromDeployer, INDEX_OPERATOR_FEE_FLOAT, ROLE_FEE_FLOAT } from '../lib/funding';
import { readKeypair } from '../lib/keys';
import { out, step } from '../lib/log';
import { diffParams, loadParams } from '../lib/params';
import { confirm } from '../lib/run';
import { StateStore } from '../lib/state';
import { sendTx } from '../lib/tx';
import { declaredId } from './deploy';

export const INIT_OPTIONS = {
  params: { type: 'string' },
  'program-id': { type: 'string' },
  deployer: { type: 'string' },
  admin: { type: 'string' },
  scorer: { type: 'string' },
  publisher: { type: 'string' },
  cranker: { type: 'string' },
  maker: { type: 'string' },
  treasury: { type: 'string' },
  'dispute-window-slots': { type: 'string' },
  'index-max-move-bps': { type: 'string' },
  'index-operators': { type: 'string' },
  'apply-changes': { type: 'boolean', default: false },
} as const;

export type InitOptions = {
  [K in keyof typeof INIT_OPTIONS]?: (typeof INIT_OPTIONS)[K]['type'] extends 'boolean' ? boolean : string;
};

/** ≈ 6 minutes of devnet slots (0.239 s): long enough for a real veto, short enough for a demo. */
export const DEFAULT_DISPUTE_WINDOW_SLOTS = 1_500n;
export const DEFAULT_INDEX_MAX_MOVE_BPS = 2_000;
/** Operator consensus on devnet: three keys run by one publisher_app, so a ballot agrees at the second vote. */
export const DEFAULT_INDEX_OPERATORS = 3;
export const INDEX_THRESHOLD_BPS = 6_667;
export const INDEX_TOLERANCE_BPS = 100;

/**
 * What `init` tops up from the deployer: fee floats for the signing roles (refilled below half), the admin's rent for
 * the accounts it still has to create (pool + vault, Fee Index; needed in full), and the treasury's rent-exempt
 * minimum (it receives protocol fees smaller than that). A re-run after a complete init sends nothing.
 */
export function roleFundTargets(
  roles: Roles,
  rent: (dataLen: number) => bigint,
  missing: { pool: boolean; index: boolean; registry?: boolean },
): FundTarget[] {
  const adminRent =
    (missing.pool ? rent(sdk.ACCOUNT_SIZES.Pool) + rent(0) : 0n) +
    (missing.index ? rent(sdk.ACCOUNT_SIZES.FeeIndex) : 0n) +
    (missing.registry && roles.operators.length ? rent(sdk.ACCOUNT_SIZES.IndexOperators) : 0n);
  const admin =
    adminRent > 0n
      ? { label: 'admin', to: roles.admin.publicKey, lamports: ROLE_FEE_FLOAT.admin + adminRent }
      : feeFloat('admin', roles.admin.publicKey, ROLE_FEE_FLOAT.admin);
  return [
    admin,
    feeFloat('scorer', roles.scorer.publicKey, ROLE_FEE_FLOAT.scorer),
    feeFloat('publisher', roles.publisher.publicKey, ROLE_FEE_FLOAT.publisher),
    feeFloat('cranker', roles.cranker.publicKey, ROLE_FEE_FLOAT.cranker),
    { label: 'treasury', to: roles.treasury, lamports: rent(0) },
    ...roles.operators.map((op, i) => feeFloat(`index-operator-${i + 1}`, op.publicKey, INDEX_OPERATOR_FEE_FLOAT)),
  ];
}

export interface Roles {
  admin: Keypair;
  scorer: Keypair;
  publisher: Keypair;
  cranker: Keypair;
  maker: Keypair;
  treasury: PublicKey;
  /** Fee Index operators (empty: the single publisher posts). */
  operators: Keypair[];
}

export function programIdFrom(arg: string | undefined): PublicKey {
  return new PublicKey(arg ?? declaredId());
}

export async function assertDeployed(ctx: Context, programId: PublicKey): Promise<void> {
  const info = await ctx.cluster.connection.getAccountInfo(programId);
  if (!info?.executable) {
    throw new KitError(
      'NOT_DEPLOYED',
      `${programId.toBase58()} is not a deployed program on ${ctx.cluster.name}; run deploy first`,
    );
  }
}

export function loadRoles(ctx: Context, o: InitOptions): Roles {
  const keys = ctx.keys!;
  const role = (name: keyof typeof ROLE_FEE_FLOAT | 'maker', file: string | undefined): Keypair =>
    file ? readKeypair(file) : keys.getOrCreate(name);
  return {
    admin: role('admin', o.admin),
    scorer: role('scorer', o.scorer),
    publisher: role('publisher', o.publisher),
    cranker: role('cranker', o.cranker),
    maker: role('maker', o.maker),
    treasury: o.treasury ? new PublicKey(o.treasury) : keys.getOrCreate('treasury').publicKey,
    operators: Array.from({ length: indexOperatorCount(o) }, (_, i) => keys.getOrCreate(`index-operator-${i + 1}`)),
  };
}

export function indexOperatorCount(o: InitOptions): number {
  const n = Number(o['index-operators'] ?? DEFAULT_INDEX_OPERATORS);
  if (!Number.isInteger(n) || n < 0 || n > sdk.PROGRAM_CONSTANTS.MAX_INDEX_OPERATORS) {
    throw new KitError('BAD_ARGS', `--index-operators must be 0 to ${sdk.PROGRAM_CONSTANTS.MAX_INDEX_OPERATORS}`);
  }
  return n;
}

export async function runInit(ctx: Context, o: InitOptions): Promise<void> {
  if (!ctx.keys || !ctx.stateDir) throw new KitError('BAD_ARGS', '--keys is required');
  const conn = ctx.cluster.connection;
  const programId = programIdFrom(o['program-id']);
  await assertDeployed(ctx, programId);
  const params = loadParams(o.params);
  const roles = loadRoles(ctx, o);
  const deployer = o.deployer ? readKeypair(o.deployer) : ctx.keys.get('deployer');
  const disputeWindowSlots = BigInt(o['dispute-window-slots'] ?? DEFAULT_DISPUTE_WINDOW_SLOTS);
  const maxMoveBps = Number(o['index-max-move-bps'] ?? DEFAULT_INDEX_MAX_MOVE_BPS);
  const state = new StateStore(ctx.stateDir, 'init', ctx.cluster.name, ctx.cluster.genesisHash, programId.toBase58());
  const [pool] = sdk.findPoolPda(programId);
  const [vault] = sdk.findVaultPda(programId, pool);
  const [feeIndex] = sdk.findFeeIndexPda(programId, pool);
  const [registry] = sdk.findIndexOperatorsPda(programId, feeIndex);
  const send = (label: string, ixs: Parameters<typeof sendTx>[2], signers: Keypair[]) =>
    sendTx(conn, label, ixs, signers, { microLamportsPerCu: ctx.priorityFee, programId });
  const link = (sig: string) => explorerUrl('tx', sig, ctx.cluster);

  out(`init on ${ctx.cluster.name}: program ${programId.toBase58()}, pool ${pool.toBase58()}`);
  out(
    `  admin ${roles.admin.publicKey.toBase58()} · scorer ${roles.scorer.publicKey.toBase58()} · publisher ${roles.publisher.publicKey.toBase58()}`,
  );
  out(
    `  cranker ${roles.cranker.publicKey.toBase58()} · maker ${roles.maker.publicKey.toBase58()} · treasury ${roles.treasury.toBase58()}`,
  );

  // 1. Fee floats; the admin also gets the rent of the accounts it still has to create. The treasury receives
  //    transfers below the rent-exempt minimum (protocol fees), so it is pre-funded (harness finding 6).
  const rent = rentFromPerByte(perByteFromRentOfZero(BigInt(await conn.getMinimumBalanceForRentExemption(0))));
  const poolInfo = await conn.getAccountInfo(pool, 'confirmed');
  const indexInfo = await conn.getAccountInfo(feeIndex, 'confirmed');
  const registryInfo = await conn.getAccountInfo(registry, 'confirmed');
  // With operators, the Fee Index's publisher is the registry once it exists (it is created after the index).
  const expectedPublisher = registryInfo ? registry : roles.publisher.publicKey;
  const targets = roleFundTargets(roles, rent, { pool: !poolInfo, index: !indexInfo, registry: !registryInfo });
  await confirm(
    `Fund role wallets from ${deployer.publicKey.toBase58()} and initialize on ${ctx.cluster.name}?`,
    ctx.yes,
  );
  const funded = await fundFromDeployer(conn, deployer, targets, ctx.priorityFee);
  for (const t of funded.sent) step(`funded ${t.label} +${sol(t.send)} SOL`);
  if (funded.txs.length) state.record(`fund:${Date.now()}`, { signatures: funded.txs.map((t) => t.signature) });
  else step('role wallets already hold their floats');

  // 2. Pool.
  if (!poolInfo) {
    const tx = await send(
      'initialize_pool',
      sdk.initializePool({
        programId,
        admin: roles.admin.publicKey,
        treasury: roles.treasury,
        scorer: roles.scorer.publicKey,
        params,
      }),
      [roles.admin],
    );
    state.record('initialize_pool', { signature: tx.signature, slot: tx.slot });
    step(`initialize_pool ✓ ${link(tx.signature)}`);
  } else {
    const onChain = sdk.decodePool(poolInfo.data);
    const diffs = diffParams(onChain.params, params);
    const roleDiff =
      !onChain.treasury.equals(roles.treasury) ||
      !onChain.scorer.equals(roles.scorer.publicKey) ||
      !onChain.admin.equals(roles.admin.publicKey);
    if (!diffs.length && !roleDiff) step('pool exists with these params and roles');
    for (const d of diffs) out(`  params.${d.field}: on chain ${d.onChain}, file ${d.wanted}`);
    if (roleDiff) {
      out(
        `  roles on chain: admin ${onChain.admin.toBase58()}, treasury ${onChain.treasury.toBase58()}, scorer ${onChain.scorer.toBase58()}`,
      );
    }
    if ((diffs.length || roleDiff) && !o['apply-changes']) {
      throw new KitError(
        'CHECK_FAILED',
        'the pool on chain differs from the inputs; re-run with --apply-changes to update it',
      );
    }
    if (!onChain.admin.equals(roles.admin.publicKey) && (diffs.length || roleDiff)) {
      throw new KitError(
        'CHECK_FAILED',
        `the pool's admin is ${onChain.admin.toBase58()}; pass its keypair with --admin`,
      );
    }
    if (diffs.length) {
      const tx = await send('update_params', sdk.updateParams({ programId, admin: roles.admin.publicKey, params }), [
        roles.admin,
      ]);
      state.record(`update_params:${tx.slot}`, { signature: tx.signature });
      step(`update_params ✓ ${link(tx.signature)}`);
    }
    if (roleDiff) {
      const tx = await send(
        'set_roles',
        sdk.setRoles({
          programId,
          admin: roles.admin.publicKey,
          treasury: roles.treasury,
          scorer: roles.scorer.publicKey,
          newAdmin: roles.admin.publicKey,
        }),
        [roles.admin],
      );
      state.record(`set_roles:${tx.slot}`, { signature: tx.signature });
      step(`set_roles ✓ ${link(tx.signature)}`);
    }
  }

  // 3. Fee Index.
  if (!indexInfo) {
    const tx = await send(
      'initialize_index',
      sdk.initializeIndex({
        programId,
        admin: roles.admin.publicKey,
        publisher: roles.publisher.publicKey,
        disputeWindowSlots,
        maxMoveBps,
      }),
      [roles.admin],
    );
    state.record('initialize_index', { signature: tx.signature, slot: tx.slot });
    step(`initialize_index ✓ ${link(tx.signature)}`);
  } else {
    const idx = sdk.decodeFeeIndex(indexInfo.data);
    const same =
      idx.publisher.equals(expectedPublisher) &&
      idx.disputeWindowSlots === disputeWindowSlots &&
      idx.maxMoveBps === maxMoveBps;
    if (same) step('Fee Index exists with this publisher, window and max move');
    else {
      out(
        `  Fee Index on chain: publisher ${idx.publisher.toBase58()}, window ${idx.disputeWindowSlots}, max move ${idx.maxMoveBps}`,
      );
      if (!o['apply-changes']) throw new KitError('CHECK_FAILED', 'the Fee Index differs; re-run with --apply-changes');
      const tx = await send(
        'configure_index',
        sdk.configureIndex({
          programId,
          admin: roles.admin.publicKey,
          publisher: expectedPublisher,
          disputeWindowSlots,
          maxMoveBps,
        }),
        [roles.admin],
      );
      state.record(`configure_index:${tx.slot}`, { signature: tx.signature });
      step(`configure_index ✓ ${link(tx.signature)}`);
    }
  }

  // 4. Operator consensus: the registry with the operator keys, created once.
  const wantedOperators = roles.operators.map((op) => op.publicKey.toBase58()).sort();
  if (roles.operators.length && !registryInfo) {
    const tx = await send(
      'initialize_index_operators + add_index_operator',
      [
        ...sdk.initializeIndexOperators({
          programId,
          admin: roles.admin.publicKey,
          thresholdBps: INDEX_THRESHOLD_BPS,
          toleranceBps: INDEX_TOLERANCE_BPS,
        }),
        ...roles.operators.flatMap((op) =>
          sdk.addIndexOperator({ programId, admin: roles.admin.publicKey, operator: op.publicKey, weight: 1 }),
        ),
      ],
      [roles.admin],
    );
    state.record('initialize_index_operators', { signature: tx.signature, slot: tx.slot });
    step(`operator registry ✓ ${roles.operators.length} operators ${link(tx.signature)}`);
  } else if (registryInfo) {
    const onChain = sdk
      .activeIndexOperators(sdk.decodeIndexOperators(registryInfo.data))
      .map((op) => op.key.toBase58())
      .sort();
    if (onChain.join() !== wantedOperators.join()) {
      throw new KitError(
        'CHECK_FAILED',
        `the operator registry holds ${onChain.join(', ') || 'no operators'}; the key folder has ${wantedOperators.join(', ') || 'none'} (the kit never changes a registry: use the admin instructions)`,
      );
    }
    step(`operator registry exists with these ${onChain.length} operators`);
  }

  // 5. Read back.
  const p = sdk.decodePool((await conn.getAccountInfo(pool))!.data);
  const idx = sdk.decodeFeeIndex((await conn.getAccountInfo(feeIndex))!.data);
  const publisherNow = roles.operators.length ? registry : roles.publisher.publicKey;
  if (
    diffParams(p.params, params).length ||
    !p.admin.equals(roles.admin.publicKey) ||
    !idx.publisher.equals(publisherNow)
  ) {
    throw new KitError('CHECK_FAILED', 'pool or index does not match the inputs after init');
  }
  state.setData('accounts', {
    programId: programId.toBase58(),
    pool: pool.toBase58(),
    vault: vault.toBase58(),
    feeIndex: feeIndex.toBase58(),
    admin: roles.admin.publicKey.toBase58(),
    treasury: roles.treasury.toBase58(),
    scorer: roles.scorer.publicKey.toBase58(),
    publisher: roles.publisher.publicKey.toBase58(),
    cranker: roles.cranker.publicKey.toBase58(),
    maker: roles.maker.publicKey.toBase58(),
    indexOperators: roles.operators.length ? registry.toBase58() : null,
    operators: roles.operators.map((op) => op.publicKey.toBase58()),
  });
  step(
    `ready: senior ${p.params.seniorRateBpsPerEpoch} bps/epoch, junior lock ${p.params.juniorLockEpochs}, paused ${p.paused}`,
  );
}
