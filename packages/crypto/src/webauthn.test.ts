import { beforeAll, describe, expect, it } from 'vitest';

import { decodeCbor } from './cbor';
import { EncodingError } from './errors';
import { lib, initCrypto } from './sodium';
import { fromHex, toHex } from './test-helpers';
import {
  COSE_ALGORITHM,
  PASSKEY_CREDENTIAL_ID_LENGTH,
  type PasskeyAlgorithm,
  authenticatorData,
  createPasskey,
  ecdsaDer,
  passkeyAlgorithm,
  passkeyPublicKey,
  signPasskeyAssertion,
  signPasskeyAssertionHash,
} from './webauthn';

// WebCrypto, to the extent the tests verify with it (the package compiles without the DOM lib).
interface VerifySubtle {
  importKey(
    format: 'spki',
    key: Uint8Array,
    algorithm: { name: 'ECDSA'; namedCurve: 'P-256' },
    extractable: false,
    usages: ['verify'],
  ): Promise<unknown>;
  verify(
    algorithm: { name: 'ECDSA'; hash: 'SHA-256' },
    key: unknown,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}
declare const crypto: { readonly subtle: VerifySubtle };

beforeAll(initCrypto);

const ES256_PREFIX = '308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420';
const EDDSA_PREFIX = '302e020100300506032b657004220420';
const P256_N = 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551';

// RFC 6979 A.2.5: a P-256 key with its public point.
const RFC6979_D = 'c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721';
const RFC6979_X = '60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6';
const RFC6979_Y = '7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299';
// RFC 8032 §7.1 test 1: an Ed25519 seed and its public key.
const RFC8032_SEED = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
const RFC8032_PUBLIC = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';

const es256 = (d: string, x = RFC6979_X, y = RFC6979_Y) =>
  fromHex(`${ES256_PREFIX}${d}a14403420004${x}${y}`);
const eddsa = (seed: string) => fromHex(`${EDDSA_PREFIX}${seed}`);

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

const utf8 = (s: string) => new Uint8Array(Array.from(s, (c) => c.charCodeAt(0)));
const sha256 = (b: Uint8Array) => lib().crypto_hash_sha256(b);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A DER `Ecdsa-Sig-Value` back to the 64-byte `r ‖ s` WebCrypto verifies. */
function derToRaw(der: Uint8Array): Uint8Array {
  expect(der[0]).toBe(0x30);
  expect(der[1]).toBe(der.length - 2);
  const out = new Uint8Array(64);
  let at = 2;
  for (const half of [0, 1]) {
    expect(der[at]).toBe(0x02);
    const length = der[at + 1] ?? 0;
    const int = der.subarray(at + 2, at + 2 + length);
    // Minimal: no leading zero unless the next byte has its high bit set.
    if (int.length > 1 && int[0] === 0) expect((int[1] ?? 0) & 0x80).not.toBe(0);
    const value = int[0] === 0 ? int.subarray(1) : int;
    out.set(value, half * 32 + 32 - value.length);
    at += 2 + length;
  }
  expect(at).toBe(der.length);
  return out;
}

async function verifyEs256(
  spki: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), data);
}

