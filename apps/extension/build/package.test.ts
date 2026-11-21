import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { manifestOf } from '../../web/build/asset-manifest.ts';
import { manifestJson } from './manifest';
import { packageFiles, versionOf } from './package';

const text = (s: string) => new TextEncoder().encode(s);

const WEB = [
  { path: 'index.html', bytes: text('<!doctype html>\n') },
  { path: 'version.txt', bytes: text('1.0.0-rc.2\n') },
  { path: 'asset-manifest.txt', bytes: text('the web build’s\n') },
];

describe('packageFiles (D285)', () => {
  it('adds manifest.json and the service worker, and lists them in its own asset manifest', () => {
    const worker = text('// worker\n');
    const { files, hash } = packageFiles('chrome', WEB, '1.0.0-rc.2', worker);
    expect(files.map((f) => f.path)).toEqual([
      'index.html',
      'version.txt',
      'manifest.json',
      'background.js',
      'asset-manifest.txt',
    ]);
    const listed = new TextDecoder().decode(files.at(-1)?.bytes);
    const json = text(manifestJson('chrome', '1.0.0-rc.2'));
    expect(listed).toBe(
      manifestOf([
        WEB[0] as never,
        WEB[1] as never,
        { path: 'manifest.json', bytes: json },
        { path: 'background.js', bytes: worker },
      ]),
    );
    expect(listed).toContain(`${createHash('sha256').update(json).digest('hex')}  manifest.json\n`);
    expect(listed).not.toContain('asset-manifest.txt');
    expect(hash).toBe(createHash('sha256').update(listed).digest('hex'));
  });

  it('gives each browser its own manifest, and so its own hash', () => {
    const chrome = packageFiles('chrome', WEB, '1.0.0', text(''));
    const firefox = packageFiles('firefox', WEB, '1.0.0', text(''));
    expect(chrome.hash).not.toBe(firefox.hash);
  });

  it('refuses a web build that already holds one of its files', () => {
    const web = [...WEB, { path: 'manifest.json', bytes: text('{}') }];
    expect(() => packageFiles('firefox', web, '1.0.0', text(''))).toThrow(/duplicate path/);
  });
});

describe('versionOf', () => {
  it('reads version.txt of the web build', () => {
    expect(versionOf(WEB)).toBe('1.0.0-rc.2');
  });

  it('fails without it', () => {
    expect(() => versionOf([])).toThrow(/no version.txt/);
  });
});
