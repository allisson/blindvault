import { encodeCbor } from '@blindvault/crypto';
import { describe, expect, it } from 'vitest';

import { ContentInvalidError } from './errors';
import {
  DEFAULT_PREFERENCES,
  type LocalConfigState,
  localConfigStateToCbor,
  localConfigToCbor,
  localConfigWithoutReplaces,
  parseLocalConfig,
  readLocalConfigState,
} from './local-config';

const id = (byte: number) => new Uint8Array(16).fill(byte);

describe('Local Config writers (record-content.md §9)', () => {
  it('writes every later-phase key of the encrypted part and reads it back', () => {
    const state: LocalConfigState = {
      preferences: DEFAULT_PREFERENCES,
      hlc: { physicalMs: 1_760_000_000_000, counter: 2, deviceId: id(0x44) },
      lastBackupAt: 1_760_000_000_000,
      lastPhraseId: id(0xe0),
      lastSyncByPeer: [
        [id(1), 1],
        [id(2), 2],
      ],
      seenDevices: [id(1), id(2)],
      seenRetiredDevices: [id(2)],
      rejectedPeers: [id(3)],
    };
    expect(readLocalConfigState(localConfigStateToCbor(state))).toEqual(state);
  });

  it('refuses to write an invalid encrypted part', () => {
    expect(() =>
      localConfigStateToCbor({
        preferences: { ...DEFAULT_PREFERENCES, autoLockMinutes: 0 },
        hlc: { physicalMs: 0, counter: 0, deviceId: id(1) },
      }),
    ).toThrow(new ContentInvalidError('preferences'));
  });

  it('reads stored bytes that are not CBOR as a corrupt Local Config', () => {
    expect(() => parseLocalConfig(new Uint8Array([0xff]))).toThrow(
      new ContentInvalidError('local config'),
    );
  });
});

describe('clearing replacesVaultId (D96)', () => {
  const sealed = (byte: number, length: number) => ({
    n: new Uint8Array(24).fill(byte),
    c: new Uint8Array(length).fill(byte),
  });
  const base = {
    vaultId: id(1),
    localConfigId: id(2),
    kek: { salt: id(3), opslimit: 2, memlimit: 67_108_864, mkWrap: sealed(4, 48) },
    encrypted: sealed(5, 64),
  };

  it('drops only replacesVaultId, keeping the PRF wrap and every other byte', () => {
    const prf = {
      credentialId: new Uint8Array([7]),
      prfInput: new Uint8Array(32),
      mkWrap: sealed(6, 48),
    };
    const replacing = encodeCbor(localConfigToCbor({ ...base, prf, replacesVaultId: id(9) }));
    const cleared = localConfigWithoutReplaces(replacing);
    expect(parseLocalConfig(cleared)).toEqual({ ...base, prf });
    expect(cleared).toEqual(encodeCbor(localConfigToCbor({ ...base, prf })));
    const plain = encodeCbor(localConfigToCbor(base));
    expect(localConfigWithoutReplaces(plain)).toEqual(plain);
  });

  it('refuses a Local Config it cannot read', () => {
    expect(() => localConfigWithoutReplaces(new Uint8Array([0xff]))).toThrow(ContentInvalidError);
  });
});
