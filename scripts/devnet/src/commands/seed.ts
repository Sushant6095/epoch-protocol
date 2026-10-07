/**
 * `pnpm devnet seed --url devnet --keys <dir> [--program-id <id>] [--params <json>] [--deployer <path>] [--yes]`
 *
 * Real flows through `@epoch/epoch-sdk`, as ordered steps recorded in `<state>/seed-<genesis>.json` (keyed to the
 * cluster's genesis hash and the program id). Every step checks its on-chain effect before sending, so a re-run after a
 * crash never sends twice, and wallets are topped up from the deployer with only what the remaining steps need
 * (`walletNeeds`). Signing wallets and the test validators' keys are created in the key folder on first use.
 *
 * Steps in the onboarding epoch (E0):
 *   fund → deposits (lender1 junior, lender2 junior + senior, lender3 senior) → lender3's senior withdrawal request
 *   (processed later by cranks_app) → vote accounts ×3 (`solana create-vote-account … --commission <percent>`: the
 *   legacy `InitializeAccount`, as devnet has no VoteInitV2 yet; withdrawer = operator; topped up to the sweep floor)
 *   → onboarding ×3 (`onboard_validator` → `set_collectors` → `post_bond` in one transaction, payout = `rewards`)
 *   → the revenue token (where Meteora's DBC is deployed: launched by the validator's operator through
 *   `@epoch/meteora`'s launch CLI, then `register_revenue_token`).
 *
 * Every epoch from E0 on: sweeps, accrual, scores, the next epoch's revenue, the market (the maker takes back quotes
 * whose epoch has begun with no open swap and posts the missing ones of the next five epochs; the taker's swap once),
 * then each planned advance once its position has MIN_REVENUE_HISTORY sweeps.
 */
import fs from 'node:fs';
import path from 'node:path';

import * as sdk from '@epoch/epoch-sdk';
import { DAMM_V2_PROGRAM, DBC_PROGRAM } from '@epoch/meteora';
import { type Connection, type Keypair, PublicKey, SystemProgram } from '@solana/web3.js';

import { perByteFromRentOfZero, rentFromPerByte, sol } from '../lib/budget';
import { explorerUrl } from '../lib/cluster';
import { type Context } from '../lib/context';
import { KitError } from '../lib/errors';
import { type FundTarget, fundFromDeployer } from '../lib/funding';
import { REPO_ROOT, readKeypair } from '../lib/keys';
import { out, step } from '../lib/log';
import { loadParams } from '../lib/params';
import { confirm, run } from '../lib/run';
import { StateStore } from '../lib/state';
import { isRetryableProgramError, type Landed, sendTx, sendTxRetrying, sleep } from '../lib/tx';
import { parseVoteHeader } from '../lib/vote';
import { depositKey, revenueShortfall, type SeedProgress, walletNeeds } from '../seed/needs';
import { DEVNET_PLAN, quoteLamports, type RevenueTokenSeed, type SeedPlan, type ValidatorSeed } from '../seed/plan';
import { VOTE_ACCOUNT_SIZE } from './budget';
import { assertDeployed, programIdFrom } from './init';

export const SEED_OPTIONS = {
  'program-id': { type: 'string' },
  params: { type: 'string' },
  deployer: { type: 'string' },
  solana: { type: 'string' },
  wait: { type: 'boolean', default: false },
} as const;

export type SeedOptions = {
  [K in keyof typeof SEED_OPTIONS]?: (typeof SEED_OPTIONS)[K]['type'] extends 'boolean' ? boolean : string;
};

/** Seconds per slot from the cluster's recent performance samples (devnet ≈ 0.24 s with Alpenglow). */
async function slotSeconds(conn: Context['cluster']['connection']): Promise<number> {
  const samples = await conn.getRecentPerformanceSamples(5).catch(() => []);
  const slots = samples.reduce((a, x) => a + x.numSlots, 0);
  return slots > 0 ? samples.reduce((a, x) => a + x.samplePeriodSecs, 0) / slots : 0.4;
}

/** Metaplex token metadata: DBC creates the token's metadata through it. */
const METAPLEX_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

/** Are Meteora's DBC, DAMM v2 and Metaplex all deployed on this cluster (the launch CLI's pre-flight needs them)? */
export async function meteoraOnCluster(conn: Connection): Promise<boolean> {
  const infos = await conn.getMultipleAccountsInfo(
    [DBC_PROGRAM, DAMM_V2_PROGRAM, METAPLEX_PROGRAM].map((k) => new PublicKey(k)),
    'confirmed',
  );
  return infos.every((i) => !!i?.executable);
}

