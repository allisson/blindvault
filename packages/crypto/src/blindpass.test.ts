import { beforeAll, describe, expect, it } from 'vitest';

import { openBlindPassExport } from './blindpass';
import { BlindPassRejectedError, DecryptionError, KdfWorkerError } from './errors';
import { BLINDPASS_KDF_PARAMS } from './password';
import { initCrypto, lib } from './sodium';
import { inProcessPort } from './test-helpers';

beforeAll(initCrypto);

// Written by BlindPass's own `deriveKeyEncryptionKey` and `encryptSymmetric` (its built
// `@blindpass/crypto`), as its `exportVaultEncrypted` writes a `.blindpass` file.
const PASSPHRASE = 'café horse battery';
const FIXTURE = JSON.stringify({
  version: 1,
  type: 'blindpass-export-encrypted',
  kekSalt: 'ht1882pF5SjMHIB35iyfRQ==',
  nonce: 'gdGrmt11vJbaivGpiOyIxzpRmwwXYYmj',
  ciphertext:
    'n0zlPO3ut0kIp0d1Sdmopx9pkT1HXkk/PF+kT/IDwqwnBw7hKEH1qYifO0+XxEVQgP+jU/smfMiQ1KBbYQ+ZjgeoU5Kz4fAexr7lmERHFvbMRp5BbxGLB0JBWTH71xTprpd4Z5NfetX58s0nPg+UpGmsdoLWI3FUVgv5BFHy1RfJOlNIgKJ5Q3VEDf8+f65MTWW4hMm9t8WEozqjg/skWvj01i71dBEUe4+QGegJevLmH2sJa3AYJIfw/eNhs1eyILUx0nmURkBBEZIR1PQAUnvkDSaAaDZQrX67D6ZzkuYlVRXpiPVoPXVbBGaILbV/g2rBaP1UeSRoiBQMFJgDSasFZ594tbQA79U7CaS1Dhvp3cgY/dSOnXcmHHJR0AU=',
});

// Each derivation at 1 GiB takes seconds.
const SLOW = 60_000;

const b64 = (bytes: Uint8Array) => lib().to_base64(bytes, lib().base64_variants.ORIGINAL);

/** A file sealed under `key`, and a port whose worker answers `key` at BlindPass's parameters. */
function sealed(plaintext: string, fields: Record<string, unknown> = {}) {
  const key = lib().randombytes_buf(32);
  const nonce = lib().randombytes_buf(24);
  const file = {
    version: 1,
    type: 'blindpass-export-encrypted',
    kekSalt: b64(new Uint8Array(16)),
    nonce: b64(nonce),
    ciphertext: b64(lib().crypto_secretbox_easy(lib().from_string(plaintext), nonce, key)),
    ...fields,
  };
  const port = inProcessPort(() => ({ ok: true, key, params: BLINDPASS_KDF_PARAMS }));
  return { file, key, port };
}

async function rejected(file: unknown, reason: string) {
  const port = inProcessPort();
  const text = typeof file === 'string' ? file : JSON.stringify(file);
  const error: unknown = await openBlindPassExport(port, text, 'x').catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BlindPassRejectedError);
  expect((error as BlindPassRejectedError).reason).toBe(reason);
  expect(port.state.posted).toBe(0);
  expect(port.state.terminated).toBe(1);
}

describe('.blindpass decryption (D126)', () => {
  it(
    "decrypts BlindPass's own file at its fixed parameters, in the worker",
    async () => {
      const port = inProcessPort();
      const json = await openBlindPassExport(port, FIXTURE, PASSPHRASE);
      expect(JSON.parse(json)).toMatchObject({
        version: 1,
        type: 'blindpass-export',
        items: [{ type: 'login', title: 'GitHub', password: 'hunter2' }],
      });
      expect(port.state.transferred).toHaveLength(1);
      expect(port.state.terminated).toBe(1);
    },
    SLOW,
  );

  it(
    'rejects a wrong passphrase, here the same one normalized to NFC',
    async () => {
      const nfc = PASSPHRASE.normalize('NFC');
      expect(nfc).not.toBe(PASSPHRASE);
      await expect(openBlindPassExport(inProcessPort(), FIXTURE, nfc)).rejects.toThrow(
        DecryptionError,
      );
    },
    SLOW,
  );

  it('holds the libsodium SENSITIVE limits as constants', () => {
    expect(BLINDPASS_KDF_PARAMS).toEqual({
      opslimit: lib().crypto_pwhash_OPSLIMIT_SENSITIVE,
      memlimit: lib().crypto_pwhash_MEMLIMIT_SENSITIVE,
    });
  });

  it('opens a file whose key the worker returns, and wipes that key', async () => {
    const { file, key, port } = sealed('{"items":[]}');
    expect(await openBlindPassExport(port, JSON.stringify(file), 'x')).toBe('{"items":[]}');
    expect(key.every((b) => b === 0)).toBe(true);
  });

  it('rejects a tampered ciphertext as a decryption failure, and wipes the key', async () => {
    const { file, key, port } = sealed('{"items":[]}');
    const bytes = lib().from_base64(file.ciphertext, lib().base64_variants.ORIGINAL);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    await expect(
      openBlindPassExport(port, JSON.stringify({ ...file, ciphertext: b64(bytes) }), 'x'),
    ).rejects.toThrow(DecryptionError);
    expect(key.every((b) => b === 0)).toBe(true);
  });

  it('rejects and wipes a key the worker derived at other parameters', async () => {
    const { file, key } = sealed('{}');
    const port = inProcessPort(() => ({ ok: true, key, params: { opslimit: 2, memlimit: 1 } }));
    await expect(openBlindPassExport(port, JSON.stringify(file), 'x')).rejects.toThrow(
      KdfWorkerError,
    );
    expect(key.every((b) => b === 0)).toBe(true);
  });

  it('refuses a file that is not a .blindpass export, before deriving', async () => {
    const { file } = sealed('{}');
    await rejected('not json', 'not-this-format');
    await rejected('null', 'not-this-format');
    await rejected({ ...file, type: 'blindpass-export' }, 'not-this-format');
    await rejected({ ...file, kekSalt: undefined }, 'not-this-format');
    await rejected({ ...file, kekSalt: 16 }, 'not-this-format');
    await rejected({ ...file, kekSalt: b64(new Uint8Array(15)) }, 'not-this-format');
    await rejected({ ...file, kekSalt: b64(new Uint8Array(17)) }, 'not-this-format');
    await rejected({ ...file, nonce: b64(new Uint8Array(23)) }, 'not-this-format');
    await rejected({ ...file, ciphertext: b64(new Uint8Array(15)) }, 'not-this-format');
    await rejected({ ...file, kekSalt: 'AAAAAAAAAAAAAAAAAAAAAA' }, 'not-this-format');
    await rejected({ ...file, nonce: file.nonce.replace(/.$/, '_') }, 'not-this-format');
  });

  it('refuses a version other than 1, before deriving', async () => {
    const { file } = sealed('{}');
    await rejected({ ...file, version: 2 }, 'unsupported-version');
    await rejected({ ...file, version: '1' }, 'unsupported-version');
  });

  it('opens a file whose ciphertext is only the MAC: an empty plaintext', async () => {
    const { file, port } = sealed('');
    expect(await openBlindPassExport(port, JSON.stringify(file), 'x')).toBe('');
  });
});
