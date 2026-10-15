import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_STUN_URLS,
  STUN_LIMITS,
  loadStunSettings,
  parseStunList,
  parseStunUrl as parse,
  readStunSettings,
  resetStunList,
  saveStunList,
  stunHosts,
} from './stun-settings';

/** `localStorage` as the browser offers it; Vitest runs in Node, which has none. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The URL kept, or why it is refused. */
function parseStunUrl(text: string): string {
  const parsed = parse(text);
  return parsed.ok ? parsed.url : parsed.problem;
}

describe('a STUN URL (D209)', () => {
  it('takes a DNS name, an IPv4 or a bracketed IPv6 address, with or without a port', () => {
    expect(parseStunUrl('stun:stun.example.org')).toBe('stun:stun.example.org');
    expect(parseStunUrl('stun:stun.example.org:3478')).toBe('stun:stun.example.org:3478');
    expect(parseStunUrl('  STUN:Stun.Example.ORG:3478 ')).toBe('stun:stun.example.org:3478');
    expect(parseStunUrl('stun:192.0.2.7:19302')).toBe('stun:192.0.2.7:19302');
    expect(parseStunUrl('stun:[2001:db8::1]')).toBe('stun:[2001:db8::1]');
    expect(parseStunUrl('stun:[2001:DB8::1]:3478')).toBe('stun:[2001:db8::1]:3478');
    expect(parseStunUrl('stun:localhost:1')).toBe('stun:localhost:1');
    expect(parseStunUrl('stun:a.b:65535')).toBe('stun:a.b:65535');
    expect(parseStunUrl('stun:host:03478')).toBe('stun:host:3478');
  });

  it('refuses TURN, STUNS and any other scheme: v1 uses no TURN (§9.2)', () => {
    expect(parseStunUrl('turn:turn.example.org:3478')).toBe('scheme');
    expect(parseStunUrl('turns:turn.example.org:5349')).toBe('scheme');
    expect(parseStunUrl('stuns:stun.example.org:5349')).toBe('scheme');
    expect(parseStunUrl('https://stun.example.org')).toBe('scheme');
    expect(parseStunUrl('stun.example.org:3478')).toBe('scheme');
    expect(parseStunUrl('')).toBe('scheme');
  });

  it('refuses a query, a port outside 1 to 65535 and an invalid host', () => {
    expect(parseStunUrl('stun:stun.example.org:3478?transport=tcp')).toBe('query');
    expect(parseStunUrl('stun:stun.example.org?x')).toBe('query');
    expect(parseStunUrl('stun:stun.example.org:0')).toBe('port');
    expect(parseStunUrl('stun:stun.example.org:65536')).toBe('port');
    expect(parseStunUrl('stun:stun.example.org:')).toBe('port');
    expect(parseStunUrl('stun:stun.example.org:34a')).toBe('port');
    expect(parseStunUrl('stun:stun.example.org:123456')).toBe('port');
    expect(parseStunUrl('stun:')).toBe('host');
    expect(parseStunUrl('stun::3478')).toBe('host');
    expect(parseStunUrl('stun:user@stun.example.org')).toBe('host');
    expect(parseStunUrl('stun:stun.example.org/path')).toBe('host');
    expect(parseStunUrl('stun:stun example.org')).toBe('host');
    expect(parseStunUrl('stun:-bad.example.org')).toBe('host');
    expect(parseStunUrl('stun:bad-.example.org')).toBe('host');
    expect(parseStunUrl('stun:a..b')).toBe('host');
    expect(parseStunUrl('stun:256.1.1.1')).toBe('host');
    expect(parseStunUrl('stun:2001:db8::1')).toBe('host');
    expect(parseStunUrl('stun:[stun.example.org]')).toBe('host');
    expect(parseStunUrl('stun:[2001:db8::1')).toBe('host');
    expect(parseStunUrl('stun:[2001:db8::1]x')).toBe('host');
    expect(parseStunUrl('stun:[]')).toBe('host');
    expect(parseStunUrl(`stun:${'a'.repeat(64)}.org`)).toBe('host');
  });

  it('refuses a URL longer than 255 characters', () => {
    const host = Array.from({ length: 4 }, () => 'a'.repeat(60)).join('.');
    expect(parseStunUrl(`stun:${host}`)).toBe(`stun:${host}`);
    expect(`stun:${host}.abcdef`).toHaveLength(STUN_LIMITS.length);
    expect(parseStunUrl(`stun:${host}.abcdef`)).toBe(`stun:${host}.abcdef`);
    expect(parseStunUrl(`stun:${host}.abcdefg`)).toBe('too-long');
  });
});

