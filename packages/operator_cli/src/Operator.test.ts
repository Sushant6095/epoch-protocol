import { findVoteAuthPda, instructionNameOf } from '@epoch/epoch-sdk';
import { type SimulationResult } from '@epoch/solana';
import { Keypair, PublicKey } from '@solana/web3.js';

import { advance, key, pool, poolParamsJson, position, PROGRAM_ID, SOL, voteState } from './__fixtures__/accounts';
import { type Command } from './Cli';
import { decodeTransaction, signatureStatus } from './Offline';
import { type OperatorChainLike, type OperatorIo, runCommand, runSignTx } from './Operator';

const VOTE = key(20);

function setup(overrides: Partial<Record<keyof OperatorChainLike, unknown>> = {}) {
  const chain = {
    programId: PROGRAM_ID,
    operator: key(22),
    epoch: jest.fn(async () => 100n),
    position: jest.fn(async () => position()),
    advance: jest.fn(async () => advance()),
    pool: jest.fn(async () => pool()),
    voteState: jest.fn(async () =>
      voteState({ authorizedWithdrawer: findVoteAuthPda(PROGRAM_ID, VOTE)[0].toBase58() }),
    ),
    simulate: jest.fn(async (): Promise<SimulationResult> => ({ ok: true, err: null, logs: [], unitsConsumed: 9_000 })),
    send: jest.fn(async () => 'sig123'),
    signer: Keypair.generate(),
    priorityFeeMicroLamports: 10_000,
    accounts: jest.fn(async (keys: unknown[]) => keys.map(() => null)),
    latestBlockhash: jest.fn(async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 99 })),
    nonce: jest.fn(async () => null),
    simulateSigned: jest.fn(async (): Promise<SimulationResult> => ({
      ok: true,
      err: null,
      logs: [],
      unitsConsumed: 7_000,
    })),
    sendSigned: jest.fn(async () => 'sig456'),
    ...overrides,
  };
  const output: string[] = [];
  const files = new Map<string, string>();
  const io: OperatorIo = {
    out: (text) => void output.push(text),
    confirm: jest.fn(async () => true),
    loadKeypair: jest.fn(() => Keypair.generate()),
    explorer: (signature) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    readFile: (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error('no such file');
      return text;
    },
    writeFile: (path, text) => void files.set(path, text),
  };
  return { chain, io, output, files, text: () => output.join('\n') };
}

const BLOCKHASH = new PublicKey(new Uint8Array(32).fill(3)).toBase58();

const withdraw = (dryRun = false): Command => ({ name: 'withdraw-bond', vote: VOTE, lamports: SOL, dryRun });
const ADMIN = key(70);

