// The `.bvault` file as the browser gets it (D181): its name, the download, and the file picked for
// a restore read by ranges. The file is ciphertext only; the Master Key inside it never reaches this
// code (backup-format.md §6).

import { BackupRejectedError } from '@blindvault/backup';
import { type BackupSource } from '@blindvault/crypto';

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** `blindvault-<local date>.bvault`: the vaultId stays out of the name. */
export function backupFileName(at: number): string {
  const d = new Date(at);
  return `blindvault-${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}.bvault`;
}

/** A record that failed verification cannot be decrypted: it is named by its ID (D64, D181). */
export function recordIdPrefix(recordId: Uint8Array): string {
  return [...recordId.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A `phraseId` as the UI shows it, next to the phrase's creation date: a label, not a check (D185). */
export function phraseLabel(phraseId: Uint8Array): string {
  return recordIdPrefix(phraseId);
}

/** How long the object URL outlives the click, so every browser has taken the file. */
const REVOKE_AFTER_MS = 10_000;

/** Hands `file` to the browser as a download named `name`. */
export function download(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, REVOKE_AFTER_MS);
}

/**
 * The file picked for a restore, read by ranges in both passes and in step 11 (backup-format.md §6,
 * §8, D278): never read whole. A file that can no longer be read, changed or removed since it was
 * picked, is `corrupt`, as one that changed between the passes.
 */
export function fileSource(file: Blob): BackupSource {
  return {
    size: file.size,
    read: async (offset, length) => {
      try {
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
      } catch {
        throw new BackupRejectedError('corrupt');
      }
    },
  };
}
