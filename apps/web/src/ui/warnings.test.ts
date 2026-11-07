// The warnings of states only someone holding the Master Key makes (a forged backup or vault): each
// condition, tested where it is detected, reaches its user as its own text (UX Gate).

import { RecordType } from '@blindvault/crypto';
import { describe, expect, it } from 'vitest';

import { MESSAGES } from '../i18n/messages';
import { mergeError } from './MergeBackup';
import { resetError } from './ResetPassword';
import { openingError, restoreError } from './RestoreVault';

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

describe('a vault changed with the Master Key', () => {
  it('a reset refuses a Recovery Envelope that opens but not this vault (D184)', () => {
    expect(resetError(m, { kind: 'master-key-mismatch' })).toBe(
      'This phrase opens the Recovery Envelope held here, but not this vault: the storage is damaged, or someone holding the Master Key changed it. Replace the vault with a backup.',
    );
  });
});
