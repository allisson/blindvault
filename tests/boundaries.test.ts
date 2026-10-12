import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const cryptoFile = `${root}packages/crypto/src/boundary-probe.ts`;
const vaultFile = `${root}packages/vault/src/boundary-probe.ts`;
const storageFile = `${root}packages/storage/src/boundary-probe.ts`;
const webFile = `${root}apps/web/src/boundary-probe.ts`;

async function restricted(code: string, filePath: string, rule: string): Promise<string[]> {
  // The probe files do not exist on disk, so the type-aware project service cannot load them.
  const eslint = new ESLint({ cwd: root, overrideConfig: tseslint.configs.disableTypeChecked });
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === rule).map((m) => m.message);
}

function restrictedImports(code: string, filePath: string): Promise<string[]> {
  return restricted(code, filePath, 'no-restricted-imports');
}

describe('packages/crypto import boundary', () => {
  it.each([
    "import '@blindvault/vault';",
    "import '@blindvault/storage';",
    "import 'react';",
    "import 'react-dom/client';",
  ])('rejects %s', async (code) => {
    expect(await restrictedImports(`${code}\nexport {};\n`, cryptoFile)).toHaveLength(1);
  });

  it('does not restrict other packages', async () => {
    expect(await restrictedImports("import 'react';\nexport {};\n", vaultFile)).toEqual([]);
  });
});

describe('packages/storage import boundary', () => {
  it.each(["import '@blindvault/vault';", "import '@blindvault/sync';", "import 'react';"])(
    'rejects %s',
    async (code) => {
      expect(await restrictedImports(`${code}\nexport {};\n`, storageFile)).toHaveLength(1);
    },
  );

  it('allows @blindvault/crypto', async () => {
    const code = "import '@blindvault/crypto';\nexport {};\n";
    expect(await restrictedImports(code, storageFile)).toEqual([]);
  });
});

describe('apps/web keeps vault state out of the URL and history (D167)', () => {
  it.each([
    "history.pushState({}, '', '/item');",
    "history.replaceState({}, '', '/item');",
    "location.hash = 'item';",
    "location.search = '?id=1';",
    "location.assign('/item');",
    "location.replace('/item');",
  ])('rejects %s', async (code) => {
    expect(
      await restricted(`${code}\nexport {};\n`, webFile, 'no-restricted-properties'),
    ).toHaveLength(1);
  });
});
