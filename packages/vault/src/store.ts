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

/** One atomic write: records put and deleted, and the whole new Local Config (D62, D82). */
export interface Commit {
  readonly put: readonly StoredRecord[];
  readonly delete: readonly RecordKey[];
  /** The deterministic CBOR Local Config (`record-content.md` §9), cleartext and encrypted parts. */
  readonly localConfig: Uint8Array;
}

export interface RecordStore {
  /** Every record held, read once at unlock. */
  records(): Promise<readonly StoredRecord[]>;
  /** Applies `commit` in one transaction: all of it or none of it. */
  commit(commit: Commit): Promise<void>;
}
