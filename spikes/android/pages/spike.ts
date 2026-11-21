// The Android measurement page (docs/spikes/README.md §7, D281). In the spike app it talks to the
// Kotlin shell through `spikeBridge`, a message listener open to this origin only; opened in Chrome
// on the A54 (through `adb reverse`) it has no bridge and measures Argon2id and storage only.
// Results are kept in localStorage, so an app restart or an APK update keeps them.

import { Keyring, calibrateDeviceKek, initCrypto, randomBytes } from '@blindvault/crypto';
import { startKdfWorker } from '../../../apps/web/src/app/kdf';
import { readQr } from '../../../apps/web/src/app/qr-wasm';

const bridge = (globalThis as any).spikeBridge as
  | { postMessage(s: string): void; onmessage: ((e: { data: string }) => void) | null }
  | undefined;
const context = bridge ? 'webview' : 'chrome';
const pending = new Map<string, (m: any) => void>();
if (bridge) {
  bridge.onmessage = (e) => {
    const m = JSON.parse(e.data);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
}

function call(op: string, extra: Record<string, unknown> = {}): Promise<any> {
  if (!bridge) return Promise.resolve({ error: 'no bridge: not in the spike app' });
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    pending.set(id, (m) => {
      delete m.id;
      resolve(m);
    });
    bridge.postMessage(JSON.stringify({ id, op, ...extra }));
  });
}

// Results
const KEY = 'spike-results';
const load = (): Record<string, unknown> => JSON.parse(localStorage.getItem(KEY) ?? '{}');
let info: unknown = null;

function render(): void {
  const env = { context, origin: location.origin, userAgent: navigator.userAgent, app: info, at: new Date().toISOString() };
  document.querySelector('#results')!.textContent = JSON.stringify({ environment: env, results: load() }, null, 2);
}

function record(key: string, value: unknown): void {
  localStorage.setItem(KEY, JSON.stringify({ ...load(), [key]: value }));
  render();
}

const errorOf = (e: unknown): { name: string; message: string } =>
  e instanceof Error ? { name: e.name, message: e.message } : { name: 'Error', message: String(e) };

function button(id: string, fn: () => Promise<unknown> | void): void {
  const el = document.getElementById(id) as HTMLButtonElement;
  el.addEventListener('click', () => {
    el.disabled = true;
    Promise.resolve()
      .then(fn)
      .catch((e) => record(`error:${id}`, errorOf(e)))
      .finally(() => {
        el.disabled = false;
      });
  });
}

const checked = (id: string): boolean => (document.getElementById(id) as HTMLInputElement).checked;
const text = (id: string): string | null => (document.getElementById(id) as HTMLInputElement).value || null;
const at = (): string => new Date().toISOString();

async function fingerprint(bytes: BufferSource): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// 1. The apps/web build
button('app-record', async () => {
  const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : 'missing';
  const registrations = (await navigator.serviceWorker?.getRegistrations())?.map((r) => r.scope) ?? 'missing';
  record('1.app', {
    firstScreen: checked('first-screen'),
    note: text('app-note'),
    databases: dbs,
    serviceWorkers: registrations,
    log: (await call('log')).log ?? null,
    at: at(),
  });
});
button('log-clear', () => call('log-clear'));

button('argon', async () => {
  const t0 = performance.now();
  await initCrypto();
  const initMs = Math.round(performance.now() - t0);
  const keyring = new Keyring();
  const t1 = performance.now();
  // The app's own worker start, which passes the URL through its Trusted Types policy (D83).
  const { params } = await calibrateDeviceKek(
    keyring,
    startKdfWorker().port(),
    new TextEncoder().encode('spike password'),
    randomBytes(16),
  );
  keyring.wipeAll();
  record(`1.argon2id.${context}`, { initMs, calibrateMs: Math.round(performance.now() - t1), params, at: at() });
});

