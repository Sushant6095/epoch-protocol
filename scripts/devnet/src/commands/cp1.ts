/**
 * `pnpm devnet cp1 --url devnet|testnet --keys <dir> [--program-id <id>] [--deployer <path>] [--out <md>] [--wait]`
 *
 * The CP1 mechanism proof (docs/IMPLEMENTATION_PLAN.md F1) with the real instructions, on a throwaway vote account
 * (legacy init) whose withdraw authority the program takes, uses and gives back:
 *   0. control: a direct vote-program `UpdateCommission` decrease signed by the original withdrawer succeeds
 *      (decreases are allowed at any time, so the later failure can only be the authority);
 *   1. `onboard_validator`: program CPI `Authorize(Withdrawer → vote_auth PDA)`, co-signed by the original withdrawer;
 *   2. `set_collectors`: program CPI `UpdateCommissionCollector` (both collectors → escrow), signed by the PDA;
 *   3. a direct `UpdateCommission` decrease by the original withdrawer, sent without preflight: it lands and fails;
 *   4. next epoch: a revenue transfer into the vote account, then `sweep`: program CPI `Withdraw` signed by the PDA;
 *   5. `release_validator`: CPIs `UpdateCommissionCollector` back and `Authorize(Withdrawer → original)`, then a direct
 *      `UpdateCommission` by the original key succeeds again (closing control).
 * Steps 0–3 run at once; 4–5 need the next epoch: `--wait` blocks, otherwise re-run after the boundary (resumable,
 * state keyed to the genesis hash). Writes signatures and explorer links to `--out` (default `docs/cp1-results.md` on
 * devnet and testnet, the state folder elsewhere so a rehearsal never lands in the repo).
 */
import fs from 'node:fs';
import path from 'node:path';

import * as sdk from '@epoch/epoch-sdk';
import { SystemProgram } from '@solana/web3.js';

import { perByteFromRentOfZero, rentFromPerByte, sol } from '../lib/budget';
import { explorerUrl } from '../lib/cluster';
import { type Context } from '../lib/context';
import { KitError } from '../lib/errors';
import { fundFromDeployer } from '../lib/funding';
import { readKeypair, REPO_ROOT } from '../lib/keys';
import { ist, out, step } from '../lib/log';
import { loadParams } from '../lib/params';
import { confirm, run } from '../lib/run';
import { StateStore, type StepRecord } from '../lib/state';
import { type Landed, sendTx, sendTxRetrying, sleep } from '../lib/tx';
import { parseVoteHeader, type VoteHeader, voteUpdateCommission } from '../lib/vote';
import { CP1_REVENUE, cp1Lines } from './budget';
import { assertDeployed, programIdFrom } from './init';

export const CP1_OPTIONS = {
  'program-id': { type: 'string' },
  deployer: { type: 'string' },
  params: { type: 'string' },
  out: { type: 'string' },
  solana: { type: 'string' },
  wait: { type: 'boolean', default: false },
} as const;

export type Cp1Options = {
  [K in keyof typeof CP1_OPTIONS]?: (typeof CP1_OPTIONS)[K]['type'] extends 'boolean' ? boolean : string;
};

/** Commission of the throwaway vote account at creation (percent), then the two decreases and the closing one. */
export const CP1_COMMISSION = { initial: 10, control: 9, refused: 8, closing: 8 } as const;

/** The proof's steps in order, with what each one shows (used for the results file). */
export const CP1_STEPS = [
  ['control-before', '0. Direct `UpdateCommission` by the original withdrawer succeeds (control)'],
  ['onboard', '1. `onboard_validator`: CPI `Authorize(Withdrawer → vote_auth PDA)`'],
  ['set-collectors', '2. `set_collectors`: CPI `UpdateCommissionCollector` (both → escrow), PDA-signed'],
  ['direct-update-refused', '3. Direct `UpdateCommission` by the original withdrawer lands and **fails**'],
  ['revenue', '4a. Revenue transfer into the vote account (next epoch)'],
  ['sweep', '4b. `sweep`: CPI `Withdraw`, PDA-signed'],
  ['release', '5. `release_validator`: CPIs `UpdateCommissionCollector` back and `Authorize(Withdrawer → original)`'],
  ['control-after', '5b. Direct `UpdateCommission` by the original withdrawer succeeds again'],
] as const;

