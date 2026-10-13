// @ts-check
/// <reference lib="webworker" />
// BlindVault service worker (overview §11, D63, D190, D191). Written by hand, with no bundler and no
// dependency, so its bytes change only with its logic; every change goes in the release notes.
//
// Install fetches asset-manifest.txt (D189) and every file it lists, checks each against its
// SHA-256, and only then caches them under `blindvault-<manifest hash>`. Activation makes that cache
// the active one and deletes the other versions. Fetch answers same-origin GET requests from the
// active cache, a navigation with index.html, and leaves everything else to the network.
//
// An asset update (D191) never switches on its own: `check` stages a new bundle, checked as at
// install, and answers its version and manifest hash; only `apply` with that hash, sent once the
// user confirmed, makes it the active cache.

/** @type {ServiceWorkerGlobalScope} */
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

const PREFIX = 'blindvault-';
const STATE = 'blindvault-state';
const MANIFEST = 'asset-manifest.txt';
const VERSION = 'version.txt';
const LINE = /^([0-9a-f]{64}) {2}(.+)$/;
const HASH = /^[0-9a-f]{64}$/;
const VERSION_LINE = /^([0-9A-Za-z][0-9A-Za-z.+-]{0,63})\n$/;

/** @param {string} path */
function key(path) {
  return new URL(path, sw.registration.scope).href;
}

