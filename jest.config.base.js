/** Shared jest config. Each package runs it with --rootDir set to the package folder. */
const path = require('path');

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: path.join(__dirname, 'tsconfig.base.json'), diagnostics: { warnOnly: false } }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
};
