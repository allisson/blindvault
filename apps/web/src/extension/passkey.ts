// Stored passkeys in the session host (extension.md §7.2 to §7.4, D268, D288, D289): the checks a
// request passes before any window, `clientDataJSON`, and which passkeys and items a request can
// use. Keys, signatures and authenticator data are `packages/crypto`'s.

import { COSE_ALGORITHM, type PasskeyAlgorithm } from '@blindvault/crypto';
import {
  type Field,
  type Item,
  type ItemView,
  type PasskeyValue,
  fillablePage,
  matchingUrl,
  registrableDomain,
} from '@blindvault/vault';

import { hex } from '../app/ids';
import { type Credential, type PasskeyRequest, toBase64url } from './passkey-options';

/** The bounds of the pending request's time, in ms (§7.4, D289). */
export const TIMEOUT_MIN = 30_000;
export const TIMEOUT_MAX = 600_000;
export const TIMEOUT_DEFAULT = 300_000;

/** The page's `timeout`, bounded to 30 s to 600 s; 300 s without one. */
export function timeoutOf(timeout: number | undefined): number {
  if (timeout === undefined) return TIMEOUT_DEFAULT;
  return Math.min(TIMEOUT_MAX, Math.max(TIMEOUT_MIN, timeout));
}

/** What a request the session host takes is for: its `rpId`, and on create the key's algorithm. */
export type Checked =
  | { readonly kind: 'get'; readonly rpId: string }
  | { readonly kind: 'create'; readonly rpId: string; readonly algorithm: PasskeyAlgorithm };

/**
 * Whether `rpId` may serve `host` (§7.2 step 2): the host itself, or a suffix of it that is a
 * registrable domain, so neither a public suffix nor another site's domain. An IP address serves
 * only itself.
 */
export function rpIdServes(rpId: string, host: string): boolean {
  if (rpId === host) return true;
  return (
    host.endsWith(`.${rpId}`) &&
    registrableDomain(host) !== null &&
    registrableDomain(rpId) !== null
  );
}

/** The algorithm of a new key: ES256 when the site lists it, else EdDSA, else none (§7.3). */
function algorithmOf(
  params: readonly { type: string; alg: number }[],
): PasskeyAlgorithm | undefined {
  const listed = (alg: number) => params.some((p) => p.type === 'public-key' && p.alg === alg);
  if (listed(COSE_ALGORITHM.ES256)) return 'ES256';
  if (listed(COSE_ALGORITHM.EdDSA)) return 'EdDSA';
  return undefined;
}

/**
 * The checks of §7.2, in order, on the origin the browser reported: `undefined` when one fails, and
 * the call goes back to the browser.
 */
export function checkRequest(request: PasskeyRequest): Checked | undefined {
  const page = fillablePage(request.origin);
  if (!page) return undefined;
  const asked = request.kind === 'create' ? request.options.rp.id : request.options.rpId;
  const rpId = asked ?? page.hostname;
  if (!rpIdServes(rpId, page.hostname)) return undefined;
  if (request.kind === 'get') return { kind: 'get', rpId };
  const algorithm = algorithmOf(request.options.pubKeyCredParams);
  if (!algorithm) return undefined;
  if (request.options.authenticatorSelection?.authenticatorAttachment === 'cross-platform') {
    return undefined;
  }
  return { kind: 'create', rpId, algorithm };
}

/**
 * `clientDataJSON` (§7.3), in WebAuthn's key order: `type`, `challenge`, the origin the browser
 * reported, `crossOrigin`, and `topOrigin` in a frame of another origin than the top frame's.
 */
