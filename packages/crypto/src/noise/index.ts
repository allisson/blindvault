// noise-protocol 3.0.2, index.js (see LICENSE): the algorithms bound together.
// Deviation: `bindNoise` takes the DH, so the official vectors can fix the ephemeral keys; the app
// always uses the default, libsodium's random key pairs.

import { createCipher } from './cipher';
import { createCipherState } from './cipher-state';
import { type Dh, createDh } from './dh';
import { createHash } from './hash';
import { createHandshake } from './handshake-state';
import { createSymmetricState } from './symmetric-state';

export function bindNoise(dh: Dh = createDh()) {
  const hash = createHash({ dh });
  const cipher = createCipher();
  const cipherState = createCipherState({ cipher });
  const symmetricState = createSymmetricState({ hash, cipherState });

  return {
    handshake: createHandshake({ dh, hash, cipher, cipherState, symmetricState }),
    symmetricState,
    cipherState,
  };
}

export type Noise = ReturnType<typeof bindNoise>;
