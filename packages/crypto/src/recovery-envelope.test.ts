// The Recovery Envelope record (crypto-spec.md §11, D2, D16, D24).

import { describe, expect, it } from 'vitest';

import { type CborMap, type CborValue } from './cbor';
import { DecryptionError, EncodingError, KeyWipedError } from './errors';
import { recoveryEnvelopeRecordId } from './ids';
import { deriveMasterSubkeys } from './kdf';
import { Keyring, adoptKey, generateKey, keyBytes } from './keys';
import { type RecordHeader } from './layout';
import {
  RecordType,
  type VerificationKeys,
  checkBackupRecoveryEnvelope,
  checkRecoveryEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  openRecoveryEnvelope,
  sealRecoveryEnvelope,
  verifyRecord,
} from './record';
import { deriveRecoveryKeys, generateRecoveryPhrase, parseRecoveryPhrase } from './recovery';
import { initCrypto, randomId } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

// Test tables below build IDs at collection time.
await initCrypto();

const r = vectors.records;
const VAULT_ID = fromHex('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');

function header(over: Partial<RecordHeader> = {}): RecordHeader {
  return {
    recordFormatVersion: 1,
    recordType: RecordType.recoveryEnvelope,
    recordId: recoveryEnvelopeRecordId(VAULT_ID),
    keyEpoch: 1,
    hlc: { physicalMs: 1_760_000_000_000, counter: 1, deviceId: new Uint8Array(16).fill(4) },
    deleted: false,
    ...over,
  };
}

function metadata(publicKey: Uint8Array, over: [string, CborValue | undefined][] = []): CborMap {
  const m = new Map<CborValue, CborValue>([
    ['keyslotPublicKey', publicKey],
    ['phraseCreatedAt', 1_760_000_000_000],
    ['phraseId', new Uint8Array(16).fill(0xe0)],
  ]);
  for (const [k, v] of over) {
    if (v === undefined) m.delete(k);
    else m.set(k, v);
  }
  return m;
}

function setup() {
  const keyring = new Keyring();
  const vaultKey = generateKey(keyring);
  const masterKey = generateKey(keyring);
  const recovery = deriveRecoveryKeys(keyring, generateRecoveryPhrase(keyring).entropy);
  const keys: VerificationKeys = {
    vaultId: VAULT_ID,
    vaultKey: (epoch) => (epoch === 1 ? vaultKey : undefined),
    vaultKeyWrapKey: generateKey(keyring),
    versionIdKey: generateKey(keyring),
  };
  return { keyring, vaultKey, masterKey, recovery, keys };
}

describe('Recovery Envelope (crypto-spec.md §11)', () => {
  it('opens the vector envelope with its envelope key', () => {
    const keyring = new Keyring();
    const mk = openRecoveryEnvelope(
      keyring,
      fromHex(r.recoveryEnvelope.envelope),
      VAULT_ID,
      adoptKey(keyring, fromHex(r.envelopeKey)),
    );
    expect(toHex(keyBytes(mk))).toBe(r.recoveryEnvelope.masterKey);
  });

  it('seals an envelope that verifies on receipt and opens with the phrase', () => {
    const { keyring, vaultKey, masterKey, recovery, keys } = setup();
    const meta = metadata(recovery.keyslotPublicKey);
    const envelope = sealRecoveryEnvelope(
      header(),
      VAULT_ID,
      vaultKey,
      recovery.envelopeKey,
      masterKey,
      meta,
    );
    const verified = verifyRecord(keyring, envelope, keys);
    expect(verified.content).toEqual(meta);
    const opened = openRecoveryEnvelope(keyring, envelope, VAULT_ID, recovery.envelopeKey);
    expect(keyBytes(opened)).toEqual(keyBytes(masterKey));
  });

  it('keeps unknown metadata keys from a newer app (D98)', () => {
    const { keyring, vaultKey, masterKey, recovery, keys } = setup();
    const meta = metadata(recovery.keyslotPublicKey, [['hint', 'x']]);
    const envelope = sealRecoveryEnvelope(
      header(),
      VAULT_ID,
      vaultKey,
      recovery.envelopeKey,
      masterKey,
      meta,
    );
    expect(verifyRecord(keyring, envelope, keys).content?.get('hint')).toBe('x');
  });

  it('does not open with another phrase, another vault or another header', () => {
    const { keyring, vaultKey, masterKey, recovery } = setup();
    const other = deriveRecoveryKeys(keyring, generateRecoveryPhrase(keyring).entropy);
    const envelope = sealRecoveryEnvelope(
      header(),
      VAULT_ID,
      vaultKey,
      recovery.envelopeKey,
      masterKey,
      metadata(recovery.keyslotPublicKey),
    );
    expect(() => openRecoveryEnvelope(keyring, envelope, VAULT_ID, other.envelopeKey)).toThrow(
      DecryptionError,
    );
    expect(() => openRecoveryEnvelope(keyring, envelope, randomId(), recovery.envelopeKey)).toThrow(
      DecryptionError,
    );
    // The same mk under a later HLC: the header is bound through the AAD (D21).
    const decoded = decodeEnvelope(envelope);
    const later = encodeEnvelope({
      ...decoded,
      header: { ...decoded.header, hlc: { ...decoded.header.hlc, counter: 2 } },
    });
    expect(() => openRecoveryEnvelope(keyring, later, VAULT_ID, recovery.envelopeKey)).toThrow(
      DecryptionError,
    );
  });

  it('opens only a Recovery Envelope', () => {
    const keyring = new Keyring();
    expect(() =>
      openRecoveryEnvelope(
        keyring,
        fromHex(r.vaultKeyRecord.envelope),
        VAULT_ID,
        adoptKey(keyring, fromHex(r.envelopeKey)),
      ),
    ).toThrow(DecryptionError);
  });

  it.each([
    ['another recordId', header({ recordId: randomId() }), undefined],
    ['deleted = true', header({ deleted: true }), undefined],
    ['another record type', header({ recordType: RecordType.item }), undefined],
    ['recordFormatVersion 2', header({ recordFormatVersion: 2 }), undefined],
    ['no keyslotPublicKey', header(), [['keyslotPublicKey', undefined]]],
    ['a keyslotPublicKey of 31 bytes', header(), [['keyslotPublicKey', new Uint8Array(31)]]],
    ['a phraseId of 15 bytes', header(), [['phraseId', new Uint8Array(15)]]],
    ['phraseCreatedAt as text', header(), [['phraseCreatedAt', '2026']]],
  ] as const)('refuses to seal with %s', (_, h, over) => {
    const { vaultKey, masterKey, recovery } = setup();
    const meta = metadata(
      recovery.keyslotPublicKey,
      (over ?? []) as unknown as [string, CborValue | undefined][],
    );
    expect(() =>
      sealRecoveryEnvelope(h, VAULT_ID, vaultKey, recovery.envelopeKey, masterKey, meta),
    ).toThrow(EncodingError);
  });
});

