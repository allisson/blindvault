import {
  ACCEPTED_KDF_RANGE,
  DecryptionError,
  Keyring,
  generateKey,
  KeyWipedError,
  initCrypto,
  randomBytes,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { BackupRejectedError } from './errors';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_MAGIC,
  type BackupHeader,
  EXPORT_KDF,
  MAX_HEADER_LENGTH,
  type PasswordKeyslot,
  type RecoveryKeyslot,
  encodeHeader,
  openBackup,
  parseBackup,
  sealBackup,
} from './format';
import { blake2b512, fromBase64, fromHex, rejectedFile, vectors } from './test-helpers';

beforeAll(initCrypto);

function fileKey(keyring: Keyring) {
  // The vectors' fixed file key; a real one comes only from a keyslot or `generateKey`.
  return keyring.adopt(fromHex(vectors.inputs.fileKey));
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof BackupRejectedError) return error.reason;
    throw error;
  }
  throw new Error('accepted');
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

describe('.bvault v1 constants (backup-format.md §2, §4)', () => {
  it('matches the generator', () => {
    expect(BACKUP_MAGIC).toEqual(fromHex(vectors.constants.magic));
    expect(BACKUP_FORMAT_VERSION).toBe(vectors.constants.formatVersion);
    expect(MAX_HEADER_LENGTH).toBe(vectors.constants.maxHeaderLength);
    expect(EXPORT_KDF).toEqual(vectors.constants.export);
  });

  it('exports at parameters a restore accepts (D78)', () => {
    expect(EXPORT_KDF.memlimit).toBe(ACCEPTED_KDF_RANGE.memlimit[0]);
    expect(EXPORT_KDF.opslimit).toBeGreaterThanOrEqual(ACCEPTED_KDF_RANGE.opslimit[0]);
    expect(EXPORT_KDF.opslimit).toBeLessThanOrEqual(ACCEPTED_KDF_RANGE.opslimit[1]);
  });
});

describe('.bvault v1 vectors (backup-format.md §9)', () => {
  it.each(vectors.valid.map((v) => [v.case, v] as const))('opens a file with %s', (_, v) => {
    const file = fromBase64(v.file);
    const parsed = parseBackup(file);
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
    // The header re-encodes to the exact bytes the first chunk authenticated.
    expect(encodeHeader(parsed.header)).toEqual(parsed.headerBytes);

    const keyring = new Keyring();
    const opened = openBackup(keyring, fileKey(keyring), parsed);
    expect(opened.vaultId).toEqual(fromHex(v.meta.vaultId));
    expect(opened.exportedAt).toBe(v.meta.exportedAt);
    expect(opened.records.map((r) => ({ length: r.length, blake2b512: blake2b512(r) }))).toEqual(
      v.records,
    );
    expect(opened.records).toHaveLength(v.meta.recordCount);
  });

  it.each(vectors.rejectHeader.map((v) => [v.case, v] as const))(
    'rejects before any key: %s',
    (_, v) => {
      expect(reason(() => parseBackup(fromBase64(v.file)))).toBe(v.reason);
    },
  );

  it.each(vectors.rejectStream.map((v) => [v.case, v] as const))(
    'rejects once the file key is known: %s',
    (_, v) => {
      const parsed = parseBackup(rejectedFile(v));
      const keyring = new Keyring();
      expect(reason(() => openBackup(keyring, fileKey(keyring), parsed))).toBe(v.reason);
      // Only the file key is in the keyring: no Master Key was adopted.
      expect(keyring.size).toBe(1);
    },
  );
});

describe('sealBackup', () => {
  it.each([
    ['both keyslots', () => [recovery(), password()] as const],
    ['the recovery keyslot only', () => [recovery()] as const],
  ])('writes a file that opens again, with %s', (_, keyslots) => {
    const keyring = new Keyring();
    const key = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const slots = keyslots();
    const header = {
      phraseId: randomBytes(16),
      phraseCreatedAt: 1_760_000_000_000,
      keyslots: slots,
    };
    const records = [randomBytes(300), randomBytes(80_000)];
    const vaultId = randomBytes(16);
    const file = sealBackup(key, header, { vaultId, exportedAt: 5, masterKey }, records);

    const parsed = parseBackup(file);
    expect(parsed.header).toEqual({ ...header, stream: parsed.header.stream });
    const opened = openBackup(keyring, key, parsed);
    expect(opened).toMatchObject({ vaultId, exportedAt: 5 });
    // Byte comparison: `toEqual` on 80 KB walks it element by element, slow under coverage.
    expect(opened.records.map((r, i) => Buffer.compare(r, records[i] ?? new Uint8Array()))).toEqual(
      [0, 0],
    );
  });

  it('uses a new stream header for every file', () => {
    const keyring = new Keyring();
    const key = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const header = {
      phraseId: randomBytes(16),
      phraseCreatedAt: 1,
      keyslots: [recovery()] as const,
    };
    const meta = { vaultId: randomBytes(16), exportedAt: 1, masterKey };
    const a = parseBackup(sealBackup(key, header, meta, []));
    const b = parseBackup(sealBackup(key, header, meta, []));
    expect(a.header.stream).not.toEqual(b.header.stream);
  });

  it('refuses a record it could not restore, and a wiped key', () => {
    const keyring = new Keyring();
    const key = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const header = {
      phraseId: new Uint8Array(16),
      phraseCreatedAt: 1,
      keyslots: [recovery()] as const,
    };
    const meta = { vaultId: new Uint8Array(16), exportedAt: 1, masterKey };
    expect(reason(() => sealBackup(key, header, meta, [new Uint8Array(0)]))).toBe('malformed');
    const file = sealBackup(key, header, meta, [new Uint8Array(1)]);
    keyring.release(masterKey);
    expect(() => sealBackup(key, header, meta, [])).toThrow(KeyWipedError);
    keyring.release(key);
    expect(() => openBackup(new Keyring(), key, parseBackup(file))).toThrow(KeyWipedError);
  });

  it('does not open under another file key', () => {
    const keyring = new Keyring();
    const masterKey = generateKey(keyring);
    const header = {
      phraseId: randomBytes(16),
      phraseCreatedAt: 1,
      keyslots: [recovery()] as const,
    };
    const file = sealBackup(
      generateKey(keyring),
      header,
      { vaultId: randomBytes(16), exportedAt: 1, masterKey },
      [],
    );
    expect(reason(() => openBackup(keyring, generateKey(keyring), parseBackup(file)))).toBe(
      'corrupt',
    );
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
  ])('%s', (_, header) => {
    expect(reason(() => encodeHeader(header as BackupHeader))).toBe('malformed');
  });

  it('accepts the valid header', () => {
    expect(encodeHeader(ok).subarray(0, 8)).toEqual(BACKUP_MAGIC);
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
