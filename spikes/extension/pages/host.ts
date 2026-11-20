// Measures 1, 2 and 6 (D281): a session host, the offscreen document on Chrome, the event page on
// Firefox, or an extension tab as fallback. It holds a throwaway random key in memory and writes a
// heartbeat to localStorage, which is not an extension API call, so it does not keep an event page
// alive. Spike code: the key is never used for anything.

import { Keyring, calibrateDeviceKek, initCrypto, randomBytes } from '@blindvault/crypto';
import workerUrl from '@blindvault/crypto/kdf.worker?worker&url';

declare const chrome: any;

export type HostKind = 'offscreen' | 'background' | 'tab';

const loadedAt = Date.now();

async function fingerprint(key: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', key));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('spike-host', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function idb(mode: 'readonly' | 'readwrite', fn: (s: IDBObjectStore) => IDBRequest): Promise<unknown> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = fn(d.transaction('kv', mode).objectStore('kv'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function argon2id(): Promise<unknown> {
  const t0 = performance.now();
  await initCrypto();
  const initMs = performance.now() - t0;
  const worker = new Worker(workerUrl, { type: 'module' });
  const keyring = new Keyring();
  const t1 = performance.now();
  const { params } = await calibrateDeviceKek(keyring, worker as any, new TextEncoder().encode('spike password'), randomBytes(16));
  const ms = performance.now() - t1;
  keyring.wipeAll();
  return { initMs: Math.round(initMs), calibrateMs: Math.round(ms), params };
}

let rtc: RTCPeerConnection | null = null;

async function answer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
  rtc?.close();
  const pc = new RTCPeerConnection({ iceServers: [] });
  rtc = pc;
  pc.ondatachannel = (e) => {
    e.channel.onmessage = (m) => e.channel.send(`pong:${String(m.data)}`);
  };
  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') resolve();
    pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve();
    setTimeout(resolve, 5000);
  });
  return pc.localDescription!.toJSON();
}

async function clearClipboard(): Promise<unknown> {
  const tried: Record<string, string> = {};
  try {
    await navigator.clipboard.writeText('');
    tried.writeText = 'ok';
    return tried;
  } catch (e) {
    tried.writeText = String(e);
  }
  const onCopy = (ev: ClipboardEvent): void => {
    ev.clipboardData?.setData('text/plain', '');
    ev.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  try {
    tried.execCommand = document.execCommand('copy') ? 'ok' : 'false';
  } catch (e) {
    tried.execCommand = String(e);
  } finally {
    document.removeEventListener('copy', onCopy);
  }
  return tried;
}

export function startHost(kind: HostKind): void {
  let key: Uint8Array | null = null;
  let fp: string | null = null;
  let startedAt = 0;
  let beat: ReturnType<typeof setInterval> | undefined;

  const ops: Record<string, (msg: any) => Promise<unknown>> = {
    start: async () => {
      key = crypto.getRandomValues(new Uint8Array(32));
      fp = await fingerprint(key);
      startedAt = Date.now();
      localStorage.setItem(`host:${kind}`, JSON.stringify({ startedAt, fp }));
      localStorage.setItem(`hb:${kind}`, String(startedAt));
      clearInterval(beat);
      beat = setInterval(() => localStorage.setItem(`hb:${kind}`, String(Date.now())), 60_000);
      return { fp, startedAt };
    },
    check: async () => ({
      kind,
      alive: key !== null,
      fp,
      startedAt: startedAt || null,
      loadedAt,
      offscreenApiInHost: typeof chrome.offscreen !== 'undefined',
    }),
    argon2id,
    // The offscreen document has only runtime messaging: the page sends the version.
    'marker-write': async (msg) => {
      const value = { at: Date.now(), version: msg.version ?? null };
      await idb('readwrite', (s) => s.put(value, 'marker'));
      return value;
    },
    'marker-read': async () => ({
      marker: await idb('readonly', (s) => s.get('marker')),
      persisted: await navigator.storage?.persisted?.(),
    }),
    persist: async () => ({ persist: await navigator.storage?.persist?.() }),
    locks: async () => {
      if (!navigator.locks) return { locks: 'missing' };
      const got = await navigator.locks.request('spike-host', { ifAvailable: true }, (l) => l !== null);
      return { locks: 'ok', acquired: got };
    },
    rtc: async (msg) => ({ answer: await answer(msg.offer) }),
    'clipboard-clear': async (msg) => {
      await new Promise((r) => setTimeout(r, msg.delayMs ?? 10_000));
      const result = await clearClipboard();
      localStorage.setItem('clipboard-clear', JSON.stringify({ at: Date.now(), result }));
      return result;
    },
  };

  chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, sendResponse: (r: unknown) => void) => {
    if (msg?.to !== `host:${kind}`) return undefined;
    const op = ops[msg.op];
    if (!op) return undefined;
    op(msg).then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  });
}
