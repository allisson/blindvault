// The extension's packages (extension.md §2, D285): `apps/web`'s extension build, the browser's
// `manifest.json` and the service worker, with the package's own `asset-manifest.txt` listing every
// file, `manifest.json` included. For each browser: `dist/<browser>/`, to load unpacked, and
// `dist/blindvault-<browser>-<version>.zip`, reproducible. `node build/package.ts` runs it after
// `vite build --mode extension` (`pnpm build`), so it imports nothing but Node's own modules and
// the asset manifest of the web build.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST,
  type BuildFile,
  assertNodeVersion,
  manifestHash,
  manifestOf,
} from '../../web/build/asset-manifest.ts';
import { BROWSERS, type Browser, manifestJson } from './manifest.ts';
import { zip } from './zip.ts';

export const SERVICE_WORKER = 'background.js';

/** The files of one browser's package, its asset manifest last. */
export function packageFiles(
  browser: Browser,
  web: readonly BuildFile[],
  version: string,
  worker: Uint8Array,
): { readonly files: readonly BuildFile[]; readonly hash: string } {
  const own: BuildFile[] = [
    { path: 'manifest.json', bytes: new TextEncoder().encode(manifestJson(browser, version)) },
    { path: SERVICE_WORKER, bytes: worker },
  ];
  // The web build's manifest lists the web build alone; the package gets its own.
  const files = [...web.filter((f) => f.path !== MANIFEST), ...own];
  const manifest = manifestOf(files);
  return {
    files: [...files, { path: MANIFEST, bytes: new TextEncoder().encode(manifest) }],
    hash: manifestHash(manifest),
  };
}

/** `version.txt` of the web build (D191), without its newline. */
export function versionOf(web: readonly BuildFile[]): string {
  const file = web.find((f) => f.path === 'version.txt');
  if (!file) throw new Error('the web build has no version.txt');
  return new TextDecoder().decode(file.bytes).replace(/\n$/, '');
}

async function filesUnder(root: string): Promise<BuildFile[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        const full = join(e.parentPath, e.name);
        return { path: relative(root, full).split(sep).join('/'), bytes: await readFile(full) };
      }),
  );
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..');
  assertNodeVersion(process.version, await readFile(join(root, '../../.nvmrc'), 'utf8'));
  const web = await filesUnder(join(root, '../web/dist-extension'));
  const version = versionOf(web);
  const worker = await readFile(join(root, 'src', SERVICE_WORKER));
  const dist = join(root, 'dist');
  await rm(dist, { recursive: true, force: true });
  for (const browser of BROWSERS) {
    const { files, hash } = packageFiles(browser, web, version, worker);
    for (const f of files) {
      const path = join(dist, browser, ...f.path.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, f.bytes);
    }
    await writeFile(join(dist, `blindvault-${browser}-${version}.zip`), zip(files));
    process.stdout.write(`${browser}: asset manifest sha256 ${hash}\n`);
  }
}

if (import.meta.main) await main();
