// The service worker as shipped (`public/sw.js`, D190), run in a VM against fake caches and network.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://app.test';

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function manifestOf(files: Record<string, string>): string {
  return Object.entries(files)
    .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(([path, body]) => `${sha(body)}  ${path}\n`)
    .join('');
}

class FakeCache {
  readonly entries = new Map<string, { body: ArrayBuffer; type: string | null }>();

  put(key: string, response: Response): Promise<void> {
    return response.arrayBuffer().then((body) => {
      this.entries.set(key, { body, type: response.headers.get('content-type') });
    });
  }

  match(key: string): Promise<Response | undefined> {
    const hit = this.entries.get(key);
    if (!hit) return Promise.resolve(undefined);
    const headers: Record<string, string> = hit.type ? { 'content-type': hit.type } : {};
    return Promise.resolve(new Response(hit.body.slice(0), { headers }));
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();

  open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.stores.set(name, cache);
    }
    return Promise.resolve(cache);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.stores.keys()]);
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name));
  }
}

type Handler = (event: unknown) => void;

/** One deployment the fake network serves: path → body (404 when absent). */
type Site = Record<string, string>;

function worker(caches: FakeCaches, site: { current: Site }) {
  const handlers = new Map<string, Handler>();
  const fetched: { url: string; cache: RequestCache | undefined }[] = [];
  const fetch = (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${ORIGIN}/`);
    fetched.push({ url: url.href, cache: init?.cache });
    // A static host serves index.html at the root.
    const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const body = url.origin === ORIGIN ? site.current[path] : undefined;
    return Promise.resolve(
      body === undefined
        ? new Response('missing', { status: 404 })
        : new Response(body, { headers: { 'content-type': 'text/plain' } }),
    );
  };
  const self = {
    location: { origin: ORIGIN },
    registration: { scope: `${ORIGIN}/` },
    addEventListener: (type: string, handler: Handler) => {
      handlers.set(type, handler);
    },
  };
  vm.runInNewContext(SOURCE, {
    self,
    caches,
    fetch,
    crypto: globalThis.crypto,
    Response,
    URL,
    TextEncoder,
    TextDecoder,
  });

  function lifecycle(type: 'install' | 'activate'): Promise<unknown> {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get(type)?.({
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
    });
    return pending;
  }

  /** The response the worker gives, or `undefined` when it leaves the request to the browser. */
  async function request(path: string, init: { method?: string; mode?: RequestMode } = {}) {
    let answer: Promise<Response> | undefined;
    const request = {
      url: new URL(path, `${ORIGIN}/`).href,
      method: init.method ?? 'GET',
      mode: init.mode ?? 'no-cors',
    };
    handlers.get('fetch')?.({
      request,
      respondWith: (p: Promise<Response>) => {
        answer = p;
      },
    });
    return answer ? (await answer).text() : undefined;
  }

  return {
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    request,
    fetched,
  };
}

const V1: Site = { 'index.html': '<html>v1</html>', 'assets/app-1.js': 'app 1' };
const V2: Site = { 'index.html': '<html>v2</html>', 'assets/app-2.js': 'app 2' };

function deploy(files: Site, manifest = manifestOf(files)): Site {
  return { ...files, 'asset-manifest.txt': manifest, 'sw.js': 'worker' };
}

describe('service worker install (D190)', () => {
  it('caches every listed file and the manifest under the manifest hash, bypassing the HTTP cache', async () => {
    const caches = new FakeCaches();
    caches.stores.set('blindvault-old', new FakeCache());
    caches.stores.set('another-app', new FakeCache());
    const site = { current: deploy(V1) };
    const sw = worker(caches, site);
    await sw.install();
    const name = `blindvault-${sha(manifestOf(V1))}`;
    const cache = caches.stores.get(name);
    expect([...(cache?.entries.keys() ?? [])].sort()).toEqual(
      [`${ORIGIN}/asset-manifest.txt`, `${ORIGIN}/assets/app-1.js`, `${ORIGIN}/index.html`].sort(),
    );
    expect(sw.fetched.every((f) => f.cache === 'no-store')).toBe(true);
    expect(sw.fetched.map((f) => f.url)).not.toContain(`${ORIGIN}/sw.js`);

    await sw.activate();
    expect(
      [...caches.stores.keys()].filter(
        (k) => k.startsWith('blindvault-') && k !== 'blindvault-state',
      ),
    ).toEqual([name]);
    expect(caches.stores.has('another-app')).toBe(true);
  });

  it.each([
    ['a tampered file', { ...deploy(V1), 'assets/app-1.js': 'tampered' }],
    [
      'a missing file',
      (() => {
        const site = deploy(V1);
        delete site['assets/app-1.js'];
        return site;
      })(),
    ],
    [
      'no manifest',
      (() => {
        const site = deploy(V1);
        delete site['asset-manifest.txt'];
        return site;
      })(),
    ],
  ])('fails on %s, leaving no versioned cache and nothing active', async (_, broken) => {
    const caches = new FakeCaches();
    const sw = worker(caches, { current: broken });
    await expect(sw.install()).rejects.toThrow();
    expect([...caches.stores.keys()].filter((k) => k !== 'blindvault-state')).toEqual([]);
    await sw.activate();
    sw.fetched.length = 0;
    expect(await sw.request('/', { mode: 'navigate' })).toBe('<html>v1</html>');
    expect(sw.fetched.map((f) => f.url)).toEqual([`${ORIGIN}/`]);
  });

  const index = `${sha(V1['index.html'] ?? '')}  index.html\n`;
  it.each([
    ['an empty manifest', ''],
    ['no final newline', index.slice(0, -1)],
    ['uppercase hex', index.toUpperCase().replace('INDEX.HTML', 'index.html')],
    ['one space', index.replace('  ', ' ')],
    ['a short hash', index.slice(2)],
    ['an absolute path', `${sha('x')}  /index.html\n`],
    ['a dot segment', `${index}${sha('x')}  assets/../x\n`],
    ['an empty segment', `${sha('x')}  assets//x\n${index}`],
    ['a query', `${sha('x')}  assets/x?y\n${index}`],
    ['a percent sign', `${sha('x')}  assets/x%41\n${index}`],
    ['a backslash', `${sha('x')}  assets\\x\n${index}`],
    ['sw.js listed', `${index}${sha('worker')}  sw.js\n`],
    ['itself listed', `${index}${sha('x')}  asset-manifest.txt\n`],
    ['a duplicate path', `${index}${index}`],
    ['paths out of byte order', `${index}${sha('app 1')}  assets/app-1.js\n`],
    ['no index.html', `${sha('app 1')}  assets/app-1.js\n`],
  ])('refuses a manifest with %s', async (_, manifest) => {
    const caches = new FakeCaches();
    const sw = worker(caches, { current: deploy(V1, manifest) });
    await expect(sw.install()).rejects.toThrow();
    expect([...caches.stores.keys()].filter((k) => k !== 'blindvault-state')).toEqual([]);
  });
});

