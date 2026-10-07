/**
 * Epoch devnet go-live kit.
 *
 *   pnpm devnet <command> --url <devnet|testnet|localnet|http(s)://…> [--keys <folder outside the repo>] [options]
 *
 * Commands:
 *   budget   exact SOL per stage on the target cluster (no keys; sends nothing)
 *   deploy   set the program id, build, deploy through a buffer, verify, hand over the upgrade authority
 *   init     pool with its params, Fee Index and roles (idempotent)
 *   seed     real flows: deposits, test vote accounts, onboarding (resumable; state keyed to the genesis hash)
 *   cp1      the CP1 mechanism proof on a throwaway vote account; writes docs/cp1-results.md on devnet/testnet
 *
 * Common options: --url (required), --ws <websocket URL>, --keys <dir> (or EPOCH_DEVNET_KEYS),
 * --state-dir <dir> (default <keys>/state), --priority-fee <µlamports/CU> (default 0 on localnet, 1000 elsewhere),
 * --yes (skip the confirmation before spending). Mainnet is refused by name and by genesis hash.
 * See scripts/devnet/README.md and docs/runbooks/devnet.md.
 */
import { parseArgs } from 'node:util';

import { BUDGET_OPTIONS, runBudget } from './commands/budget';
import { CP1_OPTIONS, type Cp1Options, runCp1 } from './commands/cp1';
import { DEPLOY_OPTIONS, type DeployOptions, runDeploy } from './commands/deploy';
import { INIT_OPTIONS, type InitOptions, runInit } from './commands/init';
import { runSeed, SEED_OPTIONS, type SeedOptions } from './commands/seed';
import { COMMON_OPTIONS, type CommonOptions, openContext } from './lib/context';
import { KitError } from './lib/errors';
import { TxError } from './lib/tx';

const USAGE = `usage: pnpm devnet <command> --url <devnet|testnet|localnet|URL> [--keys <dir>] [options]

commands:
  budget   exact SOL per stage on the target cluster (no keys; sends nothing)
           [--so <epoch.so>] [--so-size <bytes>] [--max-len <bytes>] [--params <json>]
  deploy   set the program id, build, deploy through a buffer, verify, hand over the upgrade authority
           --program-keypair <path> [--deployer <path>] [--max-len <bytes>] [--upgrade-authority-to <pubkey>]
           [--skip-build] [--build-lock <file>] [--so <epoch.so>] [--solana <cli path>]
  init     pool with its params, Fee Index and roles (idempotent; differences need --apply-changes)
           [--params <json>] [--program-id <id>] [--deployer <path>] [--admin|--scorer|--publisher|--cranker|--maker <path>]
           [--treasury <pubkey>] [--dispute-window-slots <n>] [--index-max-move-bps <n>] [--apply-changes]
  seed     real flows through the SDK: deposits, a withdrawal request, test vote accounts, onboarding (resumable)
           [--program-id <id>] [--params <json>] [--deployer <path>] [--solana <cli path>] [--wait]
           then each epoch: sweeps, accrual, scores, next epoch's revenue, the advance after 3 sweeps;
           --wait blocks across epochs until the advance is open (localnet), otherwise prints the next run's time
  cp1      the CP1 proof: control, onboard (CPI Authorize), set_collectors, refused direct UpdateCommission, then
           next epoch revenue + sweep (CPI Withdraw), release, closing control; results to docs/cp1-results.md
           [--program-id <id>] [--params <json>] [--deployer <path>] [--out <md>] [--solana <cli path>] [--wait]

common options:
  --url <cluster>          devnet, testnet, localnet or an http(s) RPC URL (mainnet is refused)
  --ws <url>               websocket URL (default: derived; loopback → RPC port + 1)
  --keys <dir>             key folder outside the repo (or EPOCH_DEVNET_KEYS)
  --state-dir <dir>        resumable state (default <keys>/state)
  --priority-fee <n>       micro-lamports per CU (default 0 on localnet, 1000 elsewhere)
  --yes                    do not ask before spending
`;

interface Command {
  options: Record<string, { type: 'string' | 'boolean'; short?: string; default?: string | boolean }>;
  needKeys: boolean;
  run: (ctx: Awaited<ReturnType<typeof openContext>>, values: Record<string, unknown>) => Promise<void>;
}

const COMMANDS: Record<string, Command> = {
  budget: {
    options: BUDGET_OPTIONS,
    needKeys: false,
    run: (ctx, v) => runBudget(ctx, v as { so?: string; 'so-size'?: string; 'max-len'?: string; params?: string }),
  },
  deploy: {
    options: DEPLOY_OPTIONS,
    needKeys: true,
    run: (ctx, v) => runDeploy(ctx, v as DeployOptions),
  },
  init: {
    options: INIT_OPTIONS,
    needKeys: true,
    run: (ctx, v) => runInit(ctx, v as InitOptions),
  },
  seed: {
    options: SEED_OPTIONS,
    needKeys: true,
    run: (ctx, v) => runSeed(ctx, v as SeedOptions),
  },
  cp1: {
    options: CP1_OPTIONS,
    needKeys: true,
    run: (ctx, v) => runCp1(ctx, v as Cp1Options),
  },
};

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  const command = name ? COMMANDS[name] : undefined;
  if (!command) {
    process.stdout.write(USAGE);
    return name && name !== '--help' && name !== '-h' ? 2 : 0;
  }
  const { values } = parseArgs({ args: rest, options: { ...COMMON_OPTIONS, ...command.options }, strict: true });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const ctx = await openContext(values as CommonOptions, command.needKeys);
  await command.run(ctx, values);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      if (e instanceof KitError) {
        process.stderr.write(`error [${e.code}]: ${e.message}\n`);
        if (e instanceof TxError && e.logs.length) process.stderr.write(`${e.logs.slice(-8).join('\n')}\n`);
        process.exit(1);
      }
      if (
        e instanceof TypeError &&
        /Unknown option|ERR_PARSE_ARGS/.test(String((e as { code?: string }).code ?? e.message))
      ) {
        process.stderr.write(`${e.message}\n\n${USAGE}`);
        process.exit(2);
      }
      throw e;
    },
  );
}
