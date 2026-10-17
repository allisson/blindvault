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

/**
 * Retirement refused (D41, D186): this device's own Device record, or one already retired. Nothing
 * was written.
 */
export class RetirementRefusedError extends VaultError {
  override name = 'RetirementRefusedError';
  constructor(readonly reason: 'own-device' | 'already-retired') {
    super(`retirement refused: ${reason}`);
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
 * Why Recovery Phrase regeneration is blocked (overview §5.4, D185): no Recovery Envelope (a D177
 * preview vault, D179), envelope metadata from a newer app version (D98), a held envelope beyond the
 * future-clock bound (D74), or a vault read-only because the clock went back (D73). `until` is when
 * it becomes possible (Unix ms).
 */
export type RegenerationBlock =
  | { readonly reason: 'no-envelope' | 'newer-content' }
  | { readonly reason: 'future-clock' | 'read-only'; readonly until: number };

/** Regeneration was refused before opening anything; nothing was written. */
export class RegenerationBlockedError extends VaultError {
  override name = 'RegenerationBlockedError';
  constructor(readonly block: RegenerationBlock) {
    super(`regeneration blocked: ${block.reason}`);
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

/**
 * Why a backup merge was refused as a whole, writing nothing (sync-protocol.md §1.1, D13, D57, D64,
 * D182): another vault, another Master Key, a record that fails verification or the content checks
 * (`record`), a record beyond the future-clock bound (`retryAt`, Unix ms), or a record that breaks
 * the immutability of the Vault Key record or the Recovery Envelope (`record`).
 */
export type MergeRejection =
  | 'different-vault'
  | 'master-key-mismatch'
  | 'corrupt-record'
  | 'future-clock'
  | 'immutable-record';

/**
 * Why a forgotten password reset with the Recovery Phrase was refused (D184): no Recovery Envelope
 * held, a phrase that does not open it, or one that opens it to a Master Key that is not this
 * vault's, as this device's Local Config proves.
 */
export type PasswordResetRejection = 'no-envelope' | 'wrong-phrase' | 'master-key-mismatch';

export class PasswordResetRejectedError extends VaultError {
  override name = 'PasswordResetRejectedError';
  constructor(readonly reason: PasswordResetRejection) {
    super(`password reset rejected: ${reason}`);
  }
}

export class MergeRejectedError extends VaultError {
  override name = 'MergeRejectedError';
  constructor(
    readonly reason: MergeRejection,
    readonly record?: RecordKey,
    readonly retryAt?: number,
  ) {
    super(`merge rejected: ${reason}`);
  }
}

/**
 * Why A refuses to pair (pairing-protocol.md §2, §8, D45, D102, D202): its vault is read-only for a
 * clock gone back, its own Device record is retired, a record fails verification (`record`, kept
 * aside at unlock or found when read again before sending), or the joining device's key already
 * has a Device record. Nothing was written.
 */
export type PairingRefusal = 'read-only' | 'retired' | 'corrupt-record' | 'known-device';

export class PairingRefusedError extends VaultError {
  override name = 'PairingRefusedError';
  constructor(
    readonly reason: PairingRefusal,
    readonly record?: RecordKey,
  ) {
    super(`pairing refused: ${reason}`);
  }
}

/**
 * Why this device does not sync with a peer (sync-protocol.md §3, D113, D216): it holds no Device
 * record of its own, its own is retired, it holds no Device record of the peer (or the peer is this
 * device), or the peer's is retired; for a retirement notice, the peer's is not retired (D219). A
 * read-only vault and a record kept aside as corrupt still sync.
 */
export type SyncRefusal =
  'unregistered' | 'retired' | 'unknown-peer' | 'retired-peer' | 'not-retired';

export class SyncRefusedError extends VaultError {
  override name = 'SyncRefusedError';
  constructor(readonly reason: SyncRefusal) {
    super(`sync refused: ${reason}`);
  }
}

/**
 * Why a sync session stops on this device (sync-protocol.md §6, §11.2, D219): the abort reason it
 * sends. `verification-failed`: the peer's retired record it was about to send fails verification;
 * `protocol-error`: a `retired` that is not this device's own Device record, retired and valid.
 * Nothing was written.
 */
export type SyncRejection = 'verification-failed' | 'protocol-error';

export class SyncRejectedError extends VaultError {
  override name = 'SyncRejectedError';
  constructor(readonly reason: SyncRejection) {
    super(`sync rejected: ${reason}`);
  }
}

/**
 * Why B refuses what it received, before its commit (pairing-protocol.md §8 step 5, D202): each
 * reason is the abort reason of §10.3 it sends. `record` names a record that fails verification.
 * Nothing was written.
 */
export type JoinRejection =
  'unsupported-format' | 'verification-failed' | 'retired-peer' | 'protocol-error';

export class JoinRejectedError extends VaultError {
  override name = 'JoinRejectedError';
  constructor(
    readonly reason: JoinRejection,
    readonly record?: RecordKey,
  ) {
    super(`pairing rejected: ${reason}`);
  }
}
