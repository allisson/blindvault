// The `publicKey` options of a passkey request, as the MAIN-world script copies them (extension.md
// §7.7, D289): only the keys below, each checked by type and range, an unknown key refused. Bytes
// travel as base64url without padding. It imports nothing: the popup and the confirmation window
// read the messages' types through `rpc.ts`.

/** A request's ID, drawn by the MAIN-world script, and a confirmation window's token. */
export const HEX_32 = /^[0-9a-f]{32}$/;

export const CHALLENGE_MIN = 16;
export const CHALLENGE_MAX = 1024;
export const USER_ID_MAX = 64;
export const CREDENTIAL_ID_MAX = 1023;
/** The most entries of `pubKeyCredParams`, `excludeCredentials` and `allowCredentials`. */
export const LIST_MAX = 64;
/** `rp.name`, `user.name` and `user.displayName`, in code points. */
export const NAME_MAX = 255;
/** `rpId` and `rp.id`, in characters. */
export const RP_ID_MAX = 253;
/** An origin's longest serialization the session host takes. */
const ORIGIN_MAX = 2048;
/** A credential type or an attachment: WebAuthn's are short words. */
const WORD_MAX = 32;

export interface Credential {
  readonly type: string;
  readonly id: Uint8Array;
}

export interface CreateOptions {
  readonly rp: { readonly id?: string; readonly name: string };
  readonly user: { readonly id: Uint8Array; readonly name: string; readonly displayName: string };
  readonly challenge: Uint8Array;
  readonly pubKeyCredParams: readonly { readonly type: string; readonly alg: number }[];
  readonly timeout?: number;
  readonly excludeCredentials?: readonly Credential[];
  readonly authenticatorSelection?: { readonly authenticatorAttachment?: string };
  readonly extensions?: { readonly credProps?: boolean };
}

export interface GetOptions {
  readonly challenge: Uint8Array;
  readonly rpId?: string;
  readonly timeout?: number;
  readonly allowCredentials?: readonly Credential[];
}

/** What the service worker forwards (§7.7 Route): every key but the first two from `MessageSender`. */
interface Forwarded {
  readonly request: string;
  readonly tabId: number;
  readonly frameId: number;
  readonly origin: string;
  readonly topOrigin: string;
}

export type PasskeyRequest =
  | (Forwarded & { readonly kind: 'create'; readonly options: CreateOptions })
  | (Forwarded & { readonly kind: 'get'; readonly options: GetOptions });

type Fields = Record<string, unknown>;

function plain(value: unknown): value is Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A plain object with only `keys`, each of `required` present. */
function shaped(
  value: unknown,
  keys: readonly string[],
  required: readonly string[] = keys,
): value is Fields {
  if (!plain(value)) return false;
  const present = Object.keys(value);
  return present.every((k) => keys.includes(k)) && required.every((k) => present.includes(k));
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function word(value: unknown): value is string {
  return typeof value === 'string' && value.length <= WORD_MAX;
}

/** A name a site sends: at most 255 code points, one line, well formed. */
function name(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !/[\n\r]/.test(value) &&
    !LONE_SURROGATE.test(value) &&
    Array.from(value).length <= NAME_MAX
  );
}

function rpId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= RP_ID_MAX;
}

function timeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** base64url without padding, as the messages carry bytes. */
export function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The bytes of canonical base64url without padding, `undefined` for any other text. */
export function fromBase64url(text: string): Uint8Array | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined;
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  // Unused bits set give other text for the same bytes: refused, so each value has one form.
  return toBase64url(bytes) === text ? bytes : undefined;
}

function bytes(value: unknown, min: number, max: number): Uint8Array | undefined {
  // Four characters per three bytes: the text is bounded before it is decoded.
  if (typeof value !== 'string' || value.length > Math.ceil((max * 4) / 3)) return undefined;
  const decoded = fromBase64url(value);
  return decoded && decoded.length >= min && decoded.length <= max ? decoded : undefined;
}

function credentials(value: unknown): Credential[] | undefined {
  if (!Array.isArray(value) || value.length > LIST_MAX) return undefined;
  const out: Credential[] = [];
  for (const c of value as unknown[]) {
    if (!shaped(c, ['type', 'id']) || !word(c.type)) return undefined;
    const id = bytes(c.id, 1, CREDENTIAL_ID_MAX);
    if (!id) return undefined;
    out.push({ type: c.type, id });
  }
  return out;
}

function params(value: unknown): { type: string; alg: number }[] | undefined {
  if (!Array.isArray(value) || value.length > LIST_MAX) return undefined;
  const out: { type: string; alg: number }[] = [];
  for (const p of value as unknown[]) {
    if (!shaped(p, ['type', 'alg']) || !word(p.type)) return undefined;
    if (typeof p.alg !== 'number' || !Number.isSafeInteger(p.alg)) return undefined;
    out.push({ type: p.type, alg: p.alg });
  }
  return out;
}

