import { beforeAll, describe, expect, it } from 'vitest';

import { UserVerificationError } from './errors';
import { Keyring, keyBytes } from './keys';
import { PRF_INPUT_LENGTH, derivePrfKek, generatePrfInput, isBackupEligible } from './prf';
import { initCrypto } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

beforeAll(initCrypto);

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;

function authenticatorData(flags: number, length = 37): Uint8Array {
  const data = new Uint8Array(length);
  data[32] = flags;
  return data;
}

describe('PRF KEK (crypto-spec.md §5.2, D75)', () => {
  it('derives the vector PRF KEK from an assertion with user verification', () => {
    const keyring = new Keyring();
    const prfOutput = fromHex(vectors.kdf.prfOutput);
    const kek = derivePrfKek(keyring, { authenticatorData: authenticatorData(UP | UV), prfOutput });
    expect(toHex(keyBytes(kek))).toBe(vectors.local.prfKek);
    expect(prfOutput.every((b) => b === 0)).toBe(true);
    expect(keyring.size).toBe(1);
  });

  it.each([
    ['without the UV flag', authenticatorData(UP | BE), 32],
    ['with no flags', authenticatorData(0), 32],
    ['with truncated authenticator data', authenticatorData(UP | UV, 36), 32],
    ['with a PRF output that is not 32 bytes', authenticatorData(UP | UV), 31],
  ])('rejects an assertion %s and wipes the PRF output (CRYPTO-INV-021)', (_n, data, length) => {
    const keyring = new Keyring();
    const prfOutput = new Uint8Array(length).fill(0x55);
    expect(() => derivePrfKek(keyring, { authenticatorData: data, prfOutput })).toThrow(
      UserVerificationError,
    );
    expect(prfOutput.every((b) => b === 0)).toBe(true);
    expect(keyring.size).toBe(0);
  });

  it('reads the backup-eligible flag for the synced-passkey notice (D84)', () => {
    expect(isBackupEligible(authenticatorData(UP | UV | BE))).toBe(true);
    expect(isBackupEligible(authenticatorData(UP | UV))).toBe(false);
    expect(() => isBackupEligible(new Uint8Array(10))).toThrow(UserVerificationError);
  });

  it('generates a random 32-byte PRF input', () => {
    expect(generatePrfInput()).toHaveLength(PRF_INPUT_LENGTH);
    expect(generatePrfInput()).not.toEqual(generatePrfInput());
  });
});
