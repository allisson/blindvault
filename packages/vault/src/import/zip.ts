// The zip imports (1Password `.1pux`, Dashlane `.zip`, Proton Pass `.zip`), read with fflate's
// `unzipSync` only (architecture.md): it inflates each entry into a buffer of the size its header
// declares, so the caps of D130 hold on the declared sizes, checked before each entry is inflated.

import { unzipSync } from 'fflate';

import { ImportRejectedError } from '../errors';

export const MAX_ZIP_SIZE = 100 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 10_000;

/** Every entry by name; refused as `too-large` beyond a cap, as `not-this-format` when not a zip. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  let size = 0;
  let entries = 0;
  try {
    const files = unzipSync(bytes, {
      filter: (file) => {
        // A stored entry is copied at its compressed size, which entries can share: count both.
        size += Math.max(file.size, file.originalSize);
        entries++;
        if (entries > MAX_ZIP_ENTRIES || size > MAX_ZIP_SIZE) {
          throw new ImportRejectedError('too-large');
        }
        return true;
      },
    });
    return new Map(Object.entries(files));
  } catch (e) {
    if (e instanceof ImportRejectedError) throw e;
    throw new ImportRejectedError('not-this-format');
  }
}

/** An entry's text, UTF-8. */
export function readText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** The entry's name without its directories. */
export function baseName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}
