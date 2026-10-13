// Restore validation, backup-format.md §8 steps 3 to 8 (D43, D61, D64, D81, D178).

import {
  Keyring,
  KeyWipedError,
  PhraseRejectedError,
  RecordType,
  decodeEnvelope,
  deriveMasterSubkeys,
  generateRecoveryPhrase,
  initCrypto,
  normalizePassword,
  verifyRecord,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { BackupRejectedError } from './errors';
import { parseBackup } from './format';
import { type ValidatedBackup, restoreWithPassword, restoreWithPhrase } from './restore';
import { blake2b512, fromBase64, fromHex, validFile, vectorKdf, vectors } from './test-helpers';

beforeAll(initCrypto);

const PHRASE = vectors.inputs.phrase;
const PASSWORD = vectors.inputs.exportPassword;

type Via = 'phrase' | 'password';

async function restore(
  keyring: Keyring,
  file: Uint8Array,
  via: Via,
  password = normalizePassword(PASSWORD),
): Promise<ValidatedBackup> {
  const parsed = parseBackup(file);
  if (via === 'phrase') return restoreWithPhrase(keyring, parsed, PHRASE);
  return restoreWithPassword(keyring, vectorKdf().port(), parsed, password);
}

async function rejection(fn: () => unknown): Promise<BackupRejectedError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof BackupRejectedError) return error;
    throw error;
  }
  throw new Error('accepted');
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The returned Master Key unwraps the payload's Vault Key record, as the stored vault's does. */
function opensVaultKey(backup: ValidatedBackup): boolean {
  const scratch = new Keyring();
  try {
    const subkeys = deriveMasterSubkeys(scratch, backup.masterKey);
    const vaultKey = backup.records.find((r) => r.recordType === RecordType.vaultKey);
    if (!vaultKey) return false;
    const verified = verifyRecord(scratch, vaultKey.envelope, {
      vaultId: backup.vaultId,
      vaultKey: () => undefined,
      vaultKeyWrapKey: subkeys.vaultKeyWrap,
      versionIdKey: subkeys.versionId,
    });
    return verified.vaultKey !== undefined;
  } finally {
    scratch.wipeAll();
  }
}

const VIAS: Via[] = ['phrase', 'password'];

describe('restore of the valid vectors (backup-format.md §8, §9)', () => {
  it.each(vectors.valid.flatMap((v) => VIAS.map((via) => [v.case, via, v] as const)))(
    'validates a file with %s, opened by the %s',
    async (_, via, v) => {
      const keyring = new Keyring();
      const file = fromBase64(v.file);
      if (via === 'password' && v.header.keyslots.length === 1) {
        expect((await rejection(() => restore(keyring, file, via))).reason).toBe(
          'no-password-keyslot',
        );
        expect(keyring.size).toBe(0);
        return;
      }
      const backup = await restore(keyring, file, via);
      expect(backup.vaultId).toEqual(fromHex(v.meta.vaultId));
      expect(backup.exportedAt).toBe(v.meta.exportedAt);
      expect(backup.openedWith).toBe(via);
      // Every envelope exactly as in the file, in its order, with its storage identity.
      expect(
        backup.records.map((r) => ({
          length: r.envelope.length,
          blake2b512: blake2b512(r.envelope),
        })),
      ).toEqual(v.records);
      for (const r of backup.records) {
        const { header } = decodeEnvelope(r.envelope);
        expect(r.recordType).toBe(header.recordType);
        expect(r.recordId).toEqual(header.recordId);
      }
      expect(opensVaultKey(backup)).toBe(true);
      // Only the Master Key is left in the caller's keyring (step 10).
      expect(keyring.size).toBe(1);
    },
  );

  it('accepts the phrase as typed: uppercase, newlines, extra spaces', () => {
    const keyring = new Keyring();
    const typed = `  ${PHRASE.toUpperCase().split(' ').join('\n ')} `;
    const backup = restoreWithPhrase(keyring, parseBackup(validFile('bothKeyslots')), typed);
    expect(backup.openedWith).toBe('phrase');
  });
});

