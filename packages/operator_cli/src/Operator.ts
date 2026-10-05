import {
  findDbcPoolPda,
  findPartnerTreasuryPda,
  findPoolPda,
  findPositionPda,
  findRevenueTokenPda,
  findVoteAuthPda,
  parseEpochError,
} from '@epoch/epoch-sdk';
import { type SimulationResult } from '@epoch/solana';
import { type Keypair, type Signer } from '@solana/web3.js';

import { adminLabels, type AdminContext, parsePoolParams, planInitPool, planSetPaused, planSetRoles } from './Admin';
import { type Command } from './Cli';
import { describePlan, describeStatus } from './Describe';
import {
  addSignature,
  buildPartlySigned,
  decodeTransaction,
  describeTransaction,
  encodeTransaction,
  type Lifetime,
  submitProblems,
} from './Offline';
import { type OperatorChain } from './OperatorChain';
import {
  accountLabels,
  type OperatorContext,
  type Plan,
  planOnboard,
  planRegisterRevenueToken,
  planRelease,
  planSetCollectors,
  planUpdateCommission,
  planUpdateIdentity,
  planWithdrawBond,
} from './Plans';

export type OperatorChainLike = Pick<
  OperatorChain,
  | 'programId'
  | 'operator'
  | 'signer'
  | 'priorityFeeMicroLamports'
  | 'epoch'
  | 'position'
  | 'advance'
  | 'pool'
  | 'voteState'
  | 'accounts'
  | 'latestBlockhash'
  | 'nonce'
  | 'simulate'
  | 'send'
  | 'simulateSigned'
  | 'sendSigned'
>;

export interface OperatorIo {
  out: (text: string) => void;
  /** Asks a yes/no question; true only for an explicit yes. */
  confirm: (question: string) => Promise<boolean>;
  /** Loads a keypair file (a new identity, a withdrawer, the signer of sign-tx). */
  loadKeypair: (path: string) => Keypair;
  /** Explorer link for a signature on the program's cluster. */
  explorer: (signature: string) => string;
  readFile: (path: string) => string;
  writeFile: (path: string, text: string) => void;
}

type VoteCommand = Extract<
  Command,
  {
    name:
      | 'status'
      | 'update-commission'
      | 'update-identity'
      | 'withdraw-bond'
      | 'release'
      | 'set-collectors'
      | 'register-revenue-token';
  }
>;

/** Runs one command. Returns the process exit code. */
export async function runCommand(command: Command, chain: OperatorChainLike, io: OperatorIo): Promise<number> {
  switch (command.name) {
    case 'help':
      return 0;
    case 'init-pool':
    case 'set-roles':
    case 'set-paused':
      return runAdmin(command, chain, io);
    case 'onboard-validator':
      return runOnboard(command, chain, io);
    case 'sign-tx':
      return runSignTx(command, io);
    case 'submit-tx':
      return runSubmit(command, chain, io);
    default:
      return runVoteCommand(command, chain, io);
  }
}

function describeFailure(simulation: SimulationResult): string {
  const error = parseEpochError({ err: simulation.err, logs: simulation.logs });
  return [
    '',
    `Simulation failed: ${error ? `${error.name} (${error.code}): ${error.message}` : JSON.stringify(simulation.err)}`,
    ...simulation.logs.map((line) => `  ${line}`),
  ].join('\n');
}

/** Print, check, simulate; with `--send`, confirm and send. The flow every transaction command shares. */
async function execute(
  plan: Plan,
  labels: Map<string, string>,
  chain: OperatorChainLike,
  io: OperatorIo,
  dryRun: boolean,
  signers: Signer[] = [],
): Promise<number> {
  io.out(describePlan(plan, labels));
  if (plan.problems.length > 0) return 1;
  const simulation = await chain.simulate(plan.instructions);
  if (!simulation.ok) {
    io.out(describeFailure(simulation));
    return 1;
  }
  io.out(`\nSimulation passed (${simulation.unitsConsumed ?? '?'} compute units).`);
  if (dryRun) {
    io.out('Dry run: nothing sent. Run again with --send to send it.');
    return 0;
  }
  if (!(await io.confirm(`Send this transaction as ${chain.operator.toBase58()}? (y/N) `))) {
    io.out('Not sent.');
    return 1;
  }
  return sendAndReport(() => chain.send(plan.instructions, signers), io);
}

