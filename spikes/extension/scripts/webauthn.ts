// Measures 3 and 4 (D281): the background side of the interception. The origin and frame come only
// from the browser's MessageSender; whatever origin the page claims is logged and ignored. A
// throwaway ES256 credential lives in storage.session (memory only, gone at browser restart), so a
// Firefox event page unloading between register and sign-in does not fail measure 4 for measure 1's
// reason. Every use waits for a click in a confirm window (UP).

import { bytesOf, concat, deserialize, fromB64, sha256, toB64 } from './b64';
import { encode } from './cbor';

declare const chrome: any;

interface StoredCredential {
  credId: string;
  rpId: string;
  userHandle: string;
  userName: string;
  jwk: JsonWebKey;
  spki: string;
  createdAt: number;
}

export interface WebAuthnRequest {
  kind: 'create' | 'get';
  options: any;
  claimedOrigin?: string;
}

const pending = new Map<string, (choice: 'use' | 'browser' | 'cancel') => void>();

async function log(entry: Record<string, unknown>): Promise<void> {
  const { log: list = [] } = await chrome.storage.session.get('log');
  list.push({ at: new Date().toISOString(), ...entry });
  await chrome.storage.session.set({ log: list });
}

async function credentials(): Promise<StoredCredential[]> {
  const { creds = [] } = await chrome.storage.session.get('creds');
  return creds;
}

/** The rpId rule of D267, without the Public Suffix List the product ships (recorded, not enforced). */
function rpIdValid(host: string, rpId: string): boolean {
  return host === rpId || host.endsWith(`.${rpId}`);
}

function originOf(sender: any): { origin: string; field: string } {
  if (typeof sender.origin === 'string' && sender.origin !== 'null') return { origin: sender.origin, field: 'origin' };
  return { origin: new URL(sender.url).origin, field: 'url' };
}

/** The decision of the confirm window; closing it cancels. */
function confirm(request: Record<string, unknown>): Promise<'use' | 'browser' | 'cancel'> {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    let windowId: number | undefined;
    const onRemoved = (removed: number): void => {
      if (removed === windowId) finish('cancel');
    };
    const finish = (choice: 'use' | 'browser' | 'cancel'): void => {
      if (!pending.has(id)) return;
      pending.delete(id);
      chrome.windows.onRemoved.removeListener(onRemoved);
      void chrome.storage.session.remove(`req:${id}`);
      if (windowId !== undefined && choice !== 'cancel') void chrome.windows.remove(windowId).catch(() => {});
      resolve(choice);
    };
    pending.set(id, finish);
    chrome.windows.onRemoved.addListener(onRemoved);
    void chrome.storage.session.set({ [`req:${id}`]: request }).then(async () => {
      const win = await chrome.windows.create({
        url: chrome.runtime.getURL(`spike/confirm.html?id=${id}`),
        type: 'popup',
        width: 460,
        height: 420,
      });
      windowId = win.id;
    });
  });
}

export function decide(id: string, choice: 'use' | 'browser' | 'cancel'): boolean {
  const finish = pending.get(id);
  if (!finish) return false;
  finish(choice);
  return true;
}

