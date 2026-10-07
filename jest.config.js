/** Root jest config: runs every package's *.test.ts in one process. */
const base = require('./jest.config.base');

module.exports = {
  ...base,
  rootDir: __dirname,
  testMatch: ['<rootDir>/packages/*/src/**/*.test.ts', '<rootDir>/scripts/devnet/src/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};