describe('secrets that do not open the file (backup-format.md §8 step 3)', () => {
  it('reports an invalid phrase with its position, keeping no key', () => {
    const keyring = new Keyring();
    const parsed = parseBackup(validFile('bothKeyslots'));
    const words = PHRASE.split(' ');
    words[4] = 'notaword';
    let error: unknown;
    try {
      restoreWithPhrase(keyring, parsed, words.join(' '));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PhraseRejectedError);
    expect((error as PhraseRejectedError).position).toBe(5);
    expect(keyring.size).toBe(0);
  });

  it('reports another valid phrase as a wrong secret, keeping no key', async () => {
    const keyring = new Keyring();
    const parsed = parseBackup(validFile('bothKeyslots'));
    const other = generateRecoveryPhrase(new Keyring()).words;
    expect((await rejection(() => restoreWithPhrase(keyring, parsed, other))).reason).toBe(
      'wrong-secret',
    );
    expect(keyring.size).toBe(0);
  });

  it('reports another password as a wrong secret, and wipes it', async () => {
    const keyring = new Keyring();
    const password = normalizePassword('another export password entirely');
    const error = await rejection(() =>
      restore(keyring, validFile('bothKeyslots'), 'password', password),
    );
    expect(error.reason).toBe('wrong-secret');
    expect(password.every((b) => b === 0)).toBe(true);
    expect(keyring.size).toBe(0);
  });

  it('wipes the export password after a restore that validates', async () => {
    const password = normalizePassword(PASSWORD);
    await restore(new Keyring(), validFile('bothKeyslots'), 'password', password);
    expect(password.every((b) => b === 0)).toBe(true);
  });
});

describe('restore checks of the vectors (backup-format.md §8 steps 6 to 8, §9)', () => {
  it.each(
    vectors.rejectRestore.flatMap((v) =>
      VIAS.map((via) => [`step ${String(v.step)}, ${v.case}`, via, v] as const),
    ),
  )('%s, opened by the %s', async (_, via, v) => {
    const keyring = new Keyring();
    const file = fromBase64(v.file);
    if (v.phraseOnly && via === 'password') {
      // Only the phrase opens the Recovery Envelope's mk: an export password recommends Check
      // Recovery Phrase instead (D43).
      const backup = await restore(keyring, file, via);
      expect(backup.openedWith).toBe('password');
      return;
    }
    const error = await rejection(() => restore(keyring, file, via));
    expect(error.reason).toBe(v.reason);
    if (v.reason === 'corrupt-record') {
      const named = error.record && {
        recordType: error.record.recordType,
        recordIdPrefix: hex(error.record.recordId.subarray(0, 4)),
      };
      expect(named ?? null).toEqual(v.record);
    } else {
      expect(error.record).toBeUndefined();
    }
    // Nothing kept: not even the Master Key the payload carried (step 10).
    expect(keyring.size).toBe(0);
  });

  it('covers every rejection reason of steps 6 to 8', () => {
    expect(new Set(vectors.rejectRestore.map((v) => v.reason))).toEqual(
      new Set([
        'newer-record',
        'corrupt-record',
        'envelope-mismatch',
        'master-key-mismatch',
        'public-key-mismatch',
      ]),
    );
  });

  it('names the record in its own field, the message staying fixed (CRYPTO-INV-005)', async () => {
    const v = vectors.rejectRestore.find(
      (x) => x.case === 'an Item whose ct does not authenticate',
    );
    expect(v).toBeDefined();
    const error = await rejection(() =>
      restore(new Keyring(), fromBase64(v?.file ?? ''), 'phrase'),
    );
    expect(error.record?.recordType).toBe(RecordType.item);
    expect(error.message).toBe('backup rejected: corrupt-record');
  });
});

describe('locks and wiped keys (CRYPTO-INV-010)', () => {
  it('keeps nothing when the caller keyring is wiped during the password derivation', async () => {
    const keyring = new Keyring();
    const kdf = vectorKdf(() => {
      keyring.wipeAll();
    });
    const parsed = parseBackup(validFile('bothKeyslots'));
    await expect(
      restoreWithPassword(keyring, kdf.port(), parsed, normalizePassword(PASSWORD)),
    ).rejects.toThrow(KeyWipedError);
    expect(keyring.size).toBe(0);
  });

  it('refuses a wiped caller keyring before the derivation, wiping the password', async () => {
    const keyring = new Keyring();
    keyring.wipeAll();
    const kdf = vectorKdf();
    let terminated = false;
    const port = { ...kdf.port(), terminate: () => (terminated = true) };
    const password = normalizePassword(PASSWORD);
    await expect(
      restoreWithPassword(keyring, port, parseBackup(validFile('bothKeyslots')), password),
    ).rejects.toThrow(KeyWipedError);
    expect(password.every((b) => b === 0)).toBe(true);
    expect(terminated).toBe(true);
    expect(kdf.requests).toHaveLength(0);
  });

  it('refuses a wiped caller keyring before touching the phrase', () => {
    const keyring = new Keyring();
    keyring.wipeAll();
    expect(() =>
      restoreWithPhrase(keyring, parseBackup(validFile('bothKeyslots')), PHRASE),
    ).toThrow(KeyWipedError);
  });
});
