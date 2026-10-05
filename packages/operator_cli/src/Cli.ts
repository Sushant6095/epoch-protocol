import { parseArgs } from 'util';

import { solToLamports } from '@epoch/epoch-sdk';
import { PublicKey } from '@solana/web3.js';

export type CommissionKindName = 'inflation' | 'block';

/**
 * Every command that builds a transaction is a dry run unless `--send`: it prints the plan and simulates. With
 * `--send` it simulates, asks `y/N`, then sends. `dryRun` is the opposite of `--send`.
 */
export type Command =
  | { name: 'help' }
  | { name: 'status'; vote: PublicKey }
  | { name: 'update-commission'; vote: PublicKey; kind: CommissionKindName; bps: number; dryRun: boolean }
  | {
      name: 'update-identity';
      vote: PublicKey;
      newIdentityKeypairPath: string;
      /** Re-assert the escrow as block revenue collector in the same transaction. */
      setCollectors: boolean;
      dryRun: boolean;
    }
  | { name: 'withdraw-bond'; vote: PublicKey; lamports: bigint; dryRun: boolean }
  | { name: 'release'; vote: PublicKey; newWithdrawer?: PublicKey; dryRun: boolean }
  // ── Pool admin (the signer is the pool admin) ──
  | { name: 'init-pool'; paramsPath: string; treasury: PublicKey; scorer: PublicKey; dryRun: boolean }
  | { name: 'set-roles'; newAdmin?: PublicKey; treasury?: PublicKey; scorer?: PublicKey; dryRun: boolean }
  | { name: 'set-paused'; paused: boolean; dryRun: boolean }
  // ── Validator onboarding and revenue tokens ──
  | {
      name: 'onboard-validator';
      vote: PublicKey;
      payout: PublicKey;
      /** The vote account's withdraw authority today: co-signs (locally with its keypair, or offline). */
      withdrawer: PublicKey;
      withdrawerKeypairPath?: string;
      bondLamports: bigint;
      setCollectors: boolean;
      /** Durable nonce account (authority: the signer) so the offline signature does not expire. */
      nonce?: PublicKey;
      /** Where the partly signed transaction goes for the withdrawer (offline signing). */
      outPath?: string;
      dryRun: boolean;
    }
  | { name: 'set-collectors'; vote: PublicKey; dryRun: boolean }
  | {
      name: 'register-revenue-token';
      vote: PublicKey;
      mint: PublicKey;
      dbcConfig: PublicKey;
      shareBps: number;
      termEpochs: number;
      dryRun: boolean;
    }
  // ── Offline signing ──
  | { name: 'sign-tx'; txPath: string; keypairPath: string; outPath?: string }
  | { name: 'submit-tx'; txPath: string; dryRun: boolean };

export type CommandName = Exclude<Command['name'], 'help'>;

export class UsageError extends Error {}

export const USAGE = `Epoch operator script: manage the pool and onboarded validators through the Epoch program.

Usage: pnpm operator <command> [options]

Validator operator (signer: the position's operator)
  status            --vote <vote>                                    position, bond, score and the open advance
  update-commission --vote <vote> --kind inflation|block --bps <n>   change a commission (0-10000 bps)
  update-identity   --vote <vote> --new-identity-keypair <path>      rotate the validator identity
                    [--no-set-collectors]                            (skip re-asserting the escrow collector)
  withdraw-bond     --vote <vote> --sol <amount>                     take bond SOL back (no advance open)
  release           --vote <vote> [--new-withdrawer <key>]           leave Epoch: withdraw authority back
  onboard-validator --vote <vote> --payout <key> --withdrawer <key>  join Epoch (the signer becomes the operator)
                    [--withdrawer-keypair <path>] [--bond-sol <x>]    sign the withdrawer here, or offline:
                    [--nonce <account>] [--out <file>]                 --send writes the partly signed transaction
                    [--no-set-collectors]
  set-collectors    --vote <vote>                                    point both collectors at the escrow (anyone)
  register-revenue-token --vote <vote> --mint <mint> --dbc-config <config> --share-bps <n> --term-epochs <n>

Pool admin (signer: the pool admin)
  init-pool         --params <file.json> --treasury <key> --scorer <key>
  set-roles         [--new-admin <key>] [--treasury <key>] [--scorer <key>]   (unchanged roles are kept)
  set-paused        --paused true|false

Offline signing
  sign-tx           --tx <file> --keypair <path> [--out <file>]       add a signature, no network or config
  submit-tx         --tx <file>                                      verify the signatures, simulate, send

Options
  --send            send after the simulation passes and you confirm (y/N); without it, a dry run
  --dry-run         the default: print the plan and simulate, send nothing
  --keypair <path>  signer for this run instead of OPERATOR_KEYPAIR_PATH (e.g. the pool admin's key)
  --env <file>      env file to load (default .env): EPOCH_RPC_URL, EPOCH_PROGRAM_ID, OPERATOR_KEYPAIR_PATH
  -h, --help        this text`;

const COMMANDS = [
  'status',
  'update-commission',
  'update-identity',
  'withdraw-bond',
  'release',
  'init-pool',
  'set-roles',
  'set-paused',
  'onboard-validator',
  'set-collectors',
  'register-revenue-token',
  'sign-tx',
  'submit-tx',
] as const;

function pubkey(value: string | undefined, flag: string): PublicKey {
  if (!value) throw new UsageError(`${flag} is required`);
  try {
    return new PublicKey(value);
  } catch {
    throw new UsageError(`${flag} is not a valid public key: ${value}`);
  }
}

const optionalKey = (value: string | undefined, flag: string): PublicKey | undefined =>
  value === undefined ? undefined : pubkey(value, flag);

