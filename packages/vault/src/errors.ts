// Errors carry fixed messages only: never item content, a key or any other secret.

import { type RecordKey } from './store';

export class VaultError extends Error {
  override name = 'VaultError';
}

/** A Folder, Device or Local Config value fails `record-content.md` (verification failure). */
export class ContentInvalidError extends VaultError {
  override name = 'ContentInvalidError';
  constructor(readonly what: string) {
    super(`invalid content: ${what}`);
  }
}

/** No HLC can be issued: the HLC state is beyond the future-clock cap (D73). */
export class HlcReadOnlyError extends VaultError {
  override name = 'HlcReadOnlyError';
  constructor() {
    super('the device clock is behind its HLC state: the vault is read-only');
  }
}

/** The session is locked: its keys and decrypted state are gone (CRYPTO-INV-010). */
export class VaultLockedError extends VaultError {
  override name = 'VaultLockedError';
  constructor() {
    super('the vault is locked');
  }
}

/** The password or passkey does not open this vault. Says nothing about why. */
export class UnlockRejectedError extends VaultError {
  override name = 'UnlockRejectedError';
  constructor() {
    super('the password or passkey does not open this vault');
  }
}

export class RecordNotFoundError extends VaultError {
  override name = 'RecordNotFoundError';
  constructor() {
    super('no such record');
  }
}

/**
 * Why an action is refused on a record (overview §6, D39, D52, D74, D143, D171): content from a
 * newer app version, an HLC beyond the future-clock bound, a record in the trash, a record not in
 * the trash, a purged tombstone, or a folder moved into its own subtree.
 */
export type BlockedReason =
  'newer-content' | 'future-clock' | 'in-trash' | 'not-in-trash' | 'purged' | 'cycle';

/** The action would write a record it may not write; nothing was written. */
export class RecordBlockedError extends VaultError {
  override name = 'RecordBlockedError';
  constructor(readonly reason: BlockedReason) {
    super(`action blocked: ${reason}`);
  }
}

/** A record a folder action would write but may not, and why. */
export interface BlockedRecord {
  readonly recordType: number;
  readonly recordId: Uint8Array;
  readonly reason: BlockedReason;
}

/**
 * Trashing or restoring a folder would write read-only records (overview §6, D52): the action is
 * refused as a whole, and `records` lists them for the UI.
 */
export class SubtreeBlockedError extends VaultError {
  override name = 'SubtreeBlockedError';
  constructor(readonly records: readonly BlockedRecord[]) {
    super(`action blocked: ${String(records.length)} read-only records`);
  }
}

/**
 * Why a backup was not made (backup-format.md §8, D64, D179, D181): a record that fails
 * verification, stored now or kept aside at unlock, named by `record`; or no Recovery Envelope to
 * seal the recovery keyslot to (a D177 preview vault). No file was made and nothing was written.
 */
export class ExportRejectedError extends VaultError {
  override name = 'ExportRejectedError';
  constructor(
    readonly reason: 'corrupt-record' | 'no-envelope',
    readonly record?: { readonly recordType: number; readonly recordId: Uint8Array },
  ) {
    super(`export refused: ${reason}`);
  }
}

/**
 * A fresh restore refused as a whole, writing nothing (overview §10, D61, D64): a record of the
 * backup fails the content checks of unlock (D59). `record` names it; the message stays fixed.
 */
export class RestoreRejectedError extends VaultError {
  override name = 'RestoreRejectedError';
  constructor(readonly record: RecordKey) {
    super('restore rejected: a record does not verify');
  }
}
