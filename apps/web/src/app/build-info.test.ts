import { describe, expect, it, vi } from 'vitest';

import { MANIFEST_URL, readManifestHash } from './build-info';

const MANIFEST = `${'a'.repeat(64)}  assets/app.js\n${'b'.repeat(64)}  index.html\n`;

function serving(response: Response | Error) {
  return vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
  );
}

describe('the running build’s manifest hash (D192)', () => {
  it('is the SHA-256 of the served asset manifest', async () => {
    const fetch = serving(new Response(MANIFEST));
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(MANIFEST)),
    );
    const expected = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
    expect(await readManifestHash(fetch)).toBe(expected);
    expect(fetch).toHaveBeenCalledWith(MANIFEST_URL);
    expect(MANIFEST_URL).toBe('/asset-manifest.txt');
  });

  it.each([
    ['a 404', new Response('missing', { status: 404 })],
    ['the dev server’s fallback page', new Response('<!doctype html><html></html>')],
    ['an empty body', new Response('')],
    ['no final newline', new Response(MANIFEST.slice(0, -1))],
    ['a network failure', new TypeError('Failed to fetch')],
  ])('is unavailable for %s', async (_, response) => {
    expect(await readManifestHash(serving(response))).toBeUndefined();
  });
});
