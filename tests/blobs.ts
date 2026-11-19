// Attachments for the protocol tests: the blob store the app wires to the vault
// (`apps/web/src/app/blobs.ts`), and a sealed blob with the field that cites it.

import { sealBlob } from '@blindvault/crypto';
import type { BlobStore } from '@blindvault/sync';
import type { BlobGrant, ItemInput, RejectedRecord } from '@blindvault/vault';

/** The vault's blobs through `grant`, read when each call runs; a rejected blob lands in `rejected`. */
export function vaultBlobs(grant: () => BlobGrant, rejected: RejectedRecord[] = []): BlobStore {
  return {
    lacking: () => grant().lacking(),
    read: (id) => grant().read(id),
    discard: (id) => grant().discard(id),
    write: (id, blob) => grant().write(id, blob),
    rejected: (id) => {
      for (const record of grant().citing(id)) {
        rejected.push({ reason: 'verification-failed', record });
      }
      return Promise.resolve();
    },
  };
}

/** A file of `size` bytes of `byte`, sealed: its blob as stored, and a login citing it. */
export function attachment(title: string, byte: number, size = 3) {
  const { blob, blobId, key } = sealBlob(new Uint8Array(size).fill(byte));
  const item: ItemInput = {
    templateId: 'login',
    templateVersion: 1,
    title,
    fields: [
      { type: 'secret', role: 'password', value: 'hunter2-very-secret' },
      {
        type: 'attachment',
        value: { name: 'scan.pdf', size, mediaType: 'application/pdf', blobId, key },
      },
    ],
    tags: [],
  };
  return { blob, blobId, stored: { blobId, blob }, item };
}