async function sendAndReport(send: () => Promise<string>, io: OperatorIo): Promise<number> {
  try {
    const signature = await send();
    io.out(`Sent: ${signature}\n${io.explorer(signature)}`);
    return 0;
  } catch (failure) {
    const details = (failure as { details?: { error?: unknown; logs?: unknown } }).details ?? {};
    const error = parseEpochError({ logs: details.logs, error: details.error ?? String(failure) });
    io.out(`Failed: ${error ? `${error.name}: ${error.message}` : String(details.error ?? failure)}`);
    return 1;
  }
}

async function runVoteCommand(command: VoteCommand, chain: OperatorChainLike, io: OperatorIo): Promise<number> {
  const vote = command.vote;
  const [position, pool, voteState, epoch] = await Promise.all([
    chain.position(vote),
    chain.pool(),
    chain.voteState(vote),
    chain.epoch(),
  ]);
  if (!position) {
    io.out(`${vote.toBase58()} is not onboarded with this Epoch program (${chain.programId.toBase58()}).`);
    return 1;
  }
  const advance = position.openAdvance ? await chain.advance(position.openAdvance) : null;
  const [voteAuth] = findVoteAuthPda(chain.programId, vote);

  if (command.name === 'status') {
    io.out(describeStatus({ vote, position, advance, pool, voteState, voteAuth, epoch }));
    return 0;
  }
  if (!pool) {
    io.out('The Pool account is missing: is EPOCH_PROGRAM_ID right?');
    return 1;
  }

  const ctx: OperatorContext = {
    programId: chain.programId,
    operator: chain.operator,
    vote,
    position,
    advance,
    pool,
    voteState,
  };
  const labels = accountLabels(ctx);
  const signers: Signer[] = [];
  let plan: Plan;
  switch (command.name) {
    case 'update-commission':
      plan = planUpdateCommission(ctx, command.kind, command.bps);
      break;
    case 'update-identity': {
      const newIdentity = io.loadKeypair(command.newIdentityKeypairPath);
      signers.push(newIdentity);
      plan = planUpdateIdentity(ctx, newIdentity.publicKey, command.setCollectors);
      break;
    }
    case 'withdraw-bond':
      plan = planWithdrawBond(ctx, command.lamports);
      break;
    case 'release':
      plan = planRelease(ctx, command.newWithdrawer);
      break;
    case 'set-collectors':
      plan = planSetCollectors(ctx);
      break;
    case 'register-revenue-token': {
      const dbcPool = findDbcPoolPda(command.dbcConfig, command.mint);
      const revenueToken = findRevenueTokenPda(chain.programId, vote)[0];
      const [mint, dbcConfig, pool2, existing] = await chain.accounts([
        command.mint,
        command.dbcConfig,
        dbcPool,
        revenueToken,
      ]);
      plan = planRegisterRevenueToken(
        {
          ...ctx,
          mint: mint ? { owner: mint.owner, data: mint.data } : null,
          dbcConfig: dbcConfig ? { owner: dbcConfig.owner, data: dbcConfig.data } : null,
          dbcPool: pool2 ? { address: dbcPool, owner: pool2.owner, data: pool2.data } : null,
          revenueTokenExists: existing !== null,
        },
        command,
      );
      labels.set(command.mint.toBase58(), 'token mint');
      labels.set(command.dbcConfig.toBase58(), 'DBC config');
      labels.set(dbcPool.toBase58(), 'DBC pool');
      labels.set(revenueToken.toBase58(), 'revenue token (new)');
      labels.set(
        findPartnerTreasuryPda(chain.programId, findPoolPda(chain.programId)[0])[0].toBase58(),
        'Epoch treasury PDA',
      );
      break;
    }
  }
  return execute(plan, labels, chain, io, command.dryRun, signers);
}