describe('runCommand', () => {
  it('status prints the position, the vote account and the open advance', async () => {
    const { chain, io, text } = setup({ position: jest.fn(async () => position({ openAdvance: key(80) })) });
    await expect(runCommand({ name: 'status', vote: VOTE }, chain as OperatorChainLike, io)).resolves.toBe(0);
    expect(text()).toMatch(/status\s+active/);
    expect(text()).toContain('(the Epoch program)');
    expect(text()).toContain(`Open advance ${key(80).toBase58()}`);
    expect(text()).toMatch(/outstanding\s+2\.06 SOL/);
  });

  it('says so when the vote account is not onboarded', async () => {
    const { chain, io, text } = setup({ position: jest.fn(async () => null) });
    await expect(runCommand(withdraw(), chain as OperatorChainLike, io)).resolves.toBe(1);
    expect(text()).toContain('is not onboarded');
  });

  it('simulates, asks, then sends', async () => {
    const { chain, io, text } = setup();
    await expect(runCommand(withdraw(), chain as OperatorChainLike, io)).resolves.toBe(0);
    expect(chain.simulate).toHaveBeenCalledTimes(1);
    expect(io.confirm).toHaveBeenCalledTimes(1);
    expect(chain.send).toHaveBeenCalledWith(expect.any(Array), []);
    expect(text()).toContain('withdraw_bond');
    expect(text()).toContain('Sent: sig123');
  });

  it('--dry-run prints and simulates but never asks or sends', async () => {
    const { chain, io, text } = setup();
    await expect(runCommand(withdraw(true), chain as OperatorChainLike, io)).resolves.toBe(0);
    expect(io.confirm).not.toHaveBeenCalled();
    expect(chain.send).not.toHaveBeenCalled();
    expect(text()).toContain('Dry run: nothing sent.');
    expect(text()).toMatch(/#1 withdraw_bond → program/);
  });

  it('sends nothing when the answer is not yes', async () => {
    const { chain, io, text } = setup();
    (io.confirm as jest.Mock).mockResolvedValueOnce(false);
    await expect(runCommand(withdraw(), chain as OperatorChainLike, io)).resolves.toBe(1);
    expect(chain.send).not.toHaveBeenCalled();
    expect(text()).toContain('Not sent.');
  });

  it('stops before simulating when the program would reject it, and after a failed simulation', async () => {
    const locked = setup({ position: jest.fn(async () => position({ openAdvance: key(80) })) });
    await expect(runCommand(withdraw(), locked.chain as OperatorChainLike, locked.io)).resolves.toBe(1);
    expect(locked.chain.simulate).not.toHaveBeenCalled();
    expect(locked.text()).toContain('cannot send: an advance is open');

    const failing = setup({
      simulate: jest.fn(async () => ({ ok: false, err: { InstructionError: [1, { Custom: 6041 }] }, logs: ['x'] })),
    });
    await expect(runCommand(withdraw(), failing.chain as OperatorChainLike, failing.io)).resolves.toBe(1);
    expect(failing.text()).toContain('Simulation failed: BondLocked (6041)');
    expect(failing.chain.send).not.toHaveBeenCalled();
  });

  it('update-identity co-signs with the new identity keypair', async () => {
    const { chain, io } = setup();
    const command: Command = {
      name: 'update-identity',
      vote: VOTE,
      newIdentityKeypairPath: '/keys/new.json',
      setCollectors: true,
      dryRun: false,
    };
    await expect(runCommand(command, chain as OperatorChainLike, io)).resolves.toBe(0);
    expect(io.loadKeypair).toHaveBeenCalledWith('/keys/new.json');
    const [instructions, signers] = (chain.send as jest.Mock).mock.calls[0] as [unknown[], Keypair[]];
    expect(instructions).toHaveLength(2);
    expect(signers).toHaveLength(1);
  });

  it('pool admin: a dry run by default, sent with --send after the confirmation', async () => {
    const adminPool = { ...pool(), admin: ADMIN, treasury: key(71), scorer: key(72) };
    const dry = setup({ operator: ADMIN, pool: jest.fn(async () => adminPool) });
    await expect(
      runCommand({ name: 'set-paused', paused: true, dryRun: true }, dry.chain as OperatorChainLike, dry.io),
    ).resolves.toBe(0);
    expect(dry.chain.simulate).toHaveBeenCalledTimes(1);
    expect(dry.chain.send).not.toHaveBeenCalled();
    expect(dry.text()).toContain('Run again with --send');

    const live = setup({ operator: ADMIN, pool: jest.fn(async () => adminPool) });
    await expect(
      runCommand({ name: 'set-paused', paused: true, dryRun: false }, live.chain as OperatorChainLike, live.io),
    ).resolves.toBe(0);
    expect(live.io.confirm).toHaveBeenCalledTimes(1);
    const [instructions] = (live.chain.send as jest.Mock).mock.calls[0] as [{ data: Buffer }[]];
    expect(instructions.map((ix) => instructionNameOf(ix.data))).toEqual(['set_paused']);

    const notAdmin = setup({ pool: jest.fn(async () => adminPool) });
    await expect(
      runCommand(
        { name: 'set-roles', scorer: key(81), dryRun: false },
        notAdmin.chain as OperatorChainLike,
        notAdmin.io,
      ),
    ).resolves.toBe(1);
    expect(notAdmin.text()).toContain('NotAdmin');
    expect(notAdmin.chain.simulate).not.toHaveBeenCalled();
  });

  it('init-pool reads the params file', async () => {
    const t = setup({ operator: ADMIN, pool: jest.fn(async () => null) });
    t.files.set('params.json', JSON.stringify(poolParamsJson));
    const command: Command = {
      name: 'init-pool',
      paramsPath: 'params.json',
      treasury: key(71),
      scorer: key(72),
      dryRun: true,
    };
    await expect(runCommand(command, t.chain as OperatorChainLike, t.io)).resolves.toBe(0);
    expect(t.text()).toContain('#1 initialize_pool');
    await expect(
      runCommand({ ...command, paramsPath: 'missing.json' }, t.chain as OperatorChainLike, t.io),
    ).resolves.toBe(1);
    expect(t.text()).toContain('Cannot read missing.json');
  });

  describe('onboard-validator with offline signing, sign-tx and submit-tx', () => {
    const operatorKey = Keypair.generate();
    const withdrawer = Keypair.generate();
    const onboard = (overrides: Partial<Extract<Command, { name: 'onboard-validator' }>> = {}): Command => ({
      name: 'onboard-validator',
      vote: VOTE,
      payout: key(23),
      withdrawer: withdrawer.publicKey,
      bondLamports: 0n,
      setCollectors: true,
      dryRun: false,
      outPath: 'onboard.tx',
      ...overrides,
    });
    const chainFor = () =>
      setup({
        operator: operatorKey.publicKey,
        signer: operatorKey,
        voteState: jest.fn(async () => voteState({ authorizedWithdrawer: withdrawer.publicKey.toBase58() })),
      });

    it('the operator signs and writes the transaction; the withdrawer signs it offline; it is submitted', async () => {
      const op = chainFor();
      await expect(runCommand(onboard(), op.chain as OperatorChainLike, op.io)).resolves.toBe(0);
      expect(op.chain.simulate).toHaveBeenCalledTimes(1);
      expect(op.chain.send).not.toHaveBeenCalled();
      const written = op.files.get('onboard.tx')!;
      const tx = decodeTransaction(written);
      expect(signatureStatus(tx).map((s) => [s.key.toBase58(), s.signed])).toEqual([
        [operatorKey.publicKey.toBase58(), true],
        [withdrawer.publicKey.toBase58(), false],
      ]);
      expect(tx.instructions.map((ix) => instructionNameOf(ix.data))).toEqual([
        null,
        'onboard_validator',
        'set_collectors',
      ]);
      expect(op.text()).toContain('solana decode-transaction');

      // The withdrawer, offline: no chain at all.
      const w = setup();
      w.files.set('onboard.tx', written);
      (w.io.loadKeypair as jest.Mock).mockReturnValueOnce(withdrawer);
      await expect(runSignTx({ name: 'sign-tx', txPath: 'onboard.tx', keypairPath: '/w.json' }, w.io)).resolves.toBe(0);
      const signed = w.files.get('onboard.tx.signed')!;
      expect(signatureStatus(decodeTransaction(signed)).every((s) => s.signed)).toBe(true);

      // Back with the operator: verified, simulated, sent.
      op.files.set('onboard.tx.signed', signed);
      await expect(
        runCommand(
          { name: 'submit-tx', txPath: 'onboard.tx.signed', dryRun: true },
          op.chain as OperatorChainLike,
          op.io,
        ),
      ).resolves.toBe(0);
      expect(op.chain.sendSigned).not.toHaveBeenCalled();
      await expect(
        runCommand(
          { name: 'submit-tx', txPath: 'onboard.tx.signed', dryRun: false },
          op.chain as OperatorChainLike,
          op.io,
        ),
      ).resolves.toBe(0);
      expect(op.chain.simulateSigned).toHaveBeenCalledTimes(2);
      expect(op.chain.sendSigned).toHaveBeenCalledTimes(1);
      expect(op.text()).toContain('Sent: sig456');
    });

    it('submit-tx refuses a transaction that still misses a signature', async () => {
      const op = chainFor();
      await runCommand(onboard(), op.chain as OperatorChainLike, op.io);
      await expect(
        runCommand({ name: 'submit-tx', txPath: 'onboard.tx', dryRun: false }, op.chain as OperatorChainLike, op.io),
      ).resolves.toBe(1);
      expect(op.text()).toContain(`cannot send: missing the signature of ${withdrawer.publicKey.toBase58()}`);
      expect(op.chain.simulateSigned).not.toHaveBeenCalled();
    });

    it('sign-tx refuses a key the transaction does not ask for', async () => {
      const op = chainFor();
      await runCommand(onboard(), op.chain as OperatorChainLike, op.io);
      const w = setup();
      w.files.set('onboard.tx', op.files.get('onboard.tx')!);
      await expect(
        runSignTx({ name: 'sign-tx', txPath: 'onboard.tx', keypairPath: '/other.json' }, w.io),
      ).resolves.toBe(1);
      expect(w.text()).toContain('is not a signer of this transaction');
    });

    it('uses a durable nonce when given one, and signs here with --withdrawer-keypair', async () => {
      const op = chainFor();
      (op.chain.nonce as jest.Mock).mockResolvedValueOnce({ nonce: BLOCKHASH, authority: operatorKey.publicKey });
      await expect(runCommand(onboard({ nonce: key(50) }), op.chain as OperatorChainLike, op.io)).resolves.toBe(0);
      const tx = decodeTransaction(op.files.get('onboard.tx')!);
      expect(tx.instructions[0].data.readUInt32LE(0)).toBe(4); // AdvanceNonceAccount first
      expect(op.chain.latestBlockhash).not.toHaveBeenCalled();

      const local = chainFor();
      (local.io.loadKeypair as jest.Mock).mockReturnValueOnce(withdrawer);
      await expect(
        runCommand(
          onboard({ withdrawerKeypairPath: '/w.json', outPath: undefined }),
          local.chain as OperatorChainLike,
          local.io,
        ),
      ).resolves.toBe(0);
      const [, signers] = (local.chain.send as jest.Mock).mock.calls[0] as [unknown, Keypair[]];
      expect(signers.map((k) => k.publicKey.toBase58())).toEqual([withdrawer.publicKey.toBase58()]);
    });

    it('a dry run signs nothing', async () => {
      const op = chainFor();
      await expect(runCommand(onboard({ dryRun: true }), op.chain as OperatorChainLike, op.io)).resolves.toBe(0);
      expect(op.files.size).toBe(0);
      expect(op.text()).toContain('Dry run: nothing signed');
    });
  });
});
