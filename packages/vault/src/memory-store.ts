// An in-memory `RecordStore` for tests: commits are atomic and recorded, and one can be made to fail.
// Like `packages/storage`, it deletes nothing but Item Versions (CRYPTO-INV-013, D224), and holds
// blobs by `blobId`.

import { RecordType } from '@blindvault/crypto';

import { idBytes, idKey } from './ids';
import {
  type Commit,
  type RecordKey,
  type RecordStore,
  type StoredBlob,
  type StoredRecord,
} from './store';

function key(k: RecordKey): string {
  return `${String(k.recordType)}:${idKey(k.recordId)}`;
}

export class MemoryStore implements RecordStore {
  readonly held = new Map<string, StoredRecord>();
  readonly commits: Commit[] = [];
  /** Blobs by `blobId` in hex. */
  readonly blobs = new Map<string, Uint8Array>();
  /** Every `deleteBlobs` call, in order. */
  readonly blobDeletes: Uint8Array[][] = [];
  localConfig: Uint8Array = new Uint8Array(0);
  /** The next commit rejects, writing nothing. */
  failNext = false;
  /** While set, commits wait for it before applying. */
  gate: Promise<void> | undefined;

  records(): Promise<readonly StoredRecord[]> {
    return Promise.resolve([...this.held.values()]);
  }

  record(k: RecordKey): Promise<StoredRecord | undefined> {
    return Promise.resolve(this.held.get(key(k)));
  }

  async commit(commit: Commit): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('storage failure');
    }
    if (commit.delete.some((d) => d.recordType !== RecordType.itemVersion)) {
      throw new Error('only an Item Version is ever deleted');
    }
    this.commits.push(commit);
    for (const d of commit.delete) this.held.delete(key(d));
    for (const p of commit.put) this.held.set(key(p), p);
    for (const b of commit.putBlobs ?? []) this.blobs.set(idKey(b.blobId), b.blob);
    this.localConfig = commit.localConfig;
  }

  blobIds(): Promise<readonly Uint8Array[]> {
    return Promise.resolve([...this.blobs.keys()].map(idBytes));
  }

  deleteBlobs(blobIds: readonly Uint8Array[]): Promise<void> {
    this.blobDeletes.push(blobIds.map((id) => id.slice()));
    for (const id of blobIds) this.blobs.delete(idKey(id));
    return Promise.resolve();
  }

  blob(blobId: Uint8Array): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.blobs.get(idKey(blobId)));
  }

  /** Writes a blob in its own transaction, as a sync or a restore does; a test calls it too. */
  putBlob(b: StoredBlob): Promise<void> {
    if (!this.blobs.has(idKey(b.blobId))) this.blobs.set(idKey(b.blobId), b.blob);
    return Promise.resolve();
  }

  get(k: RecordKey): StoredRecord | undefined {
    return this.held.get(key(k));
  }

  put(record: StoredRecord): void {
    this.held.set(key(record), record);
  }

  ofType(recordType: number): StoredRecord[] {
    return [...this.held.values()].filter((r) => r.recordType === recordType);
  }
}
