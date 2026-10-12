import { beforeAll, describe, expect, it } from 'vitest';

import { EncodingError } from './errors';
import { deviceId, recoveryEnvelopeRecordId, vaultKeyRecordId, versionId } from './ids';
import { Keyring, adoptKey } from './keys';
import { initCrypto } from './sodium';
import { fromHex, hlcFromHex, toHex, vectors } from './test-helpers';

beforeAll(initCrypto);

const ids = vectors.ids;

describe('derived identifiers (crypto-spec.md §4)', () => {
  it('derives deviceId from the static public key (D19)', () => {
    expect(toHex(deviceId(fromHex(ids.deviceId.staticPublicKey)))).toBe(ids.deviceId.deviceId);
    expect(() => deviceId(new Uint8Array(31))).toThrow(EncodingError);
  });

  it('derives the keyed versionId (D6)', () => {
    const keyring = new Keyring();
    const key = adoptKey(keyring, fromHex(ids.versionId.versionIdKey));
    const hlc = hlcFromHex(ids.versionId.hlc);
    expect(toHex(versionId(key, fromHex(ids.versionId.itemId), hlc))).toBe(ids.versionId.versionId);
    expect(
      toHex(versionId(key, fromHex(ids.versionId.itemId), { ...hlc, counter: hlc.counter + 1 })),
    ).not.toBe(ids.versionId.versionId);
  });

  it('derives the fixed Vault Key and Recovery Envelope recordIds', () => {
    expect(toHex(vaultKeyRecordId(ids.vaultKeyRecordId.keyEpoch))).toBe(
      ids.vaultKeyRecordId.recordId,
    );
    expect(toHex(vaultKeyRecordId(2))).not.toBe(ids.vaultKeyRecordId.recordId);
    expect(toHex(recoveryEnvelopeRecordId(fromHex(ids.recoveryEnvelopeRecordId.vaultId)))).toBe(
      ids.recoveryEnvelopeRecordId.recordId,
    );
  });
});