const CREATE_KEYS = [
  'rp',
  'user',
  'challenge',
  'pubKeyCredParams',
  'timeout',
  'excludeCredentials',
  'authenticatorSelection',
  'extensions',
];

export function parseCreateOptions(value: unknown): CreateOptions | undefined {
  if (!shaped(value, CREATE_KEYS, ['rp', 'user', 'challenge', 'pubKeyCredParams'])) {
    return undefined;
  }
  const { rp, user } = value;
  if (!shaped(rp, ['id', 'name'], ['name']) || !name(rp.name)) return undefined;
  if ('id' in rp && !rpId(rp.id)) return undefined;
  if (!shaped(user, ['id', 'name', 'displayName'])) return undefined;
  if (!name(user.name) || !name(user.displayName)) return undefined;
  const userId = bytes(user.id, 1, USER_ID_MAX);
  const challenge = bytes(value.challenge, CHALLENGE_MIN, CHALLENGE_MAX);
  const pubKeyCredParams = params(value.pubKeyCredParams);
  if (!userId || !challenge || !pubKeyCredParams) return undefined;
  if ('timeout' in value && !timeout(value.timeout)) return undefined;
  const exclude = 'excludeCredentials' in value ? credentials(value.excludeCredentials) : [];
  if (!exclude) return undefined;
  const selection = value.authenticatorSelection;
  if ('authenticatorSelection' in value) {
    if (!shaped(selection, ['authenticatorAttachment'], [])) return undefined;
    if ('authenticatorAttachment' in selection && !word(selection.authenticatorAttachment)) {
      return undefined;
    }
  }
  const extensions = value.extensions;
  if ('extensions' in value) {
    if (!shaped(extensions, ['credProps'], [])) return undefined;
    if ('credProps' in extensions && typeof extensions.credProps !== 'boolean') return undefined;
  }
  return {
    rp: { ...(typeof rp.id === 'string' ? { id: rp.id } : {}), name: rp.name },
    user: { id: userId, name: user.name, displayName: user.displayName },
    challenge,
    pubKeyCredParams,
    ...(timeout(value.timeout) ? { timeout: value.timeout } : {}),
    ...('excludeCredentials' in value ? { excludeCredentials: exclude } : {}),
    ...(plain(selection)
      ? {
          authenticatorSelection: word(selection.authenticatorAttachment)
            ? { authenticatorAttachment: selection.authenticatorAttachment }
            : {},
        }
      : {}),
    ...(plain(extensions)
      ? {
          extensions:
            typeof extensions.credProps === 'boolean' ? { credProps: extensions.credProps } : {},
        }
      : {}),
  };
}

export function parseGetOptions(value: unknown): GetOptions | undefined {
  if (!shaped(value, ['challenge', 'rpId', 'timeout', 'allowCredentials'], ['challenge'])) {
    return undefined;
  }
  const challenge = bytes(value.challenge, CHALLENGE_MIN, CHALLENGE_MAX);
  if (!challenge) return undefined;
  if ('rpId' in value && !rpId(value.rpId)) return undefined;
  if ('timeout' in value && !timeout(value.timeout)) return undefined;
  const allow = 'allowCredentials' in value ? credentials(value.allowCredentials) : [];
  if (!allow) return undefined;
  return {
    challenge,
    ...(rpId(value.rpId) ? { rpId: value.rpId } : {}),
    ...(timeout(value.timeout) ? { timeout: value.timeout } : {}),
    ...('allowCredentials' in value ? { allowCredentials: allow } : {}),
  };
}

/** An origin as the browser serializes it; `null` (opaque) and anything else are refused. */
function origin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > ORIGIN_MAX) return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function index(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** The keys of `passkey-create` and `passkey-get` beside `v`, `type` and `id`. */
export const PASSKEY_KEYS = ['request', 'options', 'tabId', 'frameId', 'origin', 'topOrigin'];

/** A `passkey-create` or `passkey-get` the service worker forwarded, or `undefined`. */
export function parsePasskeyRequest(
  kind: 'create' | 'get',
  value: Fields,
): PasskeyRequest | undefined {
  const { request, tabId, frameId } = value;
  if (typeof request !== 'string' || !HEX_32.test(request)) return undefined;
  if (!index(tabId) || !index(frameId) || !origin(value.origin) || !origin(value.topOrigin)) {
    return undefined;
  }
  const forwarded = { request, tabId, frameId, origin: value.origin, topOrigin: value.topOrigin };
  if (kind === 'create') {
    const options = parseCreateOptions(value.options);
    return options ? { kind, ...forwarded, options } : undefined;
  }
  const options = parseGetOptions(value.options);
  return options ? { kind, ...forwarded, options } : undefined;
}
