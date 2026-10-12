// Record content padding (crypto-spec.md §9.3, D92): `sodium_pad` to 256-byte blocks.

import { EncodingError } from './errors';
import { lib } from './sodium';

export const PAD_BLOCK = 256;

/** Pads to a multiple of 256 bytes; always adds 1 to 256 bytes. */
export function pad(content: Uint8Array): Uint8Array {
  return lib().pad(content, PAD_BLOCK);
}

/**
 * Removes the padding. `sodium_unpad` does not check that the length is a multiple of the block,
 * so this does (crypto-spec.md §9.5 step 5); any failure is one `EncodingError`.
 */
export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length === 0 || padded.length % PAD_BLOCK !== 0) {
    throw new EncodingError('invalid padding');
  }
  try {
    return lib().unpad(padded, PAD_BLOCK);
  } catch {
    throw new EncodingError('invalid padding');
  }
}
