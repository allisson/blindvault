import { beforeAll, describe, expect, it } from 'vitest';

import { open, seal } from './aead';
import { DecryptionError, KdfParamsRejectedError, KdfWorkerError } from './errors';
import {
  type KdfPort,
  type KdfRequest,
  calibrateDeviceKek,
  deriveDeviceKek,
  handleKdfRequest,
} from './kdf-worker';
import { Keyring, generateKey, keyBytes } from './keys';
import { MEMLIMIT, normalizePassword } from './password';
import { initCrypto } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

beforeAll(initCrypto);

const a2 = vectors.argon2id;
const PARAMS = { opslimit: a2.opslimit, memlimit: a2.memlimit };

/** A clock that advances 2 s per reading: every timed derivation looks slow, so calibration stops at 2. */
function slowClock(): () => number {
  let t = 0;
  return () => (t += 2000);
}

/** Runs the worker handler in-process, answering asynchronously like a real worker. */
function inProcessPort(answer?: (request: KdfRequest) => unknown) {
  const state = { posted: 0, terminated: 0, transferred: [] as ArrayBuffer[] };
  const port: KdfPort & { state: typeof state } = {
    state,
    onmessage: null,
    onerror: null,
    postMessage(message, transfer) {
      state.posted += 1;
      state.transferred.push(...transfer);
      const data = answer ? answer(message) : handleKdfRequest(message, slowClock());
      queueMicrotask(() => port.onmessage?.({ data }));
    },
    terminate() {
      state.terminated += 1;
    },
  };
  return port;
}

describe('Argon2id worker handler', () => {
  it('derives the vector Device KEK and wipes the password', () => {
    const password = fromHex(a2.passwordNormalizedUtf8);
    const response = handleKdfRequest(
      { op: 'derive', password, salt: fromHex(a2.salt), params: PARAMS },
      slowClock(),
    );
    expect(response.ok && toHex(response.key)).toBe(a2.deviceKek);
    expect(password.every((b) => b === 0)).toBe(true);
  });

  it('calibrates: a slow device stays at opslimit 2 and returns that derivation', () => {
    const response = handleKdfRequest(
      { op: 'calibrate', password: fromHex(a2.passwordNormalizedUtf8), salt: fromHex(a2.salt) },
      slowClock(),
    );
    expect(response).toEqual({ ok: true, key: fromHex(a2.deviceKek), params: PARAMS });
  });

  it.each([
    ['a non-object', 'derive'],
    ['no password', { op: 'derive', salt: new Uint8Array(16), params: PARAMS }],
    [
      'a short salt',
      { op: 'derive', password: new Uint8Array(1), salt: new Uint8Array(15), params: PARAMS },
    ],
    ['no params', { op: 'derive', password: new Uint8Array(1), salt: new Uint8Array(16) }],
    ['an unknown op', { op: 'hash', password: new Uint8Array(1), salt: new Uint8Array(16) }],
    [
      'params outside the range',
      {
        op: 'derive',
        password: new Uint8Array(1),
        salt: new Uint8Array(16),
        params: { opslimit: 1, memlimit: MEMLIMIT },
      },
    ],
  ])('answers { ok: false } to %s', (_name, request) => {
    expect(handleKdfRequest(request, slowClock())).toEqual({ ok: false });
  });

  it('wipes the password of a rejected request', () => {
    const password = new Uint8Array(8).fill(7);
    handleKdfRequest(
      { op: 'derive', password, salt: new Uint8Array(3), params: PARAMS },
      slowClock(),
    );
    expect(password.every((b) => b === 0)).toBe(true);
  });
});

