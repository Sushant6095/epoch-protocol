/**
 * Registers a launched revenue token with the Epoch program: `register_revenue_token(share_bps, term_epochs)`, signed
 * and paid by the validator's operator (ADR 0006). From the next epoch every sweep moves the share into the buyback
 * escrow, and until the term ends the validator cannot release its withdraw authority or cut its commission.
 * Dry run by default; `--execute` sends. The launch CLI runs this step itself when it holds the operator key.
 *
 *   LAUNCH_OPERATOR_KEYPAIR_PATH=<operator keypair> EPOCH_PROGRAM_ID=<program id> LAUNCHES_PATH=<registry> \
 *   pnpm --filter @epoch/meteora register -- --symbol <SYM> [--cluster devnet|mainnet] [--rpc <url>] [--execute]
 *
 * Checks the cluster, the program and its Pool, the terms, the validator's position (onboarded, Active, no revenue
 * token, the program holds its withdraw authority, the operator key), the mint and its DBC config (fee claimer = the
 * treasury PDA), the operator's balance, and simulates the instruction. On success it writes the program's term (its
 * start epoch) and the signature into the launch record. Keys come from paths only and are never printed.
 */
import { parseArgs } from 'util';

import { Connection, PublicKey } from '@solana/web3.js';

import {
  checkCluster,
  checkEpochPool,
  checkPayerBalance,
  checkProgram,
  checkRegistrableConfig,
  checkRegistrableMint,
  checkRevenueTokenTerms,
  checkValidatorPosition,
  dbcClient,
  formatSol,
  type LaunchCluster,
  type LaunchRegistryEntry,
  type PreflightCheck,
  readTokenMint,
  summarizePreflight,
  treasuryMismatch,
  withRegistration,
} from '../src';
import {
  ask,
  DEFAULT_RPC,
  err,
  explorer,
  loadKeypairFile,
  out,
  readRegistryFile,
  replaceRegistryEntry,
  sendLabelled,
  simulate,
  waitFinalized,
  withPriorityFee,
} from './cli';
import {
  epochProgramKeys,
  planRegistration,
  readEpochProgram,
  readRegistered,
  REGISTRATION_RENT_LAMPORTS,
  registrationLabels,
  registrationLines,
  registrationTransaction,
  REVENUE_TOKEN_LIMITS,
  revenueTokenAccounts,
} from './epochProgram';

