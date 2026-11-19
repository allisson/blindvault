// The blob store of the sync and the admissions until the vault serves its blobs (Phase 9, the
// next task wires it): it lacks nothing and holds nothing, so this device asks for no blob and
// answers every ID with `blob-missing`, as `sync-protocol.md` §10.1 lets a device that holds none.

import type { BlobStore } from '@blindvault/sync';

export const NO_BLOBS: BlobStore = {
  lacking: () => Promise.resolve([]),
  read: () => Promise.resolve(undefined),
  discard: () => Promise.resolve(),
  write: () => Promise.resolve(),
  rejected: () => Promise.resolve(),
};
