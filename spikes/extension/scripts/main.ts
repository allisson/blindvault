// Measure 3 (D281): the MAIN-world override of navigator.credentials, run at document_start. It
// relays to the isolated content script by window messages, which the page can see and forge: the
// background therefore takes the origin from MessageSender only. Calls outside https: and localhost,
// calls without publicKey and conditional mediation go straight to the browser.

import { fromB64, serialize } from './b64';

const CH = 'bv-spike';
const container = navigator.credentials;
const native = {
  create: container.create.bind(container),
  get: container.get.bind(container),
};
const pending = new Map<number, (data: any) => void>();
let seq = 0;

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.ch !== CH || e.data.dir !== 'to-main') return;
  const resolve = pending.get(e.data.id);
  if (!resolve) return;
  pending.delete(e.data.id);
  resolve(e.data);
});

const buf = (text: string): ArrayBuffer => fromB64(text).buffer as ArrayBuffer;

function build(kind: 'create' | 'get', c: any): PublicKeyCredential {
  const r = c.response;
  const response: any =
    kind === 'create'
      ? {
          clientDataJSON: buf(r.clientDataJSON),
          attestationObject: buf(r.attestationObject),
          getAuthenticatorData: () => buf(r.authenticatorData),
          getPublicKey: () => buf(r.publicKey),
          getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
          getTransports: () => [...r.transports],
        }
      : {
          clientDataJSON: buf(r.clientDataJSON),
          authenticatorData: buf(r.authenticatorData),
          signature: buf(r.signature),
          userHandle: r.userHandle ? buf(r.userHandle) : null,
        };
  const proto = kind === 'create' ? globalThis.AuthenticatorAttestationResponse : globalThis.AuthenticatorAssertionResponse;
  if (proto) Object.setPrototypeOf(response, proto.prototype);
  const json = {
    id: c.id,
    rawId: c.id,
    type: 'public-key',
    authenticatorAttachment: c.authenticatorAttachment,
    clientExtensionResults: c.clientExtensionResults,
    response: { ...r },
  };
  const credential: any = {
    id: c.id,
    rawId: buf(c.id),
    type: 'public-key',
    authenticatorAttachment: c.authenticatorAttachment,
    response,
    getClientExtensionResults: () => c.clientExtensionResults,
    toJSON: () => json,
  };
  if (globalThis.PublicKeyCredential) Object.setPrototypeOf(credential, PublicKeyCredential.prototype);
  return credential;
}

function call(kind: 'create' | 'get', options?: any): Promise<Credential | null> {
  const direct =
    !options?.publicKey ||
    options.mediation === 'conditional' ||
    (location.protocol !== 'https:' && location.hostname !== 'localhost');
  if (direct) return native[kind](options);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, (data) => {
      if (data.browser) native[kind](options).then(resolve, reject);
      else if (data.error) reject(new DOMException(data.error.message, data.error.name));
      else resolve(build(kind, data.credential));
    });
    window.postMessage({ ch: CH, dir: 'to-relay', id, kind, options: serialize(options) }, '*');
  });
}

Object.defineProperty(container, 'create', { value: (o?: any) => call('create', o), configurable: true, writable: true });
Object.defineProperty(container, 'get', { value: (o?: any) => call('get', o), configurable: true, writable: true });
