// Restore validation (backup-format.md §8 steps 3 to 8, D43, D61, D64, D81, D178): a file opened by
// one of its keyslots is checked in full before anything is written. Applying it is the caller's.

import {
  type CborMap,
  type EncryptedRecord,
  type Envelope,
  type KdfPort,
  KeyWipedError,
  Keyring,
  NewerRecordError,
  type OpenedBackupPayload,
  RecordRejectedError,
  RecordType,
  type RecoveryKeys,
  type SymmetricKey,
  type VerificationKeys,
  checkBackupRecoveryEnvelope,
  decodeEnvelope,
  deriveMasterSubkeys,
  deriveRecoveryKeys,
  encodeEnvelope,
  parseRecoveryPhrase,
  verifyRecord,
} from '@blindvault/crypto';

import { BackupRejectedError, type RejectedRecord } from './errors';
import { type ParsedBackup, openBackup } from './format';
import { openPasswordKeyslot, openRecoveryKeyslot } from './keyslots';

/** A backup that passed every check of §8 up to step 8, ready to apply (step 9). */
export interface ValidatedBackup {
  readonly vaultId: Uint8Array;
  readonly exportedAt: number;
  /** In the caller's keyring: the caller wipes it unless the restore commits (step 10). */
  readonly masterKey: SymmetricKey;
  /** Every envelope exactly as in the file, in its order, with its storage identity. */
  readonly records: readonly EncryptedRecord[];
  /** `password`: the restore ends by recommending Check Recovery Phrase (D43). */
  readonly openedWith: 'phrase' | 'password';
}

/**
 * Restores with the Recovery Phrase as typed. An invalid phrase throws `PhraseRejectedError` with
 * the position of the first unknown word; anything else that fails throws `BackupRejectedError`.
 * The phrase-derived keys and the file key are wiped before returning.
 */
export function restoreWithPhrase(
  keyring: Keyring,
  parsed: ParsedBackup,
  phrase: string,
): ValidatedBackup {
  if (keyring.wiped) throw new KeyWipedError();
  const scratch = new Keyring();
  try {
    const recovery = deriveRecoveryKeys(scratch, parseRecoveryPhrase(scratch, phrase));
    const fileKey = openRecoveryKeyslot(scratch, parsed.header, recovery);
    scratch.release(recovery.keyslotPrivateKey);
    return validate(keyring, parsed, fileKey, recovery);
  } finally {
    scratch.wipeAll();
  }
}

/**
 * Restores with a normalized export password, which is wiped. The KEK and the file key are wiped
 * before returning; a caller keyring wiped during the derivation keeps nothing.
 */
export async function restoreWithPassword(
  keyring: Keyring,
  port: KdfPort,
  parsed: ParsedBackup,
  password: Uint8Array,
): Promise<ValidatedBackup> {
  if (keyring.wiped) {
    password.fill(0);
    port.terminate();
    throw new KeyWipedError();
  }
  const scratch = new Keyring();
  try {
    const fileKey = await openPasswordKeyslot(scratch, port, parsed.header, password);
    return validate(keyring, parsed, fileKey);
  } finally {
    scratch.wipeAll();
  }
}

