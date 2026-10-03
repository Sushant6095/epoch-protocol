import { key } from './__fixtures__/accounts';
import { parseCommand, UsageError } from './Cli';

const VOTE = key(20).toBase58();

describe('parseCommand', () => {
  it('parses every command', () => {
    expect(parseCommand(['status', '--vote', VOTE])).toEqual({ name: 'status', vote: key(20) });
    expect(parseCommand(['update-commission', '--vote', VOTE, '--kind', 'block', '--bps', '750'])).toEqual({
      name: 'update-commission',
      vote: key(20),
      kind: 'block',
      bps: 750,
      dryRun: false,
    });
    expect(
      parseCommand(['update-identity', '--vote', VOTE, '--new-identity-keypair', '/keys/id.json', '--dry-run']),
    ).toEqual({
      name: 'update-identity',
      vote: key(20),
      newIdentityKeypairPath: '/keys/id.json',
      setCollectors: true,
      dryRun: true,
    });
    expect(
      parseCommand(['update-identity', '--vote', VOTE, '--new-identity-keypair', 'x', '--no-set-collectors']),
    ).toMatchObject({ setCollectors: false });
    expect(parseCommand(['withdraw-bond', '--vote', VOTE, '--sol', '1.25'])).toMatchObject({
      name: 'withdraw-bond',
      lamports: 1_250_000_000n,
    });
    expect(parseCommand(['release', '--vote', VOTE, '--new-withdrawer', key(5).toBase58()])).toEqual({
      name: 'release',
      vote: key(20),
      newWithdrawer: key(5),
      dryRun: false,
    });
    expect(parseCommand(['release', '--vote', VOTE])).toMatchObject({ newWithdrawer: undefined });
  });

  it('accepts --env (read by first-module) and shows help', () => {
    expect(parseCommand(['status', '--vote', VOTE, '--env', '.env.devnet'])).toMatchObject({ name: 'status' });
    expect(parseCommand([])).toEqual({ name: 'help' });
    expect(parseCommand(['--help'])).toEqual({ name: 'help' });
  });

  it.each([
    [['frobnicate', '--vote', VOTE], "unknown command 'frobnicate'"],
    [['status'], '--vote is required'],
    [['status', '--vote', 'nope'], 'not a valid public key'],
    [['update-commission', '--vote', VOTE, '--kind', 'mev', '--bps', '1'], '--kind must be inflation or block'],
    [['update-commission', '--vote', VOTE, '--kind', 'block', '--bps', '10001'], '--bps must be'],
    [['update-commission', '--vote', VOTE, '--kind', 'block', '--bps', '-5'], '--bps'],
    [['update-identity', '--vote', VOTE], '--new-identity-keypair is required'],
    [['withdraw-bond', '--vote', VOTE, '--sol', '0'], '--sol must be more than 0'],
    [['withdraw-bond', '--vote', VOTE, '--sol', '0.0000000001'], '--sol must be a SOL amount'],
    [['status', '--vote', VOTE, '--bogus'], "Unknown option '--bogus'"],
    [['status', 'extra', '--vote', VOTE], "unexpected argument 'extra'"],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    expect(() => parseCommand(argv)).toThrow(message);
  });
});
