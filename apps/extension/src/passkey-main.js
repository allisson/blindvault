// @ts-check
/* global window */
// The MAIN-world script (extension.md §7.2, §7.7, D289): registered only while passkeys are on, at
// `document_start` in every frame, so it replaces `navigator.credentials.create` and `get` before
// the page's code runs. It copies the `publicKey` options the session host reads, hands them to the
// isolated content script by a window message, and builds the `PublicKeyCredential` the page
// receives. It holds no key; the page can read and forge its messages, which is why the service
// worker takes the origin from the browser alone. A classic script, shipped as written.

(function install(window) {
  const CHANNEL = 'blindvault-passkey';
  /** The session host's longest wait (§7.4), and the time a lost answer is given beyond it. */
  const TIMEOUT_MIN = 30_000;
  const TIMEOUT_MAX = 600_000;
  const TIMEOUT_DEFAULT = 300_000;
  const GRACE = 5_000;

  const container = window.navigator.credentials;
  if (!container) return;
  // Kept before the page runs, so a page replacing them later changes nothing here.
  const native = { create: container.create.bind(container), get: container.get.bind(container) };
  const post = window.postMessage.bind(window);
  const random = window.crypto.getRandomValues.bind(window.crypto);
  const schedule = window.setTimeout.bind(window);
  const unschedule = window.clearTimeout.bind(window);

  /** @typedef {Record<string, unknown>} Fields */

  /** @type {Map<string, (result: unknown) => void>} The calls waiting for their answer. */
  const pending = new Map();

  /** @param {unknown} value @returns {value is Fields} */
  function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** @param {Uint8Array} bytes */
  function toBase64url(bytes) {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** @param {unknown} text @returns {ArrayBuffer} */
  function buffer(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('bytes');
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0)).buffer;
  }

  /** A `BufferSource` as base64url, `undefined` for anything else. @param {unknown} value */
  function bytes(value) {
    if (value instanceof ArrayBuffer) return toBase64url(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) {
      return toBase64url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
    return undefined;
  }

  /** @param {unknown} list @returns {{ type: unknown, id: string }[] | undefined} */
  function credentials(list) {
    if (!Array.isArray(list)) return undefined;
    const out = [];
    for (const c of list) {
      const id = object(c) ? bytes(c.id) : undefined;
      if (!object(c) || id === undefined) return undefined;
      out.push({ type: c.type, id });
    }
    return out;
  }

  /**
   * Only the keys of §7.7, bytes as base64url; `undefined` when a key the call needs cannot be
   * copied, and the call goes to the browser, which gives the page its own error. The session host
   * checks every value again.
   * @param {'create' | 'get'} kind
   * @param {Fields} pk
   * @returns {Fields | undefined}
   */
  function copy(kind, pk) {
    /** @type {Fields} */
    const out = {};
    const challenge = bytes(pk.challenge);
    if (challenge === undefined) return undefined;
    if (kind === 'create') {
      const { rp, user } = pk;
      if (!object(rp) || !object(user)) return undefined;
      const userId = bytes(user.id);
      if (userId === undefined || !Array.isArray(pk.pubKeyCredParams)) return undefined;
      out.rp = { ...(rp.id === undefined ? {} : { id: rp.id }), name: rp.name };
      out.user = { id: userId, name: user.name, displayName: user.displayName };
      out.challenge = challenge;
      out.pubKeyCredParams = pk.pubKeyCredParams.map((p) =>
        object(p) ? { type: p.type, alg: p.alg } : p,
      );
      if (pk.timeout !== undefined) out.timeout = pk.timeout;
      if (pk.excludeCredentials !== undefined) {
        const exclude = credentials(pk.excludeCredentials);
        if (!exclude) return undefined;
        out.excludeCredentials = exclude;
      }
      const selection = pk.authenticatorSelection;
      if (object(selection)) {
        out.authenticatorSelection =
          selection.authenticatorAttachment === undefined
            ? {}
            : { authenticatorAttachment: selection.authenticatorAttachment };
      }
      const extensions = pk.extensions;
      if (object(extensions)) {
        out.extensions =
          typeof extensions.credProps === 'boolean' ? { credProps: extensions.credProps } : {};
      }
      return out;
    }
    out.challenge = challenge;
    if (pk.rpId !== undefined) out.rpId = pk.rpId;
    if (pk.timeout !== undefined) out.timeout = pk.timeout;
    if (pk.allowCredentials !== undefined) {
      const allow = credentials(pk.allowCredentials);
      if (!allow) return undefined;
      out.allowCredentials = allow;
    }
    return out;
  }

  /** @param {unknown} timeout */
  function bounded(timeout) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout)) return TIMEOUT_DEFAULT;
    return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, timeout));
  }

  /** @param {object} target @param {{ prototype: object } | undefined} type */
  function as(target, type) {
    if (type) Object.setPrototypeOf(target, type.prototype);
    return target;
  }

  /**
   * The credential of a `created` or `asserted` result (§7.2): `platform` attachment, `credProps`
   * the only extension answered, and `toJSON()` complete.
   * @param {'create' | 'get'} kind
   * @param {Fields} r
   * @param {boolean} credProps
   */
  function credential(kind, r, credProps) {
    const strings =
      kind === 'create'
        ? ['id', 'clientDataJSON', 'attestationObject', 'authenticatorData', 'publicKey']
        : ['id', 'clientDataJSON', 'authenticatorData', 'signature', 'userHandle'];
    for (const key of strings) buffer(r[key]);
    if (kind === 'create' && !Number.isSafeInteger(r.publicKeyAlgorithm)) throw new Error('alg');
    const transports = ['internal', 'hybrid'];
    const results = kind === 'create' && credProps ? { credProps: { rk: true } } : {};
    const json =
      kind === 'create'
        ? {
            clientDataJSON: r.clientDataJSON,
            authenticatorData: r.authenticatorData,
            transports,
            publicKey: r.publicKey,
            publicKeyAlgorithm: r.publicKeyAlgorithm,
            attestationObject: r.attestationObject,
          }
        : {
            clientDataJSON: r.clientDataJSON,
            authenticatorData: r.authenticatorData,
            signature: r.signature,
            userHandle: r.userHandle,
          };
    const response =
      kind === 'create'
        ? as(
            {
              clientDataJSON: buffer(r.clientDataJSON),
              attestationObject: buffer(r.attestationObject),
              getAuthenticatorData: () => buffer(r.authenticatorData),
              getPublicKey: () => buffer(r.publicKey),
              getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
              getTransports: () => [...transports],
              toJSON: () => ({ ...json, transports: [...transports] }),
            },
            /** @type {any} */ (window).AuthenticatorAttestationResponse,
          )
        : as(
            {
              clientDataJSON: buffer(r.clientDataJSON),
              authenticatorData: buffer(r.authenticatorData),
              signature: buffer(r.signature),
              userHandle: buffer(r.userHandle),
              toJSON: () => ({ ...json }),
            },
            /** @type {any} */ (window).AuthenticatorAssertionResponse,
          );
    return as(
      {
        id: r.id,
        rawId: buffer(r.id),
        type: 'public-key',
        authenticatorAttachment: 'platform',
        response,
        getClientExtensionResults: () => structuredClone(results),
        toJSON: () => ({
          id: r.id,
          rawId: r.id,
          response: kind === 'create' ? { ...json, transports: [...transports] } : { ...json },
          authenticatorAttachment: 'platform',
          clientExtensionResults: structuredClone(results),
          type: 'public-key',
        }),
      },
      /** @type {any} */ (window).PublicKeyCredential,
    );
  }

  /** @param {unknown} name */
  function failure(name) {
    return new DOMException(
      'The operation either timed out or was not allowed.',
      name === 'InvalidStateError' ? name : 'NotAllowedError',
    );
  }

  /**
   * @param {'create' | 'get'} kind
   * @param {any} options
   * @returns {Promise<Credential | null>}
   */
  function call(kind, options) {
    const pk = object(options) ? options.publicKey : undefined;
    // Without `publicKey`, or with conditional mediation, the call is not one for BlindVault (D283).
    if (!object(pk) || options.mediation === 'conditional') return native[kind](options);
    const copied = copy(kind, pk);
    if (!copied) return native[kind](options);
    /** @type {AbortSignal | undefined} */
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const request = Array.from(random(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    const credProps = object(copied.extensions) && copied.extensions.credProps === true;
    return new Promise((resolve, reject) => {
      const done = () => {
        pending.delete(request);
        unschedule(timer);
        signal?.removeEventListener('abort', aborted);
      };
      const aborted = () => {
        done();
        reject(signal?.reason);
      };
      /** @param {unknown} result */
      const settle = (result) => {
        done();
        const r = object(result) ? result : {};
        if (r.kind === 'browser') {
          native[kind](options).then(resolve, reject);
        } else if (r.kind === (kind === 'create' ? 'created' : 'asserted')) {
          try {
            resolve(/** @type {Credential} */ (credential(kind, r, credProps)));
          } catch {
            reject(failure('NotAllowedError'));
          }
        } else {
          reject(failure(r.kind === 'error' ? r.name : 'NotAllowedError'));
        }
      };
      // The session host ends the request at its timeout; this ends a call whose answer was lost.
      const timer = schedule(
        () => {
          settle({ kind: 'error', name: 'NotAllowedError' });
        },
        bounded(copied.timeout) + GRACE,
      );
      signal?.addEventListener('abort', aborted, { once: true });
      pending.set(request, settle);
      const type = kind === 'create' ? 'passkey-create' : 'passkey-get';
      post({ channel: CHANNEL, to: 'isolated', type, request, options: copied }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!object(d) || d.channel !== CHANNEL || d.to !== 'main' || typeof d.request !== 'string') {
      return;
    }
    pending.get(d.request)?.(d.result);
  });

  for (const kind of /** @type {const} */ (['create', 'get'])) {
    Object.defineProperty(container, kind, {
      /** @param {any} options */
      value: (options) => call(kind, options),
      configurable: true,
      writable: true,
    });
  }
})(window);
