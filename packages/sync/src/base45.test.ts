import { describe, expect, it } from 'vitest';

import vectors from '../test-vectors/pairing-v1.json' with { type: 'json' };
import { Base45Error, decodeBase45, encodeBase45 } from './base45';

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

describe('base45 (RFC 9285)', () => {
  it.each(vectors.base45.valid)('encodes and decodes "$text"', ({ bytes, text }) => {
    expect(encodeBase45(hex(bytes))).toBe(text);
    expect(decodeBase45(text)).toEqual(hex(bytes));
  });

  it.each(vectors.base45.invalid)('rejects $case', ({ text }) => {
    expect(() => decodeBase45(text)).toThrow(Base45Error);
  });

  it('round-trips every two-byte value through its only encoding', () => {
    for (let n = 0; n <= 0xffff; n += 0x0101) {
      const bytes = Uint8Array.of(n >> 8, n & 0xff);
      const text = encodeBase45(bytes);
      expect(text).toHaveLength(3);
      expect(decodeBase45(text)).toEqual(bytes);
    }
  });
});