/** The launch CLI's config (`@epoch/meteora` `parseLaunchConfig`) for the seed's revenue token: no secrets. */
export function revenueTokenLaunchConfig(
  token: RevenueTokenSeed,
  v: Pick<ValidatorSeed, 'name' | 'revenuePerEpoch'>,
  vote: PublicKey,
  operator: PublicKey,
): Record<string, unknown> {
  return {
    validator: { name: `Epoch devnet ${v.name}`, vote: vote.toBase58() },
    symbol: token.symbol,
    name: token.name,
    uri: token.uri,
    shareBps: token.shareBps,
    termEpochs: token.termEpochs,
    // The curve is priced from the revenue the seed simulates (the vote account is not on mainnet).
    avgRevenueSol: Number(v.revenuePerEpoch) / 1e9,
    supply: token.supply,
    decimals: token.decimals,
    raiseTargetSol: Number(token.raiseTarget) / 1e9,
    tradingFeeBps: 100,
    dammFeeBps: 100,
    // The operator pays and stays the pool creator (no hand-over), and makes the first buy.
    creator: operator.toBase58(),
    initialBuySol: Number(token.firstBuy) / 1e9,
  };
}

/** Epochs of the maker's quotes this state file recorded and has not taken back yet. */
export function openQuoteEpochs(steps: Record<string, unknown>): bigint[] {
  return Object.keys(steps)
    .map((id) => /^quote:(\d+)$/.exec(id)?.[1])
    .filter((e): e is string => !!e && !(`quote-back:${e}` in steps))
    .map((e) => BigInt(e))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Key-folder names of a test validator's vote and identity keypairs. */
export function validatorKeyNames(v: Pick<ValidatorSeed, 'name'>): { vote: string; identity: string } {
  return { vote: `${v.name}-vote`, identity: `${v.name}-identity` };
}

/** Top-ups for the seed wallets: the remaining steps' needs, refilled once below needs minus half a fee float. */
export function seedFundTargets(needs: Map<string, bigint>, wallets: Map<string, PublicKey>, feeFloat: bigint) {
  return [...needs].map(([label, lamports]): FundTarget => ({
    label,
    to: wallets.get(label)!,
    lamports,
    refillBelow: lamports - feeFloat / 2n,
  }));
}

export async function runSeed(ctx: Context, o: SeedOptions, plan: SeedPlan = DEVNET_PLAN): Promise<void> {
  if (!ctx.keys || !ctx.stateDir) throw new KitError('BAD_ARGS', '--keys is required');
  const keys = ctx.keys;
  const conn = ctx.cluster.connection;
  const programId = programIdFrom(o['program-id']);
  await assertDeployed(ctx, programId);
  const params = loadParams(o.params);
  const deployer = o.deployer ? readKeypair(o.deployer) : keys.get('deployer');
  const [pool] = sdk.findPoolPda(programId);
  const poolInfo = await conn.getAccountInfo(pool, 'confirmed');
  if (!poolInfo) throw new KitError('NOT_INITIALIZED', `no pool at ${pool.toBase58()}; run init first`);
  const state = new StateStore(ctx.stateDir, 'seed', ctx.cluster.name, ctx.cluster.genesisHash, programId.toBase58());
  const rent = rentFromPerByte(perByteFromRentOfZero(BigInt(await conn.getMinimumBalanceForRentExemption(0))));
  const send = (label: string, ixs: Parameters<typeof sendTx>[2], signers: Keypair[]) =>
    sendTx(conn, label, ixs, signers, { microLamportsPerCu: ctx.priorityFee, programId });
  const link = (sig: string) => explorerUrl('tx', sig, ctx.cluster);
  const record = (id: string, tx: Landed, extra: Record<string, unknown> = {}) =>
    state.record(id, { signature: tx.signature, slot: tx.slot, ...extra });

  const wallet = (name: string): Keypair => keys.getOrCreate(name);
  const wallets = new Map<string, PublicKey>();
  const names = [...new Set([...plan.deposits.map((d) => d.lender), plan.swap.taker])];
  for (const n of [...names, ...new Set(plan.validators.map((v) => v.operator)), 'maker', 'rewards']) {
    wallets.set(n, wallet(n).publicKey);
  }
  const vals = plan.validators.map((v) => {
    const k = validatorKeyNames(v);
    const vote = keys.getOrCreate(k.vote).publicKey;
    return {
      v,
      vote,
      identity: keys.getOrCreate(k.identity).publicKey,
      operator: wallet(v.operator),
      position: sdk.findPositionPda(programId, vote)[0],
      voteAuth: sdk.findVoteAuthPda(programId, vote)[0],
      escrow: sdk.findEscrowPda(programId, vote)[0],
    };
  });
  out(`seed on ${ctx.cluster.name}: program ${programId.toBase58()}, pool ${pool.toBase58()}`);
  const maker = wallet('maker');
  const taker = wallet(plan.swap.taker);
  const quoteAt = (epoch: bigint) => sdk.findQuotePda(programId, maker.publicKey, epoch)[0];
  const token = plan.revenueToken;
  const tokenVal = token ? vals.find((x) => x.v.name === token.validator) : undefined;
  if (token && !tokenVal) throw new KitError('BAD_ARGS', `revenue token validator ${token.validator} is not seeded`);
  const meteora = token ? await meteoraOnCluster(conn) : false;
  if (token && !meteora) {
    step(`Meteora's DBC, DAMM v2 or Metaplex is not on ${ctx.cluster.name}: the revenue token is skipped`);
  }
  // The swap is open once recorded, or when the quote it would use already has the taker's swap (a crash between
  // sending and recording).
  const swapOpen = async (): Promise<boolean> => {
    if (state.done('swap')) return true;
    const e = BigInt((await conn.getEpochInfo('confirmed')).epoch) + BigInt(plan.swap.epochsAhead);
    return !!(await conn.getAccountInfo(sdk.findSwapPda(programId, quoteAt(e), taker.publicKey)[0], 'confirmed'));
  };
  const revenueTokenRegistered = async (): Promise<boolean> =>
    !!tokenVal && !!(await conn.getAccountInfo(sdk.findRevenueTokenPda(programId, tokenVal.vote)[0], 'confirmed'));

  // What is already on chain.
  const progress = async (): Promise<SeedProgress> => {
    const p: SeedProgress = {
      deposited: new Set(),
      withdrawalRequested: !!state.done('withdraw-request'),
      voteAccounts: new Set(),
      onboarded: new Set(),
      revenueMissing: new Map(),
      advanced: new Set(),
      swapOpen: await swapOpen(),
      revenueTokenDone: !token || !meteora || (await revenueTokenRegistered()),
    };
    for (const d of plan.deposits) {
      const info = await conn.getAccountInfo(sdk.findLenderPda(programId, pool, wallets.get(d.lender)!, d.tranche)[0]);
      if (info && sdk.decodeLenderShares(info.data).totalDeposited >= d.lamports) {
        p.deposited.add(depositKey(d.lender, d.tranche));
      }
    }
    for (const x of vals) {
      const voteInfo = await conn.getAccountInfo(x.vote, 'confirmed');
      if (voteInfo) {
        p.voteAccounts.add(x.v.name);
        const floor = rent(voteInfo.data.length) + params.voteReserveLamports;
        p.revenueMissing.set(x.v.name, revenueShortfall(BigInt(voteInfo.lamports), floor, x.v.revenuePerEpoch));
      }
      const posInfo = await conn.getAccountInfo(x.position, 'confirmed');
      if (posInfo) {
        p.onboarded.add(x.v.name);
        const pos = sdk.decodeValidatorPosition(posInfo.data);
        if (pos.openAdvance || pos.advanceSeq > 0n) p.advanced.add(x.v.name);
      }
    }
    return p;
  };
  let done = await progress();

  // 1. Fund the seed wallets for the remaining steps.
  const needs = walletNeeds(
    plan,
    rent,
    { voteAccount: VOTE_ACCOUNT_SIZE, voteReserve: params.voteReserveLamports },
    done,
  );
  await confirm(`Fund seed wallets from ${deployer.publicKey.toBase58()} and seed ${ctx.cluster.name}?`, ctx.yes);
  const funded = await fundFromDeployer(
    conn,
    deployer,
    seedFundTargets(needs, wallets, plan.feeFloat),
    ctx.priorityFee,
  );
  for (const t of funded.sent) step(`funded ${t.label} +${sol(t.send)} SOL`);
  if (funded.txs.length) state.record(`fund:${Date.now()}`, { signatures: funded.txs.map((t) => t.signature) });
  else step('seed wallets hold what the remaining steps need');

  // 2. Deposits.
  for (const d of plan.deposits) {
    const id = `deposit:${depositKey(d.lender, d.tranche)}`;
    if (done.deposited.has(depositKey(d.lender, d.tranche))) {
      step(`${id} already on chain`);
      continue;
    }
    const tx = await send(
      id,
      sdk.deposit({ programId, owner: wallets.get(d.lender)!, tranche: d.tranche, lamports: d.lamports }),
      [wallet(d.lender)],
    );
    record(id, tx, { lamports: d.lamports.toString() });
    step(`${id} ${sol(d.lamports)} SOL ✓ ${link(tx.signature)}`);
  }

  // 3. A senior withdrawal request for the crank to process later.
  if (!done.withdrawalRequested) {
    const w = plan.withdrawal;
    const p = sdk.decodePool((await conn.getAccountInfo(pool, 'confirmed'))!.data);
    const [assets, shares] =
      w.tranche === 'senior' ? [p.seniorAssets, p.seniorShares] : [p.juniorAssets, p.juniorShares];
    const sharesOut = sdk.assetsToShares(w.lamports, assets, shares);
    const tx = await send(
      'request_withdraw',
      sdk.requestWithdraw({
        programId,
        owner: wallets.get(w.lender)!,
        tranche: w.tranche,
        shares: sharesOut,
        withdrawTail: p.withdrawTail,
      }),
      [wallet(w.lender)],
    );
    record('withdraw-request', tx, { seq: p.withdrawTail.toString(), shares: sharesOut.toString() });
    step(`request_withdraw ${w.lender} ${w.tranche} seq ${p.withdrawTail} ✓ ${link(tx.signature)}`);
  } else step('withdrawal request already made');

  // 4. Vote accounts (legacy init), topped up to the sweep floor so every lamport added later is revenue.
  const solana = o.solana ?? 'solana';
  for (const x of vals) {
    const id = `vote:${x.v.name}`;
    if (!done.voteAccounts.has(x.v.name)) {
      const k = validatorKeyNames(x.v);
      const operatorPath = keys.path(x.v.operator);
      run(
        solana,
        [
          'create-vote-account',
          keys.path(k.vote),
          keys.path(k.identity),
          x.operator.publicKey.toBase58(),
          '--commission',
          String(x.v.commissionPercent),
          '--keypair',
          operatorPath,
          '--fee-payer',
          operatorPath,
          '--url',
          ctx.cluster.rpcUrl,
          '--commitment',
          'confirmed',
          ...(ctx.priorityFee > 0n ? ['--with-compute-unit-price', ctx.priorityFee.toString()] : []),
        ],
        { label: 'solana create-vote-account' },
      );
    }
    const info = await conn.getAccountInfo(x.vote, 'confirmed');
    if (!info) throw new KitError('CHECK_FAILED', `vote account ${x.vote.toBase58()} was not created`);
    const floor = rent(info.data.length) + params.voteReserveLamports;
    const have = BigInt(info.lamports);
    if (have < floor && !done.onboarded.has(x.v.name)) {
      const tx = await send(
        `top up ${x.v.name}`,
        [SystemProgram.transfer({ fromPubkey: x.operator.publicKey, toPubkey: x.vote, lamports: floor - have })],
        [x.operator],
      );
      state.record(`${id}:floor`, { signature: tx.signature, slot: tx.slot });
    }
    if (!state.done(id)) state.record(id, { vote: x.vote.toBase58(), identity: x.identity.toBase58() });
    step(`${id} ${x.vote.toBase58()} (identity ${x.identity.toBase58()}, ${info.data.length} bytes)`);
  }

  // 5. Onboarding: withdraw authority to the program, collectors to the escrow, bond.
  done = await progress();
  for (const x of vals) {
    const id = `onboard:${x.v.name}`;
    if (!done.onboarded.has(x.v.name)) {
      const tx = await send(
        id,
        sdk.onboardWithBond({
          programId,
          operator: x.operator.publicKey,
          currentWithdrawer: x.operator.publicKey,
          vote: x.vote,
          payout: wallets.get('rewards')!,
          bondLamports: x.v.bond,
          setCollectors: true,
        }),
        [x.operator],
      );
      record(id, tx);
      step(`${id} ✓ ${link(tx.signature)}`);
    } else step(`${id} already on chain`);
    const voteInfo = await conn.getAccountInfo(x.vote, 'confirmed');
    if (!voteInfo || !parseVoteHeader(voteInfo.data).authorizedWithdrawer.equals(x.voteAuth)) {
      throw new KitError('CHECK_FAILED', `${x.v.name}: the vote account's withdrawer is not the vote_auth PDA`);
    }
  }

  // 6. The revenue token, once: launched on Meteora's DBC by the validator's operator (payer and pool creator, first
  //    buy included) through `@epoch/meteora`'s launch CLI, with the Epoch treasury PDA as fee claimer and leftover
  //    receiver, then registered by the same operator (`register_revenue_token`). A launch that landed without its
  //    registration is registered from the launch record (`register`). Records live next to the seed state.
  let tokenError: string | null = null;
  if (token && tokenVal && meteora && !(await revenueTokenRegistered())) {
    const registry = path.join(ctx.stateDir, `launches-${ctx.cluster.genesisHash.slice(0, 8)}.json`);
    const configFile = path.join(ctx.stateDir, `revenue-token-${ctx.cluster.genesisHash.slice(0, 8)}.json`);
    fs.writeFileSync(
      configFile,
      `${JSON.stringify(revenueTokenLaunchConfig(token, tokenVal.v, tokenVal.vote, tokenVal.operator.publicKey), null, 2)}\n`,
    );
    const launched = fs.existsSync(registry)
      ? (JSON.parse(fs.readFileSync(registry, 'utf8')) as { symbol?: string; dbcPool?: string }[]).some(
          (e) => e.symbol === token.symbol && !!e.dbcPool,
        )
      : false;
    const common = [
      '--cluster',
      'devnet',
      '--rpc',
      ctx.cluster.rpcUrl,
      '--registry',
      registry,
      '--program-id',
      programId.toBase58(),
      '--priority-fee',
      ctx.priorityFee.toString(),
      '--execute',
      '--yes',
      ...(ctx.cluster.name === 'devnet' ? [] : ['--allow-unknown-genesis']),
    ];
    const operatorPath = keys.path(tokenVal.v.operator);
    const env = {
      LAUNCH_KEYPAIR_PATH: operatorPath,
      LAUNCH_OPERATOR_KEYPAIR_PATH: operatorPath,
      EPOCH_PROGRAM_ID: programId.toBase58(),
    };
    step(
      `revenue token ${token.symbol} on ${tokenVal.v.name}: ${launched ? 'registering the launched token' : 'launching on DBC'}`,
    );
    // A failed launch stops only this step (its pre-flight sends nothing): the rest of the seed runs, and the seed exits
    // with the error at the end so a re-run retries it.
    try {
      run(
        'pnpm',
        launched
          ? ['-s', '--filter', '@epoch/meteora', 'register', '--', '--symbol', token.symbol, ...common]
          : [
              '-s',
              '--filter',
              '@epoch/meteora',
              'launch',
              '--',
              '--config',
              configFile,
              '--revenue',
              'config',
              '--skip-uri-check',
              ...common,
            ],
        { label: launched ? 'meteora register' : 'meteora launch', cwd: REPO_ROOT, env, inherit: true },
      );
      if (!(await revenueTokenRegistered())) throw new KitError('CHECK_FAILED', 'register_revenue_token did not land');
    } catch (e) {
      tokenError = `${token.symbol}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
      step(`revenue token ${token.symbol} not launched (${tokenError}); the rest of the seed goes on`);
    }
  }
  if (token && tokenVal && meteora && !tokenError) {
    const [rtPda] = sdk.findRevenueTokenPda(programId, tokenVal.vote);
    const rt = sdk.decodeRevenueToken((await conn.getAccountInfo(rtPda, 'confirmed'))!.data);
    if (!state.done('revenue-token')) {
      state.record('revenue-token', {
        revenueToken: rtPda.toBase58(),
        mint: rt.mint.toBase58(),
        dbcPool: rt.dbcPool.toBase58(),
        startEpoch: Number(rt.startEpoch),
      });
    }
    step(
      `revenue token ${token.symbol}: mint ${rt.mint.toBase58()}, DBC pool ${rt.dbcPool.toBase58()}, ${rt.shareBps} bps for epochs ${rt.startEpoch}–${rt.termEndEpoch - 1n}`,
    );
  }

  state.setData('accounts', {
    wallets: Object.fromEntries([...wallets].map(([k, v]) => [k, v.toBase58()])),
    validators: vals.map((x) => ({
      name: x.v.name,
      vote: x.vote.toBase58(),
      identity: x.identity.toBase58(),
      operator: x.operator.publicKey.toBase58(),
      position: x.position.toBase58(),
      voteAuth: x.voteAuth.toBase58(),
      escrow: x.escrow.toBase58(),
    })),
  });
  // 6. Every epoch from E0 on: sweeps (cranks_app sweeps too; whoever comes first), accrual, scores, then the next
  //    epoch's simulated revenue, and each planned advance once its position has MIN_REVENUE_HISTORY sweeps.
  const cranker = keys.getOrCreate('cranker');
  const scorer = keys.getOrCreate('scorer');
  const rewards = wallet('rewards');
  const borrowers = vals.filter((x) => x.v.advance > 0n);
  const position = async (x: (typeof vals)[number]) =>
    sdk.decodeValidatorPosition((await conn.getAccountInfo(x.position, 'confirmed'))!.data);

  // The market, every epoch: the maker takes back quotes whose epoch has begun and that hold no open swap (collateral
  // and rent return to it), then posts the missing quotes of the next `epochsAhead` epochs, topped up from the deployer
  // only for what the returned quotes do not cover; each quote expires at its epoch's first slot, when trading on it
  // closes. The taker's swap is opened once, on the quote `swap.epochsAhead` epochs out.
  const liveEpoch = async () => BigInt((await conn.getEpochInfo('confirmed')).epoch);
  const marketSteps = async (epoch: bigint): Promise<void> => {
    const begun = await liveEpoch();
    for (const e of openQuoteEpochs(state.state.steps)) {
      if (e > begun) continue;
      const info = await conn.getAccountInfo(quoteAt(e), 'confirmed');
      if (!info) {
        state.record(`quote-back:${e}`, { note: 'already closed' });
        continue;
      }
      if (sdk.decodeFeeQuote(info.data).openSwaps > 0) continue;
      const tx = await send(`withdraw_quote ${e}`, sdk.withdrawQuote({ programId, maker: maker.publicKey, epoch: e }), [
        maker,
      ]);
      record(`quote-back:${e}`, tx);
      step(`epoch ${epoch}: withdraw_quote for epoch ${e} ✓ ${link(tx.signature)}`);
    }
    // Quotes and the swap read the live epoch: on a short-epoch cluster the boundary can pass while the epoch's other
    // steps run, and the program refuses a quote for the current epoch (QuoteEpochMismatch) or a swap whose epoch has
    // begun (QuoteExpired); those are retried with the new epoch.
    const postMissingQuotes = async (): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        const now = await liveEpoch();
        const missing: bigint[] = [];
        for (let k = 1n; k <= BigInt(plan.quotes.epochsAhead); k++) {
          if (!(await conn.getAccountInfo(quoteAt(now + k), 'confirmed'))) missing.push(now + k);
        }
        if (!missing.length) break;
        const need = quoteLamports(plan, rent) * BigInt(missing.length);
        const topUp = await fundFromDeployer(
          conn,
          deployer,
          [
            {
              label: 'maker',
              to: maker.publicKey,
              lamports: need + plan.feeFloat,
              refillBelow: need + plan.feeFloat / 2n,
            },
          ],
          ctx.priorityFee,
        );
        for (const t of topUp.sent) step(`funded ${t.label} +${sol(t.send)} SOL`);
        const schedule = await conn.getEpochSchedule();
        try {
          const tx = await send(
            `post_quote ×${missing.length}`,
            missing.flatMap((e) =>
              sdk.postQuote({
                programId,
                maker: maker.publicKey,
                epoch: e,
                fixedRate: plan.quotes.fixedRate,
                maxNotional: plan.quotes.maxNotional,
                maxMoveBps: plan.quotes.maxMoveBps,
                expirySlot: BigInt(schedule.getFirstSlotInEpoch(Number(e))),
              }),
            ),
            [maker],
          );
          for (const e of missing) record(`quote:${e}`, tx, { quote: quoteAt(e).toBase58() });
          step(`epoch ${now}: post_quote for epochs ${missing.join(', ')} ✓ ${link(tx.signature)}`);
          break;
        } catch (e) {
          if (attempt >= 3 || !isRetryableProgramError(e, ['QuoteEpochMismatch'])) throw e;
          step(`epoch ${now} ended while quoting; quoting again from the new epoch`);
        }
      }
    };
    await postMissingQuotes();
    for (let attempt = 1; !(await swapOpen()); attempt++) {
      const e = (await liveEpoch()) + BigInt(plan.swap.epochsAhead);
      const quote = quoteAt(e);
      try {
        const tx = await send(
          `open_swap ${plan.swap.taker}`,
          sdk.openSwap({
            programId,
            taker: taker.publicKey,
            quote,
            side: plan.swap.side,
            notionalLamports: plan.swap.notional,
          }),
          [taker],
        );
        record('swap', tx, {
          epoch: Number(e),
          quote: quote.toBase58(),
          swap: sdk.findSwapPda(programId, quote, taker.publicKey)[0].toBase58(),
        });
        step(
          `epoch ${e - BigInt(plan.swap.epochsAhead)}: open_swap ${plan.swap.taker} ${plan.swap.side} ${sol(plan.swap.notional)} SOL on epoch ${e} ✓ ${link(tx.signature)}`,
        );
      } catch (err) {
        // The epoch moved on: post the new epoch's missing quotes, then open the swap on the new next epoch.
        if (attempt >= 3 || !isRetryableProgramError(err, ['QuoteExpired', 'AccountNotInitialized'])) throw err;
        step(`epoch ${e - BigInt(plan.swap.epochsAhead)} ended before the swap; trying again`);
        await postMissingQuotes();
      }
    }
  };

  // Simulated commission into the vote accounts, from the rewards wallet (topped up from the deployer): only what each
  // vote account does not hold yet above its sweep floor.
  const sendRevenue = async (targets: typeof vals, recordId: string, what: string, epoch: bigint): Promise<void> => {
    const missing = (await progress()).revenueMissing;
    const transfers = targets
      .map((x) => ({ x, lamports: missing.get(x.v.name) ?? x.v.revenuePerEpoch }))
      .filter((t) => t.lamports > 0n);
    if (!transfers.length) return;
    const total = transfers.reduce((a, t) => a + t.lamports, 0n);
    const topUp = await fundFromDeployer(
      conn,
      deployer,
      [
        {
          label: 'rewards',
          to: rewards.publicKey,
          lamports: total + plan.feeFloat,
          refillBelow: total + plan.feeFloat / 2n,
        },
      ],
      ctx.priorityFee,
    );
    for (const t of topUp.sent) step(`funded ${t.label} +${sol(t.send)} SOL`);
    const tx = await send(
      what,
      transfers.map((t) =>
        SystemProgram.transfer({ fromPubkey: rewards.publicKey, toPubkey: t.x.vote, lamports: t.lamports }),
      ),
      [rewards],
    );
    record(recordId, tx, { lamports: total.toString() });
    step(`epoch ${epoch}: ${sol(total)} SOL of ${what} ✓ ${link(tx.signature)}`);
  };

  const epochSteps = async (epoch: bigint): Promise<void> => {
    // A vote account still short of one epoch's revenue when its sweep is due (the boundary passed before the seed
    // sent it, e.g. while E0's steps ran) gets it first, so no sweep records an empty epoch in the credit history.
    const due: typeof vals = [];
    for (const x of vals) if ((await position(x)).lastSweptEpoch < (await liveEpoch())) due.push(x);
    await sendRevenue(due, `revenue-owed:${epoch}`, 'revenue owed before the sweep', epoch);
    for (const x of vals) {
      const pos = await position(x);
      if (pos.lastSweptEpoch >= epoch) continue;
      const tx = await sendTxRetrying(
        conn,
        `sweep ${x.v.name}`,
        sdk.sweepPosition({ programId, cranker: cranker.publicKey, position: pos }),
        [cranker],
        { microLamportsPerCu: ctx.priorityFee, programId, retryOn: ['RewardsInProgress'] },
      );
      record(`sweep:${x.v.name}:${epoch}`, tx);
      step(`epoch ${epoch}: sweep ${x.v.name} ✓ ${link(tx.signature)}`);
    }
    const p0 = sdk.decodePool((await conn.getAccountInfo(pool, 'confirmed'))!.data);
    if (p0.lastAccruedEpoch < epoch) {
      const tx = await send('accrue', sdk.accrue({ programId, cranker: cranker.publicKey, treasury: p0.treasury }), [
        cranker,
      ]);
      record(`accrue:${epoch}`, tx);
      step(`epoch ${epoch}: accrue ✓ ${link(tx.signature)}`);
    }
    const unscored: typeof vals = [];
    for (const x of vals) if ((await position(x)).lastScoredEpoch < epoch) unscored.push(x);
    if (unscored.length && p0.scorer.equals(scorer.publicKey)) {
      const tx = await send(
        `update_score ×${unscored.length}`,
        unscored.flatMap((x) =>
          sdk.updateScore({ programId, scorer: scorer.publicKey, vote: x.vote, update: x.v.score }),
        ),
        [scorer],
      );
      record(`score:${epoch}`, tx);
      step(`epoch ${epoch}: update_score ×${unscored.length} ✓ ${link(tx.signature)}`);
    } else if (unscored.length) {
      step(`epoch ${epoch}: scores skipped (the pool's scorer is ${p0.scorer.toBase58()}, not the key folder's)`);
    }
    // The next epoch's revenue: only what each vote account does not hold yet above its sweep floor.
    await sendRevenue(vals, `revenue:${epoch + 1n}`, `simulated revenue for epoch ${epoch + 1n}`, epoch);
    await marketSteps(epoch);
    for (const x of borrowers) {
      const pos = await position(x);
      if (pos.openAdvance || pos.advanceSeq > 0n || pos.revenueCount < sdk.PROGRAM_CONSTANTS.MIN_REVENUE_HISTORY) {
        continue;
      }
      const limit = sdk.creditLimit({
        trailingRevenue: sdk.trailingRevenue(pos),
        historyEpochs: pos.revenueCount,
        advanceBps: pos.hedged ? p0.params.advanceBpsHedged : p0.params.advanceBpsUnhedged,
        bondLamports: pos.bondLamports,
        bondMultiplier: p0.params.bondMultiplier,
        capLamports: p0.params.maxAdvanceLamports,
      });
      if (x.v.advance > limit) {
        throw new KitError(
          'CHECK_FAILED',
          `${x.v.name}: planned advance ${sol(x.v.advance)} SOL is over its credit limit ${sol(limit)} SOL`,
        );
      }
      const tx = await send(
        `request_advance ${x.v.name}`,
        sdk.requestAdvance({
          programId,
          operator: x.operator.publicKey,
          vote: x.vote,
          payout: pos.payout,
          advanceSeq: pos.advanceSeq,
          lamports: x.v.advance,
        }),
        [x.operator],
      );
      record(`advance:${x.v.name}`, tx, { lamports: x.v.advance.toString(), limit: limit.toString() });
      step(
        `epoch ${epoch}: request_advance ${x.v.name} ${sol(x.v.advance)} SOL (limit ${sol(limit)}) ✓ ${link(tx.signature)}`,
      );
    }
  };

  for (;;) {
    const info = await conn.getEpochInfo('confirmed');
    const epoch = BigInt(info.epoch);
    await epochSteps(epoch);
    done = await progress();
    const pending = borrowers.filter((x) => !done.advanced.has(x.v.name));
    if (!pending.length) break;
    const sweepsLeft = Math.max(
      ...(await Promise.all(
        pending.map(async (x) => sdk.PROGRAM_CONSTANTS.MIN_REVENUE_HISTORY - (await position(x)).revenueCount),
      )),
    );
    const now = await conn.getEpochInfo('confirmed');
    const seconds =
      (now.slotsInEpoch - now.slotIndex + (sweepsLeft - 1) * now.slotsInEpoch) * (await slotSeconds(conn));
    const at = new Date(Date.now() + seconds * 1000).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    step(`next: ${sweepsLeft} more sweep(s) before the advance; epoch ${epoch + BigInt(sweepsLeft)} ≈ ${at} IST`);
    if (!o.wait) break;
    while (BigInt((await conn.getEpochInfo('confirmed')).epoch) <= epoch) await sleep(2_000);
  }

  const p = sdk.decodePool((await conn.getAccountInfo(pool, 'confirmed'))!.data);
  if (tokenError)
    throw new KitError('CHECK_FAILED', `the revenue token failed (${tokenError}); run seed again to retry it`);
  step(
    `seeded: senior ${sol(p.seniorAssets)} SOL, junior ${sol(p.juniorAssets)} SOL, ${p.validators} validators, bonds ${sol(p.bondTotal)} SOL, lent ${sol(p.outstandingPrincipal)} SOL; state ${state.file}`,
  );
}