describe('Device KEK client', () => {
  it('derives through the worker, transfers and wipes the password, and terminates it', async () => {
    const port = inProcessPort();
    const keyring = new Keyring();
    const password = fromHex(a2.passwordNormalizedUtf8);
    const kek = await deriveDeviceKek(keyring, port, password, fromHex(a2.salt), PARAMS);
    expect(toHex(keyBytes(kek))).toBe(a2.deviceKek);
    expect(password.every((b) => b === 0)).toBe(true);
    expect(port.state.transferred).toHaveLength(1);
    expect(port.state.terminated).toBe(1);
  });

  it('rejects stored parameters outside the range without starting Argon2id', async () => {
    for (const params of a2.rejectedParameters) {
      const port = inProcessPort();
      const password = new Uint8Array(4).fill(1);
      await expect(
        deriveDeviceKek(new Keyring(), port, password, fromHex(a2.salt), params),
      ).rejects.toThrow(KdfParamsRejectedError);
      expect(port.state.posted).toBe(0);
      expect(port.state.terminated).toBe(1);
      expect(password.every((b) => b === 0)).toBe(true);
    }
  });

  it('fails a wrong password with the same error as any other failure (Gate A)', async () => {
    const keyring = new Keyring();
    const salt = fromHex(a2.salt);
    const right = await deriveDeviceKek(
      keyring,
      inProcessPort(),
      normalizePassword('right horse battery'),
      salt,
      PARAMS,
    );
    const wrong = await deriveDeviceKek(
      keyring,
      inProcessPort(),
      normalizePassword('wrong horse battery'),
      salt,
      PARAMS,
    );
    const aad = fromHex('00000001aa');
    const wrap = seal(right, aad, keyBytes(generateKey(keyring)));
    expect(() => open(wrong, aad, wrap)).toThrow(DecryptionError);
    expect(() => open(wrong, aad, wrap)).toThrow('decryption failed');
  });

  it('calibrates through the worker and returns the parameters to store', async () => {
    const keyring = new Keyring();
    const { kek, params } = await calibrateDeviceKek(
      keyring,
      inProcessPort(),
      fromHex(a2.passwordNormalizedUtf8),
      fromHex(a2.salt),
    );
    expect(params).toEqual(PARAMS);
    expect(toHex(keyBytes(kek))).toBe(a2.deviceKek);
  });

  it.each([
    ['{ ok: false }', () => ({ ok: false })],
    ['a non-object', () => 42],
    ['a short key', () => ({ ok: true, key: new Uint8Array(31), params: PARAMS })],
    ['no params', () => ({ ok: true, key: new Uint8Array(32) })],
  ])('rejects a worker answer of %s', async (_name, answer) => {
    const port = inProcessPort(answer);
    await expect(
      deriveDeviceKek(new Keyring(), port, new Uint8Array(1), fromHex(a2.salt), PARAMS),
    ).rejects.toThrow(KdfWorkerError);
    expect(port.state.terminated).toBe(1);
  });

  it('wipes and rejects a key derived at other parameters than requested', async () => {
    const key = new Uint8Array(32).fill(9);
    const port = inProcessPort(() => ({
      ok: true,
      key,
      params: { opslimit: 3, memlimit: MEMLIMIT },
    }));
    await expect(
      deriveDeviceKek(new Keyring(), port, new Uint8Array(1), fromHex(a2.salt), PARAMS),
    ).rejects.toThrow(KdfWorkerError);
    expect(key.every((b) => b === 0)).toBe(true);
  });

  it('wipes and rejects a calibration outside the accepted range', async () => {
    const key = new Uint8Array(32).fill(9);
    const port = inProcessPort(() => ({
      ok: true,
      key,
      params: { opslimit: 65, memlimit: MEMLIMIT },
    }));
    await expect(
      calibrateDeviceKek(new Keyring(), port, new Uint8Array(1), fromHex(a2.salt)),
    ).rejects.toThrow(KdfWorkerError);
    expect(key.every((b) => b === 0)).toBe(true);
  });

  it('wipes a malformed key and rejects a worker error event', async () => {
    const key = new Uint8Array(31).fill(9);
    await expect(
      deriveDeviceKek(
        new Keyring(),
        inProcessPort(() => ({ ok: true, key, params: PARAMS })),
        new Uint8Array(1),
        fromHex(a2.salt),
        PARAMS,
      ),
    ).rejects.toThrow(KdfWorkerError);
    expect(key.every((b) => b === 0)).toBe(true);

    const port = inProcessPort();
    port.postMessage = () => {
      queueMicrotask(() => port.onerror?.());
    };
    await expect(
      deriveDeviceKek(new Keyring(), port, new Uint8Array(1), fromHex(a2.salt), PARAMS),
    ).rejects.toThrow(KdfWorkerError);
    expect(port.state.terminated).toBe(1);
  });
});
