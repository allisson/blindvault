import { describe, expect, it } from 'vitest';

import { Tag } from 'cbor2';

import { type CborValue, decodeCbor, encodeCbor } from './cbor';
import { EncodingError } from './errors';
import { fromHex, toHex } from './test-helpers';

describe('deterministic CBOR encoding (crypto-spec.md §14)', () => {
  it('sorts map keys bytewise and uses shortest forms', () => {
    const map = new Map<CborValue, CborValue>([
      ['bb', 1],
      ['a', 1000],
    ]);
    expect(toHex(encodeCbor(map))).toBe('a261611903e8626262' + '01');
  });

  it('round-trips every allowed value', () => {
    const value = new Map<CborValue, CborValue>([
      ['uint', 23],
      ['neg', -24],
      ['big', 2n ** 60n],
      ['bytes', Uint8Array.of(1, 2)],
      ['text', 'ação'],
      ['array', [true, false, null]],
      ['float', 1.5],
      ['nested', new Map<CborValue, CborValue>([['k', 'v']])],
    ]);
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  it('decodes maps as Map, so a "__proto__" key stays an ordinary key', () => {
    const decoded = decodeCbor(fromHex('a1695f5f70726f746f5f5f01'));
    expect(decoded).toBeInstanceOf(Map);
    expect((decoded as Map<CborValue, CborValue>).get('__proto__')).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses to encode values outside CBOR content', () => {
    expect(() => encodeCbor(new Tag(1, 0) as unknown as CborValue)).toThrow(EncodingError);
    expect(() => encodeCbor(undefined as unknown as CborValue)).toThrow(EncodingError);
    expect(() => encodeCbor({ a: 1 } as unknown as CborValue)).toThrow(EncodingError);
  });

  it('reports an encoder failure as an EncodingError', () => {
    const deep: CborValue[] = [];
    let cursor = deep;
    for (let i = 0; i < 100_000; i++) {
      const next: CborValue[] = [];
      cursor.push(next);
      cursor = next;
    }
    try {
      encodeCbor(deep);
    } catch (error) {
      expect(error).toBeInstanceOf(EncodingError);
    }
  });
});

describe('strict CBOR decoding', () => {
  it.each([
    ['unsorted map keys', 'a2616201616101'],
    ['duplicate map keys', 'a2616101616101'],
    ['non-shortest integer', '1817'],
    ['non-shortest length', '5801ff'],
    ['indefinite-length array', '9f01ff'],
    ['indefinite-length byte string', '5f4101ff'],
    ['trailing byte', '0100'],
    ['truncated input', '62ff'],
    ['empty input', ''],
    ['a tag', 'c100'],
    ['undefined', 'f7'],
    ['a simple value', 'f0'],
    ['float 1.5 as float64', 'fb3ff8000000000000'],
    ['float 1.5 as float32', 'fa3fc00000'],
    ['integral float', 'f93c00'],
    ['NaN with a payload', 'f97e01'],
    ['NaN as float32', 'fa7fc00000'],
    ['invalid UTF-8 text', '62c328'],
    ['a reserved additional info', '1c'],
  ])('rejects %s', (_name, hex) => {
    expect(() => decodeCbor(fromHex(hex))).toThrow(EncodingError);
  });

  it('accepts canonical NaN, negative zero and the shortest floats', () => {
    expect(Number.isNaN(decodeCbor(fromHex('f97e00')))).toBe(true);
    expect(Object.is(decodeCbor(fromHex('f98000')), -0)).toBe(true);
    expect(decodeCbor(fromHex('f93e00'))).toBe(1.5);
  });

  it('decodes integers beyond 2^53 − 1 as bigint', () => {
    expect(decodeCbor(fromHex('1b0020000000000000'))).toBe(2n ** 53n);
  });

  it('survives deep nesting without a stack overflow escaping', () => {
    const bytes = new Uint8Array(200_000).fill(0x81);
    bytes[bytes.length - 1] = 0x00;
    let result: unknown;
    try {
      result = decodeCbor(bytes);
    } catch (error) {
      result = error;
    }
    expect(result instanceof EncodingError || Array.isArray(result)).toBe(true);
  });
});
