import { beforeAll, describe, expect, it } from 'vitest';

import { open, seal } from './aead';
import { CryptoError } from './errors';
import { Keyring, generateKey } from './keys';
import { normalizePassword } from './password';
import { parseRecoveryPhrase } from './recovery';
import { initCrypto } from './sodium';
import { parseOtpauthUri, parseTotpSecret } from './totp';

beforeAll(initCrypto);

const AAD = new TextEncoder().encode('aad');

/** Everything a log could show of an error: message, string form, stack and JSON. */
function shown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CryptoError);
    const e = error as Error;
    return [e.message, String(e), e.stack ?? '', JSON.stringify(e)].join('\n');
  }
  throw new Error('did not throw');
}

describe('rejections name the reason, never the input (CRYPTO-INV-005)', () => {
  const keyring = new Keyring();
  const words = 'abandon '.repeat(23);

  it.each([
    [
      'a password with a control character',
      'Tulip\u0007Orbit-5528',
      () => normalizePassword('Tulip\u0007Orbit-5528'),
    ],
    ['a TOTP secret outside base32', 'JBSWY3DP!!SECRET', () => parseTotpSecret('JBSWY3DP!!SECRET')],
    [
      'a TOTP URI with bad digits',
      'GEZDGNBVGY3TQOJQ',
      () => parseOtpauthUri('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=4'),
    ],
    [
      'a TOTP URI that is not one',
      'GEZDGNBVGY3TQOJQ',
      () => parseOtpauthUri('https://example.com/?secret=GEZDGNBVGY3TQOJQ'),
    ],
    [
      'a phrase with a bad checksum',
      `${words}zoo`,
      () => parseRecoveryPhrase(keyring, `${words}zoo`),
    ],
    [
      'a phrase with an unknown word',
      `${words}quartzlantern`,
      () => parseRecoveryPhrase(keyring, `${words}quartzlantern`),
    ],
  ])('%s', (_, secret, run) => {
    const text = shown(run);
    for (const part of secret.split(/\s+/).filter((w) => w.length > 6)) {
      expect(text).not.toContain(part);
    }
    expect(text).not.toContain(secret);
  });

  it('a failed decryption shows neither key nor plaintext', () => {
    const plaintext = 'hunter2-very-secret';
    const sealed = seal(generateKey(keyring), AAD, new TextEncoder().encode(plaintext));
    const text = shown(() => open(generateKey(keyring), AAD, sealed));
    expect(text).not.toContain(plaintext);
    expect(text).toContain('decryption failed');
  });
});
