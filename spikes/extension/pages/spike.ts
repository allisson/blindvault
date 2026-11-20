// The measurement page (docs/spikes/README.md §6, D281). Each button records into the result JSON.

import { Keyring, calibrateDeviceKek, initCrypto, randomBytes } from '@blindvault/crypto';
import workerUrl from '@blindvault/crypto/kdf.worker?worker&url';

import { browserName, button, errorOf, ext, record, send, setupResults } from './common';

const isChrome = browserName() === 'chrome';
const defaultHost = isChrome ? 'offscreen' : 'background';
const hostSelect = document.querySelector<HTMLSelectElement>('#host')!;
hostSelect.value = defaultHost;
const hostKind = (): string => hostSelect.value;

async function ensureHost(kind: string): Promise<void> {
  if (kind === 'offscreen') {
    await send({ to: 'bg', op: 'ensure-offscreen' });
  } else if (kind === 'tab') {
    const tabs = await ext.tabs.query({ url: ext.runtime.getURL('spike/host.html') });
    if (tabs.length === 0) {
      await ext.tabs.create({ url: ext.runtime.getURL('spike/host.html'), active: false });
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

const toHost = (op: string, extra: Record<string, unknown> = {}): Promise<any> =>
  send({ to: `host:${hostKind()}`, op, ...extra });

// 1. Session host
void record('1.offscreenApi', typeof ext.offscreen !== 'undefined');

button('host-start', async () => {
  const kind = hostKind();
  await ensureHost(kind);
  const r = await toHost('start');
  await record(`1.${kind}.start`, { ...r, at: new Date().toISOString() });
});

button('host-check', async () => {
  const kind = hostKind();
  const stored = JSON.parse(localStorage.getItem(`host:${kind}`) ?? 'null');
  const lastBeat = Number(localStorage.getItem(`hb:${kind}`) ?? 0);
  let r: any;
  try {
    r = await toHost('check');
  } catch (e) {
    r = { error: errorOf(e) };
  }
  const now = Date.now();
  const sameKey = !!stored && r?.alive === true && r.fp === stored.fp;
  const minutes = stored ? (now - stored.startedAt) / 60_000 : null;
  await record(`1.${kind}.check`, {
    ...r,
    sameKey,
    minutesSinceStart: minutes && Math.round(minutes * 10) / 10,
    lastHeartbeatMinutesAfterStart: stored && lastBeat ? Math.round(((lastBeat - stored.startedAt) / 60_000) * 10) / 10 : null,
    pass: sameKey && minutes !== null && minutes >= 60,
    note: (document.querySelector<HTMLInputElement>('#host-note')?.value ?? '') || null,
    at: new Date().toISOString(),
  });
});

// 2. The apps/web build, unmodified, and Argon2id here and in the host
let appWindow: Window | null = null;
button('app-open', async () => {
  appWindow = window.open(ext.runtime.getURL('index.html'), '_blank');
  await record('2.appOpened', appWindow !== null);
});

button('app-inspect', async () => {
  const w = appWindow;
  const read = (): unknown => {
    if (!w || w.closed) return { error: 'app tab closed or not opened from this page' };
    return {
      title: w.document.title,
      screen: w.document.body?.innerText.slice(0, 400) ?? null,
      serviceWorkerController: w.navigator.serviceWorker?.controller !== null,
    };
  };
  const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : 'missing';
  let registrations: unknown;
  try {
    registrations = (await navigator.serviceWorker?.getRegistrations())?.length ?? 'missing';
  } catch (e) {
    registrations = errorOf(e);
  }
  await record('2.app', {
    ...(read() as object),
    databases: dbs,
    serviceWorkerRegistrations: registrations,
    consoleErrors: document.querySelector<HTMLTextAreaElement>('#app-errors')?.value || null,
  });
});

button('argon-page', async () => {
  const t0 = performance.now();
  await initCrypto();
  const initMs = Math.round(performance.now() - t0);
  const keyring = new Keyring();
  const t1 = performance.now();
  const { params } = await calibrateDeviceKek(
    keyring,
    new Worker(workerUrl, { type: 'module' }) as any,
    new TextEncoder().encode('spike password'),
    randomBytes(16),
  );
  keyring.wipeAll();
  await record('2.argon2id.tab', { initMs, calibrateMs: Math.round(performance.now() - t1), params });
});

button('argon-host', async () => {
  await ensureHost(hostKind());
  await record(`2.argon2id.${hostKind()}`, await toHost('argon2id'));
});

// 3 and 4. Interception log and credentials, written by the background
button('log-read', async () => {
  const { log = [], creds = [] } = await ext.storage.session.get(['log', 'creds']);
  await record('3-4.log', log);
  await record(
    '3-4.credentials',
    creds.map((c: any) => ({ rpId: c.rpId, userName: c.userName, createdAt: new Date(c.createdAt).toISOString() })),
  );
});
button('log-clear', async () => {
  await ext.storage.session.remove(['log']);
});
button('webauthnio-result', async () => {
  const check = (id: string): boolean => document.querySelector<HTMLInputElement>(id)?.checked ?? false;
  await record('4.webauthn.io', {
    registered: check('#wio-register'),
    signedIn: check('#wio-signin'),
    note: document.querySelector<HTMLInputElement>('#wio-note')?.value || null,
  });
});

// 5. PRF from the extension origin
const salt = new TextEncoder().encode('BlindVault spike PRF salt, D281.');

async function prfFingerprint(cred: PublicKeyCredential): Promise<string | null> {
  const out = (cred.getClientExtensionResults() as any).prf?.results?.first as ArrayBuffer | undefined;
  if (!out) return null;
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', out));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

button('prf-create', async () => {
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
    const prf = (cred.getClientExtensionResults() as any).prf;
    await ext.storage.local.set({ prfCredential: cred.id });
    await record('5.create', {
      rpId: location.hostname,
      prfEnabled: prf?.enabled ?? null,
      outputAtCreate: await prfFingerprint(cred),
    });
  } catch (e) {
    await record('5.create', { rpId: location.hostname, error: errorOf(e) });
  }
});

async function prfGet(label: string): Promise<void> {
  const { prfCredential } = await ext.storage.local.get('prfCredential');
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        userVerification: 'required',
        allowCredentials: prfCredential
          ? [{ type: 'public-key', id: Uint8Array.from(atob(prfCredential.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) }]
          : [],
        extensions: { prf: { eval: { first: salt } } } as any,
      },
    })) as PublicKeyCredential;
    await record(`5.${label}`, { output: await prfFingerprint(cred) });
  } catch (e) {
    await record(`5.${label}`, { error: errorOf(e) });
  }
}
button('prf-get1', () => prfGet('get1'));
button('prf-get2', () => prfGet('get2'));
button('prf-get3', () => prfGet('afterRestart'));

