import { findVoteAuthPda, parseEpochError } from '@epoch/epoch-sdk';
import { type Keypair, type Signer } from '@solana/web3.js';

import { type Command } from './Cli';
import { describePlan, describeStatus } from './Describe';
import { type OperatorChain } from './OperatorChain';
import {
  accountLabels,
  type OperatorContext,
  type Plan,
  planRelease,
  planUpdateCommission,
  planUpdateIdentity,
  planWithdrawBond,
} from './Plans';

export type OperatorChainLike = Pick<
  OperatorChain,
  'programId' | 'operator' | 'epoch' | 'position' | 'advance' | 'pool' | 'voteState' | 'simulate' | 'send'
>;

export interface OperatorIo {
  out: (text: string) => void;
  /** Asks a yes/no question; true only for an explicit yes. */
  confirm: (question: string) => Promise<boolean>;
  /** Loads a keypair file (the new identity for update-identity). */
  loadKeypair: (path: string) => Keypair;
  /** Explorer link for a signature on the program's cluster. */
  explorer: (signature: string) => string;
}

/** Runs one command. Returns the process exit code. */
export async function runCommand(command: Command, chain: OperatorChainLike, io: OperatorIo): Promise<number> {
  if (command.name === 'help') return 0;
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
  }

  io.out(describePlan(plan, accountLabels(ctx)));
  if (plan.problems.length > 0) return 1;

  const simulation = await chain.simulate(plan.instructions);
  if (!simulation.ok) {
    const error = parseEpochError({ err: simulation.err, logs: simulation.logs });
    io.out(
      [
        '',
        `Simulation failed: ${error ? `${error.name} (${error.code}): ${error.message}` : JSON.stringify(simulation.err)}`,
        ...simulation.logs.map((line) => `  ${line}`),
      ].join('\n'),
    );
    return 1;
  }
  io.out(`\nSimulation passed (${simulation.unitsConsumed ?? '?'} compute units).`);
  if (command.dryRun) {
    io.out('Dry run: nothing sent.');
    return 0;
  }
  if (!(await io.confirm(`Send this transaction as ${chain.operator.toBase58()}? (y/N) `))) {
    io.out('Not sent.');
    return 1;
  }
  try {
    const signature = await chain.send(plan.instructions, signers);
    io.out(`Sent: ${signature}\n${io.explorer(signature)}`);
    return 0;
  } catch (failure) {
    const details = (failure as { details?: { error?: unknown; logs?: unknown } }).details ?? {};
    const error = parseEpochError({ logs: details.logs, error: details.error ?? String(failure) });
    io.out(`Failed: ${error ? `${error.name}: ${error.message}` : String(details.error ?? failure)}`);
    return 1;
  }
}
