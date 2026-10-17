// The strict codec shared by the pairing messages (`pairing-protocol.md` §10.2) and the sync
// messages (`sync-protocol.md` §11.1): deterministic CBOR maps `{v, t, …}` with exactly the keys of
// their type, decoded with the re-encode check (`crypto-spec.md` §14). A `v` other than 1 is refused
// as `version`, anything else wrong as `protocol-error`, and the session aborts with that reason.
// Each protocol gives its schema and its abort reasons; an unknown reason reads as `protocol-error`.

import {
  type CborMap,
  type CborValue,
  EncodingError,
  MAX_ENVELOPE_LENGTH,
  decodeCbor,
  encodeCbor,
} from '@blindvault/crypto';

export const MESSAGE_VERSION = 1;

/** The largest `count`: a CBOR uint the decoder reads as a safe integer. */
export const MAX_RECORD_COUNT = Number.MAX_SAFE_INTEGER;

/** `version` for a `v` other than 1, `protocol-error` for the rest: the reason to abort with. */
export type MessageRejection = 'version' | 'protocol-error';

export class MessageError extends Error {
  override name = 'MessageError';
  constructor(
    readonly reason: MessageRejection,
    detail: string,
  ) {
    super(`message rejected (${reason}): ${detail}`);
  }
}

export const invalid = (detail: string) => new MessageError('protocol-error', detail);

/** One key of a message type: which CBOR values it takes, and how it maps to the message. */
export interface Field {
  readonly fits: (value: CborValue | undefined) => boolean;
  /** The message value of a CBOR value that fits; by default, itself, a byte string copied. */
  readonly read?: (value: CborValue) => unknown;
  /** The CBOR value of a message value; by default, itself. */
  readonly write?: (value: unknown) => CborValue;
}

export const bytesField = (length: number): Field => ({
  fits: (value) => value instanceof Uint8Array && value.length === length,
});
export const boolField: Field = { fits: (value) => typeof value === 'boolean' };
export const textField: Field = { fits: (value) => typeof value === 'string' };
export const countField: Field = {
  fits: (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
};
/** A record envelope: longer than the largest envelope is refused before any decoding (D129). */
export const envelopeField: Field = {
  fits: (value) => value instanceof Uint8Array && value.length <= MAX_ENVELOPE_LENGTH,
};

export interface MessageCodec<M extends { readonly t: string }> {
  /** Each type's keys besides `v` and `t`. */
  readonly schema: Readonly<Record<M['t'], Readonly<Record<string, Field>>>>;
  /** The reasons `abort` may carry. */
  readonly abortReasons: readonly string[];
}

/** Encodes a message, refusing one that decoding would reject. */
export function encodeWith<M extends { readonly t: string }>(
  codec: MessageCodec<M>,
  message: M,
): Uint8Array {
  const fields: Readonly<Record<string, Field>> | undefined = Object.hasOwn(codec.schema, message.t)
    ? codec.schema[message.t as M['t']]
    : undefined;
  const map: CborMap = new Map<CborValue, CborValue>([
    ['v', MESSAGE_VERSION],
    ['t', message.t],
  ]);
  for (const [key, value] of Object.entries(message)) {
    if (key === 't') continue;
    const write = fields?.[key]?.write;
    map.set(key, write ? write(value) : value);
  }
  if (message.t === 'abort' && !codec.abortReasons.includes(reasonOf(message))) {
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
  // The decoder holds the rules: one place.
  decodeWith(codec, bytes);
  return bytes;
}

/**
 * Decodes a message under the codec's rules. Throws `MessageError`. Its byte strings are copies:
 * `bytes` can be wiped once decoded.
 */
export function decodeWith<M extends { readonly t: string }>(
  codec: MessageCodec<M>,
  bytes: Uint8Array,
): M {
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
  if (typeof t !== 'string' || !Object.hasOwn(codec.schema, t)) throw invalid('unknown type');
  const fields: Readonly<Record<string, Field>> = codec.schema[t as M['t']];
  const keys = Object.keys(fields);
  if (value.size !== keys.length + 2) throw invalid('missing or extra key');
  const out: Record<string, unknown> = { t };
  for (const key of keys) {
    const field = fields[key];
    const raw = value.get(key);
    if (!field?.fits(raw)) throw invalid(`key ${key}`);
    // The decoder's byte strings are views of `bytes`: copies, so the caller can wipe `bytes`.
    out[key] = field.read
      ? field.read(raw as CborValue)
      : raw instanceof Uint8Array
        ? raw.slice()
        : raw;
  }
  if (t === 'abort' && !codec.abortReasons.includes(out.reason as string)) {
    // An unknown reason is shown as protocol-error: the session aborts either way.
    out.reason = 'protocol-error';
  }
  return out as unknown as M;
}

function reasonOf(message: object): string {
  return 'reason' in message && typeof message.reason === 'string' ? message.reason : '';
}
