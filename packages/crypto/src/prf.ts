// WebAuthn PRF KEK (crypto-spec.md §5.2, D75, D84). The browser calls live in apps/web; this module
// checks the assertion and derives the KEK.

import { UserVerificationError } from './errors';
import { KdfContext, deriveSubkey } from './kdf';
import { Keyring, type SymmetricKey } from './keys';
import { lib, randomBytes } from './sodium';

export const PRF_INPUT_LENGTH = 32;
const PRF_OUTPUT_LENGTH = 32;

// Authenticator data: rpIdHash (32) ‖ flags (1) ‖ signCount (4) ‖ … (WebAuthn §6.1).
const FLAGS_OFFSET = 32;
const MIN_AUTHENTICATOR_DATA = 37;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;

function flags(authenticatorData: Uint8Array): number {
  const value = authenticatorData[FLAGS_OFFSET];
  if (authenticatorData.length < MIN_AUTHENTICATOR_DATA || value === undefined) {
    throw new UserVerificationError();
  }
  return value;
}

/** The random PRF input stored with the credential ID in the PRF KEK state. */
export function generatePrfInput(): Uint8Array {
  return randomBytes(PRF_INPUT_LENGTH);
}

/** Backup-eligible flag: a synced passkey, for the D84 setup notice. */
export function isBackupEligible(authenticatorData: Uint8Array): boolean {
  return (flags(authenticatorData) & FLAG_BE) !== 0;
}

export interface PrfAssertion {
  readonly authenticatorData: Uint8Array;
  /** `prf.results.first`; wiped by `derivePrfKek`. */
  readonly prfOutput: Uint8Array;
}

/**
 * The PRF KEK from an assertion. Without the UV flag, or malformed, the assertion is rejected
 * before any derivation (CRYPTO-INV-021). The PRF output is wiped in every case.
 */
export function derivePrfKek(keyring: Keyring, assertion: PrfAssertion): SymmetricKey {
  const scratch = new Keyring();
  try {
    if ((flags(assertion.authenticatorData) & FLAG_UV) === 0) throw new UserVerificationError();
    if (assertion.prfOutput.length !== PRF_OUTPUT_LENGTH) throw new UserVerificationError();
    const output = scratch.adopt(assertion.prfOutput.slice());
    return deriveSubkey(keyring, output, KdfContext.prf, 1);
  } finally {
    lib().memzero(assertion.prfOutput);
    scratch.wipeAll();
  }
}
