// An in-memory `BlobStore` for the protocol tests, alongside `memoryPair`: it holds blobs by
// `blobId` and lacks every cited ID it does not hold, and records what the blob phase wrote,
// rejected and discarded.

import { blobId } from '@blindvault/crypto';

import type { BlobStore } from './blobs';

function hex(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += b.toString(16).padStart(2, '0');
  return text;
}

export interface MemoryBlobStore extends BlobStore {
  /** The blobs held, by `blobId` in hex; a test may put a blob under another ID. */
  readonly held: Map<string, Uint8Array>;
  /** The IDs the records cite, by hex. */
  readonly cited: Map<string, Uint8Array>;
  readonly written: Uint8Array[];
  readonly rejectedIds: Uint8Array[];
  readonly discarded: Uint8Array[];
  /** Holds `blobs`, each under its own `blobId`, and cites them. */
  hold(...blobs: Uint8Array[]): void;
  /** Cites `ids`, held or not. */
  cite(...ids: Uint8Array[]): void;
}

/** A store holding `blobs` and citing them, then whatever `cite` adds. */
export function memoryBlobStore(...blobs: Uint8Array[]): MemoryBlobStore {
  const held = new Map<string, Uint8Array>();
  const cited = new Map<string, Uint8Array>();
  const store: MemoryBlobStore = {
    held,
    cited,
    written: [],
    rejectedIds: [],
    discarded: [],
    hold: (...more) => {
      for (const blob of more) {
        const id = blobId(blob);
        held.set(hex(id), blob);
        cited.set(hex(id), id);
      }
    },
    cite: (...ids) => {
      for (const id of ids) cited.set(hex(id), id.slice());
    },
    lacking: () =>
      Promise.resolve([...cited].filter(([key]) => !held.has(key)).map(([, id]) => id.slice())),
    read: (id) => Promise.resolve(held.get(hex(id))?.slice()),
    discard: (id) => {
      store.discarded.push(id.slice());
      held.delete(hex(id));
      return Promise.resolve();
    },
    write: (id, blob) => {
      store.written.push(id.slice());
      held.set(hex(id), blob.slice());
      return Promise.resolve();
    },
    rejected: (id) => {
      store.rejectedIds.push(id.slice());
      return Promise.resolve();
    },
  };
  store.hold(...blobs);
  return store;
}