describe('Check Recovery Phrase (§5.4, D24, D180)', () => {
  /** A vault's envelope and what an unlocked device holds of it; the typed phrase's entropy. */
  function vault(over: { masterKey?: 'other'; publicKey?: 'other' } = {}) {
    const keyring = new Keyring();
    const vaultKey = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const phrase = generateRecoveryPhrase(keyring);
    const recovery = deriveRecoveryKeys(keyring, phrase.entropy);
    const sealedKey = over.masterKey ? generateKey(keyring) : masterKey;
    const publicKey = over.publicKey
      ? deriveRecoveryKeys(keyring, generateRecoveryPhrase(keyring).entropy).keyslotPublicKey
      : recovery.keyslotPublicKey;
    // As stored bytes: the check takes any bytes, not only a sealed envelope.
    const envelope: Uint8Array = sealRecoveryEnvelope(
      header(),
      VAULT_ID,
      vaultKey,
      recovery.envelopeKey,
      sealedKey,
      metadata(publicKey),
    );
    return {
      keyring,
      envelope,
      subkeys: deriveMasterSubkeys(keyring, masterKey),
      publicKey,
      words: phrase.words,
    };
  }

  function check(v: ReturnType<typeof vault>, words = v.words, vaultId = VAULT_ID) {
    const typed = new Keyring();
    try {
      return checkRecoveryEnvelope(
        v.envelope,
        vaultId,
        parseRecoveryPhrase(typed, words),
        v.subkeys,
        v.publicKey,
      );
    } finally {
      typed.wipeAll();
    }
  }

  it('reports that the phrase opens the envelope to this vault and its backups', () => {
    expect(check(vault())).toBe('opens');
  });

  it('accepts the phrase as typed: uppercase, newlines, extra spaces', () => {
    const v = vault();
    expect(check(v, `  ${v.words.toUpperCase().split(' ').join('\n ')} `)).toBe('opens');
  });

  it('reports another valid phrase as wrong, and the same for another vault', () => {
    const v = vault();
    expect(check(v, generateRecoveryPhrase(new Keyring()).words)).toBe('wrong-phrase');
    expect(check(v, v.words, randomId())).toBe('wrong-phrase');
  });

  it('reports a record that is not a Recovery Envelope as a wrong phrase', () => {
    const v = vault();
    expect(check({ ...v, envelope: fromHex(r.vaultKeyRecord.envelope) })).toBe('wrong-phrase');
    expect(check({ ...v, envelope: new Uint8Array(3) })).toBe('wrong-phrase');
  });

  it('reports a recovery keyslot public key that the phrase does not derive (D24)', () => {
    expect(check(vault({ publicKey: 'other' }))).toBe('public-key-mismatch');
  });

  it('reports an envelope whose Master Key is not this vault one (D180)', () => {
    expect(check(vault({ masterKey: 'other' }))).toBe('master-key-mismatch');
    // Both wrong: the Master Key is reported, since the envelope recovers another vault.
    expect(check(vault({ masterKey: 'other', publicKey: 'other' }))).toBe('master-key-mismatch');
  });

  it('keeps nothing it derived, and leaves the caller keys alone', () => {
    const v = vault();
    const typed = new Keyring();
    const entropy = parseRecoveryPhrase(typed, v.words);
    const size = v.keyring.size;
    expect(checkRecoveryEnvelope(v.envelope, VAULT_ID, entropy, v.subkeys, v.publicKey)).toBe(
      'opens',
    );
    expect(typed.size).toBe(1);
    expect(v.keyring.size).toBe(size);
    expect(keyBytes(entropy)).toHaveLength(32);
  });

  it('throws KeyWipedError for wiped keys, never a check result', () => {
    const v = vault();
    const typed = new Keyring();
    const entropy = parseRecoveryPhrase(typed, v.words);
    typed.wipeAll();
    expect(() =>
      checkRecoveryEnvelope(v.envelope, VAULT_ID, entropy, v.subkeys, v.publicKey),
    ).toThrow(KeyWipedError);
    const again = new Keyring();
    const fresh = parseRecoveryPhrase(again, v.words);
    v.keyring.wipeAll();
    expect(() =>
      checkRecoveryEnvelope(v.envelope, VAULT_ID, fresh, v.subkeys, v.publicKey),
    ).toThrow(KeyWipedError);
  });
});

