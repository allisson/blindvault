import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { type ZipEntry, zip } from './zip';

const ENTRIES: ZipEntry[] = [
  { path: 'manifest.json', bytes: new TextEncoder().encode('{}\n') },
  { path: 'assets/a.js', bytes: new TextEncoder().encode('export {};\n') },
  { path: 'z.txt', bytes: new TextEncoder().encode('ç\n') },
  { path: 'empty', bytes: new Uint8Array() },
];

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function written(bytes: Uint8Array): string {
  dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  const file = join(dir, 'a.zip');
  writeFileSync(file, bytes);
  return file;
}

describe('zip (extension.md §2)', () => {
  it('gives the same bytes whatever the order of its input', () => {
    expect(zip(ENTRIES)).toEqual(zip([...ENTRIES].reverse()));
  });

  it('is read by unzip, files in byte order, stored, 1980-01-01, mode 0644', () => {
    const file = written(zip(ENTRIES));
    execFileSync('unzip', ['-tq', file]);
    const listing = execFileSync('zipinfo', [file], { encoding: 'utf8' }).split('\n');
    const rows = listing.filter((line) => line.startsWith('-'));
    expect(rows.map((r) => r.split(/\s+/).at(-1))).toEqual([
      'assets/a.js',
      'empty',
      'manifest.json',
      'z.txt',
    ]);
    for (const row of rows) {
      expect(row).toMatch(/^-rw-r--r-- {2}2\.0 unx +\d+ b- stor 80-Jan-01 00:00 /);
    }
    const out = join(file, '..', 'out');
    execFileSync('unzip', ['-q', file, '-d', out]);
    for (const e of ENTRIES) {
      expect(new Uint8Array(readFileSync(join(out, e.path)))).toEqual(e.bytes);
    }
  });

  it('writes a name in UTF-8, and says so', () => {
    const bytes = Buffer.from(zip([{ path: 'í', bytes: new Uint8Array() }]));
    expect(bytes.readUInt16LE(6) & 0x0800).toBe(0x0800);
    expect(bytes.readUInt16LE(26)).toBe(2);
    expect(bytes.subarray(30, 32).toString('utf8')).toBe('í');
  });

  it('writes an empty archive', () => {
    expect(zip([])).toEqual(
      new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]),
    );
  });

  it.each(['', '/abs', 'a//b', './a', 'a/../b', 'a\\b', 'dir/', 'a\0b'])(
    'refuses the path %j',
    (path) => {
      expect(() => zip([{ path, bytes: new Uint8Array() }])).toThrow(/not a relative file path/);
    },
  );

  it('refuses a duplicate path', () => {
    const e = { path: 'a', bytes: new Uint8Array() };
    expect(() => zip([e, e])).toThrow(/duplicate path a/);
  });
});
