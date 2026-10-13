// The Recovery Envelope record (crypto-spec.md §11, D2, D16, D24).

import { describe, expect, it } from 'vitest';

import { type CborMap, type CborValue } from './cbor';
import { DecryptionError, EncodingError } from './errors';
import { recoveryEnvelopeRecordId } from './ids';
import { Keyring, adoptKey, generateKey, keyBytes } from './keys';
import { type RecordHeader } from './layout';
import {
  RecordType,
  type VerificationKeys,
  decodeEnvelope,
  encodeEnvelope,
  openRecoveryEnvelope,
  sealRecoveryEnvelope,
  verifyRecord,
} from './record';
import { deriveRecoveryKeys, generateRecoveryPhrase } from './recovery';
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
