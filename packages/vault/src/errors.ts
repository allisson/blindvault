// Errors carry fixed messages only: never item content, a key or any other secret.

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
 * Why an action is refused on a record (overview §6, D39, D52, D74, D143): content from a newer app
 * version, an HLC beyond the future-clock bound, a record in the trash, a record not in the trash,
 * or a purged tombstone.
 */
export type BlockedReason =
  'newer-content' | 'future-clock' | 'in-trash' | 'not-in-trash' | 'purged';

/** The action would write a record it may not write; nothing was written. */
export class RecordBlockedError extends VaultError {
  override name = 'RecordBlockedError';
  constructor(readonly reason: BlockedReason) {
    super(`action blocked: ${reason}`);
  }
}
