// Stored passkeys (extension.md §7.3, record-content.md §4, D268, D288): key generation, the two
// fixed PKCS#8 layouts, signatures, authenticator data and the `none` attestation object. The
// checks on the request, the choice of passkey and `clientDataJSON` are the app's.

import { type CborValue, encodeCbor } from './cbor';
import { EncodingError } from './errors';
import { lib, randomBytes } from './sodium';

// The package compiles without the DOM lib; WebCrypto is declared to the extent used here.
interface EcdsaSubtle {
  generateKey(
    algorithm: { name: 'ECDSA'; namedCurve: 'P-256' },
    extractable: true,
    usages: ['sign'],
  ): Promise<{ readonly privateKey: unknown }>;
  exportKey(format: 'pkcs8', key: unknown): Promise<ArrayBuffer>;
  importKey(
    format: 'pkcs8',
    key: Uint8Array,
    algorithm: { name: 'ECDSA'; namedCurve: 'P-256' },
    extractable: false,
    usages: ['sign'],
  ): Promise<unknown>;
  sign(
    algorithm: { name: 'ECDSA'; hash: 'SHA-256' },
    key: unknown,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
}
declare const crypto: { readonly subtle: EcdsaSubtle };

export type PasskeyAlgorithm = 'ES256' | 'EdDSA';

/** The COSE algorithm identifier of each algorithm, as `pubKeyCredParams` lists them. */
export const COSE_ALGORITHM: Readonly<Record<PasskeyAlgorithm, number>> = { ES256: -7, EdDSA: -8 };

/** The length of a new passkey's `credentialId`. */
export const PASSKEY_CREDENTIAL_ID_LENGTH = 16;
const CREDENTIAL_ID_MAX = 1023;

const P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
// PKCS#8 of P-256 up to the private scalar, then the public key's tag up to the point's `04`.
const ES256_HEAD = hex('308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420');
const ES256_MIDDLE = hex('a14403420004');
const ES256_LENGTH = 138;
const D_AT = ES256_HEAD.length;
const X_AT = D_AT + 32 + ES256_MIDDLE.length;
const P256_N = hex('ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const ES256_SPKI_HEAD = hex('3059301306072a8648ce3d020106082a8648ce3d030107034200');
// RFC 8410.
const EDDSA_HEAD = hex('302e020100300506032b657004220420');
const EDDSA_LENGTH = 48;
const EDDSA_SPKI_HEAD = hex('302a300506032b6570032100');

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

function hex(s: string): Uint8Array {
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
}

function startsWith(bytes: Uint8Array, head: Uint8Array, at = 0): boolean {
  return head.every((b, i) => bytes[at + i] === b);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Whether the 32-byte big-endian `d` is 1 to n − 1. */
function scalarInRange(d: Uint8Array): boolean {
  if (d.every((b) => b === 0)) return false;
  for (let i = 0; i < 32; i++) {
    const a = d[i] ?? 0;
    const n = P256_N[i] ?? 0;
    if (a !== n) return a < n;
  }
  return false;
}

/**
 * The algorithm of a `passkey` field's `privateKey` (record-content.md §4), or `undefined` when it
 * is in neither layout. The ES256 point is not checked: a key that does not sign fails when used.
 */
export function passkeyAlgorithm(privateKey: Uint8Array): PasskeyAlgorithm | undefined {
  if (
    privateKey.length === ES256_LENGTH &&
    startsWith(privateKey, ES256_HEAD) &&
    startsWith(privateKey, ES256_MIDDLE, D_AT + 32) &&
    scalarInRange(privateKey.subarray(D_AT, D_AT + 32))
  ) {
    return 'ES256';
  }
  if (privateKey.length === EDDSA_LENGTH && startsWith(privateKey, EDDSA_HEAD)) return 'EdDSA';
  return undefined;
}

function checkedAlgorithm(privateKey: Uint8Array): PasskeyAlgorithm {
  const algorithm = passkeyAlgorithm(privateKey);
  if (algorithm === undefined) throw new EncodingError('passkey private key is not a known layout');
  return algorithm;
}

/**
 * The public key of a passkey's `privateKey`: as a COSE key (CTAP2 canonical CBOR) and as SPKI,
 * the DER the page's `getPublicKey()` returns.
 *
 * @internal
 */
export function passkeyPublicKey(privateKey: Uint8Array): {
  readonly cose: Uint8Array;
  readonly spki: Uint8Array;
} {
  if (checkedAlgorithm(privateKey) === 'ES256') {
    const x = privateKey.slice(X_AT, X_AT + 32);
    const y = privateKey.slice(X_AT + 32, X_AT + 64);
    const cose = encodeCbor(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, COSE_ALGORITHM.ES256],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]),
    );
    return { cose, spki: concat(ES256_SPKI_HEAD, privateKey.subarray(X_AT - 1)) };
  }
  const pair = lib().crypto_sign_seed_keypair(privateKey.subarray(EDDSA_HEAD.length));
  pair.privateKey.fill(0);
  const cose = encodeCbor(
    new Map<number, number | Uint8Array>([
      [1, 1],
      [3, COSE_ALGORITHM.EdDSA],
      [-1, 6],
      [-2, pair.publicKey],
    ]),
  );
  return { cose, spki: concat(EDDSA_SPKI_HEAD, pair.publicKey) };
}

/**
 * ECDSA's 64-byte `r ‖ s` as a DER `Ecdsa-Sig-Value`, the signature format WebAuthn uses for ES256.
 *
 * @internal
 */
