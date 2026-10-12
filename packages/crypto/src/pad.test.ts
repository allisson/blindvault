import { beforeAll, describe, expect, it } from 'vitest';

import { EncodingError } from './errors';
import { PAD_BLOCK, pad, unpad } from './pad';
import { initCrypto } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

beforeAll(initCrypto);

describe('padding (D92)', () => {
  it.each(vectors.pad)('reproduces the vector for length $length', ({ length, padded }) => {
    const content = new Uint8Array(length).fill(0x41);
    expect(toHex(pad(content))).toBe(padded);
    expect(unpad(fromHex(padded))).toEqual(content);
  });

  it.each([
    ['empty input', new Uint8Array(0)],
    ['a length that is not a multiple of 256', new Uint8Array(300).fill(0x80)],
    ['a block of zero bytes', new Uint8Array(PAD_BLOCK)],
    [
      'a marker followed by a non-zero byte',
      Uint8Array.from({ length: PAD_BLOCK }, (_, i) => (i === 0 ? 0x80 : 0x01)),
    ],
  ])('rejects %s', (_name, padded) => {
    expect(() => unpad(padded)).toThrow(EncodingError);
  });
});
