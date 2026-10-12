// Argon2id worker entry (architecture.md). apps/web starts it with
// `new Worker(new URL('@blindvault/crypto/kdf.worker', import.meta.url), { type: 'module' })`,
// uses it for one request, and the client terminates it.

import { handleKdfRequest } from './kdf-worker';
import { initCrypto } from './sodium';

// The package compiles without the WebWorker lib, so the worker scope is declared here.
declare const self: {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
};
declare const performance: { now(): number };

self.onmessage = ({ data }) => {
  void initCrypto().then(
    () => {
      const response = handleKdfRequest(data, () => performance.now());
      self.postMessage(response, response.ok ? [response.key.buffer as ArrayBuffer] : []);
    },
    () => {
      self.postMessage({ ok: false }, []);
    },
  );
};
