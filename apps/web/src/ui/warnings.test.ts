// The warnings of states only someone holding the Master Key (a forged backup or vault) or a newer
// app version makes: each condition, tested where it is detected, reaches its user as its own text
// (UX Gate).

import { RecordType } from '@blindvault/crypto';
import { describe, expect, it } from 'vitest';

import { MESSAGES, format } from '../i18n/messages';
import { eraseFailureText } from './EraseVault';
import { mergeError } from './MergeBackup';
import { rejectedText } from './Pairing';
import { rejectedNames } from './RefoundVault';
import { resetError } from './ResetPassword';
import { openingError, restoreError } from './RestoreVault';
import { exportError, incompleteBackupPeers, phraseResult } from './Settings';

const m = MESSAGES.en;
const date = () => 'never';
const named = { recordType: RecordType.vaultKey, recordId: '0a1b2c3d' } as const;

describe('a backup forged with the Master Key', () => {
  it('a merge refuses another Master Key under this vault ID', () => {
    expect(mergeError(m, { kind: 'master-key-mismatch' }, date)).toBe(
      'This backup has the ID of this vault but another Master Key. It cannot be merged.',
    );
  });

  it('a merge names a record that does not verify, and a changed immutable record (D64)', () => {
    expect(mergeError(m, { kind: 'corrupt-record', ...named }, date)).toBe(
      'This backup holds a record that does not verify: Vault Key 0a1b2c3d. It cannot be merged.',
    );
    expect(mergeError(m, { kind: 'immutable-record', ...named }, date)).toBe(
      'This backup holds a changed copy of a record that never changes: Vault Key 0a1b2c3d. It cannot be merged: only someone holding the Master Key, or a bug, makes one.',
    );
  });

  it('a restore refuses a backup that does not match its own Recovery Phrase', () => {
    for (const kind of [
      'envelope-mismatch',
      'master-key-mismatch',
      'public-key-mismatch',
    ] as const) {
      expect(openingError(m, { kind }, 'phrase')).toBe(
        'This backup does not match its own Recovery Phrase. It cannot be restored.',
      );
    }
  });

  it('a restore names a record that does not verify, or says it cannot be read (D64)', () => {
    const text =
      'This backup holds a record that does not verify: Vault Key 0a1b2c3d. It cannot be restored.';
    expect(openingError(m, { kind: 'corrupt-record', ...named }, 'phrase')).toBe(text);
    expect(restoreError(m, { kind: 'corrupt-record', ...named })).toBe(text);
    expect(openingError(m, { kind: 'corrupt-record' }, 'phrase')).toBe(
      'This backup holds a record that cannot be read. It cannot be restored.',
    );
  });
});

describe('records a peer on a newer app version sent, rejected here (D116)', () => {
  const id = (n: number) => new Uint8Array(16).fill(n);
  const phone = {
    deviceId: id(2),
    hlc: { physicalMs: 0, counter: 0, deviceId: id(1) },
    device: {
      publicKey: new Uint8Array(32),
      displayName: 'Phone',
      retired: false,
      registeredAt: 0,
    },
    unknownKeys: [],
  };

  it('re-founding names each peer by its device name, or its ID, in the warning and its confirmation', () => {
    const names = rejectedNames({ devices: () => [phone], rejectedPeers: [id(2), id(0xab)] });
    expect(format(m.refound.warnRejected, { names })).toBe(
      'This device rejected records from Phone, abababab, made by a newer app version. They are not on this device and will be lost: update the app and sync with those devices first.',
    );
    expect(format(m.refound.understandRejected, { names })).toBe(
      'I understand that the records from Phone, abababab are lost.',
    );
  });

  it('the export warns the backup may be incomplete, and each dismissal names its peer and asks first (D227)', () => {
    const peers = incompleteBackupPeers({
      devices: () => [phone],
      rejectedPeers: [id(2), id(0xab)],
    });
    const labels = peers.map((p) => p.label);
    expect(format(m.settings.backupIncomplete, { names: labels.join(', ') })).toBe(
      'Records from Phone, abababab were rejected because they need a newer app version, so this backup may be incomplete. Update the app and sync with them first.',
    );
    expect(labels.map((name) => format(m.settings.backupIncompleteDismiss, { name }))).toEqual([
      'Dismiss for Phone…',
      'Dismiss for abababab…',
    ]);
    expect(format(m.settings.backupIncompleteWarning, { name: 'abababab' })).toBe(
      'The records of abababab that this app rejected are not on this device, and every backup made here will still lack them. Dismiss only for a device that is lost or retired.',
    );
    expect(format(m.settings.backupIncompleteConfirm, { name: 'abababab' })).toBe(
      'Dismiss the warning for abababab',
    );
  });
});

