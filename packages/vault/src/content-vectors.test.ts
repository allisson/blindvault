// record-content.md vectors (§10): every case decodes strictly, and the validators classify it as
// the generator's reference validator does.

import { beforeAll, describe, expect, it } from 'vitest';

import { type CborMap, decodeCbor, encodeCbor, initCrypto } from '@blindvault/crypto';

import vectors from '../test-vectors/content-v1.json' with { type: 'json' };
import { ContentInvalidError } from './errors';
import { deviceToCbor, folderToCbor, readDevice, readFolder } from './folder';
import { itemToCbor, readItem } from './item';
import {
  UnsupportedLocalConfigError,
  readLocalConfig,
  readLocalConfigEncrypted,
} from './local-config';

beforeAll(initCrypto);

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
}

const decode = (hex: string) => decodeCbor(fromHex(hex));

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

  it('covers every rule of section 2 for items, with unique case names', () => {
    const rules = new Set(vectors.items.flatMap((row) => ('rule' in row ? [row.rule] : [])));
    expect([...rules].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (const section of sections) {
      const names = vectors[section].map((row) => row.case);
      expect(new Set(names).size, section).toBe(names.length);
    }
  });
});

describe('Item content (§2–§5)', () => {
  it.each(vectors.items)('$case → $expected', (row) => {
    const reading = readItem(decode(row.cbor), row.deleted);
    if (row.expected === 'valid') {
      expect(reading.readOnly).toBe(false);
      if (!reading.readOnly) {
        // A valid item writes back to the same bytes.
        expect(encodeCbor(itemToCbor(reading.item, row.deleted))).toEqual(fromHex(row.cbor));
      }
    } else {
      expect(reading).toEqual({ readOnly: true, rule: 'rule' in row ? row.rule : undefined });
    }
  });

  it.each(vectors.itemVersions)('Item Version: $case → $expected', (row) => {
    const version = decode(row.cbor) as CborMap;
    const reading = readItem(version.get('item') ?? null, null);
    expect(reading.readOnly).toBe(row.expected === 'read-only');
    if (reading.readOnly) expect(reading.rule).toBe('rule' in row ? row.rule : undefined);
  });
});

describe('Folder and Device content (§6, §7, D59)', () => {
  it.each(vectors.folders)('folder: $case → $expected', (row) => {
    const content = decode(row.cbor);
    if (row.expected === 'invalid') {
      expect(() => readFolder(content, row.deleted)).toThrow(ContentInvalidError);
      return;
    }
    const kept = readFolder(content, row.deleted);
    expect(kept.unknownKeys).toEqual(row.unknownKeys);
    // Rewriting keeps every unknown key unchanged.
    expect(encodeCbor(folderToCbor(kept.value, row.deleted, kept.content))).toEqual(
      fromHex(row.cbor),
    );
  });

  it.each(vectors.devices)('device: $case → $expected', (row) => {
    const content = decode(row.cbor);
    if (row.expected === 'invalid') {
      expect(() => readDevice(content)).toThrow(ContentInvalidError);
      return;
    }
    const kept = readDevice(content);
    expect(kept.unknownKeys).toEqual(row.unknownKeys);
    expect(encodeCbor(deviceToCbor(kept.value, kept.content))).toEqual(fromHex(row.cbor));
  });
});

describe('Local Config content (§9)', () => {
  it.each(vectors.localConfig)('cleartext: $case → $expected', (row) => {
    const read = () => readLocalConfig(decode(row.cbor));
    if (row.expected === 'valid') expect(read).not.toThrow();
    else if (row.expected === 'unsupported-version')
      expect(read).toThrow(UnsupportedLocalConfigError);
    else {
      expect(read).toThrow(ContentInvalidError);
      expect(read).not.toThrow(UnsupportedLocalConfigError);
    }
  });

  it.each(vectors.localConfigEncrypted)('encrypted part: $case → $expected', (row) => {
    const read = () => readLocalConfigEncrypted(decode(row.cbor));
    if (row.expected === 'valid') expect(read).not.toThrow();
    else expect(read).toThrow(ContentInvalidError);
  });
});
