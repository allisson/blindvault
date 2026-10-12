// Errors carry fixed messages only: never a key, a secret or file contents (CRYPTO-INV-005).

/**
 * Why a `.bvault` file was refused (backup-format.md §7, D95):
 * - `not-a-backup`: wrong magic or `formatVersion` 0;
 * - `newer-version`: a `formatVersion` this app does not know, so the backup needs a newer app;
 * - `malformed`: a header, keyslot or payload outside its exact v1 shape;
 * - `corrupt`: the stream does not authenticate in full: truncated, tampered or trailing data;
 * - `wrong-secret`: the keyslot did not open with that Recovery Phrase or export password, which
 *   is also what a tampered keyslot gives (§8);
 * - `no-password-keyslot`: the file opens only with the Recovery Phrase.
 */
export type BackupRejection =
  | 'not-a-backup'
  | 'newer-version'
  | 'malformed'
  | 'corrupt'
  | 'wrong-secret'
  | 'no-password-keyslot';

export class BackupRejectedError extends Error {
  override name = 'BackupRejectedError';
  constructor(readonly reason: BackupRejection) {
    super(`backup rejected: ${reason}`);
  }
}
