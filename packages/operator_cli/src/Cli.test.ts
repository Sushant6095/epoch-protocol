import { key } from './__fixtures__/accounts';
import { keypairOverride, parseCommand, UsageError } from './Cli';

const VOTE = key(20).toBase58();

describe('parseCommand', () => {
  it('parses every command', () => {
    expect(parseCommand(['status', '--vote', VOTE])).toEqual({ name: 'status', vote: key(20) });
    expect(parseCommand(['update-commission', '--vote', VOTE, '--kind', 'block', '--bps', '750', '--send'])).toEqual({
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
      dryRun: true,
    });
    expect(parseCommand(['release', '--vote', VOTE])).toMatchObject({ newWithdrawer: undefined });
  });

  it('is a dry run unless --send', () => {
    expect(parseCommand(['withdraw-bond', '--vote', VOTE, '--sol', '1'])).toMatchObject({ dryRun: true });
    expect(parseCommand(['withdraw-bond', '--vote', VOTE, '--sol', '1', '--dry-run'])).toMatchObject({ dryRun: true });
    expect(parseCommand(['withdraw-bond', '--vote', VOTE, '--sol', '1', '--send'])).toMatchObject({ dryRun: false });
  });

  it('parses the admin, onboarding, revenue-token and offline commands', () => {
    expect(
      parseCommand(['init-pool', '--params', 'p.json', '--treasury', key(1).toBase58(), '--scorer', key(2).toBase58()]),
    ).toEqual({ name: 'init-pool', paramsPath: 'p.json', treasury: key(1), scorer: key(2), dryRun: true });
    expect(parseCommand(['set-roles', '--new-admin', key(3).toBase58(), '--send'])).toEqual({
      name: 'set-roles',
      newAdmin: key(3),
      treasury: undefined,
      scorer: undefined,
      dryRun: false,
    });
    expect(parseCommand(['set-paused', '--paused', 'true'])).toEqual({
      name: 'set-paused',
      paused: true,
      dryRun: true,
    });
    expect(
      parseCommand([
        'onboard-validator',
        '--vote',
        VOTE,
        '--payout',
        key(4).toBase58(),
        '--withdrawer',
        key(5).toBase58(),
        '--bond-sol',
        '2',
        '--nonce',
        key(6).toBase58(),
        '--out',
        'o.tx',
        '--send',
      ]),
    ).toEqual({
      name: 'onboard-validator',
      vote: key(20),
      payout: key(4),
      withdrawer: key(5),
      withdrawerKeypairPath: undefined,
      bondLamports: 2_000_000_000n,
      setCollectors: true,
      nonce: key(6),
      outPath: 'o.tx',
      dryRun: false,
    });
    expect(
      parseCommand([
        'onboard-validator',
        '--vote',
        VOTE,
        '--payout',
        VOTE,
        '--withdrawer',
        VOTE,
        '--no-set-collectors',
      ]),
    ).toMatchObject({ bondLamports: 0n, setCollectors: false, dryRun: true });
    expect(parseCommand(['set-collectors', '--vote', VOTE])).toEqual({
      name: 'set-collectors',
      vote: key(20),
      dryRun: true,
    });
    expect(
      parseCommand([
        'register-revenue-token',
        '--vote',
        VOTE,
        '--mint',
        key(7).toBase58(),
        '--dbc-config',
        key(8).toBase58(),
        '--share-bps',
        '500',
        '--term-epochs',
        '100',
      ]),
    ).toEqual({
      name: 'register-revenue-token',
      vote: key(20),
      mint: key(7),
      dbcConfig: key(8),
      shareBps: 500,
      termEpochs: 100,
      dryRun: true,
    });
    expect(parseCommand(['sign-tx', '--tx', 'o.tx', '--keypair', '/k.json'])).toEqual({
      name: 'sign-tx',
      txPath: 'o.tx',
      keypairPath: '/k.json',
      outPath: undefined,
    });
    expect(parseCommand(['submit-tx', '--tx', 'o.tx.signed', '--send'])).toEqual({
      name: 'submit-tx',
      txPath: 'o.tx.signed',
      dryRun: false,
    });
    expect(keypairOverride(['set-paused', '--paused', 'true', '--keypair', '/admin.json'])).toBe('/admin.json');
    expect(keypairOverride(['set-paused', '--paused', 'true'])).toBeUndefined();
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
    [['withdraw-bond', '--vote', VOTE, '--sol', '1', '--send', '--dry-run'], '--send and --dry-run contradict'],
    [['init-pool', '--treasury', VOTE, '--scorer', VOTE], '--params is required'],
    [['set-roles'], 'give at least one of'],
    [['set-paused', '--paused', 'yes'], '--paused must be true or false'],
    [['onboard-validator', '--vote', VOTE, '--payout', VOTE], '--withdrawer is required'],
    [
      [
        'onboard-validator',
        '--vote',
        VOTE,
        '--payout',
        VOTE,
        '--withdrawer',
        VOTE,
        '--withdrawer-keypair',
        'w',
        '--out',
        'x',
      ],
      '--withdrawer-keypair signs here',
    ],
    [
      [
        'register-revenue-token',
        '--vote',
        VOTE,
        '--mint',
        VOTE,
        '--dbc-config',
        VOTE,
        '--share-bps',
        '5001',
        '--term-epochs',
        '10',
      ],
      '--share-bps must be',
    ],
    [
      [
        'register-revenue-token',
        '--vote',
        VOTE,
        '--mint',
        VOTE,
        '--dbc-config',
        VOTE,
        '--share-bps',
        '50',
        '--term-epochs',
        '9',
      ],
      '--term-epochs must be',
    ],
    [['sign-tx', '--tx', 'x'], '--keypair is required'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCommand(argv)).toThrow(UsageError);
    expect(() => parseCommand(argv)).toThrow(message);
  });
});