function integer(value: string | undefined, flag: string, min: number, max: number): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    throw new UsageError(`${flag} must be a whole number from ${min} to ${max}`);
  }
  return Number(value);
}

function required(value: string | undefined, flag: string): string {
  if (!value) throw new UsageError(`${flag} is required`);
  return value;
}

function sol(value: string | undefined, flag: string, allowZero: boolean): bigint {
  let lamports: bigint;
  try {
    lamports = solToLamports(value ?? '');
  } catch {
    throw new UsageError(`${flag} must be a SOL amount, e.g. 1.5`);
  }
  if (lamports === 0n && !allowZero) throw new UsageError(`${flag} must be more than 0`);
  return lamports;
}

/** The `--keypair` override for the signer, when given (read before the config). */
export function keypairOverride(argv: string[]): string | undefined {
  const i = argv.indexOf('--keypair');
  return i >= 0 ? argv[i + 1] : undefined;
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
        params: { type: 'string' },
        treasury: { type: 'string' },
        scorer: { type: 'string' },
        'new-admin': { type: 'string' },
        paused: { type: 'string' },
        payout: { type: 'string' },
        withdrawer: { type: 'string' },
        'withdrawer-keypair': { type: 'string' },
        'bond-sol': { type: 'string' },
        nonce: { type: 'string' },
        out: { type: 'string' },
        mint: { type: 'string' },
        'dbc-config': { type: 'string' },
        'share-bps': { type: 'string' },
        'term-epochs': { type: 'string' },
        tx: { type: 'string' },
        keypair: { type: 'string' },
        send: { type: 'boolean' },
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
  if (values.send && values['dry-run']) throw new UsageError('--send and --dry-run contradict each other');
  const dryRun = values.send !== true;

  switch (name as (typeof COMMANDS)[number]) {
    case 'status':
      return { name: 'status', vote: pubkey(values.vote, '--vote') };
    case 'update-commission': {
      const kind = values.kind;
      if (kind !== 'inflation' && kind !== 'block') throw new UsageError('--kind must be inflation or block');
      if (!values.bps || !/^\d+$/.test(values.bps) || Number(values.bps) > 10_000) {
        throw new UsageError('--bps must be a whole number from 0 to 10000');
      }
      return { name: 'update-commission', vote: pubkey(values.vote, '--vote'), kind, bps: Number(values.bps), dryRun };
    }
    case 'update-identity':
      return {
        name: 'update-identity',
        vote: pubkey(values.vote, '--vote'),
        newIdentityKeypairPath: required(values['new-identity-keypair'], '--new-identity-keypair'),
        setCollectors: values['no-set-collectors'] !== true,
        dryRun,
      };
    case 'withdraw-bond':
      return {
        name: 'withdraw-bond',
        vote: pubkey(values.vote, '--vote'),
        lamports: sol(values.sol, '--sol', false),
        dryRun,
      };
    case 'release':
      return {
        name: 'release',
        vote: pubkey(values.vote, '--vote'),
        newWithdrawer: optionalKey(values['new-withdrawer'], '--new-withdrawer'),
        dryRun,
      };
    case 'init-pool':
      return {
        name: 'init-pool',
        paramsPath: required(values.params, '--params'),
        treasury: pubkey(values.treasury, '--treasury'),
        scorer: pubkey(values.scorer, '--scorer'),
        dryRun,
      };
    case 'set-roles': {
      const newAdmin = optionalKey(values['new-admin'], '--new-admin');
      const treasury = optionalKey(values.treasury, '--treasury');
      const scorer = optionalKey(values.scorer, '--scorer');
      if (!newAdmin && !treasury && !scorer)
        throw new UsageError('give at least one of --new-admin, --treasury, --scorer');
      return { name: 'set-roles', newAdmin, treasury, scorer, dryRun };
    }
    case 'set-paused':
      if (values.paused !== 'true' && values.paused !== 'false') throw new UsageError('--paused must be true or false');
      return { name: 'set-paused', paused: values.paused === 'true', dryRun };
    case 'onboard-validator':
      if (values['withdrawer-keypair'] && (values.nonce || values.out)) {
        throw new UsageError('--withdrawer-keypair signs here: --nonce and --out are for offline signing');
      }
      return {
        name: 'onboard-validator',
        vote: pubkey(values.vote, '--vote'),
        payout: pubkey(values.payout, '--payout'),
        withdrawer: pubkey(values.withdrawer, '--withdrawer'),
        withdrawerKeypairPath: values['withdrawer-keypair'],
        bondLamports: values['bond-sol'] === undefined ? 0n : sol(values['bond-sol'], '--bond-sol', true),
        setCollectors: values['no-set-collectors'] !== true,
        nonce: optionalKey(values.nonce, '--nonce'),
        outPath: values.out,
        dryRun,
      };
    case 'set-collectors':
      return { name: 'set-collectors', vote: pubkey(values.vote, '--vote'), dryRun };
    case 'register-revenue-token':
      return {
        name: 'register-revenue-token',
        vote: pubkey(values.vote, '--vote'),
        mint: pubkey(values.mint, '--mint'),
        dbcConfig: pubkey(values['dbc-config'], '--dbc-config'),
        shareBps: integer(values['share-bps'], '--share-bps', 1, 5_000),
        termEpochs: integer(values['term-epochs'], '--term-epochs', 10, 1_000),
        dryRun,
      };
    case 'sign-tx':
      return {
        name: 'sign-tx',
        txPath: required(values.tx, '--tx'),
        keypairPath: required(values.keypair, '--keypair'),
        outPath: values.out,
      };
    case 'submit-tx':
      return { name: 'submit-tx', txPath: required(values.tx, '--tx'), dryRun };
  }
}
