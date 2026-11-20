// Attachments in the app (attachments.md §7, D196, D273, D278): whether a picked file is taken, and
// the download of an opened attachment.

import { MAX_ATTACHMENT_SIZE, blobLength } from '@blindvault/crypto';

export type PickCheck =
  | { readonly kind: 'ok' | 'empty' | 'too-large' }
  | { readonly kind: 'no-room'; readonly usage: number; readonly quota: number };

/**
 * Whether a picked file of `size` bytes is taken, before it is read: an empty file and one above
 * 10 MiB are refused, and so is one whose blob would take the usage above the quota. Without an
 * estimate, room is not checked.
 */
export async function checkPick(
  size: number,
  storage: Pick<StorageManager, 'estimate'> | undefined,
): Promise<PickCheck> {
  if (size < 1) return { kind: 'empty' };
  if (size > MAX_ATTACHMENT_SIZE) return { kind: 'too-large' };
  if (typeof storage?.estimate !== 'function') return { kind: 'ok' };
  let estimate: StorageEstimate;
  try {
    estimate = await storage.estimate();
  } catch {
    return { kind: 'ok' };
  }
  const { usage, quota } = estimate;
  if (usage === undefined || quota === undefined) return { kind: 'ok' };
  return usage + blobLength(size) > quota ? { kind: 'no-room', usage, quota } : { kind: 'ok' };
}

// eslint-disable-next-line no-control-regex -- the control characters are what is replaced
const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/** `name` as a download's file name: unsafe characters become `_`; empty or only dots, `attachment`. */
export function downloadName(name: string): string {
  const safe = name.replace(UNSAFE, '_');
  return /^\.*$/.test(safe) ? 'attachment' : safe;
}

interface SaveEnv {
  readonly document: Pick<Document, 'createElement'>;
  readonly URL: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
}

/**
 * Saves an opened attachment: an `application/octet-stream` Blob whatever its media type, so the
 * browser never renders it in the app's origin (D273), through an `<a download>` whose object URL is
 * revoked right after the click. `bytes` is wiped once the Blob holds its copy.
 */
export function saveAttachment(
  bytes: Uint8Array,
  name: string,
  env: SaveEnv = { document, URL },
): void {
  let url: string;
  try {
    // Opened by libsodium, so backed by an ArrayBuffer.
    const part = bytes as Uint8Array<ArrayBuffer>;
    url = env.URL.createObjectURL(new Blob([part], { type: 'application/octet-stream' }));
  } finally {
    bytes.fill(0);
  }
  try {
    const a = env.document.createElement('a');
    a.href = url;
    a.download = downloadName(name);
    a.click();
  } finally {
    env.URL.revokeObjectURL(url);
  }
}
