import { $, errorText, log, mountResults, record } from './common';

// Service-worker integrity (D63, D142): does a changed sw.js run its install code, when does it
// activate, does skipWaiting + clients.claim take over this window, and does the page see
// `updatefound` in time to lock?

const events: { event: string; at: string; detail?: unknown }[] = [];
const pageLoadedAt = Date.now();

function note(event: string, detail?: unknown): void {
  events.push({ event, at: new Date().toISOString(), detail });
  record('pageEvents', events);
  log(`${event}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`);
}

async function controllerVersion(): Promise<unknown> {
  try {
    const r = await fetch('sw-version', { cache: 'no-store' });
    return r.headers.get('content-type')?.includes('json') ? await r.json() : 'not controlled';
  } catch (e) {
    return `fetch failed: ${errorText(e)}`;
  }
}

function readSwLog(): Promise<unknown[]> {
  return new Promise((resolve) => {
    const open = indexedDB.open('spike-sw-log', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('log', { autoIncrement: true });
    open.onsuccess = () => {
      const req = open.result.transaction('log').objectStore('log').getAll();
      req.onsuccess = () => {
        resolve(
          (req.result as { version: string; event: string; at: number }[]).map((e) => ({
            ...e,
            at: new Date(e.at).toISOString(),
            secondsAfterPageLoad: Math.round((e.at - pageLoadedAt) / 1000),
          })),
        );
      };
      req.onerror = () => {
        resolve([]);
      };
    };
    open.onerror = () => {
      resolve([]);
    };
  });
}

async function refresh(): Promise<void> {
  record('controller', await controllerVersion());
  record('serviceWorkerLog', await readSwLog());
}

async function main(): Promise<void> {
  if (!('serviceWorker' in navigator)) throw new Error('no service worker support');
  const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
  note('registered', { active: !!reg.active, waiting: !!reg.waiting, installing: !!reg.installing });
  reg.addEventListener('updatefound', () => {
    note('updatefound (page would lock the vault now)');
    const sw = reg.installing;
    sw?.addEventListener('statechange', () => {
      note(`new worker ${sw.state}`);
      void refresh();
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    note('controllerchange (another worker now controls this window)');
    void refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void reg.update().catch(() => undefined);
  });
  $('#check').addEventListener('click', () => {
    note('manual update check');
    void reg.update().then(refresh, (e: unknown) => {
      note('update failed', errorText(e));
    });
  });
  $('#refresh').addEventListener('click', () => void refresh());
  await refresh();
}

mountResults('service worker');
main().catch((e: unknown) => {
  note('failed', errorText(e));
});
