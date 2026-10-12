import { initCrypto } from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  PasskeyCancelledError,
  type PasskeyEnvironment,
  PrfUnavailableError,
  browserPasskeys,
} from './passkey';

beforeAll(initCrypto);

const AUTH_DATA = new Uint8Array(37).fill(5);
const OUTPUT = new Uint8Array(32).fill(7);

interface Recorded {
  create?: CredentialCreationOptions;
  get?: CredentialRequestOptions;
}

function credential(prf: unknown, response: object): PublicKeyCredential {
  return {
    rawId: new Uint8Array([1, 2, 3]).buffer,
    response,
    getClientExtensionResults: () => ({ prf }),
  } as unknown as PublicKeyCredential;
}

function environment(
  result: () => Promise<Credential | null>,
  statics: PasskeyEnvironment['statics'] = {},
): { env: PasskeyEnvironment; recorded: Recorded } {
  const recorded: Recorded = {};
  const credentials = {
    create: (options: CredentialCreationOptions) => {
      recorded.create = options;
      return result();
    },
    get: (options: CredentialRequestOptions) => {
      recorded.get = options;
      return result();
    },
  } as unknown as CredentialsContainer;
  return { env: { credentials, statics, rpId: 'vault.example' }, recorded };
}

const attestation = { getAuthenticatorData: () => AUTH_DATA.buffer };
const assertion = { authenticatorData: AUTH_DATA.buffer };

describe('WebAuthn port (§5.5, crypto-spec.md §5.2)', () => {
  it('creates with user verification required and the PRF evaluated at the PRF input', async () => {
    const { env, recorded } = environment(() =>
      Promise.resolve(
        credential({ enabled: true, results: { first: OUTPUT.buffer } }, attestation),
      ),
    );
    const input = new Uint8Array(32).fill(9);
    const created = await browserPasskeys(env).create(input);
    expect(created).toEqual({
      credentialId: new Uint8Array([1, 2, 3]),
      authenticatorData: AUTH_DATA,
      prfOutput: OUTPUT,
    });
    const publicKey = recorded.create?.publicKey;
    expect(publicKey?.authenticatorSelection?.userVerification).toBe('required');
    expect(publicKey?.attestation).toBe('none');
    expect(publicKey?.challenge.byteLength).toBe(32);
    // No vault identifier or personal data in the credential's user entity.
    expect(publicKey?.user.name).toBe('BlindVault');
    expect(publicKey?.user.id.byteLength).toBe(16);
    const prf = (publicKey?.extensions as { prf: { eval: { first: Uint8Array } } }).prf;
    expect(new Uint8Array(prf.eval.first)).toEqual(input);
  });

  it('returns no PRF output when the create only enabled it, and refuses one not enabled', async () => {
    let prf: unknown = { enabled: true };
    const { env } = environment(() => Promise.resolve(credential(prf, attestation)));
    const port = browserPasskeys(env);
    expect((await port.create(new Uint8Array(32))).prfOutput).toBeUndefined();
    prf = { enabled: false };
    await expect(port.create(new Uint8Array(32))).rejects.toThrow(PrfUnavailableError);
    prf = undefined;
    await expect(port.create(new Uint8Array(32))).rejects.toThrow(PrfUnavailableError);
  });

  it('asserts from the stored credential with user verification required', async () => {
    const view = new Uint8Array(40);
    view.set(OUTPUT, 4);
    const { env, recorded } = environment(() =>
      Promise.resolve(credential({ results: { first: view.subarray(4, 36) } }, assertion)),
    );
    const got = await browserPasskeys(env).get(new Uint8Array([1, 2, 3]), new Uint8Array(32));
    expect(got.prfOutput).toEqual(OUTPUT);
    expect(got.authenticatorData).toEqual(AUTH_DATA);
    const publicKey = recorded.get?.publicKey;
    expect(publicKey?.userVerification).toBe('required');
    expect(publicKey?.allowCredentials?.map((c) => new Uint8Array(c.id as ArrayBuffer))).toEqual([
      new Uint8Array([1, 2, 3]),
    ]);
  });

  it('turns a dismissed or empty prompt into a cancellation, and passes other errors', async () => {
    for (const name of ['NotAllowedError', 'AbortError']) {
      const { env } = environment(() => Promise.reject(new DOMException('no', name)));
      await expect(browserPasskeys(env).get(new Uint8Array(1), new Uint8Array(32))).rejects.toThrow(
        PasskeyCancelledError,
      );
    }
    const { env: empty } = environment(() => Promise.resolve(null));
    await expect(browserPasskeys(empty).create(new Uint8Array(32))).rejects.toThrow(
      PasskeyCancelledError,
    );
    const { env } = environment(() => Promise.reject(new DOMException('no', 'SecurityError')));
    await expect(browserPasskeys(env).create(new Uint8Array(32))).rejects.toThrow('no');
  });

  it('detects support from the client capabilities, defaulting to the ceremony', async () => {
    const none = () => Promise.resolve(null);
    expect(await browserPasskeys({ rpId: 'x' }).supported()).toBe(false);
    expect(await browserPasskeys(environment(none).env).supported()).toBe(true);
    const caps = (value: Record<string, boolean>) =>
      environment(none, { getClientCapabilities: () => Promise.resolve(value) }).env;
    expect(await browserPasskeys(caps({ 'extension:prf': false })).supported()).toBe(false);
    expect(await browserPasskeys(caps({ 'extension:prf': true })).supported()).toBe(true);
    const failing = environment(none, { getClientCapabilities: () => Promise.reject(new Error()) });
    expect(await browserPasskeys(failing.env).supported()).toBe(true);
  });

  it('signals a credential as unknown by its base64url ID, where the browser can (D120)', async () => {
    const signalled: unknown[] = [];
    const { env } = environment(() => Promise.resolve(null), {
      signalUnknownCredential: (options) => {
        signalled.push(options);
        return Promise.resolve();
      },
    });
    expect(await browserPasskeys(env).forget(new Uint8Array([0xfb, 0xff, 0x01]))).toBe(true);
    expect(signalled).toEqual([{ rpId: 'vault.example', credentialId: '-_8B' }]);
    expect(
      await browserPasskeys(environment(() => Promise.resolve(null)).env).forget(new Uint8Array(1)),
    ).toBe(false);
    const failing = environment(() => Promise.resolve(null), {
      signalUnknownCredential: () => Promise.reject(new Error()),
    });
    expect(await browserPasskeys(failing.env).forget(new Uint8Array(1))).toBe(false);
  });
});
