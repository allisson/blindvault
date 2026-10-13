// The service worker as shipped (`public/sw.js`, D190, D191), run in a VM against fake caches,
// network and window clients.

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

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(key));
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

  has(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.has(name));
  }

  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.stores.delete(name));
  }
}

/** An app window the worker controls. */
interface FakeClient {
  readonly id: string;
  readonly url: string;
  navigated: string[];
}

type Handler = (event: unknown) => void;

/** One deployment the fake network serves: path → body (404 when absent). */
type Site = Record<string, string>;

function worker(caches: FakeCaches, site: { current: Site; offline?: boolean }) {
  const handlers = new Map<string, Handler>();
  const fetched: { url: string; cache: RequestCache | undefined }[] = [];
  const windows: FakeClient[] = [];
  const registration = {
    scope: `${ORIGIN}/`,
    installing: null as object | null,
    waiting: null as object | null,
  };
  const fetch = (input: string | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.url, `${ORIGIN}/`);
    fetched.push({ url: url.href, cache: init?.cache });
    if (site.offline) return Promise.reject(new TypeError('Failed to fetch'));
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
    registration,
    clients: {
      matchAll: (options: { type?: string }) =>
        Promise.resolve(
          options.type === 'window'
            ? windows.map((w) => ({
                id: w.id,
                url: w.url,
                navigate: (url: string) => {
                  w.navigated.push(url);
                  return Promise.resolve(null);
                },
              }))
            : [],
        ),
    },
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

  /** Posts `data` as the window `source` would, with a reply port; resolves to the reply. */
  async function message(data: unknown, source = 'window-1', port = true): Promise<unknown> {
    const replies: unknown[] = [];
    let pending: Promise<unknown> = Promise.resolve();
    handlers.get('message')?.({
      data,
      source: { id: source },
      ports: port ? [{ postMessage: (reply: unknown) => replies.push(reply) }] : [],
      waitUntil: (p: Promise<unknown>) => {
        pending = p;
      },
    });
    await pending;
    return replies.length === 0 ? undefined : replies;
  }

  return {
    install: () => lifecycle('install'),
    activate: () => lifecycle('activate'),
    request,
    message,
    fetched,
    windows,
    registration,
  };
}

const V1: Site = {
  'index.html': '<html>v1</html>',
  'assets/app-1.js': 'app 1',
  'version.txt': '1.0.0\n',
};
const V2: Site = {
  'index.html': '<html>v2</html>',
  'assets/app-2.js': 'app 2',
  'version.txt': '2.0.0\n',
};
const V3: Site = {
  'index.html': '<html>v3</html>',
  'assets/app-3.js': 'app 3',
  'version.txt': '3.0.0-rc.1+b7\n',
};

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
      [
        `${ORIGIN}/asset-manifest.txt`,
        `${ORIGIN}/assets/app-1.js`,
        `${ORIGIN}/index.html`,
        `${ORIGIN}/version.txt`,
      ].sort(),
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