describe('passkey private key layouts (record-content.md §4, D288)', () => {
  it('reads the ES256 and EdDSA layouts', () => {
    expect(passkeyAlgorithm(es256(RFC6979_D))).toBe('ES256');
    expect(passkeyAlgorithm(eddsa(RFC8032_SEED))).toBe('EdDSA');
    // RFC 8410 §10.3.
    expect(
      passkeyAlgorithm(
        fromHex(
          '302e020100300506032b657004220420d4ee72dbf913584ad5b6d8f1f769f8ad3afe7c28cbf1d4fbe097a88f44755842',
        ),
      ),
    ).toBe('EdDSA');
  });

  it('accepts d = 1 and d = n − 1', () => {
    expect(passkeyAlgorithm(es256('00'.repeat(31) + '01'))).toBe('ES256');
    expect(passkeyAlgorithm(es256(P256_N.slice(0, -2) + '50'))).toBe('ES256');
  });

  const malformed: [string, Uint8Array][] = [
    ['ES256 with d = 0', es256('00'.repeat(32))],
    ['ES256 with d = n', es256(P256_N)],
    ['ES256 with d above n', es256('ff'.repeat(32))],
    ['ES256 with a trailing byte', concat(es256(RFC6979_D), new Uint8Array(1))],
    ['ES256 cut by a byte', es256(RFC6979_D).subarray(0, 137)],
    ['ES256 without the public key', fromHex(`${ES256_PREFIX}${RFC6979_D}`)],
    [
      'ES256 with a compressed point marker',
      fromHex(`${ES256_PREFIX}${RFC6979_D}a14403420002${RFC6979_X}${RFC6979_Y}`),
    ],
    ['EdDSA cut by a byte', eddsa(RFC8032_SEED).subarray(0, 47)],
    ['EdDSA with a trailing byte', concat(eddsa(RFC8032_SEED), new Uint8Array(1))],
    ['Ed448 OID', fromHex(`302e020100300506032b657104220420${RFC8032_SEED}`)],
    ['a raw 32-byte seed', fromHex(RFC8032_SEED)],
    ['empty', new Uint8Array(0)],
  ];

  it.each(malformed)('refuses %s (CRYPTO-INV-027)', (_name, bytes) => {
    expect(passkeyAlgorithm(bytes)).toBeUndefined();
  });

  it('flips of every prefix byte are refused', () => {
    for (const key of [es256(RFC6979_D), eddsa(RFC8032_SEED)]) {
      const prefix = key.length === 138 ? 36 : 16;
      for (let i = 0; i < prefix; i++) {
        const bad = key.slice();
        bad[i] = (bad[i] ?? 0) ^ 0x01;
        expect(passkeyAlgorithm(bad), `byte ${String(i)}`).toBeUndefined();
      }
    }
    const bad = es256(RFC6979_D);
    bad[68] = 0xa0;
    expect(passkeyAlgorithm(bad)).toBeUndefined();
  });
});

describe('passkey public keys', () => {
  it('gives the COSE key and SPKI of an ES256 key from its layout', () => {
    const { cose, spki } = passkeyPublicKey(es256(RFC6979_D));
    expect(toHex(spki)).toBe(
      `3059301306072a8648ce3d020106082a8648ce3d030107034200` + `04${RFC6979_X}${RFC6979_Y}`,
    );
    expect(decodeCbor(cose)).toEqual(
      new Map<unknown, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromHex(RFC6979_X)],
        [-3, fromHex(RFC6979_Y)],
      ]),
    );
    // CTAP2 canonical order: 1, 3, -1, -2, -3.
    expect(toHex(cose.subarray(0, 7))).toBe('a5010203262001');
  });

  it('derives the Ed25519 public key of the RFC 8032 seed', () => {
    const { cose, spki } = passkeyPublicKey(eddsa(RFC8032_SEED));
    expect(toHex(spki)).toBe(`302a300506032b6570032100${RFC8032_PUBLIC}`);
    expect(decodeCbor(cose)).toEqual(
      new Map<unknown, unknown>([
        [1, 1],
        [3, -8],
        [-1, 6],
        [-2, fromHex(RFC8032_PUBLIC)],
      ]),
    );
  });

  it('refuses a malformed layout', () => {
    expect(() => passkeyPublicKey(es256('00'.repeat(32)))).toThrow(EncodingError);
  });
});

describe('DER Ecdsa-Sig-Value', () => {
  it.each([
    [
      'plain halves',
      '11'.repeat(32) + '22'.repeat(32),
      `3044022011${'11'.repeat(31)}022022${'22'.repeat(31)}`,
    ],
    [
      'a high bit takes a zero byte',
      '80' + '00'.repeat(31) + 'ff'.repeat(32),
      `30460221008${'0'.repeat(63)}022100${'ff'.repeat(32)}`,
    ],
    [
      'leading zeros are dropped',
      '00'.repeat(31) + '01' + '0080' + '00'.repeat(30),
      `3025020101022000${'80' + '00'.repeat(30)}`,
    ],
    ['zero halves', '00'.repeat(64), '3006020100020100'],
  ])('%s', (_name, raw, der) => {
    expect(toHex(ecdsaDer(fromHex(raw)))).toBe(der);
  });

  it('refuses anything but 64 bytes', () => {
    expect(() => ecdsaDer(new Uint8Array(63))).toThrow(EncodingError);
  });
});

