import { $, environment, errorText, log, mountResults, record, tracked } from './common';

// Safari storage (D55, D103, D110) and system UIs that report the app as hidden (D105).

interface Marker {
  context: string;
  createdAt: number;
  userAgent: string;
}

interface Visit {
  context: string;
  at: number;
}

const context = () => (environment().standalone ? 'installed app' : 'browser tab');

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('spike-storage', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('markers', { keyPath: 'context' });
      req.result.createObjectStore('visits', { autoIncrement: true });
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB open failed'));
    };
  });
}

function all<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => {
      resolve(req.result as T[]);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('read failed'));
    };
  });
}

function put(db: IDBDatabase, store: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('write failed'));
    };
  });
}

async function refresh(db: IDBDatabase): Promise<void> {
  const markers = await all<Marker>(db, 'markers');
  const visits = await all<Visit>(db, 'visits');
  const now = Date.now();
  record('markers', markers.map((m) => ({ ...m, ageDays: +((now - m.createdAt) / 86_400_000).toFixed(2) })));
  record('visits', visits.map((v) => ({ context: v.context, at: new Date(v.at).toISOString() })));
  record('storage', {
    persisted: await navigator.storage.persisted(),
    estimate: await navigator.storage.estimate(),
  });
}

async function systemUi(name: string, fn: () => Promise<unknown>): Promise<void> {
  const { hidden } = await tracked(name, async () => {
    try {
      await fn();
    } catch (e) {
      log(`${name}: ${errorText(e)}`);
    }
  });
  const prev = (window as unknown as { __ui?: Record<string, boolean> }).__ui ?? {};
  prev[name] = hidden;
  (window as unknown as { __ui: Record<string, boolean> }).__ui = prev;
  record('systemUiReportsHidden', prev);
  log(`${name}: page reported hidden = ${String(hidden)}`);
}

function filePicker(): Promise<void> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.addEventListener('change', () => {
      resolve();
    });
    input.addEventListener('cancel', () => {
      resolve();
    });
    window.addEventListener(
      'focus',
      () => {
        setTimeout(resolve, 500);
      },
      { once: true },
    );
    input.click();
  });
}

async function camera(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  await new Promise((r) => setTimeout(r, 1500));
  stream.getTracks().forEach((t) => {
    t.stop();
  });
}

async function webauthn(): Promise<void> {
  await navigator.credentials.get({
    publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: 'required', timeout: 30_000 },
  });
}

async function main(): Promise<void> {
  const db = await openDb();
  await put(db, 'visits', { context: context(), at: Date.now() });
  record('thisContext', context());
  await refresh(db);
  $('#write-marker').addEventListener('click', () => {
    void put(db, 'markers', { context: context(), createdAt: Date.now(), userAgent: navigator.userAgent })
      .then(() => refresh(db))
      .then(() => {
        log(`marker written for ${context()}`);
      });
  });
  $('#persist').addEventListener('click', () => {
    void navigator.storage.persist().then((granted) => {
      record('persistRequest', { granted, at: new Date().toISOString() });
      return refresh(db);
    });
  });
  $('#ui-file').addEventListener('click', () => void systemUi('file picker', filePicker));
  $('#ui-camera').addEventListener('click', () => void systemUi('camera prompt', camera));
  $('#ui-webauthn').addEventListener('click', () => void systemUi('WebAuthn prompt', webauthn));
}

mountResults('storage');
main().catch((e: unknown) => {
  log(`failed: ${errorText(e)}`);
});