export function ecdsaDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new EncodingError('ECDSA signature is not 64 bytes');
  const integer = (half: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < half.length - 1 && half[start] === 0) start++;
    const value = half.subarray(start);
    const pad = (value[0] ?? 0) & 0x80 ? [0] : [];
    return Uint8Array.from([0x02, value.length + pad.length, ...pad, ...value]);
  };
  const body = concat(integer(raw.subarray(0, 32)), integer(raw.subarray(32)));
  return concat(Uint8Array.from([0x30, body.length]), body);
}

/**
 * Authenticator data (extension.md §7.3): SHA-256 of `rpId`, flags UP, UV, BE and BS, `signCount`
 * 0; with `attested`, on create, AT and the attested credential data with a zero AAGUID.
 *
 * @internal
 */
export function authenticatorData(
  rpId: string,
  attested?: { readonly credentialId: Uint8Array; readonly cose: Uint8Array },
): Uint8Array {
  if (rpId === '') throw new EncodingError('empty rpId');
  const rpIdHash = lib().crypto_hash_sha256(lib().from_string(rpId));
  const head = concat(rpIdHash, Uint8Array.from([UP | UV | BE | BS | (attested ? AT : 0)]));
  const signCount = new Uint8Array(4);
  if (attested === undefined) return concat(head, signCount);
  const { credentialId, cose } = attested;
  if (credentialId.length < 1 || credentialId.length > CREDENTIAL_ID_MAX) {
    throw new EncodingError('credentialId length out of range');
  }
  const length = Uint8Array.from([credentialId.length >> 8, credentialId.length & 0xff]);
  return concat(head, signCount, new Uint8Array(16), length, credentialId, cose);
}

/** A passkey just created for a site: what its field stores and what the page receives. */
export interface CreatedPasskey {
  readonly algorithm: PasskeyAlgorithm;
  /** In its fixed PKCS#8 layout; the caller writes it into the item and wipes it. */
  readonly privateKey: Uint8Array;
  readonly credentialId: Uint8Array;
  /** SPKI DER, for `getPublicKey()`. */
  readonly publicKey: Uint8Array;
  readonly authenticatorData: Uint8Array;
  /** `fmt: "none"`, empty `attStmt`. */
  readonly attestationObject: Uint8Array;
}

/** A new ES256 key, exported once as PKCS#8 and kept only in the fixed layout. */
async function generateEs256(): Promise<Uint8Array> {
  const pair = await crypto.subtle.generateKey(P256, true, ['sign']);
  const exported = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  try {
    if (passkeyAlgorithm(exported) !== 'ES256') {
      throw new EncodingError('the browser exported P-256 in another PKCS#8 layout');
    }
    return exported.slice();
  } finally {
    exported.fill(0);
  }
}

/** Creates a passkey for `rpId` (extension.md §7.3): a new key, a random `credentialId`. */
export async function createPasskey(
  rpId: string,
  algorithm: PasskeyAlgorithm,
): Promise<CreatedPasskey> {
  if (rpId === '') throw new EncodingError('empty rpId');
  const privateKey =
    algorithm === 'ES256' ? await generateEs256() : concat(EDDSA_HEAD, randomBytes(32));
  const credentialId = randomBytes(PASSKEY_CREDENTIAL_ID_LENGTH);
  const { cose, spki } = passkeyPublicKey(privateKey);
  const data = authenticatorData(rpId, { credentialId, cose });
  const attestationObject = encodeCbor(
    new Map<CborValue, CborValue>([
      ['fmt', 'none'],
      ['attStmt', new Map<CborValue, CborValue>()],
      ['authData', data],
    ]),
  );
  return {
    algorithm,
    privateKey,
    credentialId,
    publicKey: spki,
    authenticatorData: data,
    attestationObject,
  };
}

export interface PasskeyAssertion {
  readonly authenticatorData: Uint8Array;
  /** DER for ES256, 64 bytes for EdDSA. */
  readonly signature: Uint8Array;
}

/** The length of a `clientDataHash`, SHA-256's. */
const CLIENT_DATA_HASH_LENGTH = 32;

/**
 * Signs a get (extension.md §7.3): `authenticatorData ‖ SHA-256(clientDataJSON)` with the stored
 * key, ES256 through WebCrypto with the key imported non-extractable for this signature only,
 * EdDSA through libsodium. `privateKey` is left unchanged.
 */
export async function signPasskeyAssertion(
  privateKey: Uint8Array,
  rpId: string,
  clientDataJSON: Uint8Array,
): Promise<PasskeyAssertion> {
  return signPasskeyAssertionHash(privateKey, rpId, lib().crypto_hash_sha256(clientDataJSON));
}

/**
 * Signs a get over the `clientDataHash` a privileged browser passed to the Android provider, which
 * builds `clientDataJSON` itself (android.md §7.3, D301): `authenticatorData ‖ clientDataHash`.
 * `privateKey` and `clientDataHash` are left unchanged.
 */
export async function signPasskeyAssertionHash(
  privateKey: Uint8Array,
  rpId: string,
  clientDataHash: Uint8Array,
): Promise<PasskeyAssertion> {
  if (clientDataHash.length !== CLIENT_DATA_HASH_LENGTH) {
    throw new EncodingError('clientDataHash is not 32 bytes');
  }
  const algorithm = checkedAlgorithm(privateKey);
  const data = authenticatorData(rpId);
  const signed = concat(data, clientDataHash);
  if (algorithm === 'ES256') {
    const key = await crypto.subtle.importKey('pkcs8', privateKey, P256, false, ['sign']);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signed),
    );
    return { authenticatorData: data, signature: ecdsaDer(raw) };
  }
  const pair = lib().crypto_sign_seed_keypair(privateKey.subarray(EDDSA_HEAD.length));
  try {
    return {
      authenticatorData: data,
      signature: lib().crypto_sign_detached(signed, pair.privateKey),
    };
  } finally {
    pair.privateKey.fill(0);
  }
}
