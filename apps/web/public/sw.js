// @ts-check
/// <reference lib="webworker" />
// BlindVault service worker (overview §11, D63, D190). Written by hand, with no bundler and no
// dependency, so its bytes change only with its logic; every change goes in the release notes.
//
// Install fetches asset-manifest.txt (D189) and every file it lists, checks each against its
// SHA-256, and only then caches them under `blindvault-<manifest hash>`. Activation makes that cache
// the active one and deletes the other versions. Fetch answers same-origin GET requests from the
// active cache, a navigation with index.html, and leaves everything else to the network.

/** @type {ServiceWorkerGlobalScope} */
const sw = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

const PREFIX = 'blindvault-';
const STATE = 'blindvault-state';
const MANIFEST = 'asset-manifest.txt';
const LINE = /^([0-9a-f]{64}) {2}(.+)$/;

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

async function install() {
  const manifest = await download(MANIFEST);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(manifest.body);
  const entries = parseManifest(text);
  const files = await Promise.all(
    entries.map(async ({ hash, path }) => {
      const file = await download(path);
      if ((await sha256(file.body)) !== hash) throw new Error(`asset ${path}: hash mismatch`);
      return { path, ...file };
    }),
  );
  const name = PREFIX + (await sha256(manifest.body));
  try {
    const cache = await caches.open(name);
    for (const file of files) await cache.put(key(file.path), stored(file.body, file.type));
    await cache.put(key(MANIFEST), stored(manifest.body, manifest.type));
    const state = await caches.open(STATE);
    await state.put(key('installed'), new Response(name));
  } catch (error) {
    await caches.delete(name);
    throw error;
  }
}

/** @param {string} entry */
async function stateOf(entry) {
  const state = await caches.open(STATE);
  const response = await state.match(key(entry));
  return response ? response.text() : undefined;
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

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) return;
  event.respondWith(respond(request, url));
});
