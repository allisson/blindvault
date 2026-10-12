import {
  type KdfPort,
  type KdfRequest,
  KeyWipedError,
  Keyring,
  deriveRecoveryKeys,
  generateKey,
  generateRecoveryPhrase,
  initCrypto,
  normalizePassword,
  randomBytes,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { BackupRejectedError } from './errors';
import { EXPORT_KDF, type ParsedBackup, openBackup, parseBackup, sealBackup } from './format';
import {
  createPasswordKeyslot,
  createRecoveryKeyslot,
  openPasswordKeyslot,
  openRecoveryKeyslot,
} from './keyslots';
import { fromBase64, fromHex, validFile, vectors } from './test-helpers';

beforeAll(initCrypto);

const PASSWORD = vectors.inputs.exportPassword;

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * A stand-in for the Argon2id worker. For the vectors' password, salt and the export parameters it
 * answers the KEK PyNaCl derived (`inputs.passwordKek`); for anything else, a key made of the
 * password's bytes, so another password gives another key. Argon2id itself is tested in
 * `packages/crypto`.
 */
function vectorKdf(onDerive?: () => void) {
  const requests: KdfRequest[] = [];
  const expected = normalizePassword(PASSWORD);
  const salt = fromHex(vectors.valid[0]?.header.keyslots[1]?.salt ?? '');
  const port = (): KdfPort => {
    const p: KdfPort = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        requests.push(message);
        onDerive?.();
        let key: Uint8Array = new Uint8Array(32);
        key.set(message.password.subarray(0, 32));
        if (
          message.op === 'derive' &&
          equal(message.password, expected) &&
          equal(message.salt, salt) &&
          message.params.opslimit === EXPORT_KDF.opslimit &&
          message.params.memlimit === EXPORT_KDF.memlimit
        ) {
          key = fromHex(vectors.inputs.passwordKek);
        }
        const params = message.op === 'derive' ? message.params : EXPORT_KDF;
        message.password.fill(0);
        queueMicrotask(() => p.onmessage?.({ data: { ok: true, key, params } }));
      },
      terminate() {
        // nothing runs in the background
      },
    };
    return p;
  };
  return { port, requests };
}