describe('service worker asset update (D191)', () => {
  const versioned = (caches: FakeCaches) =>
    [...caches.stores.keys()].filter(
      (k) => k.startsWith('blindvault-') && k !== 'blindvault-state',
    );
  const nameOf = (files: Site) => `blindvault-${sha(manifestOf(files))}`;

  /** A worker running V1, with the host now serving `next`. */
  async function running(next: Site) {
    const caches = new FakeCaches();
    const site: { current: Site; offline?: boolean } = { current: deploy(V1) };
    const sw = worker(caches, site);
    await sw.install();
    await sw.activate();
    site.current = next;
    sw.fetched.length = 0;
    return { caches, site, sw };
  }

  it('stages a new bundle, checked file by file past the HTTP cache, and offers its version and hash without switching', async () => {
    const { caches, sw } = await running(deploy(V2));
    expect(await sw.message({ type: 'check' })).toEqual([
      { type: 'available', version: '2.0.0', hash: sha(manifestOf(V2)) },
    ]);
    expect(sw.fetched.every((f) => f.cache === 'no-store')).toBe(true);
    expect(sw.fetched.map((f) => f.url)).not.toContain(`${ORIGIN}/sw.js`);
    expect(versioned(caches).sort()).toEqual([nameOf(V1), nameOf(V2)].sort());
    // Nothing switched: the running version still answers.
    expect(await sw.request('/', { mode: 'navigate' })).toBe('<html>v1</html>');
    expect(await sw.request('/version.txt')).toBe('1.0.0\n');
  });

  it('offers nothing when the host serves the active bundle', async () => {
    const { caches, sw } = await running(deploy(V1));
    expect(await sw.message({ type: 'check' })).toEqual([{ type: 'none' }]);
    expect(sw.fetched.map((f) => f.url)).toEqual([`${ORIGIN}/asset-manifest.txt`]);
    expect(versioned(caches)).toEqual([nameOf(V1)]);
  });

  it('offers a staged bundle again without fetching its files again', async () => {
    const { sw } = await running(deploy(V2));
    await sw.message({ type: 'check' });
    sw.fetched.length = 0;
    expect(await sw.message({ type: 'check' })).toEqual([
      { type: 'available', version: '2.0.0', hash: sha(manifestOf(V2)) },
    ]);
    expect(sw.fetched.map((f) => f.url)).toEqual([`${ORIGIN}/asset-manifest.txt`]);
  });

  it("replaces an older staged bundle, keeping the active one and a new worker's", async () => {
    const { caches, site, sw } = await running(deploy(V2));
    await sw.message({ type: 'check' });
    // A changed sw.js installs V3 and waits; the host then serves V2 again, then V3.
    site.current = deploy(V3);
    await worker(caches, site).install();
    site.current = deploy({ ...V2, 'assets/extra.js': 'extra' });
    await sw.message({ type: 'check' });
    expect(versioned(caches).sort()).toEqual(
      [nameOf(V1), nameOf(V3), nameOf({ ...V2, 'assets/extra.js': 'extra' })].sort(),
    );
  });

  const withVersion = (version: string | undefined): Site => {
    const files: Site = { ...V2 };
    if (version === undefined) delete files['version.txt'];
    else files['version.txt'] = version;
    return deploy(files);
  };

  it.each([
    ['a tampered file', { ...deploy(V2), 'assets/app-2.js': 'tampered' }],
    ['a malformed manifest', deploy(V2, manifestOf(V2).replace('  ', ' '))],
    ['no version.txt', withVersion(undefined)],
    ['an empty version.txt', withVersion('')],
    ['a version without its newline', withVersion('2.0.0')],
    ['a version of two lines', withVersion('2.0.0\n2.0.1\n')],
    ['a version with a space', withVersion('2.0 beta\n')],
    ['a version with markup', withVersion('<b>2</b>\n')],
    ['a version of 65 characters', withVersion(`${'9'.repeat(65)}\n`)],
  ])('offers nothing for a bundle with %s, and keeps none of it', async (_, next) => {
    const { caches, sw } = await running(next);
    expect(await sw.message({ type: 'check' })).toEqual([{ type: 'none' }]);
    expect(versioned(caches)).toEqual([nameOf(V1)]);
    expect(await sw.request('/', { mode: 'navigate' })).toBe('<html>v1</html>');
  });

  it('offers nothing offline, and nothing before any activation', async () => {
    const { site, sw } = await running(deploy(V2));
    site.offline = true;
    expect(await sw.message({ type: 'check' })).toEqual([{ type: 'none' }]);
    const fresh = worker(new FakeCaches(), { current: deploy(V2) });
    expect(await fresh.message({ type: 'check' })).toEqual([{ type: 'none' }]);
  });

  it('applies only the staged hash: switches, deletes every other version, reloads every other window', async () => {
    const { caches, sw } = await running(deploy(V2));
    sw.windows.push(
      { id: 'window-1', url: `${ORIGIN}/`, navigated: [] },
      { id: 'window-2', url: `${ORIGIN}/other`, navigated: [] },
    );
    await sw.message({ type: 'check' });
    expect(await sw.message({ type: 'apply', hash: sha(manifestOf(V2)) })).toEqual([
      { type: 'applied' },
    ]);
    expect(await sw.request('/', { mode: 'navigate' })).toBe('<html>v2</html>');
    expect(versioned(caches)).toEqual([nameOf(V2)]);
    expect(sw.windows.map((w) => w.navigated)).toEqual([[], [`${ORIGIN}/other`]]);
    // The applied bundle is now the active one: nothing more to offer, and a restart keeps it.
    expect(await sw.message({ type: 'check' })).toEqual([{ type: 'none' }]);
    const restarted = worker(caches, { current: deploy(V2) });
    expect(await restarted.request('/', { mode: 'navigate' })).toBe('<html>v2</html>');
  });

  it('refuses to apply a hash it has not staged, or a malformed one', async () => {
    const { caches, sw } = await running(deploy(V2));
    await sw.message({ type: 'check' });
    for (const hash of [sha(manifestOf(V1)), sha(manifestOf(V3)), 'x', 42, undefined]) {
      expect(await sw.message({ type: 'apply', hash })).toEqual([{ type: 'refused' }]);
    }
    expect(await sw.request('/', { mode: 'navigate' })).toBe('<html>v1</html>');
    expect(versioned(caches).sort()).toEqual([nameOf(V1), nameOf(V2)].sort());
  });

  it('refuses to apply while another worker installs or waits', async () => {
    for (const state of ['installing', 'waiting'] as const) {
      const { sw } = await running(deploy(V2));
      await sw.message({ type: 'check' });
      sw.registration[state] = {};
      expect(await sw.message({ type: 'apply', hash: sha(manifestOf(V2)) })).toEqual([
        { type: 'refused' },
      ]);
      expect(await sw.request('/', { mode: 'navigate' })).toBe('<html>v1</html>');
    }
  });

  it('refuses to apply a staged cache whose manifest is gone or changed', async () => {
    for (const change of ['gone', 'changed'] as const) {
      const { caches, sw } = await running(deploy(V2));
      await sw.message({ type: 'check' });
      const staged = caches.stores.get(nameOf(V2));
      const key = `${ORIGIN}/asset-manifest.txt`;
      if (change === 'gone') caches.stores.delete(nameOf(V2));
      else await staged?.put(key, new Response(manifestOf(V3)));
      expect(await sw.message({ type: 'apply', hash: sha(manifestOf(V2)) })).toEqual([
        { type: 'refused' },
      ]);
      expect(await sw.request('/', { mode: 'navigate' })).toBe('<html>v1</html>');
    }
  });

  it('ignores a message without a reply port, or of another type', async () => {
    const { caches, sw } = await running(deploy(V2));
    expect(await sw.message({ type: 'check' }, 'window-1', false)).toBeUndefined();
    for (const data of [null, 'check', { type: 'skipWaiting' }, { type: 'apply' }]) {
      const reply = await sw.message(data);
      expect(reply === undefined || JSON.stringify(reply) === '[{"type":"refused"}]').toBe(true);
    }
    expect(versioned(caches)).toEqual([nameOf(V1)]);
  });
});
