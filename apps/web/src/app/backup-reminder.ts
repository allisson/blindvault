// The backup reminder (§13.4, D188): due when no backup was made on this device, when the last one
// predates the current Recovery Phrase (D185), or when it is 30 days old or more by this device's
// clock. A vault without a Recovery Envelope cannot export (D179) and gets none.

/** The fixed backup interval of v1 (D188). */
export const BACKUP_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `never`: no backup made on this device. `old-phrase`: the last one, at `at`, does not open with
 * the current Recovery Phrase. `stale`: the last one, at `at`, is 30 days old or more.
 */
export type BackupReminder =
  { readonly kind: 'never' } | { readonly kind: 'old-phrase' | 'stale'; readonly at: number };

interface ReminderSource {
  readonly lastBackupAt: number | undefined;
  readonly recovery: { readonly phraseCreatedAt: number } | undefined;
}

export function backupReminderOf(session: ReminderSource, now: number): BackupReminder | undefined {
  const { recovery } = session;
  if (!recovery) return undefined;
  const at = session.lastBackupAt;
  if (at === undefined) return { kind: 'never' };
  if (at < recovery.phraseCreatedAt) return { kind: 'old-phrase', at };
  // A date in the future (the clock went back) counts as recent until the clock passes it.
  if (now - at >= BACKUP_INTERVAL_MS) return { kind: 'stale', at };
  return undefined;
}
