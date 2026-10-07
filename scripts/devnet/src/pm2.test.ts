import path from 'node:path';

import { REPO_ROOT } from './lib/keys';

interface Pm2App {
  name: string;
  cwd: string;
  args: string;
  env: Record<string, string>;
}
interface Pm2File {
  apps: Pm2App[];
  envFile: (value?: string) => string;
}

function load(envFile: string): Pm2File {
  process.env.EPOCH_ENV_FILE = envFile;
  let loaded: Pm2File | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('../pm2.devnet.config.js') as Pm2File;
  });
  return loaded!;
}

describe('pm2.devnet.config.js', () => {
  afterEach(() => delete process.env.EPOCH_ENV_FILE);

  it('runs the indexer, cranks, publisher and Panta bot on devnet with the env file outside the repo', () => {
    const { apps } = load('/srv/epoch/devnet.env');
    expect(apps.map((a) => a.name)).toEqual([
      'epoch-devnet-indexer',
      'epoch-devnet-cranks',
      'epoch-devnet-publisher',
      'epoch-devnet-panta-bot',
    ]);
    for (const a of apps) {
      expect(a.args).toBe('--env /srv/epoch/devnet.env');
      expect(a.env.EPOCH_CLUSTER).toBe('devnet');
      expect(a.cwd.startsWith(path.join(REPO_ROOT, 'packages'))).toBe(true);
    }
  });

  it('refuses an env file inside the repo or none at all', () => {
    expect(() => load(path.join(REPO_ROOT, '.env'))).toThrow(/outside the repo/);
    const { envFile } = load('/srv/epoch/devnet.env');
    expect(() => envFile('')).toThrow(/EPOCH_ENV_FILE/);
  });
});
