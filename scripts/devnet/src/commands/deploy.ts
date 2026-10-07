/**
 * `pnpm devnet deploy --url devnet --keys <dir> --program-keypair <path> [--deployer <path>] [--max-len 1600000]
 *    [--upgrade-authority-to <pubkey>] [--skip-build] [--build-lock <file>] [--so <path>] [--solana <cli>] [--yes]`
 *
 * 1. Points every copy of the program id at the keypair's address (`scripts/set-program-id.sh`), unless it already is.
 * 2. Builds the SBF program (through `flock <lock>` when a lock file is given, one job) and checks the build embeds
 *    the id.
 * 3. Prints the exact cost from the cluster's rent and the deployer's balance; refuses when short.
 * 4. Writes a buffer whose keypair lives in the key folder (a failed write resumes), then deploys from it with
 *    `--max-len` room for upgrades. An existing program with the same bytes is left alone; different bytes upgrade it.
 * 5. Verifies the program-data bytes and authority on chain, and optionally hands the upgrade authority to a pubkey.
 *
 * Shape from spl-stake-pool's CLI and Agave's own `solana program write-buffer` / `deploy --buffer` flow
 * (scripts/mainnet/go-live.md §3); the Solana CLI does the loader work, this command adds the checks around it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PublicKey } from '@solana/web3.js';

import { deployLines, perByteFromRentOfZero, rentFromPerByte, sol, totals } from '../lib/budget';
import { type Context } from '../lib/context';
import { KitError } from '../lib/errors';
import { readKeypair, REPO_ROOT } from '../lib/keys';
import {
  deployedMatches,
  parseProgramAccount,
  parseProgramData,
  programDataAddress,
  sha256,
  soDeclaresId,
} from '../lib/loader';
import { out, step } from '../lib/log';
import { confirm, lastJson, run } from '../lib/run';
import { StateStore } from '../lib/state';
import { DEFAULT_MAX_LEN, defaultSoPath } from './budget';

export const DEPLOY_OPTIONS = {
  'program-keypair': { type: 'string' },
  deployer: { type: 'string' },
  'max-len': { type: 'string' },
  'upgrade-authority-to': { type: 'string' },
  'skip-build': { type: 'boolean', default: false },
  'build-lock': { type: 'string' },
  so: { type: 'string' },
  solana: { type: 'string' },
} as const;

export interface DeployOptions {
  'program-keypair'?: string;
  deployer?: string;
  'max-len'?: string;
  'upgrade-authority-to'?: string;
  'skip-build'?: boolean;
  'build-lock'?: string;
  so?: string;
  solana?: string;
}

const LIB_RS = path.join(REPO_ROOT, 'programs/epoch/src/lib.rs');

export function declaredId(libRs = fs.readFileSync(LIB_RS, 'utf8')): string {
  const m = /^declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\);/m.exec(libRs);
  if (!m) throw new KitError('CHECK_FAILED', 'no declare_id! in programs/epoch/src/lib.rs');
  return m[1];
}

/** The cargo-build-sbf command line, wrapped in `flock` when a lock file is given (shared build machines). */
export function buildCommand(lock: string | undefined): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const sbf = ['cargo-build-sbf', '--manifest-path', path.join(REPO_ROOT, 'programs/epoch/Cargo.toml')];
  const env: NodeJS.ProcessEnv = {
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(REPO_ROOT, 'target'),
  };
  if (!lock) return { cmd: sbf[0], args: sbf.slice(1), env };
  return { cmd: 'flock', args: [lock, 'env', 'CARGO_BUILD_JOBS=1', ...sbf], env: { ...env, CARGO_BUILD_JOBS: '1' } };
}

/**
 * Cargo shares the `epoch` crate's fingerprint between this crate and the copies other builds compile in the same
 * target dir (programs/epoch/tests/build-sbf.sh), so after one of those it can call this build fresh and keep the
 * copy's binary, with the copy's program id. Forgetting the fingerprint recompiles only `epoch` (≈ 15 s).
 */
export function forgetEpochFingerprint(targetDir: string): void {
  const dir = path.join(targetDir, 'sbpf-solana-solana', 'release', '.fingerprint');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('epoch-')) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/** Lowercase key name for the buffer keypair of a program (key names are [a-z0-9-]). */
export function bufferKeyName(programId: PublicKey): string {
  return `buffer-${createHash('sha256').update(programId.toBytes()).digest('hex').slice(0, 12)}`;
}