/** WebAuthn wants a DER ECDSA signature; WebCrypto gives r ‖ s. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array): number[] => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = [...b.slice(i)];
    if (v[0]! & 0x80) v.unshift(0);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

function clientData(type: string, challenge: Uint8Array, origin: string, top: string | null): Uint8Array {
  const data: Record<string, unknown> = { type, challenge: toB64(challenge), origin, crossOrigin: top !== null };
  if (top !== null) data.topOrigin = top;
  return new TextEncoder().encode(JSON.stringify(data));
}

export async function handle(request: WebAuthnRequest, sender: any): Promise<unknown> {
  const { origin, field } = originOf(sender);
  const topOrigin = sender.tab?.url ? new URL(sender.tab.url).origin : null;
  const frameId: number = sender.frameId ?? -1;
  const cross = frameId !== 0 && topOrigin !== null && topOrigin !== origin ? topOrigin : null;
  const host = new URL(origin).hostname;
  const options = deserialize(request.options) as any;
  const pk = options.publicKey;
  const rpId: string = request.kind === 'create' ? (pk.rp?.id ?? host) : (pk.rpId ?? host);
  const valid = rpIdValid(host, rpId);
  const base = {
    kind: request.kind,
    origin,
    originField: field,
    claimedOrigin: request.claimedOrigin ?? null,
    frameId,
    topOrigin,
    rpId,
    rpIdValid: valid,
    mediation: options.mediation ?? null,
    extensions: Object.keys(pk.extensions ?? {}),
  };
  if (!valid) {
    await log({ ...base, outcome: 'SecurityError' });
    return { error: { name: 'SecurityError', message: 'rpId is not the origin or a suffix of it' } };
  }
  const creds = (await credentials()).filter((c) => c.rpId === rpId);
  const allowed: string[] = (pk.allowCredentials ?? []).map((c: any) => toB64(c.id));
  const usable = request.kind === 'get' ? creds.filter((c) => allowed.length === 0 || allowed.includes(c.credId)) : [];
  const choice = await confirm({
    ...base,
    userName: pk.user?.name ?? null,
    usable: usable.map((c) => c.userName),
  });
  await log({ ...base, outcome: choice });
  if (choice === 'browser') return { browser: true };
  if (choice === 'cancel') return { error: { name: 'NotAllowedError', message: 'cancelled' } };

  const rpIdHash = await sha256(new TextEncoder().encode(rpId));
  if (request.kind === 'create') {
    if (!(pk.pubKeyCredParams ?? []).some((p: any) => p.alg === -7)) {
      return { error: { name: 'NotSupportedError', message: 'ES256 only in the spike' } };
    }
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const credId = crypto.getRandomValues(new Uint8Array(16));
    const cose = encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, raw.slice(1, 33)],
        [-3, raw.slice(33, 65)],
      ]),
    );
    const authData = concat(
      rpIdHash,
      new Uint8Array([UP | UV | BE | BS | AT]),
      new Uint8Array(4),
      new Uint8Array(16),
      new Uint8Array([0, credId.length]),
      credId,
      cose,
    );
    const attestationObject = encode(
      new Map<string, string | Uint8Array | Map<string, never>>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const cdj = clientData('webauthn.create', bytesOf(pk.challenge), origin, cross);
    const stored: StoredCredential = {
      credId: toB64(credId),
      rpId,
      userHandle: toB64(bytesOf(pk.user.id)),
      userName: pk.user.name,
      jwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
      spki: toB64(spki),
      createdAt: Date.now(),
    };
    await chrome.storage.session.set({ creds: [...(await credentials()), stored] });
    const ext: Record<string, unknown> = {};
    if (pk.extensions?.credProps) ext.credProps = { rk: true };
    return {
      credential: {
        id: stored.credId,
        authenticatorAttachment: 'platform',
        clientExtensionResults: ext,
        response: {
          clientDataJSON: toB64(cdj),
          attestationObject: toB64(attestationObject),
          authenticatorData: toB64(authData),
          publicKey: stored.spki,
          publicKeyAlgorithm: -7,
          transports: ['internal', 'hybrid'],
        },
      },
    };
  }

  const cred = usable[0];
  if (!cred) return { error: { name: 'NotAllowedError', message: 'no spike passkey for this rpId' } };
  const key = await crypto.subtle.importKey('jwk', cred.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const authData = concat(rpIdHash, new Uint8Array([UP | UV | BE | BS]), new Uint8Array(4));
  const cdj = clientData('webauthn.get', bytesOf(pk.challenge), origin, cross);
  const signed = concat(authData, await sha256(cdj));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signed));
  return {
    credential: {
      id: cred.credId,
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: toB64(cdj),
        authenticatorData: toB64(authData),
        signature: toB64(der(sig)),
        userHandle: cred.userHandle,
      },
    },
  };
}

/** The listener both backgrounds install: interception requests and confirm decisions. */
export function onMessage(msg: any, sender: any, sendResponse: (r: unknown) => void): boolean | undefined {
  if (msg?.to !== 'bg') return undefined;
  if (msg.op === 'webauthn') {
    handle(msg, sender).then(sendResponse, (e) =>
      sendResponse({ error: { name: 'UnknownError', message: String(e) } }),
    );
    return true;
  }
  if (msg.op === 'decision') {
    sendResponse({ ok: decide(msg.id, msg.choice) });
    return undefined;
  }
  return undefined;
}

export { fromB64 };
