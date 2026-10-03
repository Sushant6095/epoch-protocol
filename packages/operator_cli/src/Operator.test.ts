import { findVoteAuthPda } from '@epoch/epoch-sdk';
import { type SimulationResult } from '@epoch/solana';
import { Keypair } from '@solana/web3.js';

import { advance, key, pool, position, PROGRAM_ID, SOL, voteState } from './__fixtures__/accounts';
import { type Command } from './Cli';
import { type OperatorChainLike, type OperatorIo, runCommand } from './Operator';

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
    ...overrides,
  };
  const output: string[] = [];
  const io: OperatorIo = {
    out: (text) => void output.push(text),
    confirm: jest.fn(async () => true),
    loadKeypair: jest.fn(() => Keypair.generate()),
    explorer: (signature) => `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
  };
  return { chain, io, output, text: () => output.join('\n') };
}

const withdraw = (dryRun = false): Command => ({ name: 'withdraw-bond', vote: VOTE, lamports: SOL, dryRun });

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
});