// 6. Storage, Web Locks, DataChannel, clipboard
button('marker-write', async () =>
  record(`6.${hostKind()}.markerWrite`, await toHost('marker-write', { version: ext.runtime.getManifest().version })),
);
button('marker-read', async () => record(`6.${hostKind()}.markerRead`, await toHost('marker-read')));
button('persist', async () => record(`6.${hostKind()}.persist`, await toHost('persist')));
button('locks', async () => record(`6.${hostKind()}.locks`, await toHost('locks')));
button('reload', async () => {
  await record('6.reloadedAt', new Date().toISOString());
  ext.runtime.reload();
});

button('rtc', async () => {
  const kind = hostKind();
  await ensureHost(kind);
  const pc = new RTCPeerConnection({ iceServers: [] });
  const channel = pc.createDataChannel('spike');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') resolve();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve();
    setTimeout(resolve, 5000);
  });
  const r = await toHost('rtc', { offer: pc.localDescription!.toJSON() });
  if (r?.error) {
    await record(`6.${kind}.dataChannel`, { error: r.error });
    return;
  }
  await pc.setRemoteDescription(r.answer);
  const reply = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 10_000);
    channel.onopen = () => channel.send('ping');
    channel.onmessage = (m) => {
      clearTimeout(timer);
      resolve(String(m.data));
    };
  });
  pc.close();
  await record(`6.${kind}.dataChannel`, { reply, pass: reply === 'pong:ping' });
});

button('clipboard-read', async () => {
  const cleared = JSON.parse(localStorage.getItem('clipboard-clear') ?? 'null');
  const copied = JSON.parse(localStorage.getItem('clipboard-copied') ?? 'null');
  let text: string | { error: unknown };
  try {
    text = await navigator.clipboard.readText();
  } catch (e) {
    text = { error: errorOf(e) };
  }
  await record('6.clipboard', {
    copied,
    clearedByHost: cleared,
    clipboardNow: typeof text === 'string' ? (text.startsWith('spike-secret-') ? 'still the secret' : `"${text}"`) : text,
    pass: typeof text === 'string' && !text.startsWith('spike-secret-'),
  });
});

setupResults();
