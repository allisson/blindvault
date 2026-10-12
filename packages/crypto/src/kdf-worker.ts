// The Argon2id worker protocol (crypto-spec.md §6, architecture.md): every derivation of a local
// password runs off the main thread. `handleKdfRequest` runs inside the worker; `deriveDeviceKek`
// and `calibrateDeviceKek` run on the main thread and talk to it through a `KdfPort`.

import { KdfWorkerError } from './errors';
import { KEY_LENGTH, type Keyring, type SymmetricKey } from './keys';
import {
  type KdfParams,
  MEMLIMIT,
  SALT_LENGTH,
  argon2id,
  calibrate,
  checkKdfParams,
  kdfParamsAccepted,
} from './password';
import { lib } from './sodium';

export type KdfRequest =
  | {
      readonly op: 'derive';
      readonly password: Uint8Array;
      readonly salt: Uint8Array;
      readonly params: KdfParams;
    }
  | { readonly op: 'calibrate'; readonly password: Uint8Array; readonly salt: Uint8Array };

export type KdfResponse =
  | { readonly ok: true; readonly key: Uint8Array; readonly params: KdfParams }
  | { readonly ok: false };

/** The part of a `Worker` the client uses, so tests can run the handler in-process. */
export interface KdfPort {
  postMessage(message: KdfRequest, transfer: ArrayBuffer[]): void;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  terminate(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isParams(value: unknown): value is KdfParams {
  return (
    isRecord(value) && typeof value.opslimit === 'number' && typeof value.memlimit === 'number'
  );
}

/**
 * @internal Worker side. Validates the request it was sent, derives, and wipes the password. Never
 * throws: every failure is `{ ok: false }`, with no detail.
 */
export function handleKdfRequest(request: unknown, now: () => number): KdfResponse {
  if (!isRecord(request) || !(request.password instanceof Uint8Array)) return { ok: false };
  const password = request.password;
  try {
    if (!(request.salt instanceof Uint8Array) || request.salt.length !== SALT_LENGTH) {
      return { ok: false };
    }
    const salt = request.salt;
    if (request.op === 'derive' && isParams(request.params)) {
      const params = { opslimit: request.params.opslimit, memlimit: request.params.memlimit };
      return { ok: true, key: argon2id(password, salt, params), params };
    }
    if (request.op === 'calibrate') {
      const { key, opslimit } = calibrate(
        (ops) => argon2id(password, salt, { opslimit: ops, memlimit: MEMLIMIT }),
        now,
      );
      return { ok: true, key, params: { opslimit, memlimit: MEMLIMIT } };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  } finally {
    lib().memzero(password);
  }
}

/** Sends one request, waits for its one answer, and always terminates the worker. */
function run(port: KdfPort, request: KdfRequest): Promise<{ key: Uint8Array; params: KdfParams }> {
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      port.onmessage = null;
      port.onerror = null;
      port.terminate();
    };
    port.onmessage = ({ data }) => {
      finish();
      if (
        isRecord(data) &&
        data.ok === true &&
        data.key instanceof Uint8Array &&
        data.key.length === KEY_LENGTH &&
        isParams(data.params)
      ) {
        resolve({ key: data.key, params: data.params });
      } else {
        if (isRecord(data) && data.key instanceof Uint8Array) lib().memzero(data.key);
        reject(new KdfWorkerError());
      }
    };
    port.onerror = () => {
      finish();
      reject(new KdfWorkerError());
    };
    port.postMessage(request, [request.password.buffer as ArrayBuffer]);
  });
}

/** Moves the password into a buffer of its own for transfer, wiping the caller's copy. */
function transferable(password: Uint8Array): Uint8Array {
  const copy = new Uint8Array(new ArrayBuffer(password.length));
  copy.set(password);
  lib().memzero(password);
  return copy;
}

/**
 * The Device KEK at the stored parameters (unlock, password check). Parameters outside the accepted
 * range are rejected before the worker runs. `password` is wiped.
 */
export async function deriveDeviceKek(
  keyring: Keyring,
  port: KdfPort,
  password: Uint8Array,
  salt: Uint8Array,
  params: KdfParams,
): Promise<SymmetricKey> {
  try {
    checkKdfParams(params);
  } catch (error) {
    lib().memzero(password);
    port.terminate();
    throw error;
  }
  const result = await run(port, { op: 'derive', password: transferable(password), salt, params });
  if (result.params.opslimit !== params.opslimit || result.params.memlimit !== params.memlimit) {
    lib().memzero(result.key);
    throw new KdfWorkerError();
  }
  return keyring.adopt(result.key);
}

/**
 * A KEK at given parameters, for any password: the Device KEK, or the export password KEK of a
 * backup at the export parameters (backup-format.md §3, §4), which share the accepted range.
 */
export const derivePasswordKek = deriveDeviceKek;

/**
 * Calibrates and derives the Device KEK of a new local password (D166). Returns the parameters to
 * store with the salt. `password` is wiped.
 */
export async function calibrateDeviceKek(
  keyring: Keyring,
  port: KdfPort,
  password: Uint8Array,
  salt: Uint8Array,
): Promise<{ kek: SymmetricKey; params: KdfParams }> {
  const result = await run(port, { op: 'calibrate', password: transferable(password), salt });
  if (!kdfParamsAccepted(result.params)) {
    lib().memzero(result.key);
    throw new KdfWorkerError();
  }
  return { kek: keyring.adopt(result.key), params: result.params };
}