export function resultsMarkdown(input: {
  cluster: string;
  genesisHash: string;
  programId: string;
  vote: string;
  identity: string;
  withdrawer: string;
  voteAuth: string;
  escrow: string;
  steps: Record<string, StepRecord | undefined>;
  link: (sig: string) => string;
  writtenAt: string;
}): string {
  const rows = CP1_STEPS.map(([id, what]) => {
    const r = input.steps[id];
    if (!r) return `| ${what} | pending | |`;
    const sig = r.signature ? `[${r.signature.slice(0, 16)}…](${input.link(r.signature)})` : '';
    const outcome = r.err ? `failed as expected: \`${String(r.err)}\`` : 'succeeded';
    return `| ${what} | ${outcome} | ${sig} |`;
  });
  const complete = CP1_STEPS.every(([id]) => input.steps[id]);
  return [
    '# CP1 results',
    '',
    `Written by \`pnpm devnet cp1\` on ${input.writtenAt}. Cluster **${input.cluster}** (genesis \`${input.genesisHash}\`),`,
    `program \`${input.programId}\`. ${complete ? 'All steps passed.' : 'Steps 4–5 run after the next epoch boundary.'}`,
    '',
    `Throwaway vote account \`${input.vote}\` (identity \`${input.identity}\`, original withdrawer \`${input.withdrawer}\`),`,
    `vote_auth PDA \`${input.voteAuth}\`, escrow PDA \`${input.escrow}\`.`,
    '',
    '| Step | Result | Signature |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

export async function runCp1(ctx: Context, o: Cp1Options): Promise<void> {
  if (!ctx.keys || !ctx.stateDir) throw new KitError('BAD_ARGS', '--keys is required');
  const keys = ctx.keys;
  const conn = ctx.cluster.connection;
  const programId = programIdFrom(o['program-id']);
  await assertDeployed(ctx, programId);
  const params = loadParams(o.params);
  const deployer = o.deployer ? readKeypair(o.deployer) : keys.get('deployer');
  const operator = keys.getOrCreate('cp1-operator');
  const voteKey = keys.getOrCreate('cp1-vote');
  const identity = keys.getOrCreate('cp1-identity').publicKey;
  const vote = voteKey.publicKey;
  const [position] = sdk.findPositionPda(programId, vote);
  const [voteAuth] = sdk.findVoteAuthPda(programId, vote);
  const [escrow] = sdk.findEscrowPda(programId, vote);
  const state = new StateStore(ctx.stateDir, 'cp1', ctx.cluster.name, ctx.cluster.genesisHash, programId.toBase58());
  const rent = rentFromPerByte(perByteFromRentOfZero(BigInt(await conn.getMinimumBalanceForRentExemption(0))));
  const link = (sig: string) => explorerUrl('tx', sig, ctx.cluster);
  const opts = { microLamportsPerCu: ctx.priorityFee, programId };
  const header = async (): Promise<VoteHeader> => {
    const info = await conn.getAccountInfo(vote, 'confirmed');
    if (!info) throw new KitError('CHECK_FAILED', `vote account ${vote.toBase58()} does not exist`);
    return parseVoteHeader(info.data);
  };
  const expectThat = (ok: boolean, what: string) => {
    if (!ok) throw new KitError('CHECK_FAILED', `CP1: ${what}`);
  };
  const doStep = async (id: string, fn: () => Promise<Landed>, extra?: (tx: Landed) => Record<string, unknown>) => {
    if (state.done(id)) return;
    const tx = await fn();
    state.record(id, {
      signature: tx.signature,
      slot: tx.slot,
      ...(tx.err ? { err: JSON.stringify(tx.err) } : {}),
      ...(extra?.(tx) ?? {}),
    });
    step(`${id} ${tx.err ? '(failed on chain, as it must)' : '✓'} ${link(tx.signature)}`);
  };
  out(`CP1 on ${ctx.cluster.name}: program ${programId.toBase58()}, vote ${vote.toBase58()}`);

  // Funding: vote account rent and reserve, position and escrow rent, the revenue, fees.
  const need = cp1Lines(rent, params.voteReserveLamports).reduce((a, l) => a + l.lamports, 0n);
  const firstRun = !(await conn.getAccountInfo(vote, 'confirmed'));
  await confirm(`Run CP1 on ${ctx.cluster.name} with a throwaway vote account?`, ctx.yes);
  if (firstRun) {
    const funded = await fundFromDeployer(
      conn,
      deployer,
      [{ label: 'cp1-operator', to: operator.publicKey, lamports: need }],
      ctx.priorityFee,
    );
    for (const t of funded.sent) step(`funded ${t.label} +${sol(t.send)} SOL`);
    run(
      o.solana ?? 'solana',
      [
        'create-vote-account',
        keys.path('cp1-vote'),
        keys.path('cp1-identity'),
        operator.publicKey.toBase58(),
        '--commission',
        String(CP1_COMMISSION.initial),
        '--keypair',
        keys.path('cp1-operator'),
        '--fee-payer',
        keys.path('cp1-operator'),
        '--url',
        ctx.cluster.rpcUrl,
        '--commitment',
        'confirmed',
      ],
      { label: 'solana create-vote-account' },
    );
    const info = (await conn.getAccountInfo(vote, 'confirmed'))!;
    const floor = rent(info.data.length) + params.voteReserveLamports;
    if (BigInt(info.lamports) < floor) {
      await sendTx(
        conn,
        'top up to the sweep floor',
        [
          SystemProgram.transfer({
            fromPubkey: operator.publicKey,
            toPubkey: vote,
            lamports: floor - BigInt(info.lamports),
          }),
        ],
        [operator],
        opts,
      );
    }
    state.record('vote-account', { vote: vote.toBase58(), identity: identity.toBase58() });
  }
  // `release_validator` gives the block revenue collector back to the identity, which the vote program accepts only
  // as a rent-exempt account: a real validator's identity always is; the throwaway one gets the minimum.
  const identityLamports = BigInt(await conn.getBalance(identity, 'confirmed'));
  if (identityLamports < rent(0)) {
    await sendTx(
      conn,
      'identity to its rent-exempt minimum',
      [
        SystemProgram.transfer({
          fromPubkey: operator.publicKey,
          toPubkey: identity,
          lamports: rent(0) - identityLamports,
        }),
      ],
      [operator],
      opts,
    );
  }

  // 0. Control before.
  await doStep('control-before', () =>
    sendTx(
      conn,
      'UpdateCommission (control)',
      [voteUpdateCommission(vote, operator.publicKey, CP1_COMMISSION.control)],
      [operator],
      opts,
    ),
  );
  // 1. onboard_validator.
  await doStep('onboard', () =>
    sendTx(
      conn,
      'onboard_validator',
      sdk.onboardValidator({
        programId,
        operator: operator.publicKey,
        currentWithdrawer: operator.publicKey,
        vote,
        payout: operator.publicKey,
      }),
      [operator],
      opts,
    ),
  );
  expectThat(
    (await header()).authorizedWithdrawer.equals(voteAuth) || !!state.done('release'),
    'withdrawer is not the vote_auth PDA',
  );
  // 2. set_collectors.
  await doStep('set-collectors', () =>
    sendTx(
      conn,
      'set_collectors',
      sdk.setCollectors({ programId, cranker: operator.publicKey, vote }),
      [operator],
      opts,
    ),
  );
  if (!state.done('release')) {
    const h = await header();
    expectThat(
      !!h.inflationRewardsCollector?.equals(escrow) && !!h.blockRevenueCollector?.equals(escrow),
      'collectors are not the escrow',
    );
  }
  // 3. The original withdrawer can no longer change the commission.
  await doStep('direct-update-refused', async () => {
    const tx = await sendTx(
      conn,
      'UpdateCommission by the original withdrawer',
      [voteUpdateCommission(vote, operator.publicKey, CP1_COMMISSION.refused)],
      [operator],
      { ...opts, allowFailure: true },
    );
    expectThat(!!tx.err, 'the direct UpdateCommission succeeded although the PDA holds the withdraw authority');
    return tx;
  });

  // 4–5 need the epoch after onboarding.
  //    The position is closed by the release, so a finished run is recognised by its recorded sweep.
  const posInfo = await conn.getAccountInfo(position, 'confirmed');
  const onboardEpoch = posInfo ? sdk.decodeValidatorPosition(posInfo.data).onboardedEpoch : null;
  const ready = async () =>
    !!state.done('sweep') ||
    (onboardEpoch !== null && BigInt((await conn.getEpochInfo('confirmed')).epoch) > onboardEpoch);
  while (!(await ready()) && o.wait) await sleep(2_000);
  if (!(await ready())) {
    step(`steps 4–5 need epoch ${(onboardEpoch ?? 0n) + 1n}; re-run cp1 after the boundary (or pass --wait)`);
  } else {
    await doStep('revenue', () =>
      sendTx(
        conn,
        'revenue',
        [SystemProgram.transfer({ fromPubkey: operator.publicKey, toPubkey: vote, lamports: CP1_REVENUE })],
        [operator],
        opts,
      ),
    );
    await doStep('sweep', () =>
      sendTxRetrying(
        conn,
        'sweep (CPI Withdraw)',
        sdk.sweep({ programId, cranker: operator.publicKey, vote, payout: operator.publicKey, openAdvance: null }),
        [operator],
        {
          ...opts,
          retryOn: ['RewardsInProgress'],
        },
      ),
    );
    await doStep('release', () =>
      sendTx(
        conn,
        'release_validator',
        sdk.releaseValidator({
          programId,
          operator: operator.publicKey,
          vote,
          newWithdrawer: operator.publicKey,
          identity,
        }),
        [operator],
        opts,
      ),
    );
    const h = await header();
    expectThat(h.authorizedWithdrawer.equals(operator.publicKey), 'withdraw authority not handed back');
    await doStep('control-after', () =>
      sendTx(
        conn,
        'UpdateCommission (closing control)',
        [voteUpdateCommission(vote, operator.publicKey, CP1_COMMISSION.closing)],
        [operator],
        opts,
      ),
    );
  }

  const outFile =
    o.out ??
    (ctx.cluster.name === 'devnet' || ctx.cluster.name === 'testnet'
      ? path.join(REPO_ROOT, 'docs/cp1-results.md')
      : path.join(ctx.stateDir, `cp1-results-${ctx.cluster.name}.md`));
  fs.writeFileSync(
    outFile,
    resultsMarkdown({
      cluster: ctx.cluster.name,
      genesisHash: ctx.cluster.genesisHash,
      programId: programId.toBase58(),
      vote: vote.toBase58(),
      identity: identity.toBase58(),
      withdrawer: operator.publicKey.toBase58(),
      voteAuth: voteAuth.toBase58(),
      escrow: escrow.toBase58(),
      steps: state.state.steps,
      link,
      writtenAt: ist(),
    }),
  );
  step(`results → ${outFile}`);
}
