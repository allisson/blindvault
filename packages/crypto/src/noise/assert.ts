// Stands in for `nanoassert`, which noise-protocol and hmac-blake2b use (see LICENSE). A failed
// assertion throws; `noise.ts` turns any throw into a `NoiseError`.

export class NoiseAssertionError extends Error {
  override name = 'NoiseAssertionError';
}

export function assert(condition: unknown, message = 'assertion failed'): asserts condition {
  if (!condition) throw new NoiseAssertionError(message);
}

/**
 * A key the step needs. The original passes a possibly null buffer on and fails with a TypeError
 * when it is null; here that failure is an explicit assertion.
 */
export function required(value: Uint8Array | null): Uint8Array {
  assert(value != null, 'missing key');
  return value;
}