describe('service worker fetch (D190)', () => {
  async function active() {
    const caches = new FakeCaches();
    const site = { current: deploy(V1) };
    const sw = worker(caches, site);
    await sw.install();
    await sw.activate();
    // The host now serves something else: only the cache can answer v1.
    site.current = { ...deploy(V2), 'not-listed.txt': 'network' };
    return { caches, site, sw };
  }

  it('serves a navigation and a listed file from the cache, without the network', async () => {
    const { sw } = await active();
    sw.fetched.length = 0;
    expect(await sw.request('/', { mode: 'navigate' })).toBe('<html>v1</html>');
    expect(await sw.request('/some/where?x=1', { mode: 'navigate' })).toBe('<html>v1</html>');
    expect(await sw.request('/assets/app-1.js')).toBe('app 1');
    expect(await sw.request('/assets/app-1.js?v=2')).toBe('app 1');
    expect(sw.fetched).toEqual([]);
  });

  it('leaves to the network what is not listed, and never caches it', async () => {
    const { sw, caches } = await active();
    expect(await sw.request('/not-listed.txt')).toBe('network');
    expect(await sw.request('/assets/app-2.js')).toBe('app 2');
    const cached = [...caches.stores.values()].flatMap((c) => [...c.entries.keys()]);
    expect(cached).not.toContain(`${ORIGIN}/not-listed.txt`);
    expect(cached).not.toContain(`${ORIGIN}/assets/app-2.js`);
  });

  it('does not answer a request that is not a GET, or of another origin', async () => {
    const { sw } = await active();
    expect(await sw.request('/assets/app-1.js', { method: 'POST' })).toBeUndefined();
    expect(await sw.request('https://elsewhere.test/assets/app-1.js')).toBeUndefined();
  });

  it('answers from the network before any activation', async () => {
    const caches = new FakeCaches();
    const sw = worker(caches, { current: deploy(V1) });
    await sw.install();
    sw.fetched.length = 0;
    expect(await sw.request('/', { mode: 'navigate' })).toBe('<html>v1</html>');
    expect(sw.fetched.map((f) => f.url)).toEqual([`${ORIGIN}/`]);
  });

  it('keeps serving its version while a new worker installs, and switches only at activation', async () => {
    const caches = new FakeCaches();
    const site = { current: deploy(V1) };
    const old = worker(caches, site);
    await old.install();
    await old.activate();
    site.current = deploy(V2);
    const next = worker(caches, site);
    await next.install();
    expect(await old.request('/', { mode: 'navigate' })).toBe('<html>v1</html>');
    // A restarted old worker still reads its own version.
    expect(await worker(caches, site).request('/', { mode: 'navigate' })).toBe('<html>v1</html>');
    await next.activate();
    expect(await old.request('/', { mode: 'navigate' })).toBe('<html>v2</html>');
    expect(caches.stores.has(`blindvault-${sha(manifestOf(V1))}`)).toBe(false);
  });
});