// 2. Storage
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('spike-android', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function idb(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction('kv', mode).objectStore('kv'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

button('marker-write', async () => {
  const value = { at: at(), versionCode: info ? (info as any).versionCode : null };
  await idb('readwrite', (s) => s.put(value, 'marker'));
  record(`2.${context}.markerWrite`, value);
});
button('marker-read', async () => {
  const key = `2.${context}.markerRead`;
  const prev = (load()[key] as unknown[] | undefined) ?? [];
  const marker = await idb('readonly', (s) => s.get('marker'));
  record(key, [...prev, { marker: marker ?? null, versionCodeNow: (info as any)?.versionCode ?? null, persisted: await navigator.storage?.persisted?.(), at: at() }]);
});
button('persist', async () => record(`2.${context}.persist`, { persist: await navigator.storage?.persist?.() }));
button('locks', async () => {
  if (!navigator.locks) return record(`2.${context}.locks`, 'missing');
  const got = await navigator.locks.request('spike', { ifAvailable: true }, (l) => l !== null);
  record(`2.${context}.locks`, { acquired: got });
});

// 3. DataChannel to the Mac, signaled through the shell (the page's CSP allows only 'self')
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve();
    setTimeout(resolve, 5000);
  });
}

button('rtc', async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  const channel = pc.createDataChannel('spike');
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const posted = await call('signal', { path: '/offer', body: JSON.stringify(pc.localDescription!.toJSON()) });
  if (posted.error) return record('3.dataChannel', { signal: posted });
  let answer: RTCSessionDescriptionInit | null = null;
  for (let i = 0; i < 60 && !answer; i++) {
    const r = await call('signal', { path: '/answer' });
    if (r.status === 200 && r.body) answer = JSON.parse(r.body);
    else await wait(1000);
  }
  if (!answer) return record('3.dataChannel', { error: 'no answer from the Mac in 60 s' });
  await pc.setRemoteDescription(answer);
  const reply = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 15_000);
    channel.onopen = () => channel.send('ping');
    channel.onmessage = (m) => {
      clearTimeout(timer);
      resolve(String(m.data));
    };
  });
  const stats = [...(await pc.getStats()).values()].find((s: any) => s.type === 'candidate-pair' && s.nominated) as any;
  pc.close();
  record('3.dataChannel', { reply, pass: reply === 'pong:ping', candidatePair: stats?.state ?? null, at: at() });
});

button('qr', async () => {
  const video = document.getElementById('video') as HTMLVideoElement;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    return record('3.camera', { error: errorOf(e), log: (await call('log')).log ?? null });
  }
  video.srcObject = stream;
  await video.play();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const t0 = performance.now();
  let read: string | undefined;
  while (!read && performance.now() - t0 < 30_000) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (canvas.width > 0) {
      ctx.drawImage(video, 0, 0);
      read = await readQr(ctx.getImageData(0, 0, canvas.width, canvas.height));
    }
    if (!read) await wait(250);
  }
  stream.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  const nonce = await call('signal', { path: '/nonce' });
  record('3.camera', { read: read ?? null, matchesMacNonce: !!read && read === nonce.body, ms: Math.round(performance.now() - t0), at: at() });
});

// 4. Keystore and BiometricPrompt. The 32 bytes are random and thrown away; only their fingerprint
// and the wrapped form are kept, to check the unwrap after a restart or an enrollment.
button('ks-create', async () => record('4.create', await call('keystore-create')));
button('ks-wrap', async () => {
  const data = crypto.getRandomValues(new Uint8Array(32));
  const fp = await fingerprint(data);
  const r = await call('keystore-wrap', { data: b64(data) });
  data.fill(0);
  if (r.iv) localStorage.setItem('spike-wrapped', JSON.stringify({ iv: r.iv, ct: r.ct, fp }));
  record('4.wrap', { ...r, iv: undefined, ct: undefined, at: at() });
});
button('ks-unwrap', async () => {
  const label = (document.getElementById('ks-label') as HTMLSelectElement).value;
  const wrapped = JSON.parse(localStorage.getItem('spike-wrapped') ?? 'null');
  if (!wrapped) return record(`4.unwrap.${label}`, { error: 'wrap first' });
  const r = await call('keystore-unwrap', { iv: wrapped.iv, ct: wrapped.ct });
  let same: boolean | null = null;
  if (r.data) {
    const bytes = unb64(r.data);
    same = (await fingerprint(bytes)) === wrapped.fp;
    bytes.fill(0);
  }
  record(`4.unwrap.${label}`, { ...r, data: undefined, sameBytes: same, at: at() });
});
button('ks-record', () => record('4.promptEveryUse', checked('ks-every')));