async function runAdmin(
  command: Extract<Command, { name: 'init-pool' | 'set-roles' | 'set-paused' }>,
  chain: OperatorChainLike,
  io: OperatorIo,
): Promise<number> {
  const ctx: AdminContext = { programId: chain.programId, signer: chain.operator, pool: await chain.pool() };
  let plan: Plan;
  switch (command.name) {
    case 'init-pool': {
      let text: string;
      try {
        text = io.readFile(command.paramsPath);
      } catch (error) {
        io.out(`Cannot read ${command.paramsPath}: ${(error as Error).message}`);
        return 1;
      }
      const { params, problems } = parsePoolParams(text);
      plan = planInitPool(ctx, params, problems, command.treasury, command.scorer);
      break;
    }
    case 'set-roles':
      plan = planSetRoles(ctx, command);
      break;
    case 'set-paused':
      plan = planSetPaused(ctx, command.paused);
      break;
  }
  return execute(plan, adminLabels(ctx), chain, io, command.dryRun);
}

async function runOnboard(
  command: Extract<Command, { name: 'onboard-validator' }>,
  chain: OperatorChainLike,
  io: OperatorIo,
): Promise<number> {
  const [pool, voteState, positionInfo] = await Promise.all([
    chain.pool(),
    chain.voteState(command.vote),
    chain.accounts([findPositionPda(chain.programId, command.vote)[0]]),
  ]);
  const plan = planOnboard(
    {
      programId: chain.programId,
      operator: chain.operator,
      vote: command.vote,
      pool,
      voteState,
      onboarded: positionInfo[0] !== null,
    },
    command,
  );
  const labels = accountLabels({
    programId: chain.programId,
    operator: chain.operator,
    vote: command.vote,
    position: { identity: chain.operator, originalWithdrawer: command.withdrawer } as OperatorContext['position'],
  });
  labels.set(command.withdrawer.toBase58(), 'current withdraw authority (co-signs)');
  labels.set(command.payout.toBase58(), 'payout');

  // Signed here when the withdrawer's keypair is at hand.
  if (command.withdrawerKeypairPath) {
    const withdrawer = io.loadKeypair(command.withdrawerKeypairPath);
    if (!withdrawer.publicKey.equals(command.withdrawer)) {
      io.out(
        `--withdrawer-keypair is ${withdrawer.publicKey.toBase58()}, not --withdrawer ${command.withdrawer.toBase58()}`,
      );
      return 1;
    }
    return execute(plan, labels, chain, io, command.dryRun, [withdrawer]);
  }

  // Otherwise: offline signing. Simulate first (signatures are not verified), then write the partly signed transaction.
  io.out(describePlan(plan, labels));
  if (plan.problems.length > 0) return 1;
  const simulation = await chain.simulate(plan.instructions);
  if (!simulation.ok) {
    io.out(describeFailure(simulation));
    return 1;
  }
  io.out(`\nSimulation passed (${simulation.unitsConsumed ?? '?'} compute units).`);
  if (command.dryRun) {
    io.out(
      'Dry run: nothing signed. With --send (and --nonce <account> unless the withdrawer signs within a minute) the ' +
        'operator signs and writes the transaction for the withdrawer.',
    );
    return 0;
  }
  let lifetime: Lifetime;
  if (command.nonce) {
    const nonce = await chain.nonce(command.nonce);
    if (!nonce) {
      io.out(`${command.nonce.toBase58()} is not a nonce account`);
      return 1;
    }
    if (!nonce.authority.equals(chain.operator)) {
      io.out(`the nonce authority is ${nonce.authority.toBase58()}, not the signer ${chain.operator.toBase58()}`);
      return 1;
    }
    lifetime = { kind: 'nonce', account: command.nonce, nonce: nonce.nonce, authority: nonce.authority };
  } else {
    lifetime = { kind: 'blockhash', ...(await chain.latestBlockhash()) };
  }
  if (
    !(await io.confirm(`Sign as the operator ${chain.operator.toBase58()} and write it for the withdrawer? (y/N) `))
  ) {
    io.out('Not signed.');
    return 1;
  }
  const tx = buildPartlySigned({
    instructions: plan.instructions,
    signer: chain.signer,
    lifetime,
    priorityFeeMicroLamports: chain.priorityFeeMicroLamports,
  });
  const base64 = encodeTransaction(tx);
  const out = command.outPath ?? `onboard-${command.vote.toBase58().slice(0, 8)}.tx`;
  io.writeFile(out, `${base64}\n`);
  io.out(
    [
      '',
      `Signed by the operator; written to ${out}:`,
      base64,
      '',
      `Next, the withdraw authority ${command.withdrawer.toBase58()} signs it (no RPC needed):`,
      `  solana decode-transaction ${'$'}(cat ${out}) base64          # inspect it with the Solana CLI`,
      `  epoch-operator sign-tx --tx ${out} --keypair <withdrawer.json> --out ${out}.signed`,
      `Then submit it: epoch-operator submit-tx --tx ${out}.signed --send`,
      lifetime.kind === 'blockhash'
        ? 'It expires about a minute after its blockhash; use --nonce <account> to give the withdrawer more time.'
        : 'It stays valid until the nonce account advances.',
    ].join('\n'),
  );
  return 0;
}

