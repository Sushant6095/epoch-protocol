/** Shared jest config. Each package runs it with --rootDir set to the package folder. */
const path = require('path');

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: path.join(__dirname, 'tsconfig.base.json'), diagnostics: { warnOnly: false } },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // web3.js → rpc-websockets → ESM-only uuid: stub the websocket client so tests can import web3.js.
  moduleNameMapper: { '^rpc-websockets$': path.join(__dirname, 'jest-stubs/rpc-websockets.js') },
  clearMocks: true,
};