// 5. WebAuthn PRF in the WebView
const salt = new TextEncoder().encode('BlindVault spike PRF salt, D281.');

async function prfOutput(cred: PublicKeyCredential): Promise<string | null> {
  const out = (cred.getClientExtensionResults() as any).prf?.results?.first as ArrayBuffer | undefined;
  return out ? fingerprint(out) : null;
}

async function setMode(mode: string): Promise<void> {
  await call('webauthn-mode', { mode });
  location.reload();
}
button('wa-app', () => setMode('app'));
button('wa-browser', () => setMode('browser'));
button('wa-none', () => setMode('none'));

button('prf-create', async () => {
  const mode = (info as any)?.webAuthenticationMode ?? null;
  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'BlindVault spike' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'spike', displayName: 'BlindVault spike' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -8 },
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: { eval: { first: salt } } } as any,
      },
    })) as PublicKeyCredential;
    localStorage.setItem('spike-prf-id', cred.id);
    const prf = (cred.getClientExtensionResults() as any).prf;
    record(`5.create.${mode}`, { rpId: location.hostname, prfEnabled: prf?.enabled ?? null, outputAtCreate: await prfOutput(cred), at: at() });
  } catch (e) {
    record(`5.create.${mode}`, { rpId: location.hostname, publicKeyCredential: typeof PublicKeyCredential, error: errorOf(e), at: at() });
  }
});

button('prf-get', async () => {
  const mode = (info as any)?.webAuthenticationMode ?? null;
  const id = localStorage.getItem('spike-prf-id');
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        userVerification: 'required',
        allowCredentials: id ? [{ type: 'public-key', id: unb64(id.replace(/-/g, '+').replace(/_/g, '/')) }] : [],
        extensions: { prf: { eval: { first: salt } } } as any,
      },
    })) as PublicKeyCredential;
    record(`5.get.${mode}`, { output: await prfOutput(cred), at: at() });
  } catch (e) {
    record(`5.get.${mode}`, { error: errorOf(e), at: at() });
  }
});

// 6. Clipboard
const secret = (): string => `spike-secret-${crypto.randomUUID().slice(0, 8)}`;
async function nativeClip(): Promise<string> {
  const r = await call('clipboard-read');
  if (r.error) return `error: ${r.error}`;
  return r.text === null ? 'empty' : String(r.text).startsWith('spike-secret-') ? 'the secret' : `"${r.text}"`;
}
button('clip-js-copy', async () => {
  try {
    await navigator.clipboard.writeText(secret());
    record('6.pageCopy', { ok: true, clipboardNow: await nativeClip(), at: at() });
  } catch (e) {
    record('6.pageCopy', { error: errorOf(e) });
  }
});
button('clip-js-clear', async () => {
  try {
    await navigator.clipboard.writeText('');
    record('6.pageClear', { ok: true, clipboardNow: await nativeClip(), at: at() });
  } catch (e) {
    record('6.pageClear', { error: errorOf(e) });
  }
});
button('clip-native-copy', async () => {
  const r = await call('clipboard-set', { text: secret() });
  record('6.nativeCopy', { ...r, clipboardNow: await nativeClip(), at: at() });
});
button('clip-native-clear', async () => {
  const r = await call('clipboard-clear');
  record('6.nativeClear', { ...r, clipboardNow: await nativeClip(), at: at() });
});
button('clip-native-read', async () => record('6.nativeRead', { clipboardNow: await nativeClip(), at: at() }));

// Result panel
button('copy', async () => {
  render();
  const out = document.querySelector('#results')!.textContent ?? '';
  try {
    await navigator.clipboard.writeText(out);
  } catch {
    await call('clipboard-set', { text: out });
  }
});
button('reset', () => {
  localStorage.removeItem(KEY);
  render();
});

void (async () => {
  if (bridge) info = await call('info');
  document.getElementById('where')!.textContent = bridge ? 'In the spike app (WebView).' : 'In a browser: no bridge, measures 1 and 2 only.';
  document.getElementById('wa-mode')!.textContent = String((info as any)?.webAuthenticationMode ?? 'n/a');
  render();
})();