function vectorPhrase(keyring: Keyring) {
  return deriveRecoveryKeys(keyring, keyring.adopt(fromHex(vectors.inputs.phraseEntropy)));
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

describe('recovery keyslot (backup-format.md §3, D16)', () => {
  it.each(vectors.valid.map((v) => [v.case, v] as const))(
    'opens the vector file with %s by the Recovery Phrase',
    (_, v) => {
      const keyring = new Keyring();
      const parsed = parseBackup(fromBase64(v.file));
      const fileKey = openRecoveryKeyslot(keyring, parsed.header, vectorPhrase(keyring));
      expect(openBackup(keyring, fileKey, parsed).records).toHaveLength(v.meta.recordCount);
    },
  );

  it('fails with one error for another phrase and for a changed keyslot byte', async () => {
    const keyring = new Keyring();
    const parsed = parseBackup(validFile('bothKeyslots'));
    const other = deriveRecoveryKeys(keyring, generateRecoveryPhrase(keyring).entropy);
    expect(await reason(() => openRecoveryKeyslot(keyring, parsed.header, other))).toBe(
      'wrong-secret',
    );
    const sealed = parsed.header.keyslots[0].sealed.slice();
    sealed[50] = (sealed[50] ?? 0) ^ 1;
    const tampered = {
      ...parsed.header,
      keyslots: [{ type: 'recovery', sealed }],
    } as ParsedBackup['header'];
    expect(await reason(() => openRecoveryKeyslot(keyring, tampered, vectorPhrase(keyring)))).toBe(
      'wrong-secret',
    );
  });

  it('reports a released keyslot private key as such, not as a wrong phrase', () => {
    const keyring = new Keyring();
    const parsed = parseBackup(validFile('bothKeyslots'));
    const keys = vectorPhrase(keyring);
    keyring.release(keys.keyslotPrivateKey);
    expect(() => openRecoveryKeyslot(keyring, parsed.header, keys)).toThrow(KeyWipedError);
  });

  it('is made from the public key alone, and opens with the phrase', () => {
    const keyring = new Keyring();
    const phrase = generateRecoveryPhrase(keyring);
    const keys = deriveRecoveryKeys(keyring, phrase.entropy);
    const fileKey = generateKey(keyring);
    const slot = createRecoveryKeyslot(fileKey, keys.keyslotPublicKey);
    expect(slot.type).toBe('recovery');
    expect(slot.sealed).toHaveLength(80);
    const header = {
      phraseId: randomBytes(16),
      phraseCreatedAt: 1,
      keyslots: [slot] as const,
      stream: new Uint8Array(24),
    };
    const opened = openRecoveryKeyslot(keyring, header, keys);
    const file = sealBackup(
      fileKey,
      header,
      { vaultId: randomBytes(16), exportedAt: 1, masterKey: generateKey(keyring) },
      [],
    );
    expect(() => openBackup(keyring, opened, parseBackup(file))).not.toThrow();
  });
});

describe('password keyslot (backup-format.md §3, §4, D36, D78)', () => {
  it('opens the vector file by the export password, at the export parameters', async () => {
    const keyring = new Keyring();
    const kdf = vectorKdf();
    const parsed = parseBackup(validFile('bothKeyslots'));
    const password = normalizePassword(PASSWORD);
    const fileKey = await openPasswordKeyslot(keyring, kdf.port(), parsed.header, password);
    // Only the file key is left: the KEK is released once the file key is out.
    expect(keyring.size).toBe(1);
    expect(openBackup(keyring, fileKey, parsed).records).toHaveLength(3);
    expect(password.every((b) => b === 0)).toBe(true);
    expect(kdf.requests).toHaveLength(1);
    expect(kdf.requests[0]).toMatchObject({ op: 'derive', params: EXPORT_KDF });
  });

  it('fails with one error for a wrong password', async () => {
    const keyring = new Keyring();
    const parsed = parseBackup(validFile('bothKeyslots'));
    const password = normalizePassword('another password entirely');
    expect(
      await reason(() => openPasswordKeyslot(keyring, vectorKdf().port(), parsed.header, password)),
    ).toBe('wrong-secret');
    expect(keyring.size).toBe(0);
  });

  it('keeps no file key when the vault locks during the derivation', async () => {
    const keyring = new Keyring();
    const parsed = parseBackup(validFile('bothKeyslots'));
    const kdf = vectorKdf(() => {
      keyring.wipeAll();
    });
    await expect(
      openPasswordKeyslot(keyring, kdf.port(), parsed.header, normalizePassword(PASSWORD)),
    ).rejects.toThrow(KeyWipedError);
    expect(keyring.size).toBe(0);
  });

  it('says when the file has no password keyslot, deriving nothing', async () => {
    const keyring = new Keyring();
    const kdf = vectorKdf();
    const parsed = parseBackup(validFile('recoveryOnly'));
    const password = normalizePassword(PASSWORD);
    expect(
      await reason(() => openPasswordKeyslot(keyring, kdf.port(), parsed.header, password)),
    ).toBe('no-password-keyslot');
    expect(kdf.requests).toHaveLength(0);
    expect(password.every((b) => b === 0)).toBe(true);
  });

  it.each(vectors.rejectPasswordKeyslot.map((v) => [v.case, v] as const))(
    'refuses %s before Argon2id runs',
    async (_, v) => {
      const keyring = new Keyring();
      const kdf = vectorKdf();
      const parsed = parseBackup(fromBase64(v.file));
      const password = normalizePassword(PASSWORD);
      expect(
        await reason(() => openPasswordKeyslot(keyring, kdf.port(), parsed.header, password)),
      ).toBe(v.reason);
      expect(kdf.requests).toHaveLength(0);
      expect(password.every((b) => b === 0)).toBe(true);
      // The recovery keyslot of the same file still opens.
      expect(() =>
        openRecoveryKeyslot(keyring, parsed.header, vectorPhrase(keyring)),
      ).not.toThrow();
    },
  );

  it('is made at the export parameters with a new salt, and opens with the same password', async () => {
    const keyring = new Keyring();
    const kdf = vectorKdf();
    const fileKey = generateKey(keyring);
    const before = keyring.size;
    const a = await createPasswordKeyslot(
      keyring,
      kdf.port(),
      fileKey,
      normalizePassword('pw one'),
    );
    const b = await createPasswordKeyslot(
      keyring,
      kdf.port(),
      fileKey,
      normalizePassword('pw one'),
    );
    expect(keyring.size).toBe(before);
    expect(a).toMatchObject({ type: 'password', ...EXPORT_KDF });
    expect(a.salt).toHaveLength(16);
    expect(a.salt).not.toEqual(b.salt);
    const keys = deriveRecoveryKeys(keyring, generateRecoveryPhrase(keyring).entropy);
    const header = {
      phraseId: randomBytes(16),
      phraseCreatedAt: 1,
      keyslots: [createRecoveryKeyslot(fileKey, keys.keyslotPublicKey), a] as const,
    };
    const file = sealBackup(
      fileKey,
      header,
      { vaultId: randomBytes(16), exportedAt: 1, masterKey: generateKey(keyring) },
      [randomBytes(10)],
    );
    const parsed = parseBackup(file);
    const opened = await openPasswordKeyslot(
      keyring,
      kdf.port(),
      parsed.header,
      normalizePassword('pw one'),
    );
    expect(openBackup(keyring, opened, parsed).records).toHaveLength(1);
    expect(
      await reason(() =>
        openPasswordKeyslot(keyring, kdf.port(), parsed.header, normalizePassword('pw two')),
      ),
    ).toBe('wrong-secret');
  });
});
