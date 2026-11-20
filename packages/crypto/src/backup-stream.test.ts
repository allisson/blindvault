// The backup stream and payload (backup-format.md §5, §6, D278). The PyNaCl vectors are opened in
// packages/backup, which owns the file format; these tests cover the module's own edges.

import { beforeAll, describe, expect, it } from 'vitest';

import {
  type BackupBlobReader,
  type BackupSource,
  BackupStreamWriter,
  CHUNK_LENGTH,
  readBackupStream,
  scanBackupStream,
} from './backup-stream';
import { MAX_BLOB_LENGTH, blobId, sealBlob } from './blob';
import { encodeCbor } from './cbor';
import { DecryptionError, EncodingError, KeyWipedError } from './errors';
import { Keyring, generateKey, keyBytes } from './keys';
import { initCrypto, lib } from './sodium';

beforeAll(initCrypto);

const FILE_HEADER = new Uint8Array([0x89, 0x42, 0x56, 0x41, 0x55, 0x4c, 0x54, 0x0a, 0, 1]);
const VAULT_ID = new Uint8Array(16).fill(0xa0);
const MAX_RECORD = 1_049_130;

function filler(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** Byte equality: `toEqual` walks a 1 MiB array element by element, too slow under coverage. */
function sameBytes(a: readonly Uint8Array[], b: readonly Uint8Array[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return y !== undefined && Buffer.compare(x, y) === 0;
    })
  );
}

/** A stream over an arbitrary payload, for shapes the writer never produces. */
function rawStream(
  fileKey: ReturnType<typeof generateKey>,
  payload: Uint8Array,
  tags?: number[],
): { header: Uint8Array; body: Uint8Array } {
  const sodium = lib();
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(
    keyBytes(fileKey),
  );
  const full = Math.floor(payload.length / CHUNK_LENGTH);
  const parts: Uint8Array[] = [];
  for (let i = 0; i <= full; i++) {
    const tag =
      tags?.[i] ??
      (i < full
        ? sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
        : sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL);
    const chunk = payload.subarray(
      i * CHUNK_LENGTH,
      Math.min(payload.length, (i + 1) * CHUNK_LENGTH),
    );
    parts.push(
      sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        chunk,
        i === 0 ? FILE_HEADER : null,
        tag,
      ),
    );
  }
  const body = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    body.set(p, pos);
    pos += p.length;
  }
  return { header, body };
}

function payloadOf(
  meta: Map<string, number | Uint8Array>,
  records: readonly Uint8Array[],
): Uint8Array {
  const parts = [encodeCbor(meta), ...records];
  const out = new Uint8Array(parts.reduce((s, p) => s + 4 + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    new DataView(out.buffer).setUint32(pos, p.length);
    out.set(p, pos + 4);
    pos += 4 + p.length;
  }
  return out;
}

function meta(
  over: Record<string, number | Uint8Array | undefined> = {},
): Map<string, number | Uint8Array> {
  const m = new Map<string, number | Uint8Array>([
    ['exportedAt', 1],
    ['masterKey', new Uint8Array(32).fill(1)],
    ['recordCount', 1],
    ['vaultId', VAULT_ID],
  ]);
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) m.delete(k);
    else m.set(k, v);
  }
  return m;
}

// --- version 2, in parts and in two passes ------------------------------------------------------

const FULL_CHUNK = CHUNK_LENGTH + 17;
const EXPORTED_AT = 1_760_000_100_000;
type Key = ReturnType<typeof generateKey>;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function source(bytes: Uint8Array): BackupSource {
  return { size: bytes.length, read: (o, l) => Promise.resolve(bytes.slice(o, o + l)) };
}

function blob(size: number): Uint8Array {
  return sealBlob(filler(size)).blob;
}

interface SealedV2 {
  keyring: Keyring;
  fileKey: Key;
  masterKey: Key;
  header: Uint8Array;
  file: Uint8Array;
  chunks: Uint8Array[];
}