describe('a STUN list (D209)', () => {
  it('takes one URL per line, skips blank lines and drops duplicates', () => {
    expect(
      parseStunList('stun:a.example.org\n\n  stun:b.example.org:3478 \r\nSTUN:A.example.org\n'),
    ).toEqual({ kind: 'ok', urls: ['stun:a.example.org', 'stun:b.example.org:3478'] });
  });

  it('names the first line refused and why', () => {
    expect(parseStunList('stun:a.example.org\nturn:b.example.org\nstun:c?')).toEqual({
      kind: 'invalid',
      problem: 'scheme',
      url: 'turn:b.example.org',
    });
  });

  it('refuses an empty list: the same network only is the way to use none', () => {
    expect(parseStunList('')).toEqual({ kind: 'invalid', problem: 'empty' });
    expect(parseStunList(' \n \n')).toEqual({ kind: 'invalid', problem: 'empty' });
  });

  it('refuses more than 8 URLs, counted after duplicates are dropped', () => {
    const urls = (n: number) =>
      Array.from({ length: n }, (_, i) => `stun:s${String(i)}.example.org`);
    expect(parseStunList([...urls(8), ...urls(8)].join('\n'))).toEqual({
      kind: 'ok',
      urls: urls(8),
    });
    expect(parseStunList(urls(9).join('\n'))).toEqual({ kind: 'invalid', problem: 'too-many' });
  });

  it('names the hosts, for the same-network hint', () => {
    expect(stunHosts(DEFAULT_STUN_URLS)).toEqual(['stun.l.google.com', 'stun.cloudflare.com']);
    expect(stunHosts(['stun:[2001:db8::1]:3478', 'stun:192.0.2.7'])).toEqual([
      '[2001:db8::1]',
      '192.0.2.7',
    ]);
  });
});

describe('the stored STUN list (D209)', () => {
  it('is the defaults when nothing is stored', () => {
    expect(readStunSettings(null)).toEqual({ kind: 'default' });
    expect(DEFAULT_STUN_URLS).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ]);
  });

  it('reads back a saved list, and the defaults once reset', () => {
    expect(loadStunSettings()).toEqual({ kind: 'default' });
    expect(saveStunList(['stun:a.example.org', 'stun:b.example.org:3478'])).toBe(true);
    expect(localStorage.getItem('blindvault.stun')).toBe(
      '["stun:a.example.org","stun:b.example.org:3478"]',
    );
    expect(loadStunSettings()).toEqual({
      kind: 'custom',
      urls: ['stun:a.example.org', 'stun:b.example.org:3478'],
    });
    resetStunList();
    expect(localStorage.getItem('blindvault.stun')).toBeNull();
    expect(loadStunSettings()).toEqual({ kind: 'default' });
  });

  it('is unreadable, never the defaults, when what is stored is not a valid list', () => {
    for (const raw of [
      '{',
      'null',
      '"stun:a.example.org"',
      '{}',
      '[]',
      '[1]',
      '["turn:a.example.org"]',
      '["stun:a.example.org","stun:a.example.org"]',
      '["stun:A.example.org"]',
      JSON.stringify(Array.from({ length: 9 }, (_, i) => `stun:s${String(i)}.example.org`)),
    ]) {
      expect(readStunSettings(raw), raw).toEqual({ kind: 'unreadable' });
    }
    localStorage.setItem('blindvault.stun', '["stuns:a.example.org"]');
    expect(loadStunSettings()).toEqual({ kind: 'unreadable' });
  });

  it('is the defaults where the browser refuses localStorage, which then holds nothing', () => {
    const refused = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('localStorage', {
      getItem: refused,
      setItem: refused,
      removeItem: refused,
    });
    expect(loadStunSettings()).toEqual({ kind: 'default' });
    expect(saveStunList(['stun:a.example.org'])).toBe(false);
    expect(() => {
      resetStunList();
    }).not.toThrow();
  });

  it('never saves an invalid list', () => {
    expect(saveStunList([])).toBe(false);
    expect(saveStunList(['turn:a.example.org'])).toBe(false);
    expect(localStorage.getItem('blindvault.stun')).toBeNull();
  });
});
