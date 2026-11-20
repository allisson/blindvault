import {
  ACCEPTED_KDF_RANGE,
  type BackupSource,
  CHUNK_LENGTH,
  DecryptionError,
  Keyring,
  MAX_BLOB_LENGTH,
  MIN_BLOB_LENGTH,
  generateKey,
  KeyWipedError,
  initCrypto,
  randomBytes,
  sealBlob,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { BackupRejectedError } from './errors';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_MAGIC,
  type BackupHeader,
  EXPORT_KDF,
  MAX_HEADER_LENGTH,
  type OpenedBackup,
  type PasswordKeyslot,
  type RecoveryKeyslot,
  bytesSource,
  encodeHeader,
  openBackup,
  parseBackup,
  sealBackup,
} from './format';
import {
  VECTOR_SETS,
  blake2b512,
  concat,
  fromBase64,
  fromHex,
  rejectedFile,
  validFile,
  vectors,
} from './test-helpers';

beforeAll(initCrypto);

const FULL_CHUNK = CHUNK_LENGTH + 17;

function fileKey(keyring: Keyring) {
  // The vectors' fixed file key; a real one comes only from a keyslot or `generateKey`.
  return keyring.adopt(fromHex(vectors.inputs.fileKey));
}

async function reason(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof BackupRejectedError) return error.reason;
    throw error;
  }
  throw new Error('accepted');
}