function sealedV2(
  records: readonly Uint8Array[],
  blobs: readonly Uint8Array[],
  keys: { keyring?: Keyring; fileKey?: Key; masterKey?: Key } = {},
): SealedV2 {
  const keyring = keys.keyring ?? new Keyring();
  const fileKey = keys.fileKey ?? generateKey(keyring);
  const masterKey = keys.masterKey ?? generateKey(keyring);
  const writer = BackupStreamWriter.create(fileKey);
  const chunks = writer.begin(FILE_HEADER, {
    vaultId: VAULT_ID,
    exportedAt: EXPORTED_AT,
    masterKey,
    recordCount: records.length,
    blobCount: blobs.length,
  });
  for (const part of [...records, ...blobs]) chunks.push(...writer.add(part));
  chunks.push(...writer.end());
  return {
    keyring,
    fileKey,
    masterKey,
    header: writer.header,
    file: concat([FILE_HEADER, ...chunks]),
    chunks,
  };
}

async function blobsOf(reader: BackupBlobReader) {
  const out: { blobId: Uint8Array; blob: Uint8Array }[] = [];
  for (let b = await reader.next(); b; b = await reader.next()) out.push(b);
  return out;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('accepted');
}

/** A version-2 file over an arbitrary payload, for shapes the writer never produces. */
function rawFile(fileKey: Key, payload: Uint8Array): { header: Uint8Array; file: Uint8Array } {
  const { header, body } = rawStream(fileKey, payload);
  return { header, file: concat([FILE_HEADER, body]) };
}

const meta2 = (over: Record<string, number | Uint8Array | undefined> = {}) =>
  meta({ blobCount: 0, ...over });

