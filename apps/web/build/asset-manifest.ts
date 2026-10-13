// The asset manifest of the build (overview §11, D189, docs/build.md): `asset-manifest.txt` at the
// output root, one `shasum -a 256` line per file in byte order of the paths, leaving out itself and
// `sw.js`; its hash is the SHA-256 of its bytes. The build runs only under the Node of `.nvmrc`.

import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { type Plugin } from 'vite';

export const MANIFEST = 'asset-manifest.txt';

/** Updated by the browser on its own, outside the asset bundle (D63). */
const SERVICE_WORKER = 'sw.js';

export interface BuildFile {
  /** Relative to the output root, with `/` separators. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function manifestOf(files: readonly BuildFile[]): string {
  const listed = files.filter((f) => f.path !== MANIFEST && f.path !== SERVICE_WORKER);
  for (const { path } of listed) {
    // shasum escapes these, so the line would no longer be the path.
    if (path.includes('\n') || path.includes('\\')) {
      throw new Error(`asset manifest: path ${JSON.stringify(path)} cannot be listed`);
    }
  }
  const sorted = listed
    .map((f) => ({ ...f, key: Buffer.from(f.path, 'utf8') }))
    .sort((a, b) => Buffer.compare(a.key, b.key));
  sorted.forEach((f, i) => {
    if (i > 0 && sorted[i - 1]?.path === f.path) {
      throw new Error(`asset manifest: duplicate path ${f.path}`);
    }
  });
  return sorted.map((f) => `${sha256(f.bytes)}  ${f.path}\n`).join('');
}

export function manifestHash(manifest: string): string {
  return sha256(manifest);
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

/** Writes `asset-manifest.txt` into `outDir` and returns the manifest hash. */
export async function writeManifest(outDir: string): Promise<string> {
  const manifest = manifestOf(await filesUnder(outDir));
  await writeFile(join(outDir, MANIFEST), manifest);
  return manifestHash(manifest);
}

/** Refuses a build under another Node version than `.nvmrc`'s (D189). */
export function assertNodeVersion(running: string, nvmrc: string): void {
  const pinned = nvmrc.trim().replace(/^v/, '');
  if (running !== `v${pinned}`) {
    throw new Error(
      `The build needs Node ${pinned} (.nvmrc), since it publishes a hash; this is Node ${running}.`,
    );
  }
}

export function assetManifest(nvmrcPath: URL): Plugin {
  let outDir = '';
  return {
    name: 'blindvault-asset-manifest',
    apply: 'build',
    async buildStart() {
      assertNodeVersion(process.version, await readFile(nvmrcPath, 'utf8'));
    },
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    async closeBundle() {
      const hash = await writeManifest(outDir);
      this.info(`asset manifest sha256 ${hash}`);
    },
  };
}
