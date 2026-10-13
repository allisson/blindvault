import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MANIFEST,
  assertNodeVersion,
  manifestHash,
  manifestOf,
  writeManifest,
} from './asset-manifest';

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function file(path: string, text: string) {
  return { path, bytes: new TextEncoder().encode(text) };
}

describe('asset manifest (D189)', () => {
  it('lists each file as `shasum -a 256` does, in byte order of the paths', () => {
    const text = manifestOf([
      file('index.html', 'html'),
      file('assets/b.js', 'b'),
      file('assets/a.js', 'a'),
      file('Z.txt', 'z'),
      file('é.txt', 'e'),
    ]);
    expect(text).toBe(
      [
        `${sha('z')}  Z.txt`,
        `${sha('a')}  assets/a.js`,
        `${sha('b')}  assets/b.js`,
        `${sha('html')}  index.html`,
        `${sha('e')}  é.txt`,
        '',
      ].join('\n'),
    );
  });

  it('leaves out itself and sw.js at the root only (D63)', () => {
    const text = manifestOf([
      file(MANIFEST, 'old'),
      file('sw.js', 'worker'),
      file('assets/sw.js', 'not the service worker'),
    ]);
    expect(text).toBe(`${sha('not the service worker')}  assets/sw.js\n`);
  });

  it('refuses a path that shasum would escape, and a duplicate path', () => {
    expect(() => manifestOf([file('a\nb.js', '')])).toThrow(/a\\nb\.js|path/);
    expect(() => manifestOf([file('a\\b.js', '')])).toThrow(/path/);
    expect(() => manifestOf([file('a.js', '1'), file('a.js', '2')])).toThrow(/duplicate/);
  });

  it('hashes the manifest bytes', () => {
    const text = manifestOf([file('index.html', 'html')]);
    expect(manifestHash(text)).toBe(sha(text));
  });
});

describe('writing the manifest into the build output (D189)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('walks the output, writes asset-manifest.txt and returns its hash, the same on a rerun', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bv-manifest-'));
    dirs.push(dir);
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), 'html');
    await writeFile(join(dir, 'assets', 'a.js'), 'a');
    await writeFile(join(dir, 'sw.js'), 'worker');
    const hash = await writeManifest(dir);
    const text = await readFile(join(dir, MANIFEST), 'utf8');
    expect(text).toBe(`${sha('a')}  assets/a.js\n${sha('html')}  index.html\n`);
    expect(hash).toBe(sha(text));
    expect(await writeManifest(dir)).toBe(hash);
  });
});

describe('pinned Node for the build (D189)', () => {
  it('accepts only the .nvmrc version, with or without the v and surrounding space', () => {
    expect(() => {
      assertNodeVersion('v24.21.0', '24.21.0\n');
    }).not.toThrow();
    expect(() => {
      assertNodeVersion('v24.21.0', 'v24.21.0');
    }).not.toThrow();
    expect(() => {
      assertNodeVersion('v24.21.1', '24.21.0\n');
    }).toThrow(/24\.21\.0.*v24\.21\.1|v24\.21\.1.*24\.21\.0/);
    expect(() => {
      assertNodeVersion('v24.2.10', '24.21.0');
    }).toThrow();
  });
});