describe('checkBackupRecoveryEnvelope (backup-format.md §8 step 8, D43)', () => {
  function backup(over: { masterKey?: 'other'; publicKey?: 'other'; phrase?: 'other' } = {}) {
    const keyring = new Keyring();
    const vaultKey = generateKey(keyring);
    const masterKey = generateKey(keyring);
    const phrase = generateRecoveryPhrase(keyring);
    const recovery = deriveRecoveryKeys(keyring, phrase.entropy);
    const sealer =
      over.phrase === 'other'
        ? deriveRecoveryKeys(keyring, generateRecoveryPhrase(keyring).entropy)
        : recovery;
    const publicKey = over.publicKey
      ? deriveRecoveryKeys(keyring, generateRecoveryPhrase(keyring).entropy).keyslotPublicKey
      : recovery.keyslotPublicKey;
    const envelope: Uint8Array = sealRecoveryEnvelope(
      header(),
      VAULT_ID,
      vaultKey,
      sealer.envelopeKey,
      over.masterKey ? generateKey(keyring) : masterKey,
      metadata(publicKey),
    );
    return { keyring, envelope, masterKey, recovery, publicKey };
  }

  function check(v: ReturnType<typeof backup>, vaultId = VAULT_ID, bytes = v.envelope) {
    return checkBackupRecoveryEnvelope(bytes, vaultId, v.recovery, v.masterKey, v.publicKey);
  }

  it('reports an envelope that opens to the payload Master Key with the phrase key pair', () => {
    expect(check(backup())).toBe('opens');
  });

  it('reports an envelope holding another Master Key (D43)', () => {
    expect(check(backup({ masterKey: 'other' }))).toBe('master-key-mismatch');
    // Both wrong: the Master Key comes first, as in Check Recovery Phrase.
    expect(check(backup({ masterKey: 'other', publicKey: 'other' }))).toBe('master-key-mismatch');
  });

  it('reports an mk that does not open with the phrase as a Master Key mismatch', () => {
    const v = backup({ phrase: 'other' });
    expect(check(v)).toBe('master-key-mismatch');
    expect(check(backup(), randomId())).toBe('master-key-mismatch');
    expect(check(v, VAULT_ID, fromHex(r.vaultKeyRecord.envelope))).toBe('master-key-mismatch');
    expect(check(v, VAULT_ID, new Uint8Array(3))).toBe('master-key-mismatch');
  });

  it('reports a keyslot public key that the phrase does not derive (D43)', () => {
    expect(check(backup({ publicKey: 'other' }))).toBe('public-key-mismatch');
    const v = backup();
    expect(
      checkBackupRecoveryEnvelope(
        v.envelope,
        VAULT_ID,
        v.recovery,
        v.masterKey,
        v.publicKey.subarray(0, 31),
      ),
    ).toBe('public-key-mismatch');
  });

  it('keeps nothing it opened, and leaves the caller keys alone', () => {
    const v = backup();
    const size = v.keyring.size;
    expect(check(v)).toBe('opens');
    expect(v.keyring.size).toBe(size);
    expect(keyBytes(v.masterKey)).toHaveLength(32);
    expect(keyBytes(v.recovery.envelopeKey)).toHaveLength(32);
  });

  it('throws KeyWipedError for wiped keys, never a check result', () => {
    const v = backup();
    v.keyring.wipeAll();
    expect(() => check(v)).toThrow(KeyWipedError);
  });
});