const USAGE = `Usage: pnpm --filter @epoch/meteora register -- --symbol <SYM> [options]

  --registry <path>            the launch registry (default LAUNCHES_PATH)
  --cluster devnet|mainnet     the launch's cluster (default: the launch record's)
  --rpc <url>                  the cluster's RPC (default LAUNCH_RPC_URL, else the public RPC)
  --program-id <pubkey>        the Epoch program (default EPOCH_PROGRAM_ID)
  --execute                    send (default: dry run, nothing is signed or sent)
  --yes                        skip the "type the symbol" confirmation
  --priority-fee <µlamports>   compute-unit price (default 100000 on mainnet, 0 on devnet)
  --allow-unknown-genesis      accept an RPC that is not the public cluster (a local stand-in)

Env: LAUNCH_OPERATOR_KEYPAIR_PATH (the validator's operator: signs and pays about 0.0073 SOL of rent),
     EPOCH_PROGRAM_ID, EPOCH_TREASURY (optional: must be the treasury PDA), LAUNCHES_PATH, LAUNCH_RPC_URL`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    options: {
      symbol: { type: 'string' },
      registry: { type: 'string' },
      cluster: { type: 'string' },
      rpc: { type: 'string' },
      'program-id': { type: 'string' },
      execute: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      'priority-fee': { type: 'string' },
      'allow-unknown-genesis': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  const env = process.env;
  const registryPath = values.registry ?? env.LAUNCHES_PATH;
  if (values.help || !values.symbol || !registryPath) {
    out(USAGE);
    process.exit(values.help ? 0 : 2);
  }
  const programIdText = values['program-id'] ?? env.EPOCH_PROGRAM_ID;
  if (!programIdText) throw new Error('EPOCH_PROGRAM_ID (or --program-id) is not set: the program to register with');
  const keys = epochProgramKeys(new PublicKey(programIdText));
  const refusal = treasuryMismatch(env.EPOCH_TREASURY, keys.treasury.toBase58());
  if (refusal) throw new Error(refusal);

  const entries = readRegistryFile(registryPath);
  const symbol = values.symbol.toLowerCase();
  const candidates = entries.filter(
    (candidate) =>
      candidate.symbol.toLowerCase() === symbol && (!values.cluster || candidate.cluster === values.cluster),
  );
  if (candidates.length !== 1) {
    throw new Error(
      candidates.length === 0
        ? `${values.symbol} is not in ${registryPath}`
        : `${values.symbol} is in ${registryPath} on several clusters: pass --cluster`,
    );
  }
  const entry = candidates[0];
  const cluster: LaunchCluster = entry.cluster;
  if (!entry.dbcPool || !entry.dbcConfig)
    throw new Error(`${entry.symbol}: the launch record has no DBC pool or config`);
  if (!entry.validator.vote) throw new Error(`${entry.symbol}: the launch record has no validator vote account`);
  const rpc = values.rpc ?? env.LAUNCH_RPC_URL ?? DEFAULT_RPC[cluster];
  const priority =
    values['priority-fee'] !== undefined ? Number(values['priority-fee']) : cluster === 'mainnet' ? 100_000 : 0;
  const connection = new Connection(rpc, 'confirmed');
  const vote = new PublicKey(entry.validator.vote);
  const mint = new PublicKey(entry.mint);
  const operatorKeypair = env.LAUNCH_OPERATOR_KEYPAIR_PATH
    ? loadKeypairFile(env.LAUNCH_OPERATOR_KEYPAIR_PATH, 'LAUNCH_OPERATOR_KEYPAIR_PATH')
    : undefined;

  out(`Register ${entry.symbol} with the Epoch program on ${cluster}${values.execute ? '' : ' — DRY RUN'}`);
  out(`Token              ${entry.symbol} · ${entry.name} · mint ${entry.mint}`);
  out(`Validator          ${entry.validator.name} (vote ${vote.toBase58()})`);
  out(
    `Terms              ${entry.shareBps} bps of gross revenue for ${entry.termEpochs} epochs (immutable once registered)`,
  );
  out(
    `Epoch program      ${keys.programId.toBase58()} · Pool ${keys.pool.toBase58()} · treasury PDA ${keys.treasury.toBase58()}`,
  );
  out(`RPC                ${new URL(rpc).host}`);

  const [genesis, state, config, mintInfo] = await Promise.all([
    connection.getGenesisHash(),
    readEpochProgram(connection, keys, vote),
    dbcClient(connection)
      .state.getPoolConfig(entry.dbcConfig)
      .catch(() => null),
    readTokenMint({ connection, mint }),
  ]);
  const already = state.revenueToken;
  // This very token is registered already: nothing to sign (the record is brought up to date below).
  const registeredHere = !!already && already.account.mint.equals(mint);
  const operator = operatorKeypair?.publicKey ?? (state.position ? new PublicKey(state.position.operator) : null);
  const checks: PreflightCheck[] = [
    checkCluster(cluster, genesis, values['allow-unknown-genesis']),
    checkProgram('Epoch', state.program),
    checkEpochPool(state.pool),
    checkRevenueTokenTerms(entry, REVENUE_TOKEN_LIMITS),
    ...(registeredHere
      ? []
      : checkValidatorPosition(state.position, {
          cluster,
          vote: vote.toBase58(),
          operatorKey: operatorKeypair?.publicKey.toBase58() ?? null,
          registeringNow: true,
        })),
    checkRegistrableMint(mintInfo),
    checkRegistrableConfig(
      config && {
        feeClaimer: config.feeClaimer.toBase58(),
        quoteMint: config.quoteMint.toBase58(),
        migrationOption: config.migrationOption,
        tokenType: config.tokenType,
      },
      keys.treasury.toBase58(),
    ),
  ];
  if (already) {
    checks.push(
      registeredHere
        ? { name: 'RevenueToken', status: 'pass', detail: `already registered: ${already.address.toBase58()}` }
        : {
            name: 'RevenueToken',
            status: 'fail',
            detail: `the vote account already has another revenue token (mint ${already.account.mint.toBase58()})`,
          },
    );
  }

  const plan =
    operator && !registeredHere
      ? planRegistration({
          keys,
          operator,
          vote,
          mint,
          dbcPool: new PublicKey(entry.dbcPool),
          dbcConfig: new PublicKey(entry.dbcConfig),
          shareBps: entry.shareBps,
          termEpochs: entry.termEpochs,
        })
      : null;
  if (plan) {
    const balance = await connection.getBalance(plan.operator, 'confirmed');
    checks.push(
      checkPayerBalance(balance, REGISTRATION_RENT_LAMPORTS, 1_000_000, {
        name: 'Operator balance',
        step: 'registration',
      }),
    );
    const simulation = await simulate(
      connection,
      withPriorityFee(registrationTransaction(plan), priority),
      plan.operator,
    );
    checks.push(
      simulation.ok
        ? { name: 'Simulation', status: 'pass', detail: `ok, ${simulation.unitsConsumed} compute units` }
        : {
            name: 'Simulation',
            status: 'fail',
            detail: `${simulation.error}; ${simulation.logs.slice(-3).join(' | ')}`,
          },
    );
  }

  out();
  if (plan) {
    out(
      `What the operator signs (rent ${formatSol(REGISTRATION_RENT_LAMPORTS)}, returned by close_revenue_token after the term)`,
    );
    for (const line of registrationLines(plan, registrationLabels(plan, keys))) out(line);
    out();
  }
  out('Pre-flight');
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
  for (const check of checks) out(`  ${mark[check.status]}  ${check.name.padEnd(28)} ${check.detail}`);
  const summary = summarizePreflight(checks);

  if (already && registeredHere) {
    recordRegistration(registryPath, entry, {
      programId: keys.programId.toBase58(),
      revenueToken: already.address.toBase58(),
      escrow: revenueTokenAccounts(keys, vote).escrow.toBase58(),
      epoch: Number(already.account.registeredEpoch),
      startEpoch: Number(already.account.startEpoch),
    });
    out();
    out(
      `Already registered: start epoch ${already.account.startEpoch}, the term ends after epoch ${already.account.termEndEpoch - 1n}.`,
    );
    return;
  }
  if (!values.execute) {
    out();
    out(
      summary.ok
        ? 'Dry run: every check passed; add --execute to register.'
        : `Dry run: ${summary.failures.length} check(s) failed.`,
    );
    out('Nothing was signed or sent.');
    if (!summary.ok) process.exitCode = 1;
    return;
  }
  if (!summary.ok) throw new Error(`pre-flight failed: ${summary.failures.map((check) => check.name).join(', ')}`);
  if (!operatorKeypair || !plan)
    throw new Error('LAUNCH_OPERATOR_KEYPAIR_PATH is not set: the operator signs the registration');
  if (!values.yes) {
    const answer = await ask(
      `Type the symbol (${entry.symbol}) to register it for ${entry.termEpochs} epochs on ${cluster.toUpperCase()}: `,
    );
    if (answer !== entry.symbol) throw new Error('confirmation did not match the symbol: nothing was sent');
  }
  const signature = await sendLabelled({
    connection,
    tx: withPriorityFee(registrationTransaction(plan), priority),
    signers: [operatorKeypair],
    label: 'registerRevenueToken',
    cluster,
    rpc,
  });
  const registered = await readRegistered(connection, plan.revenueToken);
  if (!registered) throw new Error(`registered (${signature}) but ${plan.revenueToken.toBase58()} cannot be read yet`);
  recordRegistration(registryPath, entry, {
    programId: keys.programId.toBase58(),
    revenueToken: plan.revenueToken.toBase58(),
    escrow: plan.escrow.toBase58(),
    epoch: Number(registered.registeredEpoch),
    startEpoch: Number(registered.startEpoch),
    signature,
  });
  out();
  out(`RevenueToken       ${explorer('address', plan.revenueToken.toBase58(), cluster, rpc)}`);
  out(
    `Term               epochs ${registered.startEpoch}–${registered.termEndEpoch - 1n} (registered in ${registered.registeredEpoch})`,
  );
  out(
    `Commission floor   inflation ${registered.inflationCommissionBps} bps, block revenue ${registered.blockCommissionBps} bps until the term ends`,
  );
  out(`Buyback escrow     ${plan.escrow.toBase58()} (every sweep's share lands here)`);
  const pending = await waitFinalized(connection, [signature]);
  out(pending.length === 0 ? 'Finalized' : `Not finalized yet: ${signature} (check the explorer)`);
}

/** Writes the program's term and the signature into the launch record (other entries untouched). */
function recordRegistration(
  path: string,
  entry: LaunchRegistryEntry,
  registration: Parameters<typeof withRegistration>[1],
): void {
  const updated = withRegistration(entry, registration);
  try {
    replaceRegistryEntry(path, updated);
    out(`Launch record      updated in ${path}`);
  } catch (error) {
    err(`Could not update the launch record (${error instanceof Error ? error.message : String(error)}); add by hand:`);
    out(JSON.stringify(updated, null, 2));
  }
}

main().catch((error: unknown) => {
  err(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
