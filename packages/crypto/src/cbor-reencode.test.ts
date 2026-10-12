import { describe, expect, it, vi } from 'vitest';

import { decodeCbor } from './cbor';
import { EncodingError } from './errors';

// Simulates a decoder regression: cbor2 accepts `0x01` but returns a value that encodes as `0x02`.
vi.mock('cbor2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('cbor2')>()),
  decode: () => 2,
}));

describe('re-encode check (crypto-spec.md §14)', () => {
  it('rejects input whose decoded value re-encodes to other bytes', () => {
    expect(() => decodeCbor(Uint8Array.of(0x01))).toThrow(EncodingError);
  });
});
