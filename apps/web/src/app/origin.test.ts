import { describe, expect, it } from 'vitest';

import { sharedOrigin } from './origin';

describe('shared origin warning (D90)', () => {
  it('warns under a sub-path of a github.io host', () => {
    expect(sharedOrigin({ hostname: 'allisson.github.io', pathname: '/blindvault/' })).toBe(true);
    expect(sharedOrigin({ hostname: 'allisson.github.io', pathname: '/blindvault' })).toBe(true);
    expect(sharedOrigin({ hostname: 'ALLISSON.GitHub.IO', pathname: '/a/index.html' })).toBe(true);
    expect(sharedOrigin({ hostname: 'allisson.github.io.', pathname: '/blindvault/' })).toBe(true);
  });

  it('does not warn at the root of a host, or on a host that is not github.io', () => {
    expect(sharedOrigin({ hostname: 'allisson.github.io', pathname: '/' })).toBe(false);
    expect(sharedOrigin({ hostname: 'allisson.github.io', pathname: '/index.html' })).toBe(false);
    expect(sharedOrigin({ hostname: 'blindvault.allisson.dev', pathname: '/blindvault/' })).toBe(
      false,
    );
    expect(sharedOrigin({ hostname: 'evilgithub.io', pathname: '/blindvault/' })).toBe(false);
    expect(sharedOrigin({ hostname: 'github.io.example.com', pathname: '/x/' })).toBe(false);
    expect(sharedOrigin({ hostname: 'localhost', pathname: '/x/' })).toBe(false);
  });
});
