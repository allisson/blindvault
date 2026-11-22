import { describe, expect, it } from 'vitest';

import { MANIFEST, manifestHash, manifestOf } from '../../web/build/asset-manifest.ts';
import { apkAssets, versionCode, versionOf, versionProperties } from './assets.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

const web = [
  { path: 'index.html', bytes: bytes('<!doctype html>') },
  { path: 'assets/index-abc.js', bytes: bytes('run()') },
  { path: 'headers.json', bytes: bytes('{}\n') },
  { path: 'version.txt', bytes: bytes('1.0.0-rc.2\n') },
  { path: MANIFEST, bytes: bytes('the web build’s own manifest\n') },
];

describe('the APK’s assets (android.md §2)', () => {
  it('carries the web build with its own asset manifest, headers.json listed', () => {
    const { files, hash } = apkAssets(web);
    const listed = web.filter((f) => f.path !== MANIFEST);
    expect(files.slice(0, -1)).toEqual(listed);
    const manifest = files.at(-1);
    expect(manifest?.path).toBe(MANIFEST);
    expect(text(manifest?.bytes ?? new Uint8Array())).toBe(manifestOf(listed));
    expect(text(manifest?.bytes ?? new Uint8Array())).toContain('  headers.json\n');
    expect(hash).toBe(manifestHash(manifestOf(listed)));
  });

  it('refuses a build without headers.json, whose headers the shell sends', () => {
    expect(() => apkAssets(web.filter((f) => f.path !== 'headers.json'))).toThrow(/headers\.json/);
  });

  it('reads the version from version.txt', () => {
    expect(versionOf(web)).toBe('1.0.0-rc.2');
    expect(() => versionOf(web.filter((f) => f.path !== 'version.txt'))).toThrow(/version\.txt/);
  });
});

describe('versionCode (android.md §2)', () => {
  it('is major × 1,000,000 + minor × 10,000 + patch × 100 + n', () => {
    expect(versionCode('1.0.0-rc.2')).toBe(1_000_002);
    expect(versionCode('1.0.0')).toBe(1_000_099);
    expect(versionCode('1.2.3-rc.1')).toBe(1_020_301);
    expect(versionCode('2.99.99')).toBe(2_999_999);
    expect(versionCode('0.0.1-rc.98')).toBe(198);
  });

  it('installs each candidate and the release over the one before', () => {
    const order = [
      '1.0.0-rc.1',
      '1.0.0-rc.2',
      '1.0.0',
      '1.0.1-rc.1',
      '1.0.1',
      '1.1.0',
      '2.0.0-rc.1',
    ];
    const codes = order.map(versionCode);
    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('refuses a version it cannot order', () => {
    for (const v of [
      '',
      '1.0',
      '1.0.0.0',
      'v1.0.0',
      '01.0.0',
      '1.00.0',
      '1.100.0',
      '1.0.100',
      '1.0.0-rc.0',
      '1.0.0-rc.99',
      '1.0.0-rc.01',
      '1.0.0-beta.1',
      '1.0.0-rc',
      '1.0.0+build',
      '2100.0.0',
      ' 1.0.0',
    ]) {
      expect(() => versionCode(v), v).toThrow(RangeError);
    }
    // Android's largest versionCode is 2,100,000,000.
    expect(versionCode('2099.99.99')).toBe(2_099_999_999);
  });

  it('writes version.properties for Gradle', () => {
    expect(versionProperties('1.0.0-rc.2')).toBe('versionName=1.0.0-rc.2\nversionCode=1000002\n');
  });
});
