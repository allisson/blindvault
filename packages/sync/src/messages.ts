// The pairing messages of `pairing-protocol.md` §10.2: deterministic CBOR maps `{v, t, …}` with
// exactly the keys of their type. Decoding is strict (`crypto-spec.md` §14, with the re-encode
// check): a `v` other than 1 is refused as `version`, anything else wrong as `protocol-error`, and
// the session aborts with that reason. `records-begin`, `record` and `records-end` are those of the
// full transfer (`sync-protocol.md` §2.1).

import {
  type CborMap,
  type CborValue,
  EncodingError,
  MAX_ENVELOPE_LENGTH,
  decodeCbor,
  encodeCbor,
} from '@blindvault/crypto';

export const MESSAGE_VERSION = 1;

/** The largest `count` of `records-begin`: a CBOR uint the decoder reads as a safe integer. */
export const MAX_RECORD_COUNT = Number.MAX_SAFE_INTEGER;

/** The reasons of §10.3, in its order. */
export const ABORT_REASONS = [
  'cancelled',
  'sas-mismatch',
  'locked',
  'expired',
  'retired-peer',
  'different-vaults',
  'unsupported-format',
  'verification-failed',
  'version',
  'protocol-error',
] as const;

export type AbortReason = (typeof ABORT_REASONS)[number];

export type Message =
  | { readonly t: 'nonce'; readonly n: Uint8Array }
  | { readonly t: 'confirmed' }
  | { readonly t: 'master-key'; readonly mk: Uint8Array; readonly vid: Uint8Array }
  | { readonly t: 'received'; readonly name: string }
  | { readonly t: 'key-confirmation'; readonly mac: Uint8Array }
  | { readonly t: 'devices'; readonly own: boolean; readonly peer: boolean; readonly name: string }
  | { readonly t: 'records-begin'; readonly count: number }
  | { readonly t: 'record'; readonly r: Uint8Array }
  | { readonly t: 'records-end' }
  | { readonly t: 'committed' }
  | { readonly t: 'abort'; readonly reason: AbortReason };

export type MessageType = Message['t'];

/** `version` for a `v` other than 1, `protocol-error` for the rest: the reason to abort with. */
export type MessageRejection = 'version' | 'protocol-error';

export class MessageError extends Error {
  override name = 'MessageError';
  constructor(
    readonly reason: MessageRejection,
    detail: string,
  ) {
    super(`pairing message rejected (${reason}): ${detail}`);
  }
}

type Kind = 'bool' | 'text' | 'name' | 'count' | 'envelope' | number;

/**
 * Each type's keys besides `v` and `t`; a number is a byte string of that length, `envelope` one of
 * at most `MAX_ENVELOPE_LENGTH` bytes, refused before any decoding (`sync-protocol.md` §2.1, D129).
 */
const SCHEMA: Readonly<Record<MessageType, Readonly<Record<string, Kind>>>> = {
  nonce: { n: 32 },
  confirmed: {},
  'master-key': { mk: 32, vid: 16 },
  received: { name: 'name' },
  'key-confirmation': { mac: 32 },
  devices: { own: 'bool', peer: 'bool', name: 'name' },
  'records-begin': { count: 'count' },
  record: { r: 'envelope' },
  'records-end': {},
  committed: {},
  abort: { reason: 'text' },
};

const NAME_MAX = 64;

const invalid = (detail: string) => new MessageError('protocol-error', detail);

/** A display name: single-line, trimmed, 1 to 64 code points (`record-content.md` §1, §7). */
function isName(value: CborValue | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\n\r]/.test(value) &&
    !/^\p{White_Space}|\p{White_Space}$/u.test(value) &&
    Array.from(value).length <= NAME_MAX
  );
}

function fits(value: CborValue | undefined, kind: Kind): boolean {
  if (typeof kind === 'number') return value instanceof Uint8Array && value.length === kind;
  if (kind === 'bool') return typeof value === 'boolean';
  if (kind === 'text') return typeof value === 'string';
  if (kind === 'count') {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
  if (kind === 'envelope') {
    return value instanceof Uint8Array && value.length <= MAX_ENVELOPE_LENGTH;
  }
  return isName(value);
}

/** Encodes a message, refusing one that decoding would reject. */
export function encodeMessage(message: Message): Uint8Array {
  const map: CborMap = new Map<CborValue, CborValue>([
    ['v', MESSAGE_VERSION],
    ['t', message.t],
  ]);
  for (const [key, value] of Object.entries(message)) {
    if (key !== 't') map.set(key, value as CborValue);
  }
  if (message.t === 'abort' && !(ABORT_REASONS as readonly string[]).includes(message.reason)) {
    throw invalid('unknown abort reason');
  }
  let bytes: Uint8Array;
  try {
    bytes = encodeCbor(map);
  } catch (error) {
    if (error instanceof EncodingError) throw invalid('not encodable');
    /* v8 ignore next */
    throw error;
  }
  // The decoder holds the rules of §10.2: one place.
  decodeMessage(bytes);
  return bytes;
}

/**
 * Decodes a message under the rules of §10.2. Throws `MessageError`. Its byte strings are copies:
 * `bytes` can be wiped once decoded.
 */
export function decodeMessage(bytes: Uint8Array): Message {
  let value: CborValue;
  try {
    value = decodeCbor(bytes);
  } catch (error) {
    if (error instanceof EncodingError) throw invalid('not deterministic CBOR');
    /* v8 ignore next */
    throw error;
  }
  if (!(value instanceof Map)) throw invalid('not a map');
  const v = value.get('v');
  if ((typeof v === 'number' || typeof v === 'bigint') && v >= 0 && v !== MESSAGE_VERSION) {
    throw new MessageError('version', `version ${String(v)}`);
  }
  if (v !== MESSAGE_VERSION) throw invalid('no version');
  const t = value.get('t');
  if (typeof t !== 'string' || !Object.hasOwn(SCHEMA, t)) throw invalid('unknown type');
  const schema = SCHEMA[t as MessageType];
  const keys = Object.keys(schema);
  if (value.size !== keys.length + 2) throw invalid('missing or extra key');
  const out: Record<string, CborValue> = { t };
  for (const key of keys) {
    const field = value.get(key);
    if (!fits(field, schema[key] ?? 'text')) throw invalid(`key ${key}`);
    // The decoder's byte strings are views of `bytes`: copies, so the caller can wipe `bytes`.
    out[key] = field instanceof Uint8Array ? field.slice() : (field as CborValue);
  }
  if (t === 'abort' && !(ABORT_REASONS as readonly string[]).includes(out.reason as string)) {
    // An unknown reason is shown as protocol-error (§10.3): the session aborts either way.
    out.reason = 'protocol-error';
  }
  return out as unknown as Message;
}
