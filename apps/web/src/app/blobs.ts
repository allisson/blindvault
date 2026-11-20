// The blob store of the blob phase (`sync-protocol.md` §10.1, attachments.md §6): the vault's
// blobs through its grant. A received blob that does not match its `blobId` is reported like a
// rejected record, naming each item that cites it, and the session goes on (D278).

import type { BlobStore } from '@blindvault/sync';
import type { BlobGrant, RejectedRecord } from '@blindvault/vault';

/**
 * The blobs of `grant`, read when each call runs: B's pairing has a vault only once it committed.
 * `rejected` is told the items a mismatched blob would have served; none when no item cites it.
 * `written` is told each blob written, so an attachment waiting for it checks again (§7).
 */
export function vaultBlobs(
  grant: () => BlobGrant,
  rejected: (records: readonly RejectedRecord[]) => void,
  written: () => void = () => undefined,
): BlobStore {
  return {
    lacking: () => grant().lacking(),
    read: (id) => grant().read(id),
    discard: (id) => grant().discard(id),
    write: async (id, blob) => {
      await grant().write(id, blob);
      written();
    },
    rejected: (id) => {
      const items = grant().citing(id);
      if (items.length > 0) {
        rejected(items.map((record) => ({ reason: 'verification-failed' as const, record })));
      }
      return Promise.resolve();
    },
  };
}
