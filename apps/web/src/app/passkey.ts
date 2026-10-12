// The WebAuthn calls for passkey unlock (§5.5, crypto-spec.md §5.2). This file only talks to the
// browser: the UV check and the PRF KEK are in `@blindvault/crypto` (`derivePrfKek`). There is no
// server, so the challenge is random and never checked; what unlocks is the PRF output.

import { randomBytes } from '@blindvault/crypto';

/** What one ceremony returns. `prfOutput` is absent when the authenticator gave none. */
export interface PasskeyResult {
  readonly credentialId: Uint8Array;
  readonly authenticatorData: Uint8Array;
  readonly prfOutput?: Uint8Array;
}

export interface PasskeyPort {
  /** False when the browser has no WebAuthn or reports no PRF extension. */
  supported(): Promise<boolean>;
  /** Creates a credential with user verification required, evaluating the PRF at `prfInput`. */
  create(prfInput: Uint8Array): Promise<PasskeyResult>;
  /** An assertion from `credentialId` with user verification required, evaluating the PRF. */
  get(credentialId: Uint8Array, prfInput: Uint8Array): Promise<PasskeyResult>;
  /** Asks the authenticator to remove a credential that unlocks nothing (D120); false if unsupported. */
  forget(credentialId: Uint8Array): Promise<boolean>;
}

/** The user closed the prompt, it timed out, or no authenticator answered. */
export class PasskeyCancelledError extends Error {
  override name = 'PasskeyCancelledError';
}

/** The credential exists but its authenticator did not evaluate the PRF. */
export class PrfUnavailableError extends Error {
  override name = 'PrfUnavailableError';
}

const CHALLENGE_LENGTH = 32;
const USER_ID_LENGTH = 16;
const TIMEOUT_MS = 120_000;

interface PrfOutputs {
  readonly prf?: { readonly enabled?: boolean; readonly results?: { readonly first?: unknown } };
}

export interface PublicKeyCredentialStatics {
  getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
  signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>;
}

function buffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function prfOutput(credential: PublicKeyCredential): Uint8Array | undefined {
  const { prf } = credential.getClientExtensionResults() as PrfOutputs;
  const first = prf?.results?.first;
  if (first instanceof ArrayBuffer) return new Uint8Array(first);
  if (ArrayBuffer.isView(first)) {
    return new Uint8Array(first.buffer, first.byteOffset, first.byteLength).slice();
  }
  return undefined;
}

async function ceremony(run: () => Promise<Credential | null>): Promise<PublicKeyCredential> {
  let credential: Credential | null;
  try {
    credential = await run();
  } catch (error) {
    if (error instanceof DOMException && ['NotAllowedError', 'AbortError'].includes(error.name)) {
      throw new PasskeyCancelledError();
    }
    throw error;
  }
  if (!credential) throw new PasskeyCancelledError();
  return credential as PublicKeyCredential;
}

export interface PasskeyEnvironment {
  readonly credentials?: CredentialsContainer;
  readonly statics?: PublicKeyCredentialStatics;
  readonly rpId: string;
}

function browserEnvironment(): PasskeyEnvironment {
  const statics = (globalThis as { PublicKeyCredential?: PublicKeyCredentialStatics })
    .PublicKeyCredential;
  return {
    ...(statics ? { credentials: navigator.credentials, statics } : {}),
    rpId: location.hostname,
  };
}

/** The port over `navigator.credentials`; tests pass their own environment. */
export function browserPasskeys(env: PasskeyEnvironment = browserEnvironment()): PasskeyPort {
  const { credentials, statics, rpId } = env;
  return {
    async supported() {
      if (!credentials || !statics) return false;
      if (!statics.getClientCapabilities) return true;
      try {
        return (await statics.getClientCapabilities())['extension:prf'] !== false;
      } catch {
        // Advisory only: the create call tells for sure.
        return true;
      }
    },

    async create(prfInput) {
      if (!credentials) throw new PrfUnavailableError();
      const credential = await ceremony(() =>
        credentials.create({
          publicKey: {
            rp: { name: 'BlindVault' },
            user: {
              id: buffer(randomBytes(USER_ID_LENGTH)),
              name: 'BlindVault',
              displayName: 'BlindVault',
            },
            challenge: buffer(randomBytes(CHALLENGE_LENGTH)),
            pubKeyCredParams: [
              { type: 'public-key', alg: -8 },
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 },
            ],
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
            attestation: 'none',
            timeout: TIMEOUT_MS,
            extensions: {
              prf: { eval: { first: buffer(prfInput) } },
            },
          },
        }),
      );
      const { prf } = credential.getClientExtensionResults() as PrfOutputs;
      const output = prfOutput(credential);
      if (prf?.enabled !== true && !output) throw new PrfUnavailableError();
      const response = credential.response as AuthenticatorAttestationResponse;
      return {
        credentialId: new Uint8Array(credential.rawId),
        authenticatorData: new Uint8Array(response.getAuthenticatorData()),
        ...(output ? { prfOutput: output } : {}),
      };
    },

    async get(credentialId, prfInput) {
      if (!credentials) throw new PrfUnavailableError();
      const credential = await ceremony(() =>
        credentials.get({
          publicKey: {
            challenge: buffer(randomBytes(CHALLENGE_LENGTH)),
            allowCredentials: [{ type: 'public-key', id: buffer(credentialId) }],
            userVerification: 'required',
            timeout: TIMEOUT_MS,
            extensions: {
              prf: { eval: { first: buffer(prfInput) } },
            },
          },
        }),
      );
      const response = credential.response as AuthenticatorAssertionResponse;
      const output = prfOutput(credential);
      return {
        credentialId: new Uint8Array(credential.rawId),
        authenticatorData: new Uint8Array(response.authenticatorData),
        ...(output ? { prfOutput: output } : {}),
      };
    },

    async forget(credentialId) {
      if (!statics?.signalUnknownCredential) return false;
      try {
        await statics.signalUnknownCredential({ rpId, credentialId: base64url(credentialId) });
        return true;
      } catch {
        return false;
      }
    },
  };
}