export function clientDataJSON(request: PasskeyRequest): Uint8Array {
  const type = request.kind === 'create' ? 'webauthn.create' : 'webauthn.get';
  const cross = request.origin !== request.topOrigin;
  const parts = [
    `"type":${JSON.stringify(type)}`,
    `"challenge":${JSON.stringify(toBase64url(request.options.challenge))}`,
    `"origin":${JSON.stringify(request.origin)}`,
    `"crossOrigin":${String(cross)}`,
    ...(cross ? [`"topOrigin":${JSON.stringify(request.topOrigin)}`] : []),
  ];
  return new TextEncoder().encode(`{${parts.join(',')}}`);
}

type Live = ItemView & { readonly item: Item };

/** An item outside the trash that this app reads. */
function live(view: ItemView): view is Live {
  return !view.inTrash && view.item !== undefined;
}

function passkeysOf(item: Item): PasskeyValue[] {
  return item.fields.flatMap((f) =>
    f.type === 'passkey' && typeof f.value === 'object' && 'privateKey' in f.value ? [f.value] : [],
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function listed(list: readonly Credential[], id: Uint8Array): boolean {
  return list.some((c) => c.type === 'public-key' && sameBytes(c.id, id));
}

/** A passkey a get can answer with, and the item it was found in. */
export interface Candidate {
  /** Hexadecimal, as the window names it. */
  readonly credentialId: string;
  readonly title: string;
  readonly userName?: string;
  readonly value: PasskeyValue;
}

/**
 * The passkeys a get can answer with (§7.4): those of `rpId` outside the trash whose `credentialId`
 * is in `allowCredentials`, or every one of `rpId` when the list is empty or absent, each
 * `credentialId` once, since a duplicated item holds the same key (D288).
 */
export function candidates(
  items: readonly ItemView[],
  rpId: string,
  allow: readonly Credential[] = [],
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const view of items) {
    if (!live(view)) continue;
    for (const value of passkeysOf(view.item)) {
      if (value.rpId !== rpId) continue;
      if (allow.length > 0 && !listed(allow, value.credentialId)) continue;
      const credentialId = hex(value.credentialId);
      if (seen.has(credentialId)) continue;
      seen.add(credentialId);
      out.push({
        credentialId,
        title: view.item.title,
        ...(value.userName === undefined ? {} : { userName: value.userName }),
        value,
      });
    }
  }
  return out;
}

/** Whether the vault holds a `credentialId` the create's `excludeCredentials` lists (§7.4). */
export function holdsExcluded(items: readonly ItemView[], exclude: readonly Credential[]): boolean {
  return items.some(
    (view) => live(view) && passkeysOf(view.item).some((p) => listed(exclude, p.credentialId)),
  );
}

/** The items holding a passkey of `rpId` and `userHandle`, which a create replaces (§7.4). */
export function holders(items: readonly ItemView[], rpId: string, userHandle: Uint8Array): Live[] {
  return items.filter(
    (view): view is Live =>
      live(view) &&
      passkeysOf(view.item).some((p) => p.rpId === rpId && sameBytes(p.userHandle, userHandle)),
  );
}

/** The Login items a create can save into (§7.4): those matching the origin, and writable. */
export function saveTargets(items: readonly ItemView[], origin: string): Live[] {
  return items
    .filter(
      (view): view is Live =>
        live(view) &&
        view.readOnly === undefined &&
        view.item.templateId === 'login' &&
        matchingUrl(view.item, `${origin}/`) !== null,
    )
    .sort((a, b) => new Intl.Collator().compare(a.item.title, b.item.title));
}

/** `fields` with each passkey of `rpId` and `userHandle` replaced by `next`, or `next` added. */
export function withPasskey(item: Item, next: PasskeyValue): Item {
  const same = (f: Field) =>
    f.type === 'passkey' &&
    typeof f.value === 'object' &&
    'privateKey' in f.value &&
    f.value.rpId === next.rpId &&
    sameBytes(f.value.userHandle, next.userHandle);
  return {
    ...item,
    fields: item.fields.some(same)
      ? item.fields.map((f) => (same(f) ? { ...f, value: next } : f))
      : [...item.fields, { type: 'passkey', value: next }],
  };
}
