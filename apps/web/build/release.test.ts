import { describe, expect, it } from 'vitest';

import { type WorkerChange, checkNotes, checkTag, prerelease, releaseBody } from './release';

describe('release tag (D194)', () => {
  it('is v and the version of the build', () => {
    expect(() => {
      checkTag('v0.1.0', '0.1.0');
    }).not.toThrow();
    expect(() => {
      checkTag('v1.2.3-rc.1', '1.2.3-rc.1');
    }).not.toThrow();
  });

  it.each([
    ['another version', 'v0.1.1', '0.1.0'],
    ['no v', '0.1.0', '0.1.0'],
    ['a capital V', 'V0.1.0', '0.1.0'],
    ['a trailing suffix', 'v0.1.0x', '0.1.0'],
  ])('refuses %s', (_, tag, version) => {
    expect(() => {
      checkTag(tag, version);
    }).toThrow('does not match');
  });

  it.each([
    ['two parts', '0.1'],
    ['a leading zero', '0.01.0'],
    ['build metadata', '0.1.0+b7'],
    ['an empty pre-release', '0.1.0-'],
    ['a second line', '0.1.0\n0.1.1'],
  ])('refuses a version with %s', (_, version) => {
    expect(() => {
      checkTag(`v${version}`, version);
    }).toThrow('not a release version');
  });

  it('marks every 0.x version and every pre-release version as a pre-release', () => {
    expect(prerelease('0.1.0')).toBe(true);
    expect(prerelease('1.0.0-rc.1')).toBe(true);
    expect(prerelease('1.0.0')).toBe(false);
    expect(prerelease('10.2.0')).toBe(false);
  });
});

const SECTION = '## Service worker\n\nThe update check now retries once.\n';

describe('release notes (D191, D194)', () => {
  it('accepts notes, and a changed sw.js justified in its own section', () => {
    expect(() => {
      checkNotes('First release.\n', 'first');
    }).not.toThrow();
    expect(() => {
      checkNotes('Fixes.\n', 'unchanged');
    }).not.toThrow();
    expect(() => {
      checkNotes(`Fixes.\n\n${SECTION}\n## Other\n\nMore.\n`, 'changed');
    }).not.toThrow();
  });

  it('refuses empty notes', () => {
    expect(() => {
      checkNotes(' \n\n', 'unchanged');
    }).toThrow('empty');
  });

  it.each([
    ['no section', 'Fixes.\n'],
    ['an empty section', 'Fixes.\n\n## Service worker\n\n## Other\n\nMore.\n'],
    ['an empty section at the end', 'Fixes.\n\n## Service worker\n   \n'],
    ['the words in a sentence only', 'The service worker changed.\n'],
    ['a deeper heading', 'Fixes.\n\n### Service worker\n\nWhy.\n'],
  ])('refuses a changed sw.js with %s', (_, notes) => {
    expect(() => {
      checkNotes(notes, 'changed');
    }).toThrow('Service worker');
  });

  it('refuses notes holding the section the release adds', () => {
    expect(() => {
      checkNotes('Fixes.\n\n## Verify\n\nTrust me.\n', 'unchanged');
    }).toThrow('Verify');
  });
});

describe('release body (D194)', () => {
  const base = {
    tag: 'v0.2.0',
    version: '0.2.0',
    manifestHash: 'a'.repeat(64),
    workerHash: 'b'.repeat(64),
    previous: 'v0.1.0',
    notes: 'Fixes.\n',
  };

  it('ends the notes with the version, both hashes and how to verify', () => {
    const body = releaseBody({ ...base, worker: 'unchanged' });
    expect(body.startsWith('Fixes.\n\n## Verify\n')).toBe(true);
    expect(body).toContain('- Version: `0.2.0`');
    expect(body).toContain(`- Asset manifest SHA-256: \`${'a'.repeat(64)}\``);
    expect(body).toContain(`- \`sw.js\` SHA-256: \`${'b'.repeat(64)}\``);
    expect(body).toContain('gh attestation verify asset-manifest.txt -R allisson/blindvault');
    expect(body).toContain('shasum -a 256 -c asset-manifest.txt');
    expect(body).toContain('https://github.com/allisson/blindvault/blob/v0.2.0/docs/build.md');
  });

  it.each<[WorkerChange, string | undefined, string]>([
    ['first', undefined, '- `sw.js`: first release'],
    ['unchanged', 'v0.1.0', '- `sw.js`: unchanged since v0.1.0'],
    ['changed', 'v0.1.0', '- `sw.js`: **changed** since v0.1.0, see "Service worker" above'],
  ])('says whether sw.js changed (%s)', (worker, previous, line) => {
    expect(releaseBody({ ...base, worker, previous })).toContain(line);
  });

  it('refuses a hash that is not 64 lowercase hex digits', () => {
    expect(() =>
      releaseBody({ ...base, worker: 'unchanged', manifestHash: 'A'.repeat(64) }),
    ).toThrow('SHA-256');
    expect(() => releaseBody({ ...base, worker: 'unchanged', workerHash: 'b'.repeat(63) })).toThrow(
      'SHA-256',
    );
  });

  it('refuses a change since a previous tag without the previous tag', () => {
    expect(() => releaseBody({ ...base, worker: 'changed', previous: undefined })).toThrow(
      'previous',
    );
  });
});
