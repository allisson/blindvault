import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ImportRejectedError } from '../errors';
import { MAX_ZIP_ENTRIES, MAX_ZIP_SIZE, baseName, readText, readZip } from './zip';

/** The zip with the sizes its central directory declares rewritten, entry by entry. */
function declare(zip: Uint8Array, sizes: { size?: number; originalSize?: number }[]): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  let entry = 0;
  for (let i = 0; i + 4 <= out.length; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const { size, originalSize } = sizes[entry++] ?? {};
    if (size !== undefined) view.setUint32(i + 20, size, true);
    if (originalSize !== undefined) view.setUint32(i + 24, originalSize, true);
  }
  return out;
}

function refused(bytes: Uint8Array, reason: string) {
  expect(() => readZip(bytes)).toThrow(ImportRejectedError);
  try {
    readZip(bytes);
  } catch (e) {
    expect((e as ImportRejectedError).reason).toBe(reason);
  }
}

describe('zip reader', () => {
  it('reads every entry by name, deflated or stored', () => {
    const entries = readZip(
      zipSync({ 'a.txt': strToU8('hello'), 'dir/b.csv': [strToU8('a,b'), { level: 0 }] }),
    );
    expect([...entries.keys()]).toEqual(['a.txt', 'dir/b.csv']);
    expect(readText(entries.get('a.txt') ?? new Uint8Array())).toBe('hello');
    expect(readText(entries.get('dir/b.csv') ?? new Uint8Array())).toBe('a,b');
    expect(baseName('dir/b.csv')).toBe('b.csv');
    expect(baseName('a.txt')).toBe('a.txt');
  });

  it('refuses a file that is not a zip', () => {
    refused(new Uint8Array([0, 1, 2, 3, 4]), 'not-this-format');
    refused(strToU8('name,password\na,b'), 'not-this-format');
  });

  it('refuses an archive beyond 10,000 entries, and reads one at the cap (D130)', () => {
    const files = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i)}`, new Uint8Array()]));
    expect(readZip(zipSync(files(MAX_ZIP_ENTRIES))).size).toBe(MAX_ZIP_ENTRIES);
    refused(zipSync(files(MAX_ZIP_ENTRIES + 1)), 'too-large');
  });

  it('refuses an archive declaring more than 100 MB uncompressed, before inflating (D130)', () => {
    const half = MAX_ZIP_SIZE / 2;
    const two = zipSync({ a: strToU8('x'), b: strToU8('y') });
    // At the cap the entries inflate into buffers of the declared size, the data they hold.
    const read = readZip(declare(two, [{ originalSize: half }, { originalSize: half }]));
    expect(readText(read.get('a') ?? new Uint8Array())).toBe('x');
    refused(declare(two, [{ originalSize: half }, { originalSize: half + 1 }]), 'too-large');
    refused(
      declare(zipSync({ a: strToU8('x') }), [{ originalSize: MAX_ZIP_SIZE + 1 }]),
      'too-large',
    );
  });

  it('counts a stored entry at its compressed size, which entries can share', () => {
    const stored = zipSync({ a: [strToU8('x'), { level: 0 }] });
    refused(declare(stored, [{ size: MAX_ZIP_SIZE + 1 }]), 'too-large');
  });
});
