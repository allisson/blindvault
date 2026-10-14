// The GitHub Release of a tag (D194): checks the tag against the build and the notes against a
// changed sw.js (D191), and writes the release body. `.github/workflows/release.yml` runs it with
// Node, so it imports nothing but Node's own modules.

import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** How sw.js compares with the previous release's. */
export type WorkerChange = 'first' | 'changed' | 'unchanged';

/** SemVer with an optional pre-release and no build metadata, which a tag cannot order. */
const RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const SHA256 = /^[0-9a-f]{64}$/;

const REPOSITORY = 'allisson/blindvault';

export function checkTag(tag: string, version: string): void {
  if (!RELEASE_VERSION.test(version)) {
    throw new Error(`${JSON.stringify(version)} is not a release version`);
  }
  if (tag !== `v${version}`) {
    throw new Error(`tag ${JSON.stringify(tag)} does not match version ${version}`);
  }
}

/** Every version before 1.0, and every pre-release version: formats may still change (D177). */
export function prerelease(version: string): boolean {
  return version.startsWith('0.') || version.includes('-');
}

/** The body of the level-2 section `heading`, or undefined when there is none. */
function section(notes: string, heading: string): string | undefined {
  const lines = notes.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

export function checkNotes(notes: string, worker: WorkerChange): void {
  if (notes.trim() === '') throw new Error('the release notes are empty');
  if (section(notes, 'Verify') !== undefined) {
    throw new Error('the release notes hold a "## Verify" section, which the release adds');
  }
  if (worker === 'changed' && !section(notes, 'Service worker')?.trim()) {
    throw new Error(
      'sw.js changed: the release notes need a "## Service worker" section saying why',
    );
  }
}

export interface Release {
  readonly tag: string;
  readonly version: string;
  readonly manifestHash: string;
  readonly workerHash: string;
  readonly worker: WorkerChange;
  readonly previous: string | undefined;
  readonly notes: string;
}

function workerLine(worker: WorkerChange, previous: string | undefined): string {
  if (worker === 'first') return '- `sw.js`: first release';
  if (!previous) throw new Error('a change of sw.js is since a previous tag, and none was given');
  return worker === 'changed'
    ? `- \`sw.js\`: **changed** since ${previous}, see "Service worker" above`
    : `- \`sw.js\`: unchanged since ${previous}`;
}

export function releaseBody(r: Release): string {
  for (const hash of [r.manifestHash, r.workerHash]) {
    if (!SHA256.test(hash)) throw new Error(`${JSON.stringify(hash)} is not a SHA-256 in hex`);
  }
  return [
    r.notes.trim(),
    '',
    '## Verify',
    '',
    `- Version: \`${r.version}\``,
    `- Asset manifest SHA-256: \`${r.manifestHash}\``,
    `- \`sw.js\` SHA-256: \`${r.workerHash}\``,
    workerLine(r.worker, r.previous),
    '',
    'The About screen shows the version and the asset manifest hash of the running build. A modified app can show any value, so verify outside the app. With the files attached to this release:',
    '',
    '```sh',
    `gh attestation verify asset-manifest.txt -R ${REPOSITORY}`,
    `gh attestation verify sw.js -R ${REPOSITORY}`,
    'shasum -a 256 asset-manifest.txt sw.js',
    '```',
    '',
    `Then rebuild this tag as in [docs/build.md](https://github.com/${REPOSITORY}/blob/${r.tag}/docs/build.md) and compare, or download the served files and check them with \`shasum -a 256 -c asset-manifest.txt\`.`,
    '',
  ].join('\n');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function parseWorker(value: string | undefined): WorkerChange {
  if (value === 'first' || value === 'changed' || value === 'unchanged') return value;
  throw new Error(`sw.js change ${JSON.stringify(value)} is not first, changed or unchanged`);
}

/**
 * `node build/release.ts <tag> <dist> <notes dir> <first|changed|unchanged> [previous tag]` writes
 * the release body to stdout and, under GitHub Actions, `version`, `hash` and `prerelease` to the
 * step outputs.
 */
function main(args: readonly string[]): void {
  const [tag = '', dist = '', notesDir = '', change, previous] = args;
  const version = readFileSync(join(dist, 'version.txt'), 'utf8').replace(/\n$/, '');
  checkTag(tag, version);
  const worker = parseWorker(change);
  const notes = readFileSync(join(notesDir, `${tag}.md`), 'utf8');
  checkNotes(notes, worker);
  const manifestHash = sha256(join(dist, 'asset-manifest.txt'));
  const body = releaseBody({
    tag,
    version,
    manifestHash,
    workerHash: sha256(join(dist, 'sw.js')),
    worker,
    previous: previous === '' ? undefined : previous,
    notes,
  });
  process.stdout.write(body);
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(
      output,
      `version=${version}\nhash=${manifestHash}\nprerelease=${String(prerelease(version))}\n`,
    );
  }
}

if (import.meta.main) main(process.argv.slice(2));
