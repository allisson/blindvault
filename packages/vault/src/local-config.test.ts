import { describe, expect, it } from 'vitest';

import { ContentInvalidError } from './errors';
import {
  DEFAULT_PREFERENCES,
  type LocalConfigState,
  localConfigStateToCbor,
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
