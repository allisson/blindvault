// Deterministic CBOR (crypto-spec.md §14, D10): RFC 8949 §4.2 encoding, a strict decoder, an
// explicit check of every decoded value, and a re-encode check against a decoder regression.

import { type DecodeOptions, Tag, decode, encode } from 'cbor2';

import { EncodingError } from './errors';

/**
 * A decoded CBOR value. Maps are always `Map`, never plain objects, so no key can reach an object
 * prototype; integers beyond 2^53 − 1 are `bigint`.
 */
export type CborValue =
  number | bigint | string | boolean | null | Uint8Array | CborValue[] | CborMap;

export type CborMap = Map<CborValue, CborValue>;

const DECODE_OPTIONS: DecodeOptions = {
  cde: true,
  rejectDuplicateKeys: true,
  rejectLongFloats: true,
  rejectLongLoundNaN: true,
  rejectUndefined: true,
  rejectSimple: true,
  rejectStreaming: true,
  ignoreGlobalTags: true,
  preferMap: true,
};

/**
 * Walks a value without recursion, so deep nesting cannot exhaust the stack, and rejects anything
 * core deterministic content does not allow: tags, `undefined`, simple values, other objects.
 */
function check(root: unknown): asserts root is CborValue {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'string' ||
      value instanceof Uint8Array
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      pending.push(...(value as unknown[]));
    } else if (value instanceof Map) {
      for (const [k, v] of value as Map<unknown, unknown>) pending.push(k, v);
    } else if (value instanceof Tag) {
      throw new EncodingError('CBOR tags are not allowed');
    } else {
      throw new EncodingError('value is not allowed in CBOR content');
    }
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Core deterministic encoding: shortest forms, definite lengths, bytewise-sorted map keys. */
export function encodeCbor(value: CborValue): Uint8Array {
  check(value);
  try {
    // cbor2 starts a new writer for each map key it sorts, each allocating `chunkSize` bytes
    // (4096 by default): 256 halves the cost of unlock (architecture.md, load test). The bytes
    // are the same; `chunkSize` is only the writer's buffer size.
    return encode(value, { cde: true, chunkSize: 256 });
  } catch {
    throw new EncodingError('value cannot be encoded as CBOR');
  }
}

/**
 * Strict decode of exactly one item. Rejects non-shortest forms, indefinite lengths, unsorted or
 * duplicate keys, non-preferred floats, `undefined`, simple values, tags, trailing bytes, and any
 * input whose re-encoding differs from it.
 */
export function decodeCbor(bytes: Uint8Array): CborValue {
  let value: unknown;
  try {
    value = decode(bytes, DECODE_OPTIONS);
  } catch {
    throw new EncodingError('invalid CBOR');
  }
  check(value);
  if (!equal(encodeCbor(value), bytes)) throw new EncodingError('CBOR is not canonical');
  return value;
}
