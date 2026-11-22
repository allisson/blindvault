// apps/web's Android build into the APK (android.md §2): `dist-android` copied to
// `app/src/main/assets/web/` with the APK's own `asset-manifest.txt` (D189), listing every file,
// `headers.json` included, and `app/version.properties`, the `versionName` and `versionCode` Gradle
// reads. `node build/assets.ts` runs it after `vite build --mode android`, so it imports nothing but
// Node's own modules and the asset manifest of the web build; it prints the manifest's hash.

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

/** `apps/web/build/android.ts` `ANDROID_HEADERS_FILE`: the headers the shell adds (§3). */
const HEADERS = 'headers.json';

/** Android's largest `versionCode`. */
const MAX_VERSION_CODE = 2_100_000_000;

/** The files of `assets/web/`, the APK's asset manifest last. */
export function apkAssets(web: readonly BuildFile[]): {
  readonly files: readonly BuildFile[];
  readonly hash: string;
} {
  if (!web.some((f) => f.path === HEADERS)) throw new Error(`the Android build has no ${HEADERS}`);
  // The web build's manifest lists the web build alone; the APK gets its own.
  const files = web.filter((f) => f.path !== MANIFEST);
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

const NUMBER = '(0|[1-9]\\d*)';
const VERSION = new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-rc\\.([1-9]\\d*))?$`);

/**
 * `major × 1,000,000 + minor × 10,000 + patch × 100 + n`, `n` the release candidate's number or 99
 * for a release, so every release and candidate installs over the one before.
 */
export function versionCode(version: string): number {
  const match = VERSION.exec(version);
  if (!match) throw new RangeError(`version ${JSON.stringify(version)} is not x.y.z or x.y.z-rc.n`);
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const candidate = match[4] === undefined ? undefined : Number(match[4]);
  const n = candidate ?? 99;
  if (minor > 99 || patch > 99 || (candidate !== undefined && candidate > 98)) {
    throw new RangeError(`version ${version} does not fit in a versionCode`);
  }
  const code = major * 1_000_000 + minor * 10_000 + patch * 100 + n;
  if (code > MAX_VERSION_CODE)
    throw new RangeError(`version ${version} exceeds Android's versionCode`);
  return code;
}

export function versionProperties(version: string): string {
  return `versionName=${version}\nversionCode=${String(versionCode(version))}\n`;
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
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  assertNodeVersion(process.version, await readFile(join(root, '../../.nvmrc'), 'utf8'));
  const web = await filesUnder(join(root, '../web/dist-android'));
  const { files, hash } = apkAssets(web);
  const out = join(root, 'app/src/main/assets/web');
  await rm(out, { recursive: true, force: true });
  for (const f of files) {
    const path = join(out, ...f.path.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, f.bytes);
  }
  await writeFile(join(root, 'app/version.properties'), versionProperties(versionOf(web)));
  process.stdout.write(`asset manifest sha256 ${hash}\n`);
}

if (import.meta.main) await main();
