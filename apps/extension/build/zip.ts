// A reproducible ZIP archive of the extension (extension.md §2, D189): files only, in byte order of
// their UTF-8 paths, stored without compression so the bytes depend on no zlib version, each dated
// 1980-01-01 00:00 with mode 0644. Written here, since the format needs no more than this.

import { crc32 } from 'node:zlib';

export interface ZipEntry {
  /** Relative, with `/` separators. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

const VERSION = 20;
/** The name is UTF-8. */
const UTF8 = 0x0800;
const STORED = 0;
/** 1980-01-01, the first day a DOS date can hold. */
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;
/** Made on Unix, so the mode in the external attributes counts. */
const MADE_BY = (3 << 8) | VERSION;
const MODE = 0o100644;
const MAX32 = 0xffffffff;

function checkPath(path: string): void {
  const parts = path.split('/');
  if (
    path === '' ||
    path.includes('\\') ||
    path.includes('\0') ||
    parts.some((p) => p === '' || p === '.' || p === '..')
  ) {
    throw new Error(`zip: path ${JSON.stringify(path)} is not a relative file path`);
  }
}

export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const sorted = entries
    .map((e) => {
      checkPath(e.path);
      return { ...e, name: Buffer.from(e.path, 'utf8') };
    })
    .sort((a, b) => Buffer.compare(a.name, b.name));
  sorted.forEach((e, i) => {
    if (i > 0 && sorted[i - 1]?.path === e.path) throw new Error(`zip: duplicate path ${e.path}`);
  });
  if (sorted.length > 0xffff) throw new Error('zip: too many files');

  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of sorted) {
    if (e.bytes.length > MAX32) throw new Error(`zip: ${e.path} is too large`);
    const crc = crc32(e.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(UTF8, 6);
    header.writeUInt16LE(STORED, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(e.bytes.length, 18);
    header.writeUInt32LE(e.bytes.length, 22);
    header.writeUInt16LE(e.name.length, 26);
    header.writeUInt16LE(0, 28);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(MADE_BY, 4);
    record.writeUInt16LE(VERSION, 6);
    record.writeUInt16LE(UTF8, 8);
    record.writeUInt16LE(STORED, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(e.bytes.length, 20);
    record.writeUInt32LE(e.bytes.length, 24);
    record.writeUInt16LE(e.name.length, 28);
    // Extra field, comment, disk number and internal attributes: none.
    record.writeUInt32LE((MODE << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);

    local.push(header, e.name, Buffer.from(e.bytes));
    central.push(record, e.name);
    offset += header.length + e.name.length + e.bytes.length;
    if (offset > MAX32) throw new Error('zip: the archive is too large');
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, directory, end]));
}
