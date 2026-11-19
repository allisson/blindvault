// The record-store interface the vault session writes through (D163). `packages/storage`
// implements it over IndexedDB; this package never touches IndexedDB.

import { type EncryptedRecord, type RecordType } from '@blindvault/crypto';

/** A record's identity in storage: the pair (`recordType`, `recordId`), never `recordId` alone (D158). */
export interface RecordKey {
  readonly recordType: RecordType;
  readonly recordId: Uint8Array;
}

/** A record as stored: its key and its sealed envelope (`crypto-spec.md` §9.2), never plaintext. */
export type StoredRecord = EncryptedRecord;

/** An attachment's blob as written, named by the BLAKE2b-256 of its bytes (attachments.md §2). */
export interface StoredBlob {
  readonly blobId: Uint8Array;
  readonly blob: Uint8Array;
}

/** One atomic write: records put and deleted, and the whole new Local Config (D62, D82). */
export interface Commit {
  readonly put: readonly StoredRecord[];
  readonly delete: readonly RecordKey[];
  /** The deterministic CBOR Local Config (`record-content.md` §9), cleartext and encrypted parts. */
  readonly localConfig: Uint8Array;
  /** The blobs of new attachments, written with their items (attachments.md §4). */
  readonly putBlobs?: readonly StoredBlob[];
}

export interface RecordStore {
  /** Every record held, read once at unlock. */
  records(): Promise<readonly StoredRecord[]>;
  /** The record of `key`, or `undefined` when none is held: an Item Version read again (D277). */
  record(key: RecordKey): Promise<StoredRecord | undefined>;
  /** Applies `commit` in one transaction: all of it or none of it. */
  commit(commit: Commit): Promise<void>;
  /** The `blobId` of every blob held (attachments.md §5). */
  blobIds(): Promise<readonly Uint8Array[]>;
  /** Deletes the blobs of `blobIds` in one transaction: blob collection (attachments.md §5). */
  deleteBlobs(blobIds: readonly Uint8Array[]): Promise<void>;
}
