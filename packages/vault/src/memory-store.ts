// An in-memory `RecordStore` for tests: commits are atomic and recorded, and one can be made to fail.

import { idKey } from './ids';
import { type Commit, type RecordKey, type RecordStore, type StoredRecord } from './store';

function key(k: RecordKey): string {
  return `${String(k.recordType)}:${idKey(k.recordId)}`;
}

export class MemoryStore implements RecordStore {
  readonly held = new Map<string, StoredRecord>();
  readonly commits: Commit[] = [];
  localConfig: Uint8Array = new Uint8Array(0);
  /** The next commit rejects, writing nothing. */
  failNext = false;
  /** While set, commits wait for it before applying. */
  gate: Promise<void> | undefined;

  records(): Promise<readonly StoredRecord[]> {
    return Promise.resolve([...this.held.values()]);
  }

  async commit(commit: Commit): Promise<void> {
    if (this.gate) await this.gate;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('storage failure');
    }
    this.commits.push(commit);
    for (const d of commit.delete) this.held.delete(key(d));
    for (const p of commit.put) this.held.set(key(p), p);
    this.localConfig = commit.localConfig;
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
