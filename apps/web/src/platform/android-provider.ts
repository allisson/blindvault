// The provider window's messages to the Android shell (android.md §7.7, D301, D303): the request the
// shell took from Credential Manager, checked key by key, and the result the window hands back. A
// privileged browser's request carries its origin; an app's is bound to a domain only by that domain's
// assetlinks.json, which the window asks the shell to check (§7.4).

import { registrableDomain } from '@blindvault/vault';

import {
  type PasskeyCall,
  fromBase64url,
  parseCreateOptions,
  parseGetOptions,
  toBase64url,
} from '../extension/passkey-options';
import { type PasskeyResult } from '../extension/rpc';
import { type ShellAnswer } from './android-bridge';

/** The longest `requestJson` the window parses, as the shell bounds it. */
export const REQUEST_JSON_MAX = 64 * 1024;
const CLIENT_DATA_HASH_LENGTH = 32;
/** An Android package name, as the platform allows one. */
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const PACKAGE_MAX = 255;
const ORIGIN_MAX = 2048;
const CERT_SHA256 = /^[0-9a-f]{64}$/;
/** A lowercase ASCII host name, as the shell takes one for `provider-assetlinks` (§7.4, D303). */
const HOST =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** The longest user name or password `provider-result` carries (§7.7, D303). */
export const PASSWORD_MAX = 16384;

export interface BrowserCaller {
  readonly kind: 'browser';
  readonly origin: string;
  readonly packageName: string;
}

/** A native app, with the SHA-256 of its one signing certificate, lowercase hex (§7.3, D303). */
export interface AppCaller {
  readonly kind: 'app';
  readonly packageName: string;
  readonly certSha256: string;
}

export type Caller = BrowserCaller | AppCaller;

export type ProviderRequest =
  | {
      readonly kind: 'passkey';
      readonly call: PasskeyCall;
      readonly caller: BrowserCaller;
      /** The hash the browser built `clientDataJSON` for; the window signs over it (§7.3). */
      readonly clientDataHash: Uint8Array;
    }
  | {
      /**
       * An app's: `call.origin` is `https://<rpId>`, for the checks and the matching, and the window
       * builds `clientDataJSON` with `clientOrigin`, the app's `android:apk-key-hash` (§7.3, D303).
       */
      readonly kind: 'passkey';
      readonly call: PasskeyCall;
      readonly caller: AppCaller;
      readonly clientOrigin: string;
    }
  | { readonly kind: 'password'; readonly caller: Caller };

export interface PasswordResult {
  readonly kind: 'password';
  readonly userName: string;
  readonly password: string;
}

/** How the window ends a request: the extension's results, a password, or the user's cancellation. */
export type ProviderOutcome = PasskeyResult | PasswordResult | { readonly kind: 'cancelled' };

type WithoutClientData<T> = T extends { readonly clientDataJSON: string }
  ? Omit<T, 'clientDataJSON'>
  : T;

/**
 * What the window sends in `provider-result` (§7.7): a privileged browser's passkey result without
 * `clientDataJSON`, an app's with it.
 */
export type ProviderResult = ProviderOutcome | WithoutClientData<ProviderOutcome>;

type Fields = Record<string, unknown>;

