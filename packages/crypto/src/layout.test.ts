import { describe, expect, it } from 'vitest';

import { EncodingError } from './errors';
import {
  LocalPurpose,
  type RecordHeader,
  bool,
  id,
  label,
  layout,
  localAad,
  recordAad,
  u16,
  u32,
  u64,
  u8,
} from './layout';
import { fromHex, hlcFromHex, toHex, vectors } from './test-helpers';

const header: RecordHeader = (() => {
  const v = vectors.layout.recordAad[0];
  if (!v) throw new Error('missing vector');
  return {
    recordFormatVersion: v.recordFormatVersion,
    recordType: v.recordType,
    recordId: fromHex(v.recordId),
    keyEpoch: v.keyEpoch,
    hlc: hlcFromHex(v.hlc),
    deleted: v.deleted,
  };
})();
const vaultId = fromHex(vectors.layout.recordAad[0]?.vaultId ?? '');

describe('layout encoding (crypto-spec.md §3)', () => {
  it.each(vectors.layout.fields)('reproduces vector $layout', ({ values, layout: expected }) => {
    expect(toHex(layout(...values.map(fromHex)))).toBe(expected);
  });

  it('gives different bytes to value lists that concatenate the same', () => {
    expect(toHex(layout(label('ab'), label('')))).not.toBe(toHex(layout(label('a'), label('b'))));
    expect(toHex(layout(label('ab')))).not.toBe(toHex(layout(label('a'), label('b'))));
  });

  it('encodes integers big-endian at fixed width', () => {
    expect(toHex(u8(0xab))).toBe('ab');
    expect(toHex(u16(0x0102))).toBe('0102');
    expect(toHex(u32(0x01020304))).toBe('01020304');
    expect(toHex(u64(Number.MAX_SAFE_INTEGER))).toBe('001fffffffffffff');
    expect(toHex(bool(true))).toBe('01');
    expect(toHex(bool(false))).toBe('00');
  });

  it.each([
    ['u8', () => u8(256)],
    ['u16', () => u16(0x10000)],
    ['u32', () => u32(2 ** 32)],
    ['u64', () => u64(Number.MAX_SAFE_INTEGER + 1)],
    ['negative', () => u32(-1)],
    ['fraction', () => u16(1.5)],
    ['NaN', () => u32(Number.NaN)],
  ])('rejects an out-of-range %s', (_name, encode) => {
    expect(encode).toThrow(EncodingError);
  });

  it('rejects a non-ASCII label and an ID that is not 16 bytes', () => {
    expect(() => label('bv.v1.é')).toThrow(EncodingError);
    expect(() => id(new Uint8Array(15))).toThrow(EncodingError);
    expect(() => id(new Uint8Array(17))).toThrow(EncodingError);
  });
});

describe('record AAD (crypto-spec.md §8, CRYPTO-INV-004)', () => {
  it.each(vectors.layout.recordAad)('reproduces vector with deleted=$deleted', (v) => {
    const aad = recordAad(
      {
        recordFormatVersion: v.recordFormatVersion,
        recordType: v.recordType,
        recordId: fromHex(v.recordId),
        keyEpoch: v.keyEpoch,
        hlc: hlcFromHex(v.hlc),
        deleted: v.deleted,
      },
      fromHex(v.vaultId),
    );
    expect(toHex(aad)).toBe(v.aad);
    expect(aad).toHaveLength(105);
  });

  it.each<[string, Partial<RecordHeader>]>([
    ['recordFormatVersion', { recordFormatVersion: 2 }],
    ['recordType', { recordType: 2 }],
    ['recordId', { recordId: new Uint8Array(16) }],
    ['keyEpoch', { keyEpoch: 2 }],
    ['hlc.physicalMs', { hlc: { ...header.hlc, physicalMs: header.hlc.physicalMs + 1 } }],
    ['hlc.counter', { hlc: { ...header.hlc, counter: header.hlc.counter + 1 } }],
    ['hlc.deviceId', { hlc: { ...header.hlc, deviceId: new Uint8Array(16) } }],
    ['deleted', { deleted: !header.deleted }],
  ])('changes when %s changes', (_field, change) => {
    expect(toHex(recordAad({ ...header, ...change }, vaultId))).not.toBe(
      toHex(recordAad(header, vaultId)),
    );
  });

  it('changes with the vaultId', () => {
    expect(toHex(recordAad(header, new Uint8Array(16)))).not.toBe(
      toHex(recordAad(header, vaultId)),
    );
  });

  it.each<[string, Partial<RecordHeader>]>([
    ['keyEpoch 0', { keyEpoch: 0 }],
    ['keyEpoch beyond u32', { keyEpoch: 2 ** 32 }],
    ['recordType beyond u16', { recordType: 0x10000 }],
    ['counter beyond u32', { hlc: { ...header.hlc, counter: 2 ** 32 } }],
    ['physicalMs beyond 2^53 − 1', { hlc: { ...header.hlc, physicalMs: 2 ** 53 } }],
    ['short deviceId', { hlc: { ...header.hlc, deviceId: new Uint8Array(8) } }],
    ['short recordId', { recordId: new Uint8Array(8) }],
  ])('rejects %s', (_name, change) => {
    expect(() => recordAad({ ...header, ...change }, vaultId)).toThrow(EncodingError);
  });
});

describe('local wrap AAD (crypto-spec.md §8, CRYPTO-INV-023)', () => {
  it.each(vectors.layout.localAad)('reproduces vector for $purpose', (v) => {
    const purpose = Object.values(LocalPurpose).find((p) => p === v.purpose);
    if (!purpose) throw new Error(`unknown purpose ${v.purpose}`);
    expect(toHex(localAad(purpose, fromHex(v.vaultId), fromHex(v.localConfigId)))).toBe(v.aad);
  });

  it('covers every purpose with a vector', () => {
    expect(vectors.layout.localAad.map((v) => v.purpose).sort()).toEqual(
      Object.values(LocalPurpose).sort(),
    );
  });
});