describe('backup stream in parts and in two passes (backup-format.md §5, §6, D278)', () => {
  it('round-trips envelopes and blobs, one blob over a chunk, and hands the blobs in order', async () => {
    const records = [filler(100), filler(MAX_RECORD, 3)];
    const blobs = [blob(3), blob(70_000), blob(5)];
    const s = sealedV2(records, blobs);
    const scan = await scanBackupStream(s.fileKey, 2, s.header, FILE_HEADER, source(s.file));
    expect(scan.blobIds).toEqual(blobs.map(blobId));
    const target = new Keyring();
    const read = await readBackupStream(
      target,
      s.fileKey,
      scan,
      s.header,
      FILE_HEADER,
      source(s.file),
    );
    expect(sameBytes(read.records, records)).toBe(true);
    expect(read.vaultId).toEqual(VAULT_ID);
    expect(read.exportedAt).toBe(EXPORTED_AT);
    expect(keyBytes(read.masterKey)).toEqual(keyBytes(s.masterKey));
    expect(target.size).toBe(1);
    const got = await blobsOf(read.blobs);
    expect(got.map((b) => b.blobId)).toEqual(scan.blobIds);
    expect(
      sameBytes(
        got.map((b) => b.blob),
        blobs,
      ),
    ).toBe(true);
    expect(await read.blobs.next()).toBeUndefined();
  });

  it('closes each chunk as it fills, and only those', () => {
    const keyring = new Keyring();
    const writer = BackupStreamWriter.create(generateKey(keyring));
    const meta = { vaultId: VAULT_ID, exportedAt: 1, masterKey: generateKey(keyring) };
    expect(writer.begin(FILE_HEADER, { ...meta, recordCount: 1, blobCount: 1 })).toEqual([]);
    const full = writer.add(filler(MAX_RECORD));
    expect(full).toHaveLength(Math.floor(MAX_RECORD / CHUNK_LENGTH));
    expect(full.every((c) => c.length === FULL_CHUNK)).toBe(true);
    expect(writer.add(blob(3))).toEqual([]);
    const [final, ...rest] = writer.end();
    expect(rest).toEqual([]);
    expect(final?.length).toBeLessThan(FULL_CHUNK);
  });

  it('ends an exact multiple of the chunk length with an empty final chunk', async () => {
    const metaLength = encodeCbor(
      meta2({ exportedAt: EXPORTED_AT, masterKey: new Uint8Array(32) }),
    ).length;
    const record = filler(CHUNK_LENGTH - 4 - metaLength - 4);
    const s = sealedV2([record], []);
    expect(s.chunks.map((c) => c.length)).toEqual([FULL_CHUNK, 17]);
    const scan = await scanBackupStream(s.fileKey, 2, s.header, FILE_HEADER, source(s.file));
    const read = await readBackupStream(
      s.keyring,
      s.fileKey,
      scan,
      s.header,
      FILE_HEADER,
      source(s.file),
    );
    expect(sameBytes(read.records, [record])).toBe(true);
    expect(await read.blobs.next()).toBeUndefined();
  });

  it('round-trips a payload with no record and no blob', async () => {
    const s = sealedV2([], []);
    const scan = await scanBackupStream(s.fileKey, 2, s.header, FILE_HEADER, source(s.file));
    expect(scan.blobIds).toEqual([]);
    const read = await readBackupStream(
      s.keyring,
      s.fileKey,
      scan,
      s.header,
      FILE_HEADER,
      source(s.file),
    );
    expect(read.records).toEqual([]);
    expect(await read.blobs.next()).toBeUndefined();
  });

  it('reads a version-1 payload, and each version only with its own meta keys', async () => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const v1 = rawFile(fileKey, payloadOf(meta(), [filler(10)]));
    const scan = await scanBackupStream(fileKey, 1, v1.header, FILE_HEADER, source(v1.file));
    expect(scan.blobIds).toEqual([]);
    const read = await readBackupStream(
      keyring,
      fileKey,
      scan,
      v1.header,
      FILE_HEADER,
      source(v1.file),
    );
    expect(sameBytes(read.records, [filler(10)])).toBe(true);
    expect(await read.blobs.next()).toBeUndefined();

    const scanOf = (version: number, payload: Uint8Array) => {
      const f = rawFile(fileKey, payload);
      return rejection(scanBackupStream(fileKey, version, f.header, FILE_HEADER, source(f.file)));
    };
    expect(await scanOf(1, payloadOf(meta2(), [filler(10)]))).toBeInstanceOf(EncodingError);
    expect(await scanOf(2, payloadOf(meta(), [filler(10)]))).toBeInstanceOf(EncodingError);
    expect(await scanOf(3, payloadOf(meta2(), [filler(10)]))).toBeInstanceOf(EncodingError);
    expect(await scanOf(0, payloadOf(meta(), [filler(10)]))).toBeInstanceOf(EncodingError);
  });

  it.each([
    ['the same blob twice', () => payloadOf(meta2({ blobCount: 2 }), [filler(10), ...twice()])],
    ['a blob of 41 bytes', () => payloadOf(meta2({ blobCount: 1 }), [filler(10), filler(41)])],
    [
      'a blob length prefix one above the largest blob',
      () => concat([payloadOf(meta2({ blobCount: 1 }), [filler(10)]), u32(MAX_BLOB_LENGTH + 1)]),
    ],
    ['blobCount one too high', () => payloadOf(meta2({ blobCount: 2 }), [filler(10), blob(3)])],
    ['blobCount one too low', () => payloadOf(meta2({ blobCount: 0 }), [filler(10), blob(3)])],
    [
      'a byte after the last blob',
      () => concat([payloadOf(meta2({ blobCount: 1 }), [filler(10), blob(3)]), new Uint8Array(1)]),
    ],
    [
      'a blob length past the payload',
      () => payloadOf(meta2({ blobCount: 1 }), [filler(10), blob(3)]).slice(0, -1),
    ],
    ['a record of length 0', () => payloadOf(meta2(), [new Uint8Array(0)])],
    ['a record above the largest envelope', () => payloadOf(meta2(), [filler(MAX_RECORD + 1)])],
    ['blobCount negative', () => payloadOf(meta2({ blobCount: -1 }), [filler(10)])],
    [
      'a meta longer than 256 bytes',
      () => payloadOf(meta2({ masterKey: new Uint8Array(300) }), []),
    ],
  ])('the first pass rejects an authenticated payload with %s', async (_, payload) => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const f = rawFile(fileKey, payload());
    expect(
      await rejection(scanBackupStream(fileKey, 2, f.header, FILE_HEADER, source(f.file))),
    ).toBeInstanceOf(EncodingError);
  });

  it('a stream that fails to authenticate wins over a payload of the wrong shape (D95)', async () => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    // A record of length 0, found in the first chunk; the last chunk is cut.
    const f = rawFile(
      fileKey,
      payloadOf(meta2({ recordCount: 2 }), [new Uint8Array(0), filler(70_000)]),
    );
    const cut = f.file.slice(0, -1);
    expect(
      await rejection(scanBackupStream(fileKey, 2, f.header, FILE_HEADER, source(cut))),
    ).toBeInstanceOf(DecryptionError);
  });

  it('the first pass rejects truncation, trailing bytes, another file header and a short read', async () => {
    const s = sealedV2([filler(10)], [blob(70_000)]);
    const scan = (file: Uint8Array, fileHeader = FILE_HEADER, src = source(file)) =>
      rejection(scanBackupStream(s.fileKey, 2, s.header, fileHeader, src));
    const other = FILE_HEADER.slice();
    other[9] = 2;
    const cases = [
      await scan(s.file.slice(0, -1)),
      await scan(concat([s.file, new Uint8Array(1)])),
      await scan(s.file.slice(0, FILE_HEADER.length + FULL_CHUNK)),
      await scan(s.file.slice(0, FILE_HEADER.length + 16)),
      await scan(s.file, other),
      await scan(s.file, FILE_HEADER, {
        size: s.file.length,
        read: (o, l) => Promise.resolve(s.file.slice(o, o + l - 1)),
      }),
    ];
    for (const error of cases) expect(error).toBeInstanceOf(DecryptionError);
    expect(
      await rejection(
        scanBackupStream(s.fileKey, 2, s.header.subarray(1), FILE_HEADER, source(s.file)),
      ),
    ).toBeInstanceOf(DecryptionError);
  });

  it('the second pass refuses envelopes that changed after the first, and keeps no key', async () => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const a = sealedV2([filler(100, 1)], [], { keyring, fileKey, masterKey });
    const b = sealedV2([filler(100, 2)], [], { keyring, fileKey, masterKey });
    const scan = await scanBackupStream(fileKey, 2, a.header, FILE_HEADER, source(a.file));
    const target = new Keyring();
    // Another file under the same file key: it authenticates, its envelopes differ.
    expect(
      await rejection(
        readBackupStream(target, fileKey, scan, b.header, FILE_HEADER, source(b.file)),
      ),
    ).toBeInstanceOf(DecryptionError);
    const flipped = a.file.slice();
    flipped[flipped.length - 20] = (flipped[flipped.length - 20] ?? 0) ^ 1;
    expect(
      await rejection(
        readBackupStream(target, fileKey, scan, a.header, FILE_HEADER, source(flipped)),
      ),
    ).toBeInstanceOf(DecryptionError);
    expect(
      await rejection(
        readBackupStream(target, fileKey, scan, a.header, FILE_HEADER, source(a.file.slice(0, -1))),
      ),
    ).toBeInstanceOf(DecryptionError);
    expect(target.size).toBe(0);
  });

  it('the second pass refuses a file of another size before handing any envelope', async () => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const a = sealedV2([filler(100)], [blob(10)], { keyring, fileKey, masterKey });
    const b = sealedV2([filler(100)], [blob(20)], { keyring, fileKey, masterKey });
    const scan = await scanBackupStream(fileKey, 2, a.header, FILE_HEADER, source(a.file));
    expect(
      await rejection(
        readBackupStream(keyring, fileKey, scan, b.header, FILE_HEADER, source(b.file)),
      ),
    ).toBeInstanceOf(DecryptionError);
  });

  it('the blob reader checks the end of the payload after the last blob', async () => {
    // The last blob ends the first chunk exactly, so the empty final chunk is pulled at the end.
    const metaLength = encodeCbor(
      meta2({ exportedAt: EXPORTED_AT, masterKey: new Uint8Array(32), blobCount: 1 }),
    ).length;
    const b = blob(3);
    const record = filler(CHUNK_LENGTH - 4 - metaLength - 4 - 4 - b.length);
    const s = sealedV2([record], [b]);
    expect(s.chunks.map((c) => c.length)).toEqual([FULL_CHUNK, 17]);
    const scan = await scanBackupStream(s.fileKey, 2, s.header, FILE_HEADER, source(s.file));
    const damaged = s.file.slice();
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1;
    const read = await readBackupStream(
      s.keyring,
      s.fileKey,
      scan,
      s.header,
      FILE_HEADER,
      source(damaged),
    );
    expect((await read.blobs.next())?.blobId).toEqual(blobId(b));
    expect(await rejection(read.blobs.next())).toBeInstanceOf(DecryptionError);
  });

  it('the blob reader stops at a blob that changed after the first pass, for good', async () => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const records = [filler(100)];
    const a = sealedV2(records, [blob(10), blob(70_000)], { keyring, fileKey, masterKey });
    const b = sealedV2(records, [blob(10), blob(70_000)], { keyring, fileKey, masterKey });
    const scan = await scanBackupStream(fileKey, 2, a.header, FILE_HEADER, source(a.file));
    // Same envelopes, other blobs: the records pass, the first blob does not.
    const read = await readBackupStream(
      keyring,
      fileKey,
      scan,
      b.header,
      FILE_HEADER,
      source(b.file),
    );
    expect(sameBytes(read.records, records)).toBe(true);
    expect(await rejection(read.blobs.next())).toBeInstanceOf(DecryptionError);
    expect(await rejection(read.blobs.next())).toBeInstanceOf(DecryptionError);

    // The last chunk damaged after the first pass: the first blob comes, the second does not.
    const damaged = a.file.slice();
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1;
    const late = await readBackupStream(
      keyring,
      fileKey,
      scan,
      a.header,
      FILE_HEADER,
      source(damaged),
    );
    expect((await late.blobs.next())?.blobId).toEqual(scan.blobIds[0]);
    expect(await rejection(late.blobs.next())).toBeInstanceOf(DecryptionError);
  });

  it('a wiped file key is KeyWipedError, never a damaged file', async () => {
    const s = sealedV2([filler(10)], []);
    const scan = await scanBackupStream(s.fileKey, 2, s.header, FILE_HEADER, source(s.file));
    s.keyring.wipeAll();
    for (const p of [
      scanBackupStream(s.fileKey, 2, s.header, FILE_HEADER, source(s.file)),
      readBackupStream(new Keyring(), s.fileKey, scan, s.header, FILE_HEADER, source(s.file)),
    ]) {
      expect(await rejection(p)).toBeInstanceOf(KeyWipedError);
    }
  });

  it('binds the first chunk to the file header and the stream to its file key', async () => {
    const s = sealedV2([filler(10)], []);
    const scan = (fileKey: Key, header: Uint8Array) =>
      rejection(scanBackupStream(fileKey, 2, header, FILE_HEADER, source(s.file)));
    const flipped = s.header.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(await scan(generateKey(s.keyring), s.header)).toBeInstanceOf(DecryptionError);
    expect(await scan(s.fileKey, flipped)).toBeInstanceOf(DecryptionError);
    expect(
      await rejection(scanBackupStream(s.fileKey, 2, s.header, new Uint8Array(0), source(s.file))),
    ).toBeInstanceOf(DecryptionError);
  });

  it('rejects every tag but MESSAGE on full chunks and FINAL on the last', async () => {
    const sodium = lib();
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const one = payloadOf(meta2(), [filler(10)]);
    const two = payloadOf(meta2(), [filler(70_000)]);
    const cases: [Uint8Array, number[]][] = [
      [one, [sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE]],
      [one, [sodium.crypto_secretstream_xchacha20poly1305_TAG_PUSH]],
      [one, [sodium.crypto_secretstream_xchacha20poly1305_TAG_REKEY]],
      [two, [sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL]],
      [two, [sodium.crypto_secretstream_xchacha20poly1305_TAG_PUSH]],
    ];
    for (const [payload, tags] of cases) {
      const { header, body } = rawStream(fileKey, payload, tags);
      const file = concat([FILE_HEADER, body]);
      expect(
        await rejection(scanBackupStream(fileKey, 2, header, FILE_HEADER, source(file))),
      ).toBeInstanceOf(DecryptionError);
    }
  });

  it.each([
    ['an unknown meta key', () => payloadOf(meta2({ note: 1 }), [filler(10)])],
    ['a missing meta key', () => payloadOf(meta2({ exportedAt: undefined }), [filler(10)])],
    [
      'a Master Key of 31 bytes',
      () => payloadOf(meta2({ masterKey: new Uint8Array(31) }), [filler(10)]),
    ],
    [
      'a vaultId of 15 bytes',
      () => payloadOf(meta2({ vaultId: new Uint8Array(15) }), [filler(10)]),
    ],
    ['exportedAt above 2^53 - 1', () => payloadOf(meta2({ exportedAt: 2 ** 53 }), [filler(10)])],
    ['recordCount one too high', () => payloadOf(meta2({ recordCount: 2 }), [filler(10)])],
    ['recordCount one too low', () => payloadOf(meta2({ recordCount: 0 }), [filler(10)])],
    ['a payload of 2 bytes', () => new Uint8Array([0, 1])],
  ])('the first pass rejects an authenticated meta with %s', async (_, payload) => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const f = rawFile(fileKey, payload());
    expect(
      await rejection(scanBackupStream(fileKey, 2, f.header, FILE_HEADER, source(f.file))),
    ).toBeInstanceOf(EncodingError);
    expect(keyring.size).toBe(1);
  });

  it('refuses a writer under a wiped file key', () => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    keyring.wipeAll();
    expect(() => BackupStreamWriter.create(fileKey)).toThrow(KeyWipedError);
  });

  it('writes parts only in the order and number meta counts', () => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const ok = { vaultId: VAULT_ID, exportedAt: 1, masterKey, recordCount: 1, blobCount: 1 };
    const open = () => {
      const w = BackupStreamWriter.create(fileKey);
      w.begin(FILE_HEADER, ok);
      return w;
    };
    const refusals: [string, () => unknown][] = [
      ['add before begin', () => BackupStreamWriter.create(fileKey).add(filler(10))],
      ['end before begin', () => BackupStreamWriter.create(fileKey).end()],
      ['begin twice', () => open().begin(FILE_HEADER, ok)],
      [
        'an empty file header',
        () => BackupStreamWriter.create(fileKey).begin(new Uint8Array(0), ok),
      ],
      [
        'a vaultId of 15 bytes',
        () =>
          BackupStreamWriter.create(fileKey).begin(FILE_HEADER, {
            ...ok,
            vaultId: new Uint8Array(15),
          }),
      ],
      [
        'exportedAt -1',
        () => BackupStreamWriter.create(fileKey).begin(FILE_HEADER, { ...ok, exportedAt: -1 }),
      ],
      [
        'recordCount 1.5',
        () => BackupStreamWriter.create(fileKey).begin(FILE_HEADER, { ...ok, recordCount: 1.5 }),
      ],
      [
        'blobCount 2^53',
        () => BackupStreamWriter.create(fileKey).begin(FILE_HEADER, { ...ok, blobCount: 2 ** 53 }),
      ],
      ['a record of length 0', () => open().add(new Uint8Array(0))],
      ['a record above the largest envelope', () => open().add(filler(MAX_RECORD + 1))],
      [
        'a blob of 41 bytes',
        () => {
          const w = open();
          w.add(filler(10));
          w.add(filler(41));
        },
      ],
      [
        'a blob above the largest blob',
        () => {
          const w = open();
          w.add(filler(10));
          w.add(new Uint8Array(MAX_BLOB_LENGTH + 1));
        },
      ],
      [
        'a part past the counts',
        () => {
          const w = open();
          w.add(filler(10));
          w.add(blob(3));
          w.add(blob(3));
        },
      ],
      [
        'end before every part',
        () => {
          const w = open();
          w.add(filler(10));
          w.end();
        },
      ],
      [
        'a part after end',
        () => {
          const w = BackupStreamWriter.create(fileKey);
          w.begin(FILE_HEADER, { ...ok, recordCount: 0, blobCount: 0 });
          w.end();
          w.add(filler(10));
        },
      ],
      [
        'a part after wipe',
        () => {
          const w = open();
          w.wipe();
          w.add(filler(10));
        },
      ],
    ];
    for (const [name, fn] of refusals) {
      expect(fn, name).toThrow(EncodingError);
    }
  });
});

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function twice(): Uint8Array[] {
  const b = blob(3);
  return [b, b];
}
