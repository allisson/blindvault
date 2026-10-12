// The record-content.md vectors decode under the strict CBOR rules of crypto-spec.md §14, so the
// content validators can trust their bytes. The validators themselves come with their own tests.

import { beforeAll, describe, expect, it } from 'vitest';

import { decodeCbor, encodeCbor, initCrypto } from '@blindvault/crypto';

import vectors from '../test-vectors/content-v1.json' with { type: 'json' };

beforeAll(initCrypto);

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
}

const sections = [
  'items',
  'itemVersions',
  'folders',
  'devices',
  'localConfig',
  'localConfigEncrypted',
] as const;

describe('record-content.md vectors', () => {
  it.each(sections)('%s decode strictly and re-encode to the same bytes', (section) => {
    const rows: readonly { case: string; cbor: string }[] = vectors[section];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const bytes = fromHex(row.cbor);
      expect(encodeCbor(decodeCbor(bytes)), row.case).toEqual(bytes);
    }
  });

  it('covers every rule of section 2 for items', () => {
    const rules = new Set(vectors.items.flatMap((row) => ('rule' in row ? [row.rule] : [])));
    expect([...rules].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('has unique case names per section', () => {
    for (const section of sections) {
      const names = vectors[section].map((row) => row.case);
      expect(new Set(names).size, section).toBe(names.length);
    }
  });
});
