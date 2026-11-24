// The provider window's messages to the Android shell (android.md §7.7, D301): the request the shell
// took from Credential Manager, checked key by key, and the result the window hands back. Until apps
// bound by assetlinks.json land (D301 Order), only a privileged browser's request is taken.

import {
  type PasskeyCall,
  fromBase64url,
  parseCreateOptions,
  parseGetOptions,
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

export interface BrowserCaller {
  readonly kind: 'browser';
  readonly origin: string;
  readonly packageName: string;
}

export interface ProviderRequest {
  readonly call: PasskeyCall;
  readonly caller: BrowserCaller;
  /** The hash the browser built `clientDataJSON` for; the window signs over it (§7.3). */
  readonly clientDataHash: Uint8Array;
}

/** How the window ends a request: the extension's results, or the user's cancellation. */
export type ProviderOutcome = PasskeyResult | { readonly kind: 'cancelled' };

type WithoutClientData<T> = T extends { readonly clientDataJSON: string }
  ? Omit<T, 'clientDataJSON'>
  : T;

/** What the window sends in `provider-result` for a privileged browser (§7.7). */
export type ProviderResult = WithoutClientData<ProviderOutcome>;

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

function browserCaller(value: unknown): BrowserCaller | undefined {
  if (!plain(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['kind', 'origin', 'packageName'].every((k) => keys.includes(k))) {
    return undefined;
  }
  const { kind, origin, packageName } = value;
  if (kind !== 'browser' || !httpsOrigin(origin)) return undefined;
  if (typeof packageName !== 'string' || packageName.length > PACKAGE_MAX) return undefined;
  if (!PACKAGE.test(packageName)) return undefined;
  return { kind, origin, packageName };
}

/**
 * The answer to `provider-request`, or `undefined` when any key is missing, unknown or out of range:
 * the window then ends the request with `NotAllowedError`.
 */
export function parseProviderRequest(answer: ShellAnswer): ProviderRequest | undefined {
  const keys = Object.keys(answer).filter((k) => k !== 'v' && k !== 'id' && k !== 'ok');
  const expected = ['kind', 'caller', 'requestJson', 'clientDataHash'];
  if (keys.length !== expected.length || !expected.every((k) => keys.includes(k))) {
    return undefined;
  }
  const { kind, requestJson, clientDataHash } = answer;
  if (kind !== 'create' && kind !== 'get') return undefined;
  const caller = browserCaller(answer.caller);
  if (!caller) return undefined;
  const hash = typeof clientDataHash === 'string' ? fromBase64url(clientDataHash) : undefined;
  if (hash?.length !== CLIENT_DATA_HASH_LENGTH) return undefined;
  if (typeof requestJson !== 'string' || requestJson.length > REQUEST_JSON_MAX) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(requestJson);
  } catch {
    return undefined;
  }
  const picked = pickOptions(kind, json);
  const origins = { origin: caller.origin, topOrigin: caller.origin };
  if (kind === 'create') {
    const options = parseCreateOptions(picked);
    return options
      ? { call: { kind, ...origins, options }, caller, clientDataHash: hash }
      : undefined;
  }
  const options = parseGetOptions(picked);
  return options
    ? { call: { kind, ...origins, options }, caller, clientDataHash: hash }
    : undefined;
}

/**
 * The `result` of `provider-result`: a privileged browser writes `clientDataJSON` itself, so it is
 * left out (§7.3, D301).
 */
export function providerResult(result: ProviderOutcome): ProviderResult {
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
