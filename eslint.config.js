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
);
