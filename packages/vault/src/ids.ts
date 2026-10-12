// Byte-string identifiers as map keys.

/** A string key for a 16-byte ID, for in-memory maps only: never persisted or shown. */
export function idKey(id: Uint8Array): string {
  return Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}
