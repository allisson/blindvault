import { RecordType } from '@blindvault/crypto';
import { type BlobGrant, type RecordKey, type RejectedRecord } from '@blindvault/vault';
import { describe, expect, it } from 'vitest';

import { vaultBlobs } from './blobs';

describe('vaultBlobs (attachments.md §6, D278)', () => {
  const id = new Uint8Array(32).fill(1);
  const blob = new Uint8Array(42).fill(2);

  function grant(citing: RecordKey[]) {
    const calls: string[] = [];
    const g: BlobGrant = {
      lacking: () => {
        calls.push('lacking');
        return Promise.resolve([id]);
      },
      read: () => {
        calls.push('read');
        return Promise.resolve(blob);
      },
      discard: () => {
        calls.push('discard');
        return Promise.resolve();
      },
      write: () => {
        calls.push('write');
        return Promise.resolve();
      },
      citing: () => citing,
    };
    return { g, calls };
  }

  it('reads and writes through the grant, taken when each call runs', async () => {
    const { g, calls } = grant([]);
    let taken = 0;
    const store = vaultBlobs(
      () => {
        taken++;
        return g;
      },
      () => undefined,
    );
    expect(taken).toBe(0);
    expect(await store.lacking()).toEqual([id]);
    expect(await store.read(id)).toEqual(blob);
    await store.discard(id);
    await store.write(id, blob);
    expect(calls).toEqual(['lacking', 'read', 'discard', 'write']);
    expect(taken).toBe(4);
  });

  it('reports a rejected blob as a rejected record of each item citing it, or not at all', async () => {
    const item: RecordKey = { recordType: RecordType.item, recordId: new Uint8Array(16).fill(3) };
    const reported: (readonly RejectedRecord[])[] = [];
    await vaultBlobs(
      () => grant([item]).g,
      (records) => reported.push(records),
    ).rejected(id);
    expect(reported).toEqual([[{ reason: 'verification-failed', record: item }]]);
    await vaultBlobs(
      () => grant([]).g,
      (records) => reported.push(records),
    ).rejected(id);
    expect(reported).toHaveLength(1);
  });
});
