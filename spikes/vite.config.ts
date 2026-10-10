import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Phase 0 spikes. SPIKE_BASE is '/blindvault/' on GitHub Pages; SW_VERSION and SW_TAKEOVER shape the
// service worker emitted for the service-worker spike (see docs/spikes/README.md).
const base = process.env.SPIKE_BASE ?? '/';
const swVersion = process.env.SW_VERSION ?? 'local-1';
const swTakeover = process.env.SW_TAKEOVER === 'true';

function serviceWorker(): Plugin {
  const source = `// Service-worker spike, version ${swVersion}
const VERSION = ${JSON.stringify(swVersion)};
const TAKEOVER = ${String(swTakeover)};

function log(event) {
  return new Promise((resolve) => {
    const open = indexedDB.open('spike-sw-log', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('log', { autoIncrement: true });
    open.onsuccess = () => {
      const tx = open.result.transaction('log', 'readwrite');
      tx.objectStore('log').add({ version: VERSION, event, at: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    open.onerror = () => resolve();
  });
}

self.addEventListener('install', (e) => {
  e.waitUntil(log('install').then(() => (TAKEOVER ? self.skipWaiting() : undefined)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(log('activate').then(() => (TAKEOVER ? self.clients.claim() : undefined)));
});

self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).pathname.endsWith('/sw-version')) {
    e.respondWith(new Response(JSON.stringify({ version: VERSION, takeover: TAKEOVER }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }));
  }
});
`;
  return {
    name: 'spike-service-worker',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.endsWith('/sw.js')) {
          res.setHeader('content-type', 'text/javascript');
          res.setHeader('cache-control', 'no-store');
          res.end(source);
          return;
        }
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

const pages = ['index', 'pairing', 'argon2id', 'prf', 'storage', 'sw'];

export default defineConfig({
  base,
  define: {
    __SW_VERSION__: JSON.stringify(swVersion),
    __BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [serviceWorker()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `${p}.html`)])),
    },
  },
});
