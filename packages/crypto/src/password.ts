// Local password: normalization, Argon2id and its calibration (crypto-spec.md §6, D9, D166).

import { KdfParamsRejectedError, PasswordRejectedError } from './errors';
import { KEY_LENGTH } from './keys';
import { lib, randomBytes } from './sodium';

export const SALT_LENGTH = 16;
const MIB = 1_048_576;

/** Parameters stored in the cleartext part of Local Config. */
export interface KdfParams {
  readonly opslimit: number;
  readonly memlimit: number;
}

/** The memory every new local password uses: 64 MiB, the D9 floor. */
export const MEMLIMIT = 64 * MIB;

/** What unlock accepts from the cleartext Local Config, which can be tampered with. */
export const ACCEPTED_KDF_RANGE = {
  memlimit: [64 * MIB, 256 * MIB],
  opslimit: [2, 64],
} as const;

const CALIBRATION_TARGET_MS = 1000;

/**
 * RFC 8265 OpaqueString subset: `Zs` → U+0020, NFC, then reject control characters and empty or
 * whitespace-only input; UTF-8. Applied before the strength check and before Argon2id.
 */
export function normalizePassword(input: string): Uint8Array {
  const normalized = input.replace(/\p{Zs}/gu, ' ').normalize('NFC');
  if (/\p{Cc}/u.test(normalized)) throw new PasswordRejectedError('control-character');
  if (/^\p{White_Space}*$/u.test(normalized)) throw new PasswordRejectedError('empty');
  return lib().from_string(normalized);
}

export function generateSalt(): Uint8Array {
  return randomBytes(SALT_LENGTH);
}

function within(value: number, [min, max]: readonly [number, number]): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

/** @internal Whether parameters are within the accepted range. */
export function kdfParamsAccepted(params: KdfParams): boolean {
  return (
    within(params.memlimit, ACCEPTED_KDF_RANGE.memlimit) &&
    within(params.opslimit, ACCEPTED_KDF_RANGE.opslimit)
  );
}

/** Rejects parameters outside the accepted range, before Argon2id ever runs. */
export function checkKdfParams(params: KdfParams): void {
  if (!kdfParamsAccepted(params)) throw new KdfParamsRejectedError();
}

/** @internal One Argon2id derivation, for the worker. Returns the raw 32 bytes. */
export function argon2id(password: Uint8Array, salt: Uint8Array, params: KdfParams): Uint8Array {
  checkKdfParams(params);
  if (salt.length !== SALT_LENGTH) throw new KdfParamsRejectedError();
  return lib().crypto_pwhash(
    KEY_LENGTH,
    password,
    salt,
    params.opslimit,
    params.memlimit,
    lib().crypto_pwhash_ALG_ARGON2ID13,
  );
}

/**
 * @internal The D166 calibration: time one derivation at `opslimit` 2, extrapolate to the target,
 * then step up until a derivation takes at least the target or `opslimit` reaches 64. Returns the
 * last derivation's output, which is the Device KEK, and wipes every earlier one.
 */
export function calibrate(
  derive: (opslimit: number) => Uint8Array,
  now: () => number,
): { key: Uint8Array; opslimit: number } {
  const [min, max] = ACCEPTED_KDF_RANGE.opslimit;
  const timed = (opslimit: number): { key: Uint8Array; ms: number } => {
    const start = now();
    const key = derive(opslimit);
    return { key, ms: now() - start };
  };
  let opslimit: number = min;
  let last = timed(opslimit);
  if (last.ms >= CALIBRATION_TARGET_MS) return { key: last.key, opslimit };
  opslimit = Math.min(max, Math.ceil((min * CALIBRATION_TARGET_MS) / last.ms));
  for (;;) {
    lib().memzero(last.key);
    last = timed(opslimit);
    if (last.ms >= CALIBRATION_TARGET_MS || opslimit >= max) return { key: last.key, opslimit };
    opslimit += 1;
  }
}
