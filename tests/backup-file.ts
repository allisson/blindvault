// A `.bvault` file as the browser makes it of the parts an export returns (backup-format.md §6).

import type { BackupFile } from '@blindvault/vault';

/** The file's parts joined, as the `Blob` the app downloads holds them. */
export function joined(file: BackupFile): Uint8Array {
  const bytes = new Uint8Array(file.parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of file.parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return bytes;
}
