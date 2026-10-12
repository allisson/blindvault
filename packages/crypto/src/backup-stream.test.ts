// The backup stream and payload (backup-format.md §5, §6). The PyNaCl vectors are opened in
// packages/backup, which owns the file format; these tests cover the module's own edges.

import { beforeAll, describe, expect, it } from 'vitest';

import {
  type BackupMeta,
  BackupStreamWriter,
  CHUNK_LENGTH,
  openBackupStream,
} from './backup-stream';
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

function sealed(
  records: readonly Uint8Array[],
  keyring = new Keyring(),
): {
  keyring: Keyring;
  fileKey: ReturnType<typeof generateKey>;
  header: Uint8Array;
  body: Uint8Array;
  masterKey: ReturnType<typeof generateKey>;
} {
  const fileKey = generateKey(keyring);
  const masterKey = generateKey(keyring);
  const writer = BackupStreamWriter.create(fileKey);
  const meta: BackupMeta & { masterKey: typeof masterKey } = {
    vaultId: VAULT_ID,
    exportedAt: 1_760_000_100_000,
    masterKey,
  };
  return {
    keyring,
    fileKey,
    header: writer.header,
    body: writer.seal(FILE_HEADER, meta, records),
    masterKey,
  };
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

describe('backup stream (backup-format.md §5, §6)', () => {
  it.each([
    ['one final chunk', [filler(100), filler(3, 1)]],
    ['several chunks', [filler(MAX_RECORD), filler(70_000, 2)]],
  ])('round-trips %s', (_, records) => {
    const { keyring, fileKey, header, body, masterKey } = sealed(records);
    const opened = openBackupStream(keyring, fileKey, header, FILE_HEADER, body);
    expect(sameBytes(opened.records, records)).toBe(true);
    expect(opened.vaultId).toEqual(VAULT_ID);
    expect(opened.exportedAt).toBe(1_760_000_100_000);
    expect(keyBytes(opened.masterKey)).toEqual(keyBytes(masterKey));
    expect(opened.masterKey).not.toBe(masterKey);
  });

  it('ends an exact multiple of the chunk length with an empty final chunk', () => {
    // The meta `sealed` writes has this length: its values differ, its encoding sizes do not.
    const metaLength = encodeCbor(meta({ exportedAt: 1_760_000_100_000 })).length;
    const record = filler(CHUNK_LENGTH - 4 - metaLength - 4);
    const { keyring, fileKey, header, body } = sealed([record]);
    expect(body.length).toBe(CHUNK_LENGTH + 17 + 17);
    expect(
      sameBytes(openBackupStream(keyring, fileKey, header, FILE_HEADER, body).records, [record]),
    ).toBe(true);
  });

  it('round-trips a backup with no record', () => {
    const { keyring, fileKey, header, body } = sealed([]);
    expect(openBackupStream(keyring, fileKey, header, FILE_HEADER, body).records).toEqual([]);
  });

  it('gives the Master Key to the keyring passed in', () => {
    const { fileKey, header, body } = sealed([filler(10)]);
    const target = new Keyring();
    const opened = openBackupStream(target, fileKey, header, FILE_HEADER, body);
    expect(target.size).toBe(1);
    target.wipeAll();
    expect(() => keyBytes(opened.masterKey)).toThrow(KeyWipedError);
  });

  it('binds the first chunk to the file header', () => {
    const { keyring, fileKey, header, body } = sealed([filler(10)]);
    const other = FILE_HEADER.slice();
    other[9] = 2;
    expect(() => openBackupStream(keyring, fileKey, header, other, body)).toThrow(DecryptionError);
    expect(() => openBackupStream(keyring, fileKey, header, new Uint8Array(0), body)).toThrow(
      DecryptionError,
    );
  });

  it('rejects another file key and a bad stream header', () => {
    const { keyring, fileKey, header, body } = sealed([filler(10)]);
    expect(() =>
      openBackupStream(keyring, generateKey(keyring), header, FILE_HEADER, body),
    ).toThrow(DecryptionError);
    expect(() => openBackupStream(keyring, fileKey, header.subarray(1), FILE_HEADER, body)).toThrow(
      DecryptionError,
    );
    const flipped = header.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => openBackupStream(keyring, fileKey, flipped, FILE_HEADER, body)).toThrow(
      DecryptionError,
    );
  });

  it('rejects truncation and trailing bytes (D95)', () => {
    const { keyring, fileKey, header, body } = sealed([filler(70_000)]);
    const cut = [
      body.subarray(0, 16),
      body.subarray(0, CHUNK_LENGTH + 17),
      body.subarray(0, body.length - 1),
      new Uint8Array([...body, 0]),
      new Uint8Array([...body, ...new Uint8Array(17)]),
      new Uint8Array(0),
    ];
    for (const b of cut) {
      expect(() => openBackupStream(keyring, fileKey, header, FILE_HEADER, b)).toThrow(
        DecryptionError,
      );
    }
  });

  it('rejects every tag but MESSAGE on full chunks and FINAL on the last', () => {
    const sodium = lib();
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const one = payloadOf(meta(), [filler(10)]);
    const two = payloadOf(meta(), [filler(70_000)]);
    const cases: [Uint8Array, number[]][] = [
      [one, [sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE]],
      [one, [sodium.crypto_secretstream_xchacha20poly1305_TAG_PUSH]],
      [one, [sodium.crypto_secretstream_xchacha20poly1305_TAG_REKEY]],
      [two, [sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL]],
      [two, [sodium.crypto_secretstream_xchacha20poly1305_TAG_PUSH]],
    ];
    for (const [payload, tags] of cases) {
      const { header, body } = rawStream(fileKey, payload, tags);
      expect(() => openBackupStream(keyring, fileKey, header, FILE_HEADER, body)).toThrow(
        DecryptionError,
      );
    }
  });

  it.each([
    ['an unknown meta key', payloadOf(meta({ note: 1 }), [filler(10)])],
    ['a missing meta key', payloadOf(meta({ exportedAt: undefined }), [filler(10)])],
    ['a Master Key of 31 bytes', payloadOf(meta({ masterKey: new Uint8Array(31) }), [filler(10)])],
    ['a vaultId of 15 bytes', payloadOf(meta({ vaultId: new Uint8Array(15) }), [filler(10)])],
    ['exportedAt above 2^53 - 1', payloadOf(meta({ exportedAt: 2 ** 53 }), [filler(10)])],
    ['recordCount one too high', payloadOf(meta({ recordCount: 2 }), [filler(10)])],
    ['recordCount one too low', payloadOf(meta({ recordCount: 0 }), [filler(10)])],
    ['a record of length 0', payloadOf(meta(), [new Uint8Array(0)])],
    ['a payload of 2 bytes', new Uint8Array([0, 1])],
    [
      'a meta longer than 256 bytes',
      payloadOf(meta({ masterKey: new Uint8Array(300) }), [filler(10)]),
    ],
  ])('rejects an authenticated payload with %s', (_, payload) => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const { header, body } = rawStream(fileKey, payload);
    expect(() => openBackupStream(keyring, fileKey, header, FILE_HEADER, body)).toThrow(
      EncodingError,
    );
    expect(keyring.size).toBe(1);
  });

  it('rejects a record longer than the largest envelope', () => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const { header, body } = rawStream(fileKey, payloadOf(meta(), [filler(MAX_RECORD + 1)]));
    expect(() => openBackupStream(keyring, fileKey, header, FILE_HEADER, body)).toThrow(
      EncodingError,
    );
  });

  it('seals once, and refuses what it cannot write', () => {
    const keyring = new Keyring();
    const fileKey = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const ok = { vaultId: VAULT_ID, exportedAt: 1, masterKey };
    const writer = BackupStreamWriter.create(fileKey);
    writer.seal(FILE_HEADER, ok, []);
    expect(() => writer.seal(FILE_HEADER, ok, [])).toThrow(EncodingError);
    const bad: [Uint8Array, typeof ok, Uint8Array[]][] = [
      [new Uint8Array(0), ok, []],
      [FILE_HEADER, { ...ok, vaultId: new Uint8Array(15) }, []],
      [FILE_HEADER, { ...ok, exportedAt: -1 }, []],
      [FILE_HEADER, { ...ok, exportedAt: 2 ** 53 }, []],
      [FILE_HEADER, ok, [new Uint8Array(0)]],
      [FILE_HEADER, ok, [filler(MAX_RECORD + 1)]],
    ];
    for (const [fileHeader, m, records] of bad) {
      expect(() => BackupStreamWriter.create(fileKey).seal(fileHeader, m, records)).toThrow(
        EncodingError,
      );
    }
    keyring.wipeAll();
    expect(() => BackupStreamWriter.create(fileKey)).toThrow(KeyWipedError);
  });
});