describe('a re-admission or a sync with a peer that sends what this device rejects (D206, D222)', () => {
  it('names each rejected record by its type and ID, or as one that does not decode, with why', () => {
    const key = { recordType: RecordType.item, recordId: new Uint8Array(16).fill(0xcd) };
    const text = rejectedText(m, [
      { reason: 'verification-failed', record: key },
      { reason: 'future-clock', record: key },
      { reason: 'immutable-record', record: { ...key, recordType: RecordType.vaultKey } },
      { reason: 'unsupported-format' },
    ]);
    expect(text).toBe(
      '4 records from the other device were rejected and not merged: Item cdcdcdcd (does not verify), Item cdcdcdcd (dated ahead of this device’s clock), Vault Key cdcdcdcd (a changed copy of a record that never changes), a record that does not decode (from a newer version of BlindVault: update this device). The rest merged.',
    );
  });

  it('a merge whose peer never confirmed its own says to check it there (D207)', () => {
    expect(m.readmission.notCommitted).toBe(
      'This device merged, but the other may not have finished: check it there. Re-admitting again is safe.',
    );
  });
});

describe('a vault changed with the Master Key', () => {
  it('a reset refuses a Recovery Envelope that opens but not this vault (D184)', () => {
    expect(resetError(m, { kind: 'master-key-mismatch' })).toBe(
      'This phrase opens the Recovery Envelope held here, but not this vault: the storage is damaged, or someone holding the Master Key changed it. Replace the vault with a backup.',
    );
  });

  it('Check Recovery Phrase says a phrase that opens the vault but not its backups (D24, D180)', () => {
    expect(phraseResult(m, { kind: 'public-key-mismatch' })).toEqual({
      ok: false,
      text: 'This phrase opens the vault, but backups cannot be opened with it. Regenerate the Recovery Phrase, then make a new backup.',
    });
    expect(phraseResult(m, { kind: 'master-key-mismatch' })).toEqual({
      ok: false,
      text: 'This phrase opens a Recovery Envelope that does not recover this vault, so backups cannot be restored with it. Regenerate the Recovery Phrase, then make a new backup.',
    });
  });
});

describe('a vault an earlier preview build made without a Recovery Phrase (D179)', () => {
  it('the phrase check and the export say it cannot be recovered or backed up', () => {
    expect(phraseResult(m, { kind: 'no-envelope' })).toEqual({
      ok: false,
      text: 'This vault has no Recovery Phrase: the preview build created it, and it cannot be recovered. Create a new vault to get one.',
    });
    expect(exportError(m, { kind: 'no-envelope' })).toBe(
      'This vault has no Recovery Phrase: the preview build created it, so no backup of it could be opened. Create a new vault to get one.',
    );
  });
});

describe('an erase the browser does not carry out (D154, D205)', () => {
  it('says the vault is still here, whether another window held it or the deletion failed', () => {
    expect(eraseFailureText(m, 'busy')).toBe(
      'BlindVault is busy in another window. Nothing was erased.',
    );
    expect(eraseFailureText(m, 'failed')).toBe(
      'The vault could not be erased. It is still on this device, locked.',
    );
  });
});