async function blobsOf(opened: OpenedBackup) {
  const out: { blobId: Uint8Array; blob: Uint8Array }[] = [];
  for (let b = await opened.blobs.next(); b; b = await opened.blobs.next()) out.push(b);
  return out;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A source over `bytes` that hands the reads to `onRead` first. */
function watched(bytes: Uint8Array, onRead: (offset: number, length: number) => void) {
  const source: BackupSource = {
    size: bytes.length,
    read: (offset, length) => {
      onRead(offset, length);
      return Promise.resolve(bytes.slice(offset, offset + length));
    },
  };
  return source;
}

/** A source that serves `after` once the first pass has read the end of `before`. */
function changing(before: Uint8Array, after: Uint8Array): BackupSource {
  let current = before;
  return {
    size: before.length,
    read: (offset, length) => {
      const out = current.slice(offset, offset + length);
      if (offset + length === before.length) current = after;
      return Promise.resolve(out);
    },
  };
}

// Fixed bytes, not randomBytes: the `it.each` tables below are built before `initCrypto`.
const recovery = (): RecoveryKeyslot => ({ type: 'recovery', sealed: new Uint8Array(80).fill(1) });
const password = (): PasswordKeyslot => ({
  type: 'password',
  salt: new Uint8Array(16).fill(2),
  opslimit: EXPORT_KDF.opslimit,
  memlimit: EXPORT_KDF.memlimit,
  wrap: { n: new Uint8Array(24).fill(3), c: new Uint8Array(48).fill(4) },
});

describe('.bvault constants (backup-format.md §2, §4, §6)', () => {
  it('matches the generator, and writes version 2', () => {
    expect(BACKUP_MAGIC).toEqual(fromHex(vectors.constants.magic));
    expect(BACKUP_FORMAT_VERSION).toBe(2);
    expect(BACKUP_FORMAT_VERSION).toBe(vectors.constants.formatVersion);
    expect(MAX_HEADER_LENGTH).toBe(vectors.constants.maxHeaderLength);
    expect(MIN_BLOB_LENGTH).toBe(vectors.constants.minBlobLength);
    expect(MAX_BLOB_LENGTH).toBe(vectors.constants.maxBlobLength);
    expect(EXPORT_KDF).toEqual(vectors.constants.export);
  });

  it('exports at parameters a restore accepts (D78)', () => {
    expect(EXPORT_KDF.memlimit).toBe(ACCEPTED_KDF_RANGE.memlimit[0]);
    expect(EXPORT_KDF.opslimit).toBeGreaterThanOrEqual(ACCEPTED_KDF_RANGE.opslimit[0]);
    expect(EXPORT_KDF.opslimit).toBeLessThanOrEqual(ACCEPTED_KDF_RANGE.opslimit[1]);
  });
});

describe.each(VECTOR_SETS)('.bvault %s vectors (backup-format.md §9)', (_, set) => {
  const version = set.constants.formatVersion;

  it.each(set.valid.map((v) => [v.case, v] as const))('opens a file with %s', async (_, v) => {
    const file = fromBase64(v.file);
    const parsed = await parseBackup(file);
    expect(parsed.version).toBe(version);
    expect(parsed.headerBytes).toEqual(file.subarray(0, v.headerLength));
    expect(parsed.header.phraseId).toEqual(fromHex(v.header.phraseId));
    expect(parsed.header.phraseCreatedAt).toBe(v.header.phraseCreatedAt);
    expect(parsed.header.stream).toEqual(fromHex(v.header.stream));
    const [rec, pw] = v.header.keyslots;
    expect(parsed.header.keyslots[0]).toEqual({ type: 'recovery', sealed: fromHex(rec?.c ?? '') });
    if (pw && 'salt' in pw) {
      expect(parsed.header.keyslots[1]).toEqual({
        type: 'password',
        salt: fromHex(pw.salt),
        opslimit: pw.ops,
        memlimit: pw.mem,
        wrap: { n: fromHex(pw.n ?? ''), c: fromHex(pw.c) },
      });
    } else {
      expect(parsed.header.keyslots).toHaveLength(1);
    }
    // The header re-encodes to the bytes the first chunk authenticated, but for the version this
    // app writes.
    const encoded = encodeHeader(parsed.header);
    expect(encoded.subarray(10)).toEqual(parsed.headerBytes.subarray(10));
    expect(version === 2 ? encoded : parsed.headerBytes).toEqual(parsed.headerBytes);

    const keyring = new Keyring();
    const opened = await openBackup(keyring, fileKey(keyring), parsed);
    expect(opened.vaultId).toEqual(fromHex(v.meta.vaultId));
    expect(opened.exportedAt).toBe(v.meta.exportedAt);
    expect(opened.records.map((r) => ({ length: r.length, blake2b512: blake2b512(r) }))).toEqual(
      v.records,
    );
    expect(opened.records).toHaveLength(v.meta.recordCount);
    const blobs = 'blobs' in v ? v.blobs : [];
    expect(opened.blobIds.map(hex)).toEqual(blobs.map((b) => b.blobId));
    const read = await blobsOf(opened);
    expect(read.map((b) => ({ length: b.blob.length, blobId: hex(b.blobId) }))).toEqual(
      blobs.map((b) => ({ length: b.length, blobId: b.blobId })),
    );
    expect(await opened.blobs.next()).toBeUndefined();
  });

  it.each(set.rejectHeader.map((v) => [v.case, v] as const))(
    'rejects before any key: %s',
    async (_, v) => {
      expect(await reason(() => parseBackup(fromBase64(v.file)))).toBe(v.reason);
    },
  );

  it.each(set.rejectStream.map((v) => [v.case, v] as const))(
    'rejects once the file key is known: %s',
    async (_, v) => {
      const parsed = await parseBackup(rejectedFile(v, set));
      const keyring = new Keyring();
      expect(await reason(() => openBackup(keyring, fileKey(keyring), parsed))).toBe(v.reason);
      // Only the file key is in the keyring: no Master Key was adopted.
      expect(keyring.size).toBe(1);
    },
  );
});

describe('reading a file by ranges, in two passes (backup-format.md §6, §8 steps 4 and 5, D278)', () => {
  it('never reads the file whole, nor more than a chunk at a time', async () => {
    const file = validFile('blobs');
    const reads: number[] = [];
    const source = watched(file, (_, length) => reads.push(length));
    const keyring = new Keyring();
    const opened = await openBackup(keyring, fileKey(keyring), await parseBackup(source));
    await blobsOf(opened);
    expect(Math.max(...reads)).toBeLessThanOrEqual(FULL_CHUNK);
    // The header once, then every chunk in each pass.
    const chunks = vectors.valid.find((v) => v.name === 'blobs')?.chunks ?? 0;
    expect(reads).toHaveLength(2 + 2 * chunks);
  });

  it('rejects a header the source cuts short, before any key', async () => {
    const file = validFile('bothKeyslots');
    const short = (cut: number): BackupSource => ({
      size: file.length,
      read: (offset, length) => Promise.resolve(file.slice(offset, offset + length - cut)),
    });
    expect(await reason(() => parseBackup(short(1)))).toBe('malformed');
    const long: BackupSource = {
      size: file.length,
      read: (offset, length) => Promise.resolve(file.slice(offset, offset + length + 1)),
    };
    expect(await reason(() => parseBackup(long))).toBe('malformed');
  });

  it('rejects as corrupt envelopes changed after the first pass, keeping no Master Key', async () => {
    const file = validFile('twoChunks');
    const parsed = await parseBackup(file);
    const changed = file.slice();
    const at = parsed.headerBytes.length + 100;
    changed[at] = (changed[at] ?? 0) ^ 1;
    const keyring = new Keyring();
    const key = fileKey(keyring);
    const source = changing(file, changed);
    expect(await reason(() => openBackup(keyring, key, { ...parsed, source }))).toBe('corrupt');
    expect(keyring.size).toBe(1);
  });

  it('stops the blobs as corrupt when the file changed after the first pass, for good', async () => {
    const file = validFile('blobs');
    const parsed = await parseBackup(file);
    const changed = file.slice();
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    const keyring = new Keyring();
    const opened = await openBackup(keyring, fileKey(keyring), {
      ...parsed,
      source: changing(file, changed),
    });
    expect(opened.records).toHaveLength(5);
    // The blobs held by the first chunk come; the rest stops at the changed last chunk.
    const got: string[] = [];
    let error: unknown;
    try {
      for (let b = await opened.blobs.next(); b; b = await opened.blobs.next()) {
        got.push(hex(b.blobId));
      }
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BackupRejectedError);
    expect((error as BackupRejectedError).reason).toBe('corrupt');
    expect(got.length).toBeLessThan(opened.blobIds.length);
    expect(await reason(() => opened.blobs.next())).toBe('corrupt');
  });

  it('reads a file already in memory by slices', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const source = bytesSource(bytes);
    expect(source.size).toBe(4);
    const slice = await source.read(1, 2);
    expect(slice).toEqual(new Uint8Array([2, 3]));
    slice[0] = 9;
    expect(bytes[1]).toBe(2);
  });
});

