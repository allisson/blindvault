import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/coverage/',
      '**/.tsbuild/',
      '**/playwright-report/',
      '**/test-results/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // The service worker ships as written (D190): no bundler, the service-worker globals only.
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    // packages/crypto is the root of the dependency graph: no other workspace package, no UI.
    // A relative import that leaves the package is also rejected by tsc (composite project).
    files: ['packages/crypto/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@blindvault/*'],
              message: 'packages/crypto must not import other workspace packages.',
            },
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
              message: 'packages/crypto must not contain UI code.',
            },
          ],
        },
      ],
    },
  },
  {
    // D167: navigation lives in memory. Nothing writes the URL or the history.
    files: ['apps/web/src/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...['pushState', 'replaceState'].map((property) => ({
          object: 'history',
          property,
          message: 'No vault state in the history (D167).',
        })),
        ...['hash', 'search', 'assign', 'replace'].map((property) => ({
          object: 'location',
          property,
          message: 'No vault state in the URL (D167).',
        })),
      ],
    },
  },
  {
    // CRYPTO-INV-005: the app and the packages write no log, so no key or secret can reach one.
    files: ['apps/web/src/**', 'packages/*/src/**'],
    ignores: ['**/*.test.ts', '**/*.test.tsx', '**/test-helpers.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // packages/storage persists sealed records and Local Config: crypto types only, no domain, no UI.
    files: ['packages/storage/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@blindvault/*', '!@blindvault/crypto'],
              message: 'packages/storage imports no workspace package but @blindvault/crypto.',
            },
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
              message: 'packages/storage must not contain UI code.',
            },
          ],
        },
      ],
    },
  },
  {
    // packages/sync runs the pairing and sync protocols over a transport: crypto only. The vault
    // session merges what it receives (D182), so sync never imports the vault, storage or the UI.
    files: ['packages/sync/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@blindvault/*', '!@blindvault/crypto'],
              message: 'packages/sync imports no workspace package but @blindvault/crypto.',
            },
            {
              group: ['react', 'react/*', 'react-dom', 'react-dom/*'],
              message: 'packages/sync must not contain UI code.',
            },
          ],
        },
      ],
    },
  },
);
