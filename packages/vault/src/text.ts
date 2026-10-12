// Text rules of record-content.md §1. Lengths are Unicode code points, not UTF-16 units.

import { type CborMap, type CborValue, ID_LENGTH } from '@blindvault/crypto';

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** At least 1 code point. */
export function isText(value: CborValue | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Text with no U+000A or U+000D. */
export function isSingleLine(value: CborValue | undefined): value is string {
  return isText(value) && !/[\n\r]/.test(value);
}

/** No character with the Unicode `White_Space` property at either end. */
export function isTrimmed(text: string): boolean {
  return !/^\p{White_Space}|\p{White_Space}$/u.test(text);
}

/** Single-line, trimmed, 1 to `max` code points. */
export function isBoundedLine(value: CborValue | undefined, max: number): value is string {
  return isSingleLine(value) && isTrimmed(value) && codePointLength(value) <= max;
}

export function isId(value: CborValue | undefined): value is Uint8Array {
  return value instanceof Uint8Array && value.length === ID_LENGTH;
}

export function isBytes(value: CborValue | undefined, length: number): value is Uint8Array {
  return value instanceof Uint8Array && value.length === length;
}

/** A CBOR unsigned integer: `bigint` beyond 2^53 − 1. */
export function isUint(value: CborValue | undefined): value is number | bigint {
  if (typeof value === 'bigint') return value >= 0n && value <= 2n ** 64n - 1n;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function uintIn(value: CborValue | undefined, min: number, max: number): value is number {
  return typeof value === 'number' && isUint(value) && value >= min && value <= max;
}

/** Order of code points, which is the order of UTF-8 bytes. */
export function compareCodePoints(a: string, b: string): number {
  const x = Array.from(a, (c) => Number(c.codePointAt(0)));
  const y = Array.from(b, (c) => Number(c.codePointAt(0)));
  return compareSequences(x, y);
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  return compareSequences(a, b);
}

function compareSequences(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

/** A map whose keys are all text, as every content map is (§1). */
export function isTextKeyed(value: CborValue | undefined): value is CborMap {
  return value instanceof Map && [...value.keys()].every((k) => typeof k === 'string');
}

/** Keys of `map` outside `known`, in code-point order. */
export function unknownKeys(map: CborMap, known: ReadonlySet<string>): string[] {
  return [...map.keys()]
    .filter((k): k is string => typeof k === 'string' && !known.has(k))
    .sort(compareCodePoints);
}