describe('authenticator data (extension.md §7.3)', () => {
  it('is SHA-256(rpId), flags UP UV BE BS and signCount 0 on get', () => {
    const data = authenticatorData('example.com');
    expect(data.length).toBe(37);
    expect(data.subarray(0, 32)).toEqual(sha256(utf8('example.com')));
    expect(data[32]).toBe(UP | UV | BE | BS);
    expect(toHex(data.subarray(33))).toBe('00000000');
  });

  it('adds AT and the attested credential data, zero AAGUID, on create', () => {
    const credentialId = new Uint8Array(16).fill(0xab);
    const cose = passkeyPublicKey(eddsa(RFC8032_SEED)).cose;
    const data = authenticatorData('example.com', { credentialId, cose });
    expect(data[32]).toBe(UP | UV | BE | BS | AT);
    expect(toHex(data.subarray(33, 37))).toBe('00000000');
    expect(data.subarray(37, 53)).toEqual(new Uint8Array(16));
    expect(toHex(data.subarray(53, 55))).toBe('0010');
    expect(data.subarray(55, 71)).toEqual(credentialId);
    expect(data.subarray(71)).toEqual(cose);
  });

  it('refuses an empty rpId and a credentialId outside 1 to 1023 bytes', () => {
    const cose = passkeyPublicKey(eddsa(RFC8032_SEED)).cose;
    expect(() => authenticatorData('')).toThrow(EncodingError);
    expect(() => authenticatorData('a', { credentialId: new Uint8Array(0), cose })).toThrow(
      EncodingError,
    );
    expect(() => authenticatorData('a', { credentialId: new Uint8Array(1024), cose })).toThrow(
      EncodingError,
    );
  });
});

describe('createPasskey', () => {
  it.each<[PasskeyAlgorithm, number]>([
    ['ES256', 138],
    ['EdDSA', 48],
  ])(
    '%s: a new key in its layout, a random credentialId, attestation none',
    async (alg, length) => {
      const a = await createPasskey('example.com', alg);
      const b = await createPasskey('example.com', alg);
      expect(a.algorithm).toBe(alg);
      expect(COSE_ALGORITHM[alg]).toBe(alg === 'ES256' ? -7 : -8);
      expect(a.privateKey.length).toBe(length);
      expect(passkeyAlgorithm(a.privateKey)).toBe(alg);
      expect(a.privateKey).not.toEqual(b.privateKey);
      expect(a.credentialId.length).toBe(PASSKEY_CREDENTIAL_ID_LENGTH);
      expect(a.credentialId).not.toEqual(b.credentialId);
      const { cose, spki } = passkeyPublicKey(a.privateKey);
      expect(a.publicKey).toEqual(spki);
      expect(a.authenticatorData).toEqual(
        authenticatorData('example.com', { credentialId: a.credentialId, cose }),
      );
      const attestation = decodeCbor(a.attestationObject);
      expect(attestation).toEqual(
        new Map<unknown, unknown>([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', a.authenticatorData],
        ]),
      );
      // CTAP2 canonical order: fmt, attStmt, authData.
      expect(toHex(a.attestationObject.subarray(0, 5))).toBe('a363666d74');
    },
  );

  it('refuses an empty rpId', async () => {
    await expect(createPasskey('', 'EdDSA')).rejects.toThrow(EncodingError);
  });
});

