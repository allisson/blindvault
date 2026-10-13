// Errors carry fixed messages only: never a key, a secret or file contents (CRYPTO-INV-005).

/**
 * Why a `.bvault` file was refused (backup-format.md §7, §8, D95):
 * - `not-a-backup`: wrong magic or `formatVersion` 0;
 * - `newer-version`: a `formatVersion` this app does not know, so the backup needs a newer app;
 * - `malformed`: a header, keyslot or payload outside its exact v1 shape;
 * - `corrupt`: the stream does not authenticate in full: truncated, tampered or trailing data;
 * - `wrong-secret`: the keyslot did not open with that Recovery Phrase or export password, which
 *   is also what a tampered keyslot gives (§8);
 * - `no-password-keyslot`: the file opens only with the Recovery Phrase;
 * - `newer-record`: a record with an unknown `recordFormatVersion` or `recordType`, so the backup
 *   needs a newer app (D61, D81);
 * - `corrupt-record`: a record fails verification on receipt or repeats another's identity; the
 *   error names it when it decodes (D64);
 * - `envelope-mismatch`: no Recovery Envelope, or one for another phrase than the header's (D178);
 * - `master-key-mismatch`: the Recovery Envelope does not open, with the phrase, to the payload's
 *   Master Key (D43);
 * - `public-key-mismatch`: the Recovery Envelope's keyslot public key is not the phrase's (D43).
 */
export type BackupRejection =
  | 'not-a-backup'
  | 'newer-version'
  | 'malformed'
  | 'corrupt'
  | 'wrong-secret'
  | 'no-password-keyslot'
  | 'newer-record'
  | 'corrupt-record'
  | 'envelope-mismatch'
  | 'master-key-mismatch'
  | 'public-key-mismatch';

/** The record a `corrupt-record` rejection names: its type and `recordId`, never its contents. */
export interface RejectedRecord {
  readonly recordType: number;
  readonly recordId: Uint8Array;
}

export class BackupRejectedError extends Error {
  override name = 'BackupRejectedError';
  constructor(
    readonly reason: BackupRejection,
    readonly record?: RejectedRecord,
  ) {
    super(`backup rejected: ${reason}`);
  }
}