describe('sealBackup', () => {
  async function sealed(
    keyslots: readonly [RecoveryKeyslot] | readonly [RecoveryKeyslot, PasswordKeyslot],
    records: Uint8Array[],
    blobs: Uint8Array[],
  ) {
    const keyring = new Keyring();
    const key = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const header = { phraseId: randomBytes(16), phraseCreatedAt: 1_760_000_000_000, keyslots };
    const vaultId = randomBytes(16);
    const parts = await sealBackup(
      key,
      header,
      { vaultId, exportedAt: 5, masterKey },
      records,
      blobs.map((b) => () => Promise.resolve(b)),
    );
    return { keyring, key, header, vaultId, parts };
  }

  it.each([
    ['both keyslots', () => [recovery(), password()] as const],
    ['the recovery keyslot only', () => [recovery()] as const],
  ])('writes a version-2 file that opens again, with %s', async (_, keyslots) => {
    const records = [randomBytes(300), randomBytes(80_000)];
    const blobs = [sealBlob(randomBytes(10)).blob, sealBlob(randomBytes(70_000)).blob];
    const { keyring, key, header, vaultId, parts } = await sealed(keyslots(), records, blobs);
    const parsed = await parseBackup(concat(parts));
    expect(parsed.version).toBe(2);
    expect(parsed.header).toEqual({ ...header, stream: parsed.header.stream });
    const opened = await openBackup(keyring, key, parsed);
    expect(opened).toMatchObject({ vaultId, exportedAt: 5 });
    // Byte comparison: `toEqual` on 80 KB walks it element by element, slow under coverage.
    expect(opened.records.map((r, i) => Buffer.compare(r, records[i] ?? new Uint8Array()))).toEqual(
      [0, 0],
    );
    const read = await blobsOf(opened);
    expect(read.map((b, i) => Buffer.compare(b.blob, blobs[i] ?? new Uint8Array()))).toEqual([
      0, 0,
    ]);
  });

  it('gives the header, then each chunk as it closes: the file is never one buffer', async () => {
    const { parts } = await sealed(
      [recovery()],
      [randomBytes(200_000)],
      [sealBlob(randomBytes(10)).blob],
    );
    const [header, ...chunks] = parts;
    expect(header?.subarray(0, 8)).toEqual(BACKUP_MAGIC);
    expect(chunks.slice(0, -1).every((c) => c.length === FULL_CHUNK)).toBe(true);
    expect(chunks.at(-1)?.length).toBeLessThan(FULL_CHUNK);
  });

  it('reads each blob only when its turn comes, one at a time', async () => {
    const keyring = new Keyring();
    const events: string[] = [];
    const blob = (name: string) => async () => {
      events.push(`start ${name}`);
      await Promise.resolve();
      events.push(`end ${name}`);
      return sealBlob(randomBytes(10)).blob;
    };
    await sealBackup(
      generateKey(keyring),
      { phraseId: randomBytes(16), phraseCreatedAt: 1, keyslots: [recovery()] },
      { vaultId: randomBytes(16), exportedAt: 1, masterKey: generateKey(keyring) },
      [],
      [blob('a'), blob('b')],
    );
    expect(events).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('uses a new stream header for every file', async () => {
    const a = await parseBackup(concat((await sealed([recovery()], [], [])).parts));
    const b = await parseBackup(concat((await sealed([recovery()], [], [])).parts));
    expect(a.header.stream).not.toEqual(b.header.stream);
  });

  it('refuses a record or a blob it could not restore, and a wiped key', async () => {
    const keyring = new Keyring();
    const key = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const header = {
      phraseId: new Uint8Array(16),
      phraseCreatedAt: 1,
      keyslots: [recovery()] as const,
    };
    const meta = { vaultId: new Uint8Array(16), exportedAt: 1, masterKey };
    expect(await reason(() => sealBackup(key, header, meta, [new Uint8Array(0)], []))).toBe(
      'malformed',
    );
    const short = () => Promise.resolve(new Uint8Array(MIN_BLOB_LENGTH - 1));
    expect(await reason(() => sealBackup(key, header, meta, [], [short]))).toBe('malformed');
    const parts = await sealBackup(key, header, meta, [new Uint8Array(1)], []);
    keyring.release(masterKey);
    await expect(sealBackup(key, header, meta, [], [])).rejects.toThrow(KeyWipedError);
    keyring.release(key);
    const parsed = await parseBackup(concat(parts));
    await expect(openBackup(new Keyring(), key, parsed)).rejects.toThrow(KeyWipedError);
  });

  it('lets a blob that cannot be read stop the export as it is', async () => {
    const keyring = new Keyring();
    const gone = new Error('blob gone');
    await expect(
      sealBackup(
        generateKey(keyring),
        { phraseId: new Uint8Array(16), phraseCreatedAt: 1, keyslots: [recovery()] },
        { vaultId: new Uint8Array(16), exportedAt: 1, masterKey: generateKey(keyring) },
        [],
        [() => Promise.reject(gone)],
      ),
    ).rejects.toBe(gone);
  });

  it('does not open under another file key', async () => {
    const { keyring, parts } = await sealed([recovery()], [], []);
    const parsed = await parseBackup(concat(parts));
    expect(await reason(() => openBackup(keyring, generateKey(keyring), parsed))).toBe('corrupt');
  });
});

describe('encodeHeader refuses a header a restore would reject', () => {
  const ok: BackupHeader = {
    phraseId: new Uint8Array(16),
    phraseCreatedAt: 1,
    keyslots: [recovery()],
    stream: new Uint8Array(24),
  };

  it.each([
    ['phraseId of 15 bytes', { ...ok, phraseId: new Uint8Array(15) }],
    ['stream header of 23 bytes', { ...ok, stream: new Uint8Array(23) }],
    ['phraseCreatedAt negative', { ...ok, phraseCreatedAt: -1 }],
    ['phraseCreatedAt above 2^53 - 1', { ...ok, phraseCreatedAt: 2 ** 53 }],
    ['no keyslot', { ...ok, keyslots: [] }],
    ['password keyslot first', { ...ok, keyslots: [password(), recovery()] }],
    ['two recovery keyslots', { ...ok, keyslots: [recovery(), recovery()] }],
    ['three keyslots', { ...ok, keyslots: [recovery(), password(), password()] }],
    [
      'recovery keyslot of 79 bytes',
      { ...ok, keyslots: [{ type: 'recovery', sealed: new Uint8Array(79) }] },
    ],
    [
      'password salt of 15 bytes',
      { ...ok, keyslots: [recovery(), { ...password(), salt: new Uint8Array(15) }] },
    ],
    [
      'password wrap of 47 bytes',
      {
        ...ok,
        keyslots: [
          recovery(),
          { ...password(), wrap: { n: new Uint8Array(24), c: new Uint8Array(47) } },
        ],
      },
    ],
    [
      'password nonce of 23 bytes',
      {
        ...ok,
        keyslots: [
          recovery(),
          { ...password(), wrap: { n: new Uint8Array(23), c: new Uint8Array(48) } },
        ],
      },
    ],
    [
      'opslimit not an integer',
      { ...ok, keyslots: [recovery(), { ...password(), opslimit: 1.5 }] },
    ],
  ])('%s', async (_, header) => {
    expect(await reason(() => encodeHeader(header as BackupHeader))).toBe('malformed');
  });

  it('accepts the valid header, as version 2', () => {
    const encoded = encodeHeader(ok);
    expect(encoded.subarray(0, 8)).toEqual(BACKUP_MAGIC);
    expect(encoded.subarray(8, 10)).toEqual(new Uint8Array([0, 2]));
  });
});

describe('BackupRejectedError', () => {
  it('carries a fixed message per reason', () => {
    for (const r of ['not-a-backup', 'newer-version', 'malformed', 'corrupt'] as const) {
      expect(new BackupRejectedError(r).message).toBe(`backup rejected: ${r}`);
    }
  });

  it('is not a DecryptionError, so a wrong secret is told apart from a damaged file', () => {
    expect(new BackupRejectedError('corrupt')).not.toBeInstanceOf(DecryptionError);
  });
});
