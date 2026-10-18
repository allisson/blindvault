import { RecordType } from '@blindvault/crypto';
import { describe, expect, it } from 'vitest';

import { MemoryStore } from './memory-store';

describe('MemoryStore', () => {
  it('deletes nothing but Item Versions, as storage does, writing nothing (CRYPTO-INV-013, D224)', async () => {
    const store = new MemoryStore();
    const recordId = new Uint8Array(16).fill(1);
    const commit = (recordType: RecordType) =>
      store.commit({ put: [], delete: [{ recordType, recordId }], localConfig: Uint8Array.of(1) });
    await expect(commit(RecordType.item)).rejects.toThrow('only an Item Version is ever deleted');
    expect(store.commits).toEqual([]);
    await commit(RecordType.itemVersion);
    expect(store.commits).toHaveLength(1);
  });
});
