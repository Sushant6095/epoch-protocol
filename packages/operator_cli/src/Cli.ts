import { parseArgs } from 'util';

import { solToLamports } from '@epoch/epoch-sdk';
import { PublicKey } from '@solana/web3.js';

export type CommissionKindName = 'inflation' | 'block';

export type Command =
  | { name: 'help' }
  | { name: 'status'; vote: PublicKey }
  | { name: 'update-commission'; vote: PublicKey; kind: CommissionKindName; bps: number; dryRun: boolean }
  | {
      name: 'update-identity';
      vote: PublicKey;
      newIdentityKeypairPath: string;
      /** Re-point the block revenue collector at the escrow in the same transaction (the identity change resets it). */
      setCollectors: boolean;
      dryRun: boolean;
    }
  | { name: 'withdraw-bond'; vote: PublicKey; lamports: bigint; dryRun: boolean }
  | { name: 'release'; vote: PublicKey; newWithdrawer?: PublicKey; dryRun: boolean };

export class UsageError extends Error {}

export const USAGE = `Epoch operator script: manage an onboarded validator through the Epoch program.

Usage: pnpm operator <command> [options]

Commands
  status            --vote <vote>                                    position, bond, score and the open advance
  update-commission --vote <vote> --kind inflation|block --bps <n>   change a commission (0-10000 bps)
  update-identity   --vote <vote> --new-identity-keypair <path>      rotate the validator identity
                    [--no-set-collectors]                            (skip re-pointing the block revenue collector)
  withdraw-bond     --vote <vote> --sol <amount>                     take bond SOL back (no advance open)
  release           --vote <vote> [--new-withdrawer <key>]           leave Epoch: withdraw authority back

Options
  --dry-run         simulate and print the instructions; send nothing
  --env <file>      env file to load (default .env): EPOCH_RPC_URL, EPOCH_PROGRAM_ID, OPERATOR_KEYPAIR_PATH
  -h, --help        this text

Every command that sends a transaction simulates it first and asks for confirmation (y/N).`;

const COMMANDS = ['status', 'update-commission', 'update-identity', 'withdraw-bond', 'release'] as const;

function pubkey(value: string | undefined, flag: string): PublicKey {
  if (!value) throw new UsageError(`${flag} is required`);
  try {
    return new PublicKey(value);
  } catch {
    throw new UsageError(`${flag} is not a valid public key: ${value}`);
  }
}

/** Parses `process.argv.slice(2)`. Throws UsageError with a message for the user. */
export function parseCommand(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        vote: { type: 'string' },
        kind: { type: 'string' },
        bps: { type: 'string' },
        'new-identity-keypair': { type: 'string' },
        'no-set-collectors': { type: 'boolean' },
        sol: { type: 'string' },
        'new-withdrawer': { type: 'string' },
        'dry-run': { type: 'boolean' },
        env: { type: 'string', short: 'e' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  const [name, ...extra] = positionals;
  if (values.help || name === undefined || name === 'help') return { name: 'help' };
  if (!(COMMANDS as readonly string[]).includes(name)) throw new UsageError(`unknown command '${name}'`);
  if (extra.length > 0) throw new UsageError(`unexpected argument '${extra[0]}'`);

  const vote = pubkey(values.vote, '--vote');
  const dryRun = values['dry-run'] === true;
  switch (name as (typeof COMMANDS)[number]) {
    case 'status':
      return { name: 'status', vote };
    case 'update-commission': {
      const kind = values.kind;
      if (kind !== 'inflation' && kind !== 'block') throw new UsageError('--kind must be inflation or block');
      if (!values.bps || !/^\d+$/.test(values.bps) || Number(values.bps) > 10_000) {
        throw new UsageError('--bps must be a whole number from 0 to 10000');
      }
      return { name: 'update-commission', vote, kind, bps: Number(values.bps), dryRun };
    }
    case 'update-identity': {
      const path = values['new-identity-keypair'];
      if (!path) throw new UsageError('--new-identity-keypair is required');
      return {
        name: 'update-identity',
        vote,
        newIdentityKeypairPath: path,
        setCollectors: values['no-set-collectors'] !== true,
        dryRun,
      };
    }
    case 'withdraw-bond': {
      let lamports: bigint;
      try {
        lamports = solToLamports(values.sol ?? '');
      } catch {
        throw new UsageError('--sol must be a SOL amount, e.g. 1.5');
      }
      if (lamports === 0n) throw new UsageError('--sol must be more than 0');
      return { name: 'withdraw-bond', vote, lamports, dryRun };
    }
    case 'release':
      return {
        name: 'release',
        vote,
        newWithdrawer: values['new-withdrawer'] ? pubkey(values['new-withdrawer'], '--new-withdrawer') : undefined,
        dryRun,
      };
  }
}
