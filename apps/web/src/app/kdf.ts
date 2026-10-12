// The Argon2id worker (architecture.md): one worker per request, terminated by the client.

import { type KdfPort } from '@blindvault/crypto';
import KdfWorker from '@blindvault/crypto/kdf.worker?worker';

export function kdfWorker(): KdfPort {
  return new KdfWorker() as unknown as KdfPort;
}
