import {
  type AdvanceAccount,
  bytesToHex,
  instructionNameOf,
  lamportsToSolString,
  type PoolAccount,
  revenueHistory,
  trailingRevenue,
  type ValidatorPositionAccount,
} from '@epoch/epoch-sdk';
import { type VoteState } from '@epoch/solana';
import { type PublicKey, type TransactionInstruction } from '@solana/web3.js';

import { type Plan } from './Plans';

const sol = (lamports: bigint): string => `${lamportsToSolString(lamports)} SOL`;
const rows = (pairs: [string, string][]): string => {
  const width = Math.max(...pairs.map(([label]) => label.length));
  return pairs.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n');
};

/** Every instruction with its accounts (signer / writable flags and names) and data, as the wallet would sign it. */
export function describeInstructions(instructions: TransactionInstruction[], labels: Map<string, string>): string {
  return instructions
    .map((ix, i) => {
      const name = instructionNameOf(ix.data) ?? 'unknown';
      const accounts = ix.keys.map((meta, j) => {
        const flags = [meta.isSigner ? 'signer' : '', meta.isWritable ? 'writable' : ''].filter(Boolean).join(', ');
        const label = labels.get(meta.pubkey.toBase58()) ?? '';
        return `    ${String(j).padStart(2)} ${meta.pubkey.toBase58().padEnd(44)} ${`[${flags}]`.padEnd(20)} ${label}`;
      });
      return [
        `  #${i + 1} ${name} → program ${ix.programId.toBase58()}`,
        ...accounts,
        `    data ${bytesToHex(new Uint8Array(ix.data))}`,
      ].join('\n');
    })
    .join('\n');
}

export function describePlan(plan: Plan, labels: Map<string, string>): string {
  const parts = [plan.title, rows(plan.summary), '', 'Instructions', describeInstructions(plan.instructions, labels)];
  if (plan.warnings.length) parts.push('', ...plan.warnings.map((w) => `warning: ${w}`));
  if (plan.problems.length) parts.push('', ...plan.problems.map((p) => `cannot send: ${p}`));
  return parts.join('\n');
}

/** `status`: the decoded position, its open advance and what the vote account says on the program's cluster. */
export function describeStatus(input: {
  vote: PublicKey;
  position: ValidatorPositionAccount;
  advance: AdvanceAccount | null;
  pool: PoolAccount | null;
  voteState: VoteState | null;
  voteAuth: PublicKey;
  epoch: bigint;
}): string {
  const { position: p, advance: a, pool, voteState: v } = input;
  const ttl = pool?.params.scoreTtlEpochs;
  const scoreFresh =
    ttl === undefined || p.lastScoredEpoch === 0n
      ? 'never scored'
      : input.epoch <= p.lastScoredEpoch + BigInt(ttl)
        ? 'fresh'
        : 'stale';
  const revenue = revenueHistory(p);
  const lines = [
    `Validator position for ${input.vote.toBase58()} (program epoch ${input.epoch})`,
    rows([
      ['status', p.status],
      ['operator', p.operator.toBase58()],
      ['payout', p.payout.toBase58()],
      ['identity', p.identity.toBase58()],
      ['original withdrawer', p.originalWithdrawer.toBase58()],
      ['bond', sol(p.bondLamports)],
      ['score', `${p.score} / 10000 (scored in epoch ${p.lastScoredEpoch}, ${scoreFresh})`],
      ['hedged', String(p.hedged)],
      [
        'revenue (oldest → newest)',
        revenue.length ? revenue.map((r) => lamportsToSolString(r)).join(', ') + ' SOL' : 'none yet',
      ],
      ['trailing revenue', `${sol(trailingRevenue(p))} over ${p.revenueCount} epochs`],
      ['last swept epoch', String(p.lastSweptEpoch)],
      ['swept / remitted', `${sol(p.totalSwept)} / ${sol(p.totalRemitted)}`],
      ['late epochs', String(p.lateEpochs)],
      ['commission at onboarding', `${p.inflationCommissionBps} bps inflation, ${p.blockCommissionBps} bps block`],
      ['onboarded epoch', String(p.onboardedEpoch)],
    ]),
    '',
  ];
  if (v) {
    lines.push(
      'Vote account (program cluster)',
      rows([
        ['version', v.version],
        ['identity', v.nodePubkey],
        [
          'withdraw authority',
          `${v.authorizedWithdrawer}${v.authorizedWithdrawer === input.voteAuth.toBase58() ? ' (the Epoch program)' : ' (NOT the Epoch program)'}`,
        ],
        ['commission', `${v.inflationRewardsCommissionBps} bps inflation, ${v.blockRevenueCommissionBps} bps block`],
        ['collectors', `${v.inflationRewardsCollector ?? 'vote account'} / ${v.blockRevenueCollector ?? 'identity'}`],
      ]),
      '',
    );
  }
  if (!p.openAdvance) {
    lines.push('No open advance.');
  } else if (!a) {
    lines.push(`Open advance ${p.openAdvance.toBase58()} (could not be read)`);
  } else {
    lines.push(
      `Open advance ${p.openAdvance.toBase58()}`,
      rows([
        ['state', a.state],
        ['principal + fee', `${sol(a.principal)} + ${sol(a.fee)} = ${sol(a.totalDue)}`],
        ['repaid', `${sol(a.repaid)} (principal ${sol(a.principalRepaid)}, fee ${sol(a.feeRepaid)})`],
        ['outstanding', sol(a.totalDue > a.repaid ? a.totalDue - a.repaid : 0n)],
        ['remit', `${a.remitBps} bps of each sweep (100% while defaulted)`],
        ['opened epoch', String(a.openedEpoch)],
      ]),
    );
  }
  return lines.join('\n');
}