/** @param {BufferSource} bytes */
async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function byteOrder(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = /** @type {number} */ (a[i]) - /** @type {number} */ (b[i]);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/**
 * The manifest's entries, refusing anything but the format of docs/build.md.
 * @param {string} text
 */
function parseManifest(text) {
  if (!text.endsWith('\n')) throw new Error('asset manifest: no final newline');
  const encoder = new TextEncoder();
  /** @type {{ hash: string, path: string }[]} */
  const entries = [];
  /** @type {Uint8Array | undefined} */
  let previous;
  for (const line of text.slice(0, -1).split('\n')) {
    const match = LINE.exec(line);
    if (!match) throw new Error('asset manifest: malformed line');
    const hash = /** @type {string} */ (match[1]);
    const path = /** @type {string} */ (match[2]);
    const segments = path.split('/');
    // A path is used as a URL path as is: nothing a URL would read as escape, query or fragment.
    if (
      /[\\?#%]/.test(path) ||
      segments.some((s) => s === '' || s === '.' || s === '..') ||
      path === MANIFEST ||
      path === 'sw.js'
    ) {
      throw new Error('asset manifest: path not allowed');
    }
    const bytes = encoder.encode(path);
    if (previous && byteOrder(previous, bytes) >= 0) {
      throw new Error('asset manifest: paths not in byte order');
    }
    previous = bytes;
    entries.push({ hash, path });
  }
  if (!entries.some((e) => e.path === 'index.html')) {
    throw new Error('asset manifest: no index.html');
  }
  return entries;
}

/** @param {string} path */
async function download(path) {
  const response = await fetch(key(path), { cache: 'no-store' });
  if (!response.ok) throw new Error(`asset ${path}: HTTP ${String(response.status)}`);
  return { body: await response.arrayBuffer(), type: response.headers.get('content-type') };
}

/**
 * @param {ArrayBuffer} body
 * @param {string | null} type
 */
function stored(body, type) {
  return new Response(body, { headers: type ? { 'content-type': type } : {} });
}

/** @param {ArrayBuffer} body */
function text(body) {
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

/** @typedef {{ body: ArrayBuffer, type: string | null }} Download */

/**
 * The served manifest's files, each checked against its hash, before anything is cached.
 * @param {Download} manifest
 */
async function fetchFiles(manifest) {
  const entries = parseManifest(text(manifest.body));
  return Promise.all(
    entries.map(async ({ hash, path }) => {
      const file = await download(path);
      if ((await sha256(file.body)) !== hash) throw new Error(`asset ${path}: hash mismatch`);
      return { path, ...file };
    }),
  );
}

/**
 * Writes a checked bundle to its versioned cache, and its name to the state entry `entry`.
 * @param {string} name
 * @param {Download} manifest
 * @param {(Download & { path: string })[]} files
 * @param {string} entry
 */
async function store(name, manifest, files, entry) {
  try {
    const cache = await caches.open(name);
    for (const file of files) await cache.put(key(file.path), stored(file.body, file.type));
    await cache.put(key(MANIFEST), stored(manifest.body, manifest.type));
    const state = await caches.open(STATE);
    await state.put(key(entry), new Response(name));
  } catch (error) {
    await caches.delete(name);
    throw error;
  }
}

async function install() {
  const manifest = await download(MANIFEST);
  const files = await fetchFiles(manifest);
  await store(PREFIX + (await sha256(manifest.body)), manifest, files, 'installed');
}

/** @param {string} entry */
async function stateOf(entry) {
  const state = await caches.open(STATE);
  const response = await state.match(key(entry));
  return response ? response.text() : undefined;
}

/**
 * Deletes every versioned cache but `keep`.
 * @param {(string | undefined)[]} keep
 */
async function deleteVersionsBut(keep) {
  for (const name of await caches.keys()) {
    if (name.startsWith(PREFIX) && name !== STATE && !keep.includes(name)) {
      await caches.delete(name);
    }
  }
}

/**
 * The version a bundle's version.txt names: one line, nothing that could pass for markup.
 * @param {string} name
 */
async function versionOf(name) {
  const cache = await caches.open(name);
  const response = await cache.match(key(VERSION));
  const match = response ? VERSION_LINE.exec(text(await response.arrayBuffer())) : null;
  if (!match) throw new Error('asset update: no valid version.txt');
  return /** @type {string} */ (match[1]);
}

/** @typedef {{ type: 'none' } | { type: 'available', version: string, hash: string }} Check */

/**
 * Stages the bundle the host serves when it is not the active one (D191). Never switches.
 * @returns {Promise<Check>}
 */
async function check() {
  const active = await stateOf('active');
  if (active === undefined) return { type: 'none' };
  const manifest = await download(MANIFEST);
  const hash = await sha256(manifest.body);
  const name = PREFIX + hash;
  if (name === active) return { type: 'none' };
  if ((await stateOf('staged')) !== name || !(await caches.has(name))) {
    const files = await fetchFiles(manifest);
    if (!files.some((f) => f.path === VERSION)) throw new Error('asset update: no version.txt');
    await store(name, manifest, files, 'staged');
    // A bundle staged before, and nothing a running or waiting worker uses.
    await deleteVersionsBut([active, await stateOf('installed'), name]);
  }
  try {
    return { type: 'available', version: await versionOf(name), hash };
  } catch (error) {
    await caches.delete(name);
    throw error;
  }
}

/**
 * Switches to the staged bundle of `hash`, which the user confirmed (D191).
 * @param {unknown} hash
 * @param {string | undefined} source the window that asked, which reloads itself
 * @returns {Promise<{ type: 'applied' | 'refused' }>}
 */
async function apply(hash, source) {
  if (typeof hash !== 'string' || !HASH.test(hash)) return { type: 'refused' };
  // A changed sw.js is on its way: its warning comes first, and its cache must survive.
  if (sw.registration.installing || sw.registration.waiting) return { type: 'refused' };
  const name = PREFIX + hash;
  if ((await stateOf('staged')) !== name || !(await caches.has(name))) return { type: 'refused' };
  const cache = await caches.open(name);
  const manifest = await cache.match(key(MANIFEST));
  if (!manifest || (await sha256(await manifest.arrayBuffer())) !== hash) {
    return { type: 'refused' };
  }
  const state = await caches.open(STATE);
  await state.put(key('active'), new Response(name));
  await state.put(key('installed'), new Response(name));
  await state.delete(key('staged'));
  await deleteVersionsBut([name]);
  // No window keeps running the old code over the new files.
  for (const client of await sw.clients.matchAll({ type: 'window' })) {
    if (client.id !== source) await client.navigate(client.url);
  }
  return { type: 'applied' };
}

/** One update step at a time: two checks never stage at once. */
let queue = Promise.resolve();

/**
 * @template T
 * @param {() => Promise<T>} step
 * @returns {Promise<T>}
 */
function serial(step) {
  const run = queue.then(step);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function activate() {
  const installed = await stateOf('installed');
  if (installed === undefined) return;
  const state = await caches.open(STATE);
  await state.put(key('active'), new Response(installed));
  for (const name of await caches.keys()) {
    if (name.startsWith(PREFIX) && name !== STATE && name !== installed) await caches.delete(name);
  }
}

/**
 * @param {Request} request
 * @param {URL} url
 */
async function respond(request, url) {
  const active = await stateOf('active');
  if (active !== undefined) {
    const cache = await caches.open(active);
    const path = request.mode === 'navigate' ? 'index.html' : url.pathname.slice(1);
    const hit = await cache.match(key(path));
    if (hit) return hit;
  }
  return fetch(request);
}

sw.addEventListener('install', (event) => {
  event.waitUntil(install());
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(activate());
});

sw.addEventListener('message', (event) => {
  const port = event.ports[0];
  const data = /** @type {unknown} */ (event.data);
  if (!port || typeof data !== 'object' || data === null || !('type' in data)) return;
  const source = event.source && 'id' in event.source ? event.source.id : undefined;
  /** @type {Promise<object>} */
  let reply;
  if (data.type === 'check') {
    reply = serial(check).catch(() => ({ type: 'none' }));
  } else if (data.type === 'apply') {
    const hash = 'hash' in data ? data.hash : undefined;
    reply = serial(() => apply(hash, source)).catch(() => ({ type: 'refused' }));
  } else {
    return;
  }
  event.waitUntil(
    reply.then((r) => {
      port.postMessage(r);
    }),
  );
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  event.respondWith(respond(request, url));
});
