// A picked file sealed as an attachment (attachments.md §2, §3, D278): its blob under a new random
// key, and the `attachment` value its item holds, with the name and media type as stored.

import { MAX_ATTACHMENT_SIZE, sealBlob } from '@blindvault/crypto';

import { ContentInvalidError } from './errors';
import { type AttachmentValue, attachmentMediaType, attachmentName } from './item';
import { type StoredBlob } from './store';

/** A file the user picked: its name and type as the browser gives them, and its bytes. */
export interface PickedFile {
  readonly name: string;
  readonly type: string;
  /** Wiped once sealed, or once refused. */
  readonly bytes: Uint8Array;
}

export interface SealedAttachment {
  /** The field's value; the caller wipes its `key` once the item is written. */
  readonly value: AttachmentValue;
  /** The blob, written with its item (attachments.md §4). */
  readonly blob: StoredBlob;
}

/**
 * Seals `file` under a new key. An empty file or one above 10 MiB throws `ContentInvalidError`
 * (`attachment size`). The plaintext is wiped either way.
 */
export function sealAttachment(file: PickedFile): SealedAttachment {
  try {
    const size = file.bytes.length;
    if (size < 1 || size > MAX_ATTACHMENT_SIZE) throw new ContentInvalidError('attachment size');
    const { blob, blobId, key } = sealBlob(file.bytes);
    return {
      value: {
        name: attachmentName(file.name),
        size,
        mediaType: attachmentMediaType(file.type),
        blobId,
        key,
      },
      blob: { blobId: blobId.slice(), blob },
    };
  } finally {
    file.bytes.fill(0);
  }
}