/** Steps 4 to 8. The Master Key goes to `keyring` only if every check passes. */
function validate(
  keyring: Keyring,
  parsed: ParsedBackup,
  fileKey: SymmetricKey,
  recovery?: RecoveryKeys,
): ValidatedBackup {
  const opened = openBackup(keyring, fileKey, parsed);
  try {
    const { records, envelope } = verifyAll(opened);

    // Step 7: the Recovery Envelope of the header's phrase (D178).
    const { header } = parsed;
    const phraseId = envelope?.content.get('phraseId');
    if (
      !envelope ||
      !(phraseId instanceof Uint8Array) ||
      !sameBytes(phraseId, header.phraseId) ||
      envelope.content.get('phraseCreatedAt') !== header.phraseCreatedAt
    ) {
      throw new BackupRejectedError('envelope-mismatch');
    }

    // Step 8: with the phrase, the envelope opens to this Master Key (D43).
    if (recovery) {
      const check = checkBackupRecoveryEnvelope(
        envelope.bytes,
        opened.vaultId,
        recovery,
        opened.masterKey,
        envelope.content.get('keyslotPublicKey') as Uint8Array,
      );
      if (check !== 'opens') throw new BackupRejectedError(check);
    }
    return {
      vaultId: opened.vaultId,
      exportedAt: opened.exportedAt,
      masterKey: opened.masterKey,
      records,
      openedWith: recovery ? 'phrase' : 'password',
    };
  } catch (error) {
    keyring.release(opened.masterKey);
    throw error;
  }
}

interface Verified {
  readonly records: EncryptedRecord[];
  readonly envelope?: { readonly bytes: Uint8Array; readonly content: CborMap };
}

/**
 * Step 6: every record verified as on receipt under the payload's `vaultId` and Master Key, the
 * Vault Key records first. A newer record rejects the file whatever else it holds; otherwise the
 * first record that fails, or repeats an identity, is named. The Vault Keys and subkeys live in a
 * keyring of their own, wiped before returning.
 */
function verifyAll(opened: OpenedBackupPayload): Verified {
  const decoded = opened.records.map((bytes): Envelope | undefined => {
    try {
      return decodeEnvelope(bytes);
    } catch (error) {
      if (error instanceof NewerRecordError) throw new BackupRejectedError('newer-record');
      if (error instanceof RecordRejectedError) return undefined;
      throw error;
    }
  });
  const entries = opened.records.map((bytes, i) => ({ i, bytes, header: decoded[i]?.header }));
  const isVaultKey = (e: (typeof entries)[number]) => e.header?.recordType === RecordType.vaultKey;
  const order = [...entries.filter(isVaultKey), ...entries.filter((e) => !isVaultKey(e))];

  const scratch = new Keyring();
  try {
    const subkeys = deriveMasterSubkeys(scratch, opened.masterKey);
    const vaultKeys = new Map<number, SymmetricKey>();
    const keys: VerificationKeys = {
      vaultId: opened.vaultId,
      vaultKey: (epoch) => vaultKeys.get(epoch),
      vaultKeyWrapKey: subkeys.vaultKeyWrap,
      versionIdKey: subkeys.versionId,
    };
    const records: EncryptedRecord[] = [];
    const seen = new Set<string>();
    let envelope: Verified['envelope'];
    for (const { i, bytes, header: decodedHeader } of order) {
      const named: RejectedRecord | undefined = decodedHeader && {
        recordType: decodedHeader.recordType,
        recordId: decodedHeader.recordId.slice(),
      };
      let verified;
      try {
        verified = verifyRecord(scratch, bytes, keys);
      } catch (error) {
        if (error instanceof RecordRejectedError) {
          throw new BackupRejectedError('corrupt-record', named);
        }
        throw error;
      }
      const { header } = verified.envelope;
      const identity = `${String(header.recordType)}:${hex(header.recordId)}`;
      if (seen.has(identity)) throw new BackupRejectedError('corrupt-record', named);
      seen.add(identity);
      if (verified.vaultKey) vaultKeys.set(header.keyEpoch, verified.vaultKey);
      if (header.recordType === RecordType.recoveryEnvelope && verified.content) {
        envelope = { bytes, content: verified.content };
      }
      records[i] = {
        // Verified, so a type this format knows.
        recordType: header.recordType as RecordType,
        recordId: header.recordId.slice(),
        // Strict CBOR made the bytes canonical, so this re-encodes them exactly (crypto-spec §9.5).
        envelope: encodeEnvelope(verified.envelope),
      };
    }
    return envelope ? { records, envelope } : { records };
  } finally {
    scratch.wipeAll();
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