/** `sign-tx`: no RPC and no config. Shows the transaction, asks, adds the signature. */
export async function runSignTx(
  command: Extract<Command, { name: 'sign-tx' }>,
  io: Pick<OperatorIo, 'out' | 'confirm' | 'loadKeypair' | 'readFile' | 'writeFile'>,
): Promise<number> {
  let tx;
  try {
    tx = decodeTransaction(io.readFile(command.txPath));
  } catch (error) {
    io.out(`Cannot read the transaction in ${command.txPath}: ${(error as Error).message}`);
    return 1;
  }
  const signer = io.loadKeypair(command.keypairPath);
  io.out(describeTransaction(tx));
  try {
    if (!(await io.confirm(`\nSign this transaction as ${signer.publicKey.toBase58()}? (y/N) `))) {
      io.out('Not signed.');
      return 1;
    }
    addSignature(tx, signer);
  } catch (error) {
    io.out((error as Error).message);
    return 1;
  }
  const base64 = encodeTransaction(tx);
  const out = command.outPath ?? `${command.txPath}.signed`;
  io.writeFile(out, `${base64}\n`);
  io.out(
    `Signed; written to ${out}:\n${base64}\nSend it back to the operator for: epoch-operator submit-tx --tx ${out} --send`,
  );
  return 0;
}

async function runSubmit(
  command: Extract<Command, { name: 'submit-tx' }>,
  chain: OperatorChainLike,
  io: OperatorIo,
): Promise<number> {
  let tx;
  try {
    tx = decodeTransaction(io.readFile(command.txPath));
  } catch (error) {
    io.out(`Cannot read the transaction in ${command.txPath}: ${(error as Error).message}`);
    return 1;
  }
  io.out(describeTransaction(tx, chain.programId));
  const problems = submitProblems(tx);
  if (problems.length) {
    io.out(problems.map((p) => `cannot send: ${p}`).join('\n'));
    return 1;
  }
  const serialized = tx.serialize();
  const simulation = await chain.simulateSigned(serialized);
  if (!simulation.ok) {
    io.out(describeFailure(simulation));
    return 1;
  }
  io.out(`\nSimulation passed (${simulation.unitsConsumed ?? '?'} compute units, signatures verified).`);
  if (command.dryRun) {
    io.out('Dry run: nothing sent. Run again with --send to send it.');
    return 0;
  }
  if (!(await io.confirm('Send this transaction? (y/N) '))) {
    io.out('Not sent.');
    return 1;
  }
  return sendAndReport(() => chain.sendSigned(serialized), io);
}
