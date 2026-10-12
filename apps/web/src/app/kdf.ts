// The Argon2id worker (architecture.md): one worker per request, terminated by the client.

import { type KdfPort } from '@blindvault/crypto';
import workerUrl from '@blindvault/crypto/kdf.worker?worker&url';

interface ScriptUrlPolicy {
  createScriptURL(input: string): unknown;
}

interface TrustedTypes {
  createPolicy(
    name: string,
    rules: { createScriptURL: (input: string) => string },
  ): ScriptUrlPolicy;
}

/** The policy's rule: only `expected` becomes a script URL, so it can vouch for nothing else (D83). */
export function onlyUrl(expected: string): (input: string) => string {
  return (input) => {
    if (input !== expected) throw new TypeError('not the Argon2id worker');
    return input;
  };
}

let policy: ScriptUrlPolicy | undefined;

/** The worker URL as a TrustedScriptURL where the CSP requires Trusted Types, else as is. */
function scriptUrl(): string {
  const factory = (globalThis as { trustedTypes?: TrustedTypes }).trustedTypes;
  if (!factory) return workerUrl;
  policy ??= factory.createPolicy('blindvault-kdf-worker', { createScriptURL: onlyUrl(workerUrl) });
  // The Worker constructor takes a TrustedScriptURL where the DOM types say string.
  return policy.createScriptURL(workerUrl) as string;
}

export function kdfWorker(): KdfPort {
  return new Worker(scriptUrl(), { type: 'module' }) as unknown as KdfPort;
}