describe('signPasskeyAssertion', () => {
  const clientDataJSON = utf8(
    '{"type":"webauthn.get","challenge":"AAEC","origin":"https://example.com"}',
  );

  it('signs authenticatorData ‖ SHA-256(clientDataJSON) with an ES256 layout, as DER', async () => {
    const key = es256(RFC6979_D);
    const { authenticatorData: data, signature } = await signPasskeyAssertion(
      key,
      'example.com',
      clientDataJSON,
    );
    expect(data).toEqual(authenticatorData('example.com'));
    const signed = concat(data, sha256(clientDataJSON));
    expect(await verifyEs256(passkeyPublicKey(key).spki, signature, signed)).toBe(true);
    expect(
      await verifyEs256(passkeyPublicKey(key).spki, signature, concat(signed, new Uint8Array(1))),
    ).toBe(false);
  });

  it('signs with a new ES256 key that verifies against its own public key', async () => {
    const created = await createPasskey('example.com', 'ES256');
    const { authenticatorData: data, signature } = await signPasskeyAssertion(
      created.privateKey,
      'example.com',
      clientDataJSON,
    );
    expect(
      await verifyEs256(created.publicKey, signature, concat(data, sha256(clientDataJSON))),
    ).toBe(true);
  });

  it('signs with an EdDSA layout, 64 raw bytes', async () => {
    const { authenticatorData: data, signature } = await signPasskeyAssertion(
      eddsa(RFC8032_SEED),
      'example.com',
      clientDataJSON,
    );
    expect(signature.length).toBe(64);
    const signed = concat(data, sha256(clientDataJSON));
    expect(lib().crypto_sign_verify_detached(signature, signed, fromHex(RFC8032_PUBLIC))).toBe(
      true,
    );
    signed[0] = (signed[0] ?? 0) ^ 1;
    expect(lib().crypto_sign_verify_detached(signature, signed, fromHex(RFC8032_PUBLIC))).toBe(
      false,
    );
  });

  it('leaves the stored key unchanged', async () => {
    const key = eddsa(RFC8032_SEED);
    await signPasskeyAssertion(key, 'example.com', clientDataJSON);
    expect(key).toEqual(eddsa(RFC8032_SEED));
  });

  it('refuses a malformed key and an empty rpId (CRYPTO-INV-027)', async () => {
    await expect(
      signPasskeyAssertion(es256('00'.repeat(32)), 'example.com', clientDataJSON),
    ).rejects.toThrow(EncodingError);
    await expect(signPasskeyAssertion(eddsa(RFC8032_SEED), '', clientDataJSON)).rejects.toThrow(
      EncodingError,
    );
  });
});

describe('signPasskeyAssertionHash (android.md §7.3, D301)', () => {
  // Computed once libsodium is ready.
  let clientDataHash: Uint8Array;
  beforeAll(() => {
    clientDataHash = sha256(utf8('{"type":"webauthn.get","challenge":"AAEC"}'));
  });

  it('signs authenticatorData ‖ clientDataHash with an ES256 layout, as DER', async () => {
    const key = es256(RFC6979_D);
    const { authenticatorData: data, signature } = await signPasskeyAssertionHash(
      key,
      'example.com',
      clientDataHash,
    );
    expect(data).toEqual(authenticatorData('example.com'));
    const signed = concat(data, clientDataHash);
    expect(await verifyEs256(passkeyPublicKey(key).spki, signature, signed)).toBe(true);
    // Not a signature over the hash hashed again, as with a clientDataJSON.
    expect(
      await verifyEs256(
        passkeyPublicKey(key).spki,
        signature,
        concat(data, sha256(clientDataHash)),
      ),
    ).toBe(false);
  });

  it('gives the EdDSA signature signPasskeyAssertion gives for the clientDataJSON of that hash', async () => {
    const json = utf8('{"type":"webauthn.get","challenge":"AAEC"}');
    const key = eddsa(RFC8032_SEED);
    const overHash = await signPasskeyAssertionHash(key, 'example.com', sha256(json));
    const overJson = await signPasskeyAssertion(key, 'example.com', json);
    expect(overHash.signature).toEqual(overJson.signature);
    expect(
      lib().crypto_sign_verify_detached(
        overHash.signature,
        concat(overHash.authenticatorData, clientDataHash),
        fromHex(RFC8032_PUBLIC),
      ),
    ).toBe(true);
  });

  it('refuses a hash that is not 32 bytes, a malformed key and an empty rpId (CRYPTO-INV-027)', async () => {
    for (const length of [0, 31, 33, 64]) {
      await expect(
        signPasskeyAssertionHash(eddsa(RFC8032_SEED), 'example.com', new Uint8Array(length)),
      ).rejects.toThrow(EncodingError);
    }
    await expect(
      signPasskeyAssertionHash(es256('00'.repeat(32)), 'example.com', clientDataHash),
    ).rejects.toThrow(EncodingError);
    await expect(signPasskeyAssertionHash(eddsa(RFC8032_SEED), '', clientDataHash)).rejects.toThrow(
      EncodingError,
    );
  });

  it('leaves the stored key and the hash unchanged', async () => {
    const key = eddsa(RFC8032_SEED);
    const hash = clientDataHash.slice();
    await signPasskeyAssertionHash(key, 'example.com', hash);
    expect(key).toEqual(eddsa(RFC8032_SEED));
    expect(hash).toEqual(clientDataHash);
  });
});
