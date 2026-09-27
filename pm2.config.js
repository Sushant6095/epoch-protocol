/**
 * pm2 process file for running the off-chain services on one box.
 *   pnpm build && pm2 start pm2.config.js --env devnet
 * Each app reads its env file via the --env flag handled by @epoch/common/first-module.
 */
const apps = ['api_app', 'indexer_app', 'cranks_app', 'publisher_app', 'panta_bot_app'];

module.exports = {
  apps: apps.map((name) => ({
    name: `epoch-${name.replace(/_app$/, '').replace(/_/g, '-')}`,
    cwd: `./packages/${name}`,
    script: 'dist/index.js',
    args: '--env ../../.env',
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '512M',
    kill_timeout: 10000,
    env: { NODE_ENV: 'production' },
    env_devnet: { NODE_ENV: 'production', CLUSTER: 'devnet' },
    env_mainnet: { NODE_ENV: 'production', CLUSTER: 'mainnet' },
  })),
};
