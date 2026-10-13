// The `.bvault` file as the browser gets it (D181): its name and the download. The file is
// ciphertext only; the Master Key inside it never reaches this code (backup-format.md §6).

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

/** Hands `bytes` to the browser as a download named `name`. */
export function download(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/octet-stream' }));
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