export async function runDeploy(ctx: Context, o: DeployOptions): Promise<void> {
  if (!ctx.keys || !ctx.stateDir) throw new KitError('BAD_ARGS', '--keys is required');
  if (!o['program-keypair']) throw new KitError('BAD_ARGS', '--program-keypair <path outside the repo> is required');
  const conn = ctx.cluster.connection;
  const programKeypairPath = o['program-keypair'];
  const programId = readKeypair(programKeypairPath).publicKey;
  const deployerPath = o.deployer ?? ctx.keys.path('deployer');
  const deployer = readKeypair(deployerPath);
  const solana = o.solana ?? 'solana';
  const handTo = o['upgrade-authority-to'] ? new PublicKey(o['upgrade-authority-to']) : null;
  const state = new StateStore(ctx.stateDir, 'deploy', ctx.cluster.name, ctx.cluster.genesisHash, programId.toBase58());
  const cliConfig = path.join(ctx.stateDir, 'solana-cli.yml');
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  fs.writeFileSync(
    cliConfig,
    `json_rpc_url: "${ctx.cluster.rpcUrl}"\nwebsocket_url: "${ctx.cluster.wsUrl}"\nkeypair_path: "${deployerPath}"\ncommitment: confirmed\n`,
  );
  const cli = (args: string[], label: string, inherit = false): string =>
    run(solana, ['--config', cliConfig, '--url', ctx.cluster.rpcUrl, '--commitment', 'confirmed', ...args], {
      label,
      inherit,
    });
  const priority = ctx.priorityFee > 0n ? ['--with-compute-unit-price', ctx.priorityFee.toString()] : [];

  out(`Program id ${programId.toBase58()} · deployer ${deployer.publicKey.toBase58()} · ${ctx.cluster.name}`);

  // 1. Program id everywhere in the repo.
  if (declaredId() !== programId.toBase58()) {
    step(
      `scripts/set-program-id.sh ${programId.toBase58()} (declare_id!, Anchor.toml, IDL, .env.example, SDK vectors)`,
    );
    run('bash', [path.join(REPO_ROOT, 'scripts/set-program-id.sh'), programId.toBase58()], {
      label: 'set-program-id.sh',
      inherit: true,
      env: { CARGO_BUILD_JOBS: '1' },
    });
  } else {
    step('program id already set in the repo');
  }

  // 2. Build.
  const soPath = o.so ?? defaultSoPath();
  if (!o['skip-build']) {
    const b = buildCommand(o['build-lock'] ?? process.env.EPOCH_SBF_LOCK);
    forgetEpochFingerprint(b.env.CARGO_TARGET_DIR!);
    step(`building: ${b.cmd} ${b.args.join(' ')}`);
    run(b.cmd, b.args, { label: 'cargo-build-sbf', inherit: true, env: b.env });
  }
  if (!fs.existsSync(soPath)) throw new KitError('CHECK_FAILED', `no build at ${soPath}`);
  const so = fs.readFileSync(soPath);
  if (!soDeclaresId(so, programId)) {
    throw new KitError(
      'CHECK_FAILED',
      `${soPath} was not built for ${programId.toBase58()}; rebuild without --skip-build`,
    );
  }
  const maxLen = Number(o['max-len'] ?? Math.max(DEFAULT_MAX_LEN, so.length));
  step(`build ${soPath}: ${so.length} bytes, sha256 ${sha256(so)}`);

  // 3. What is on chain, and what it costs.
  const programInfo = await conn.getAccountInfo(programId);
  const pdAddress = programDataAddress(programId);
  if (programInfo) {
    if (!parseProgramAccount(programInfo.data).equals(pdAddress)) {
      throw new KitError('CHECK_FAILED', `${programId.toBase58()} exists but is not an upgradeable program`);
    }
    const pdInfo = await conn.getAccountInfo(pdAddress);
    const current = pdInfo ? parseProgramData(pdInfo.data) : null;
    if (current && deployedMatches(current.bytes, so)) {
      step('the program on chain already has these exact bytes; nothing to deploy');
      await handOver();
      return;
    }
    if (current && !current.authority?.equals(deployer.publicKey)) {
      throw new KitError(
        'CHECK_FAILED',
        `upgrade authority is ${current.authority?.toBase58() ?? 'none (immutable)'}, not the deployer; it must sign the upgrade`,
      );
    }
  }
  const rent = rentFromPerByte(perByteFromRentOfZero(BigInt(await conn.getMinimumBalanceForRentExemption(0))));
  const lines = deployLines({ soLen: so.length, maxLen, rent, microLamportsPerCu: ctx.priorityFee }).filter(
    (l) => !programInfo || l.temporary || l.item.includes('writes'),
  );
  const t = totals(lines);
  const before = BigInt(await conn.getBalance(deployer.publicKey));
  for (const l of lines)
    out(`  ${sol(l.lamports).padStart(15)} SOL  ${l.temporary ? 'refunded ' : 'spent    '}  ${l.item}`);
  out(`  needs ${sol(t.peak)} SOL at once (${sol(t.spent)} kept); deployer has ${sol(before)} SOL`);
  if (before < t.peak) {
    throw new KitError(
      'INSUFFICIENT_FUNDS',
      `deployer ${deployer.publicKey.toBase58()} is ${sol(t.peak - before)} SOL short; send at least that much`,
    );
  }
  await confirm(`${programInfo ? 'Upgrade' : 'Deploy'} ${programId.toBase58()} on ${ctx.cluster.name}?`, ctx.yes);

  // 4. Buffer (resumable: the same buffer keypair picks up where a failed write stopped), then deploy from it.
  const bufferPath = ctx.keys.path(bufferKeyName(programId));
  const buffer = ctx.keys.getOrCreate(bufferKeyName(programId)).publicKey;
  step(`writing buffer ${buffer.toBase58()} (${Math.ceil(so.length / 1000)} transactions or so)`);
  cli(
    [
      'program',
      'write-buffer',
      soPath,
      '--buffer',
      bufferPath,
      '--buffer-authority',
      deployerPath,
      '--fee-payer',
      deployerPath,
      '--keypair',
      deployerPath,
      '--max-sign-attempts',
      '100',
      '--use-rpc',
      ...priority,
    ],
    'solana program write-buffer',
    true,
  );
  step(programInfo ? 'upgrading from the buffer' : `deploying from the buffer (max-len ${maxLen})`);
  const deployed = lastJson<{ programId?: string; signature?: string }>(
    cli(
      [
        'program',
        'deploy',
        '--buffer',
        buffer.toBase58(),
        '--program-id',
        programKeypairPath,
        '--upgrade-authority',
        deployerPath,
        '--keypair',
        deployerPath,
        ...(programInfo ? [] : ['--max-len', String(maxLen)]),
        '--output',
        'json',
        ...priority,
      ],
      'solana program deploy',
    ),
  );

  // 5. Verify on chain.
  const pd = await conn.getAccountInfo(pdAddress, 'confirmed');
  if (!pd) throw new KitError('CHECK_FAILED', `program data ${pdAddress.toBase58()} not found after deploy`);
  const now = parseProgramData(pd.data);
  if (!deployedMatches(now.bytes, so))
    throw new KitError('CHECK_FAILED', 'on-chain program bytes differ from the build');
  if (!now.authority?.equals(deployer.publicKey))
    throw new KitError('CHECK_FAILED', 'unexpected upgrade authority after deploy');
  const after = BigInt(await conn.getBalance(deployer.publicKey));
  step(`deployed: ${pd.data.length} bytes of program data, slot ${now.slot}; spent ${sol(before - after)} SOL`);
  state.record(`deploy:${sha256(so).slice(0, 16)}`, {
    signature: deployed.signature,
    programData: pdAddress.toBase58(),
    programDataLen: pd.data.length,
    soSha256: sha256(so),
    soLen: so.length,
    spentLamports: (before - after).toString(),
    slot: Number(now.slot),
  });
  await handOver();

  async function handOver(): Promise<void> {
    if (!handTo) return;
    const info = await conn.getAccountInfo(pdAddress, 'confirmed');
    const currentAuthority = info ? parseProgramData(info.data).authority : null;
    if (currentAuthority?.equals(handTo)) {
      step(`upgrade authority is already ${handTo.toBase58()}`);
      return;
    }
    await confirm(
      `Hand the upgrade authority of ${programId.toBase58()} to ${handTo.toBase58()}? (cannot be undone by the deployer)`,
      ctx.yes,
    );
    cli(
      [
        'program',
        'set-upgrade-authority',
        programId.toBase58(),
        '--upgrade-authority',
        deployerPath,
        '--new-upgrade-authority',
        handTo.toBase58(),
        '--skip-new-upgrade-authority-signer-check',
        '--keypair',
        deployerPath,
      ],
      'solana program set-upgrade-authority',
    );
    const check = await conn.getAccountInfo(pdAddress, 'confirmed');
    if (!check || !parseProgramData(check.data).authority?.equals(handTo)) {
      throw new KitError('CHECK_FAILED', 'upgrade authority hand-over did not take effect');
    }
    state.record('upgrade-authority', { authority: handTo.toBase58() });
    step(`upgrade authority handed to ${handTo.toBase58()}`);
  }
}
