import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import unusedImports from 'eslint-plugin-unused-imports';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'app/**', 'programs/**', 'target/**', '**/migrations/**', '**/*.js', '**/*.mjs'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  prettier,
  {
    files: ['packages/**/*.ts'],
    plugins: { 'unused-imports': unusedImports },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': ['warn', { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      eqeqeq: ['error', 'always'],
    },
  },
);
