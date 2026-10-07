/**
 * pm2 entries for Epoch's keepers against the devnet program (docs/runbooks/devnet.md):
 *   pnpm build && EPOCH_ENV_FILE=/abs/path/devnet.env pm2 start scripts/devnet/pm2.devnet.config.js
 * The env file lives outside the repo (template: scripts/devnet/devnet.env.example). The indexer reads mainnet data
 * (DATA_RPC_URL) and the devnet program; cranks, publisher and the Panta bot point at devnet (EPOCH_RPC_URL).
 * Same process shape as the root pm2.config.js; each app reads the env file through its --env flag.
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const APPS = ['indexer_app', 'cranks_app', 'publisher_app', 'panta_bot_app'];

function envFile(value = process.env.EPOCH_ENV_FILE) {
  if (!value) throw new Error('set EPOCH_ENV_FILE to the devnet env file (kept outside the repo)');
  const file = path.resolve(value);
  if (file === ROOT || file.startsWith(ROOT + path.sep)) {
    throw new Error(`EPOCH_ENV_FILE must live outside the repo, not ${file}`);
  }
  return file;
}

function devnetApps(file = envFile()) {
  return APPS.map((name) => ({
    name: `epoch-devnet-${name.replace(/_app$/, '').replace(/_/g, '-')}`,
    cwd: path.join(ROOT, 'packages', name),
    script: 'dist/index.js',
    args: `--env ${file}`,
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '512M',
    kill_timeout: 10000,
    env: { NODE_ENV: 'production', CLUSTER: 'devnet', EPOCH_CLUSTER: 'devnet' },
  }));
}

module.exports = { apps: devnetApps(), devnetApps, envFile };
