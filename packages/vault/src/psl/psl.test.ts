import { describe, expect, it } from 'vitest';

import { asciiHost, isPublicSuffix, registrableDomain } from './psl';
import vectors from './test_psl.txt?raw';

// `checkPublicSuffix('input', 'expected');`, with `null` for either; commented-out lines skipped.
const CASES = [...vectors.matchAll(/^checkPublicSuffix\((null|'[^']*'), (null|'[^']*')\);$/gm)]
  .map(([, input, expected]) => ({
    input: input === 'null' ? null : String(input).slice(1, -1),
    expected: expected === 'null' ? null : String(expected).slice(1, -1),
  }))
  .filter((c): c is { input: string; expected: string | null } => c.input !== null);

describe('the list’s own vectors (test_psl.txt)', () => {
  it('reads them all', () => {
    expect(CASES.length).toBeGreaterThan(70);
  });

  it.each(CASES)('$input → $expected', ({ input, expected }) => {
    // Results are ASCII; a Unicode expectation is compared in its ASCII form.
    expect(registrableDomain(input)).toBe(expected === null ? null : asciiHost(expected));
  });
});

describe('registrableDomain', () => {
  it('keeps a private-section suffix as public', () => {
    expect(registrableDomain('alice.github.io')).toBe('alice.github.io');
    expect(registrableDomain('github.io')).toBeNull();
  });

  it('has none for an IP address', () => {
    expect(registrableDomain('192.168.0.1')).toBeNull();
    expect(registrableDomain('[::1]')).toBeNull();
  });

  it('has none for a host that does not parse or has an empty label', () => {
    expect(registrableDomain('')).toBeNull();
    expect(registrableDomain('a..example.com')).toBeNull();
    expect(registrableDomain('example.com/path')).toBeNull();
    expect(registrableDomain('user@example.com')).toBeNull();
    expect(registrableDomain('example.com:443')).toBeNull();
    expect(registrableDomain('exa mple.com')).toBeNull();
    expect(registrableDomain('exa%mple.com')).toBeNull();
  });
});

describe('isPublicSuffix', () => {
  it('holds for rules and single labels, not for registrable domains', () => {
    expect(isPublicSuffix('com')).toBe(true);
    expect(isPublicSuffix('co.uk')).toBe(true);
    expect(isPublicSuffix('github.io')).toBe(true);
    expect(isPublicSuffix('localhost')).toBe(true);
    expect(isPublicSuffix('test.ck')).toBe(true);
    expect(isPublicSuffix('www.ck')).toBe(false);
    expect(isPublicSuffix('example.com')).toBe(false);
    expect(isPublicSuffix('192.168.0.1')).toBe(false);
  });
});
