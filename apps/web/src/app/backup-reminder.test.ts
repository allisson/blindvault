import { describe, expect, it } from 'vitest';

import { BACKUP_INTERVAL_MS, backupReminderOf } from './backup-reminder';

const T0 = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** `phraseCreatedAt` null: a vault without a Recovery Envelope. */
function source(lastBackupAt: number | undefined, phraseCreatedAt: number | null = T0) {
  return {
    lastBackupAt,
    recovery: phraseCreatedAt === null ? undefined : { phraseCreatedAt },
  };
}

describe('backup reminder (§13.4, D188)', () => {
  it('is a fixed 30 days', () => {
    expect(BACKUP_INTERVAL_MS).toBe(30 * DAY);
  });

  it('is due when no backup was made on this device', () => {
    expect(backupReminderOf(source(undefined), T0)).toEqual({ kind: 'never' });
  });

  it('is due from exactly 30 days after the last backup, not a millisecond before', () => {
    const at = T0 + DAY;
    expect(backupReminderOf(source(at), at + 30 * DAY - 1)).toBeUndefined();
    expect(backupReminderOf(source(at), at + 30 * DAY)).toEqual({ kind: 'stale', at });
    expect(backupReminderOf(source(at), at + 400 * DAY)).toEqual({ kind: 'stale', at });
  });

  it('is due when the last backup predates the current Recovery Phrase, however recent (D185)', () => {
    const at = T0 - 1;
    expect(backupReminderOf(source(at), T0)).toEqual({ kind: 'old-phrase', at });
    // A backup made the same millisecond as the phrase opens with it.
    expect(backupReminderOf(source(T0), T0)).toBeUndefined();
  });

  it('counts a last backup dated in the future as recent, until the clock passes it by 30 days', () => {
    const at = T0 + 90 * DAY;
    expect(backupReminderOf(source(at), T0)).toBeUndefined();
    expect(backupReminderOf(source(at), at + 30 * DAY)).toEqual({ kind: 'stale', at });
  });

  it('is never due for a vault without a Recovery Envelope, which cannot export (D179)', () => {
    expect(backupReminderOf(source(undefined, null), T0)).toBeUndefined();
    expect(backupReminderOf(source(T0, null), T0 + 400 * DAY)).toBeUndefined();
  });
});