function plain(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` with only `keys`, those present, in that order. */
function only(value: Fields, keys: readonly string[]): Fields {
  return Object.fromEntries(keys.filter((k) => Object.hasOwn(value, k)).map((k) => [k, value[k]]));
}

/** A nested object reduced to `keys`; anything else passes through for the checks to refuse. */
function reduced(value: unknown, keys: readonly string[]): unknown {
  return plain(value) ? only(value, keys) : value;
}

function credentials(value: unknown): unknown {
  return Array.isArray(value) ? value.map((c) => reduced(c, ['type', 'id'])) : value;
}

/**
 * The keys of `extension.md` §7.7 from the options JSON the caller sent, each credential reduced to
 * `{type, id}`, as the extension's MAIN-world script copies them: a key WebAuthn adds later, or one
 * a provider answers no differently (`attestation`, `hints`, `prf`), breaks no request.
 */
export function pickOptions(kind: 'create' | 'get', json: unknown): Fields | undefined {
  if (!plain(json)) return undefined;
  if (kind === 'get') {
    const picked = only(json, ['challenge', 'rpId', 'timeout', 'allowCredentials']);
    if ('allowCredentials' in picked)
      picked.allowCredentials = credentials(picked.allowCredentials);
    return picked;
  }
  const picked = only(json, [
    'rp',
    'user',
    'challenge',
    'pubKeyCredParams',
    'timeout',
    'excludeCredentials',
    'authenticatorSelection',
    'extensions',
  ]);
  if ('rp' in picked) picked.rp = reduced(picked.rp, ['id', 'name']);
  if ('user' in picked) picked.user = reduced(picked.user, ['id', 'name', 'displayName']);
  if ('pubKeyCredParams' in picked && Array.isArray(picked.pubKeyCredParams)) {
    picked.pubKeyCredParams = picked.pubKeyCredParams.map((p) => reduced(p, ['type', 'alg']));
  }
  if ('excludeCredentials' in picked) {
    picked.excludeCredentials = credentials(picked.excludeCredentials);
  }
  if ('authenticatorSelection' in picked) {
    picked.authenticatorSelection = reduced(picked.authenticatorSelection, [
      'authenticatorAttachment',
    ]);
  }
  if ('extensions' in picked) picked.extensions = reduced(picked.extensions, ['credProps']);
  return picked;
}

/** An `https:` origin as a browser serializes it: no path, no trailing slash. */
function httpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > ORIGIN_MAX) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

function hasKeys(value: Fields, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((k) => keys.includes(k));
}

function packageName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PACKAGE_MAX && PACKAGE.test(value);
}

function callerOf(value: unknown): Caller | undefined {
  if (!plain(value)) return undefined;
  if (value.kind === 'browser') {
    if (!hasKeys(value, ['kind', 'origin', 'packageName'])) return undefined;
    const { origin, packageName: name } = value;
    if (!httpsOrigin(origin) || !packageName(name)) return undefined;
    return { kind: 'browser', origin, packageName: name };
  }
  if (value.kind === 'app') {
    if (!hasKeys(value, ['kind', 'packageName', 'certSha256'])) return undefined;
    const { packageName: name, certSha256 } = value;
    // One signer only: the `android:apk-key-hash` origin names one certificate (D303).
    if (!packageName(name) || !Array.isArray(certSha256) || certSha256.length !== 1) {
      return undefined;
    }
    const [cert] = certSha256 as unknown[];
    if (typeof cert !== 'string' || !CERT_SHA256.test(cert)) return undefined;
    return { kind: 'app', packageName: name, certSha256: cert };
  }
  return undefined;
}

/**
 * A domain the shell may check `assetlinks.json` of (§7.4, D303): a lowercase ASCII host name under a
 * registrable domain, so never an IP address, a public suffix or `localhost`.
 */
export function bindableDomain(value: string): boolean {
  return HOST.test(value) && !/^[0-9.]+$/.test(value) && registrableDomain(value) !== null;
}

/** `android:apk-key-hash:` and the base64url of the certificate's SHA-256 (§7.3). */
export function apkKeyHashOrigin(certSha256: string): string {
  const bytes = Uint8Array.from(certSha256.match(/../g) ?? [], (b) => parseInt(b, 16));
  return `android:apk-key-hash:${toBase64url(bytes)}`;
}

/**
 * The answer to `provider-request`, or `undefined` when any key is missing, unknown or out of range:
 * the window then ends the request with `NotAllowedError`.
 */
export function parseProviderRequest(answer: ShellAnswer): ProviderRequest | undefined {
  const fields = Object.fromEntries(
    Object.entries(answer).filter(([k]) => k !== 'v' && k !== 'id' && k !== 'ok'),
  );
  const { kind, requestJson, clientDataHash } = fields;
  const caller = callerOf(fields.caller);
  if (!caller) return undefined;
  if (kind === 'password') {
    return hasKeys(fields, ['kind', 'caller']) ? { kind: 'password', caller } : undefined;
  }
  if (kind !== 'create' && kind !== 'get') return undefined;
  const browser = caller.kind === 'browser';
  const expected = ['kind', 'caller', 'requestJson', ...(browser ? ['clientDataHash'] : [])];
  if (!hasKeys(fields, expected)) return undefined;
  if (typeof requestJson !== 'string' || requestJson.length > REQUEST_JSON_MAX) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(requestJson);
  } catch {
    return undefined;
  }
  const call = callOf(kind, pickOptions(kind, json));
  if (!call) return undefined;
  if (caller.kind === 'browser') {
    const hash = typeof clientDataHash === 'string' ? fromBase64url(clientDataHash) : undefined;
    if (hash?.length !== CLIENT_DATA_HASH_LENGTH) return undefined;
    return { kind: 'passkey', call: at(call, caller.origin), caller, clientDataHash: hash };
  }
  // An app sets no origin: its request names the rpId, which assetlinks.json must bind (D303).
  const rpId = call.kind === 'create' ? call.options.rp.id : call.options.rpId;
  if (rpId === undefined || !bindableDomain(rpId)) return undefined;
  return {
    kind: 'passkey',
    call: at(call, `https://${rpId}`),
    caller,
    clientOrigin: apkKeyHashOrigin(caller.certSha256),
  };
}

/** The call of the checked options, its origin still to set. */
function callOf(kind: 'create' | 'get', picked: Fields | undefined): PasskeyCall | undefined {
  if (kind === 'create') {
    const options = parseCreateOptions(picked);
    return options && { kind, origin: '', topOrigin: '', options };
  }
  const options = parseGetOptions(picked);
  return options && { kind, origin: '', topOrigin: '', options };
}

/** `call` at `origin`, in the top frame. */
function at(call: PasskeyCall, origin: string): PasskeyCall {
  return { ...call, origin, topOrigin: origin };
}

/**
 * The `result` of `provider-result`: a privileged browser writes `clientDataJSON` itself, so it is
 * left out (§7.3, D301); an app gets the window's.
 */
export function providerResult(result: ProviderOutcome, caller?: Caller): ProviderResult {
  if (caller?.kind === 'app') return result;
  if (result.kind === 'asserted') {
    const { id, authenticatorData, signature, userHandle } = result;
    return { kind: 'asserted', id, authenticatorData, signature, userHandle };
  }
  if (result.kind === 'created') {
    const { id, attestationObject, authenticatorData, publicKey, publicKeyAlgorithm } = result;
    return {
      kind: 'created',
      id,
      attestationObject,
      authenticatorData,
      publicKey,
      publicKeyAlgorithm,
    };
  }
  return result;
}
