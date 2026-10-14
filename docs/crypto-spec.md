# BlindVault — Cryptographic Specification

> Normative for byte-level detail; `overview.md` prevails on design. Every construction here
> implements a section or decision of the overview, cited as §n or `Dn`. Record format version 1.
> Test vectors: `packages/crypto/test-vectors/crypto-v1.json`, generated independently by
> `tests/vectors/generate.py` (section 15).

## 1. Conventions

- `‖` is byte concatenation. Hex is lowercase. Sizes are in bytes. `MiB` = 1,048,576 bytes.
- `u8`, `u16`, `u32`, `u64` are unsigned big-endian integers of that width.
- A **label** is an ASCII string, encoded as its bytes, with no terminator.
- MUST, MUST NOT, SHOULD and MAY are used as in the overview.
- Every random value comes from `randombytes_buf` (libsodium CSPRNG).
- Every comparison of a secret or of an authenticator (MAC, key, derived key) uses `sodium_memcmp`
  (constant time). Derived public identifiers (`recordId`, `deviceId`) MAY be compared normally.
- Key buffers are wiped with `sodium_memzero` when released and on lock. JavaScript gives no
  guarantee that no other copy exists (§7); this is best effort (CRYPTO-INV-010).

## 2. Primitives

From `libsodium-wrappers-sumo` (§5.1), and nothing else for vault data:

| Use | Function | Parameters |
| --- | --- | --- |
| AEAD | `crypto_aead_xchacha20poly1305_ietf_encrypt` / `_decrypt` | key 32, nonce 24 (random), tag 16 |
| Password KDF | `crypto_pwhash`, `crypto_pwhash_ALG_ARGON2ID13` | salt 16, output 32 (section 6) |
| Subkeys | `crypto_kdf_derive_from_key` | key 32, context 8, subkey 32 |
| Hash, MAC | `crypto_generichash` (BLAKE2b) | output 16 or 32; key 32 when keyed |
| Keyslot key pair | `crypto_box_seed_keypair` | seed 32 |
| Keyslot | `crypto_box_seal` / `_open` | `.bvault` only, see `backup-format.md` |
| Padding | `sodium_pad` / `sodium_unpad` | block size 256 (D92) |
| Large data | `crypto_secretstream_xchacha20poly1305_*` | `.bvault` only, see `backup-format.md` |
| RNG | `randombytes_buf` | |
| Constant-time compare, wipe | `sodium_memcmp`, `sodium_memzero` | |

Import and item features use `crypto_secretbox_open_easy` (`.blindpass` only, D126) and WebCrypto
HMAC (TOTP only, D127); neither ever protects vault data. Noise uses its own suite (section 13).

`crypto_kdf_derive_from_key(n, id, ctx, key)` is, by libsodium's definition,
`BLAKE2b(message = "", key = key, outlen = n, salt = u64le(id) ‖ 0^8, personal = ctx ‖ 0^8)`.
The vector generator relies on this identity to compute subkeys without libsodium.

## 3. Layout encoding (D10)

AAD, MAC inputs, hash inputs and Noise prologues use one encoding, the **layout**:

```
field(x)            = u32(len(x)) ‖ x
layout(x1, …, xn)   = field(x1) ‖ … ‖ field(xn)
```

Every field is length-prefixed, including fixed-size ones, and fields appear in the fixed order of
their definition. Values inside a field:

| Kind | Encoding |
| --- | --- |
| label | ASCII bytes |
| `u16`, `u32`, `u64` integer | fixed width, big-endian |
| boolean | `u8`, `0x00` false or `0x01` true; any other value is rejected |
| ID | its raw 16 bytes |
| key, hash, fingerprint | raw bytes |

A layout has exactly one encoding for a given list of values, so two different value lists never
produce the same bytes. Layouts are only built, never parsed from untrusted input: a receiver
rebuilds the layout from values it has already validated.

## 4. Identifiers and HLC

| Identifier | Size | Origin |
| --- | --- | --- |
| `vaultId` | 16 | random (D25) |
| `localConfigId` | 16 | random, new with each Local Config (D121) |
| `phraseId` | 16 | random, new with each Recovery Phrase (§5.4) |
| `trashOperationId` | 16 | random, per trash action (D14) |
| Item ID, Folder ID | 16 | random |
| `deviceId` | 16 | `BLAKE2b-128(static public key)`, unkeyed (D19) |
| `versionId` | 16 | `BLAKE2b-128(key = versionId subkey, layout(itemId, hlc…))` (D6), see below |
| Vault Key `recordId` | 16 | `BLAKE2b-128(layout("bv.v1.recordid.vault-key", u32 keyEpoch))` |
| Recovery Envelope `recordId` | 16 | `BLAKE2b-128(layout("bv.v1.recordid.recovery-envelope", vaultId))` |

```
versionId = BLAKE2b-128(key = K_versionId,
                        layout(itemId, u64 physicalMs, u32 counter, deviceId))
```

The fixed `recordId`s are unkeyed so every device computes them from public values; every derived
`recordId` is recomputed on receipt (D66).

**Record identity (D158).** A record is identified by the pair (`recordType`, `recordId`) in
storage, sync summaries and merge, never by `recordId` alone. Some `recordId`s are public (Vault
Key, Recovery Envelope, `deviceId`), and a valid record of another type may carry one of them
(vector `records.identityCollision`); it is then a different record.

**HLC (D19).** `(physicalMs, counter, deviceId)`, compared lexicographically in that order:
`physicalMs` and `counter` as integers, `deviceId` bytewise. Ranges: `physicalMs` ≤ 2^53 − 1
(JavaScript safe integer), `counter` ≤ 2^32 − 1. Its canonical serialization is three layout fields
(`u64`, `u32`, 16 bytes) inside a layout, and the CBOR array `[physicalMs, counter, deviceId]` in a
record (section 9). Any other form is rejected.

## 5. Key hierarchy and subkeys (§5.2, D23)

All keys are 32 bytes. The Master Key and every Vault Key are random. Every other key below is
derived with `crypto_kdf_derive_from_key`. A subkey ID is never reused for another purpose; changing
a derivation takes a new context, not a new ID.

| Context | Parent key | ID | Subkey | Use |
| --- | --- | --- | --- | --- |
| `bvmaster` | Master Key | 1 | `K_vaultKeyWrap` | wraps each Vault Key (section 10) |
| `bvmaster` | Master Key | 2 | `K_versionId` | keys `versionId` (section 4) |
| `bvmaster` | Master Key | 3 | `K_readmission` | re-admission key-confirmation MAC (section 13) |
| `bvmaster` | Master Key | 4 | `K_localConfig` | encrypted part of Local Config (section 12) |
| `bvrphras` | phrase entropy | 1 | Recovery KEK | parent of the next two rows (§5.4) |
| `bvrckek_` | Recovery KEK | 1 | `K_envelope` | wraps the Master Key in the Recovery Envelope |
| `bvrckek_` | Recovery KEK | 2 | keyslot seed | `crypto_box_seed_keypair` → recovery keyslot key pair (D16) |
| `bvprfkek` | PRF output | 1 | PRF KEK | wraps the Master Key locally (section 12) |

The Master Key is never used directly as an encryption key, and neither are the phrase entropy, the
Recovery KEK or the PRF output.

### 5.1 Recovery Phrase (§5.4, D2)

- Entropy: 32 random bytes, shown as the 24-word BIP39 mnemonic (English wordlist, 8-bit checksum).
- Input: the typed phrase is NFKD-normalized, lowercased, and split on runs of characters with the
  Unicode `White_Space` property; it MUST have
  exactly 24 words from the list and a valid checksum, or it is rejected before any derivation.
- The entropy is the mnemonic's entropy bytes. The BIP39 PBKDF2 seed and passphrase are **not**
  used.
- The keyslot private key exists only while the phrase is in use and is wiped afterwards.

### 5.2 PRF KEK (§5.5, D75)

At setup the app generates a random 32-byte PRF input, stored in the cleartext part of Local Config
with the credential ID (the "PRF KEK state"), and requests `prf.eval.first = PRF input` with
`userVerification: "required"`. The 32-byte `prf.results.first` is the PRF output. An assertion whose
authenticator data does not have the UV flag set is rejected before any derivation (CRYPTO-INV-021).

## 6. Passwords and Argon2id (D9, D71, D134)

- **Normalization**, for the local password and the export password, before the strength check and
  before Argon2id, following the RFC 8265 OpaqueString profile in this exact subset:
  1. Map every character of Unicode general category `Zs` (space separators, such as U+00A0) to
     U+0020.
  2. Normalize to NFC.
  3. Reject the password if it contains a character of category `Cc` (control), or if it is empty
     or consists only of characters with the Unicode `White_Space` property.
  4. Encode as UTF-8.

  The full PRECIS `FreeformClass` restrictions are not applied.
- **Device KEK** = `crypto_pwhash(32, password, salt, opslimit, memlimit, ARGON2ID13)`, salt 16
  random bytes, new each time a local password is set.
- **Calibration** whenever a local password is set (§5.3, D166): `memlimit` = 64 MiB (67,108,864
  bytes), confirmed by the Phase 0 Argon2id spike (D9). `opslimit` is found in these steps, each
  timing one derivation of the password being set:
  1. Derive at `opslimit` 2, taking `t` ms. If `t` ≥ 1000, the result is 2.
  2. Otherwise derive at `o = min(64, ceil(2 × 1000 / t))`.
  3. While that derivation took less than 1000 ms and `o` < 64, set `o = o + 1` and derive again.
  4. The result is the last `o`. The derivation at the result is the one whose output is the Device
     KEK.

  Every derivation runs in a Web Worker.
- **Accepted range at unlock.** The cleartext Local Config can be tampered with, so before deriving,
  the stored parameters MUST be within `memlimit` ∈ [64 MiB, 256 MiB] and `opslimit` ∈ [2, 64];
  anything else is rejected without running Argon2id.
- Export password parameters and their accepted range are in `backup-format.md` (D78).
- `.blindpass` import uses libsodium's `SENSITIVE` limits as BlindPass constants (D126).

## 7. AEAD

```
seal(key, aad, plaintext) = { n: nonce, c: crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, aad, nonce, key) }
nonce = 24 random bytes, new for every encryption
```

`c` holds the ciphertext followed by the 16-byte tag. A nonce is never chosen any other way, and
with 24 random bytes a repeat under one key is negligible (§5.6). Decryption failure, of any cause,
is reported as one error and leaves no partial plaintext.

## 8. AAD (§5.6, D8, D21, D121)

**Record AAD**, for every part of a synchronized record:

```
AAD_record = layout(u16 recordFormatVersion,
                    u16 recordType,
                    vaultId,
                    recordId,
                    u32 keyEpoch,
                    u64 hlc.physicalMs,
                    u32 hlc.counter,
                    hlc.deviceId,
                    u8  deleted)
```

That is 9 fields with 9 length prefixes: 9 × 4 + (2 + 2 + 16 + 16 + 4 + 8 + 4 + 16 + 1) =
**105 bytes**. `vaultId` comes from Local Config; every other field from the record header.

**Local wrap AAD**, for wraps that are not records:

```
AAD_local(purpose) = layout(purpose, vaultId, localConfigId)
```

| Purpose label | Protects |
| --- | --- |
| `bv.v1.mk-wrap.device-kek` | Master Key under the Device KEK |
| `bv.v1.mk-wrap.prf-kek` | Master Key under the PRF KEK |
| `bv.v1.local-config` | encrypted part of Local Config under `K_localConfig` |

Record AAD has no purpose label: its parts are encrypted under different keys (a Vault Key, a
record key, `K_vaultKeyWrap`, `K_envelope`), so one part cannot be opened as another.

## 9. Record format v1 (§6, D10, D18, D32, D92)

### 9.1 Registry

`recordFormatVersion` = **1**. `keyEpoch` starts at **1** and is at most 2^32 − 1 (it is a `u32` in
the AAD); 0 is invalid.

| `recordType` | Value | Envelope keys besides the header |
| --- | --- | --- |
| Item | 1 | `wk`, `ct` |
| Folder | 2 | `wk`, `ct` |
| Item Version | 3 | `wk`, `ct` |
| Vault Key | 4 | `ct` (the Vault Key wrap; no record key) |
| Recovery Envelope | 5 | `wk`, `ct` (metadata), `mk` (Master Key wrap) |
| Device | 6 | `wk`, `ct` |
| Template | 7 | reserved after v1: rejected |

An unknown `recordFormatVersion` or `recordType` is rejected (D32, D81).

### 9.2 Envelope

A stored or transferred record is a deterministic CBOR map with text keys (D10):

| Key | CBOR type | Value |
| --- | --- | --- |
| `v` | uint | `recordFormatVersion` |
| `t` | uint | `recordType` |
| `id` | bstr, 16 | `recordId` |
| `e` | uint | `keyEpoch` |
| `hlc` | array `[uint, uint, bstr 16]` | HLC |
| `del` | bool | `deleted` |
| `wk` | map `{n: bstr 24, c: bstr 48}` | record key sealed under the Vault Key of epoch `e` |
| `ct` | map `{n: bstr 24, c: bstr}` | content sealed under the record key (Vault Key record: under `K_vaultKeyWrap`) |
| `mk` | map `{n: bstr 24, c: bstr 48}` | Master Key sealed under `K_envelope` (Recovery Envelope only) |

The envelope has exactly the keys listed for its `recordType` in section 9.1, and each of `wk`,
`ct` and `mk` has exactly the keys `n` and `c`: a missing key, an extra key, a wrong type or a wrong
length is rejected. Envelope decoding is strict (section 14).

**Largest envelope:** 1,049,130 bytes, a Recovery Envelope with every header field at its maximum
and `ct.c` at the cap (computed by the generator, `records.maxEnvelopeLength`). A longer input is
rejected before decoding, and the decoder is configured with this limit (D129).

### 9.3 Encrypting content

On every write, purge included, a device generates a **new random record key** and seals it with
the record's AAD (D18: the key is re-wrapped on every write, here by being replaced):

```
wk = seal(VaultKey[e], AAD_record, recordKey)
ct = seal(recordKey,   AAD_record, sodium_pad(CBOR(content), 256))
```

- **Content** is a deterministic CBOR map with text keys. Unknown keys from a newer app version are
  kept as received (D52, D59, D98); the schema per record type is in `record-content.md` (D165),
  except the parts fixed below.
- **Padding (D92).** Every content is padded to a multiple of 256 bytes. The Vault Key wrap and the
  Master Key wrap are not padded.
- **Purged tombstone (D27).** `del = true` and `ct = seal(recordKey, AAD_record, "")`: empty
  plaintext, no padding, so `ct.c` is exactly 16 bytes.

### 9.4 Size caps (D129, D139, D143, D144)

- **Record cap:** `len(CBOR(content))` ≤ 1 MiB = 1,048,576 before padding. `sodium_pad` always adds
  1 to 256 bytes, so the largest valid `ct.c` is 1,048,576 + 256 + 16 = **1,048,848 bytes**. A
  received `ct.c` longer than that is rejected before any decryption.
- **Item Version content:** `{"item": <item content map>, "itemId": bstr 16}`. A version of a
  trashed state carries `trashOperationId` inside the item map.
- **Item cap:** the item content, encoded without `trashOperationId`, MUST NOT exceed
  **1,048,510 bytes** = 1 MiB − 66, where 66 is the largest overhead an Item Version of a trashed
  state adds:

  | Overhead | Bytes |
  | --- | --- |
  | Item Version map header (`0xa2`) | 1 |
  | key `"item"` | 5 |
  | key `"itemId"` | 7 |
  | `itemId` value (`0x50` + 16) | 17 |
  | key `"trashOperationId"` (`0x70` + 16) | 17 |
  | `trashOperationId` value | 17 |
  | item map header growing when one entry is added (at most 3 → 5 bytes) | 2 |
  | **Total** | **66** |

  The cap check counts the item map exactly as encoded, so a header that grows by less adds no slack
  anyone relies on. Changing these key names changes the cap and is a record format change (D32).

### 9.5 Verification on receipt (§9.2, D57, D64, D66, D92, D129, D144)

A received or restored record passes these checks, in this order, before it takes part in merge or
is persisted; any failure rejects it (CRYPTO-INV-018). The negative vectors name the step each one
fails (`expectedStep`).

1. **Size:** the envelope is at most 1,049,130 bytes, checked before decoding.
2. **Encoding:** strict CBOR decode and the re-encode check (section 14).
3. **Structure:** `v` and `t` known (D32, D81); keys, types and lengths as in section 9.2, inner
   maps included; `1 ≤ e ≤ 2^32 − 1`; HLC within its ranges (section 4).
4. **Deletion state:** `del` is always `false` for Vault Key, Recovery Envelope, Device and Item
   Version (D42, D56).
5. **Ciphertext length**, before any decryption:
   - Vault Key: `ct.c` is exactly 48 bytes.
   - Every other type: `ct.c` is exactly 16 bytes (empty content) or `len(ct.c) − 16` is a positive
     multiple of 256 (D92), and `len(ct.c)` ≤ 1,048,848 (D129). `sodium_unpad` alone does not check
     that the length is a multiple of the block size, so this check is required.
6. **AAD:** build `AAD_record` with the local `vaultId`.
7. **Authentication:** open `wk` with the Vault Key of epoch `e` (not held → reject), then `ct`
   with the record key. Vault Key record: open `ct` with `K_vaultKeyWrap`. Recovery Envelope: `mk`
   is opened only with the phrase (§5.4).
8. **Plaintext:** empty plaintext is valid only with `del = true` (a purged tombstone). Otherwise
   `sodium_unpad` MUST succeed and the result MUST decode as a strict CBOR map. Recovery Envelope
   metadata MUST hold `keyslotPublicKey` (bstr 32), `phraseId` (bstr 16) and `phraseCreatedAt`
   (uint), since D44 compares them.
9. **Item cap:** for an Item or Item Version, the item content without `trashOperationId` is at
   most 1,048,510 bytes. An Item Version whose `item` is not a map fails here, since its cap cannot
   be counted.
10. **Derived `recordId`:** recompute it (`versionId`, Vault Key, Recovery Envelope, `deviceId`) and
    compare. An Item Version without a 16-byte `itemId`, or a Device record without a 32-byte
    `publicKey`, fails here, since its `recordId` cannot be derived.

The HLC bound, merge rules and type-specific immutability (D42, D44) are in `sync-protocol.md`.

## 10. Vault Key record (§6, D23, D42)

```
recordId = Vault Key recordId for keyEpoch e          (section 4)
ct       = seal(K_vaultKeyWrap, AAD_record, VaultKey)  (c: 32 + 16 = 48 bytes)
```

## 11. Recovery Envelope (§5.4, D2, D16, D24, D44)

```
recordId = Recovery Envelope recordId for vaultId     (section 4)
e        = epoch of the Vault Key that seals wk
mk       = seal(K_envelope, AAD_record, MasterKey)
wk       = seal(VaultKey[e], AAD_record, recordKey)
ct       = seal(recordKey, AAD_record, sodium_pad(CBOR(metadata), 256))
metadata = { "keyslotPublicKey": bstr 32, "phraseCreatedAt": uint (Unix ms), "phraseId": bstr 16, …unknown keys kept (D98) }
```

Check Recovery Phrase (D24, D180) opens `mk` with `K_envelope` from the typed phrase, compares
`K_vaultKeyWrap` derived from the Master Key it opens with the session's, in constant time, and
compares `keyslotPublicKey` with the one derived from the phrase. The result is `opens`,
`wrong-phrase` (`mk` does not open), `master-key-mismatch` or `public-key-mismatch`, the Master
Key checked first; every key derived for the check is wiped before it returns.

A restore opened with the phrase (`backup-format.md` §8 step 8, D43) runs the same check against
the payload's Master Key instead of the session's: it opens `mk` with the `K_envelope` it already
derived for the keyslot and compares the Master Key itself with `meta.masterKey` in constant time.
An `mk` that does not open and another Master Key are both `master-key-mismatch` there, since the
phrase already opened the file.

**Constraint on a future Vault Key rotation.** `mk` is bound to the envelope's AAD, which holds `e`.
Moving the envelope to a new epoch therefore rewrites `mk`, which needs the phrase. A rotation
design (after v1, D11) MUST account for this, as format migration already does (§5.7).

## 12. Local Config wraps (§6, D58, D67, D121)

```
mkWrap.deviceKek = seal(Device KEK,    AAD_local("bv.v1.mk-wrap.device-kek"), MasterKey)
mkWrap.prfKek    = seal(PRF KEK,       AAD_local("bv.v1.mk-wrap.prf-kek"),    MasterKey)
encryptedPart    = seal(K_localConfig, AAD_local("bv.v1.local-config"),       sodium_pad(CBOR(encrypted part), 256))
```

The encrypted part is padded like record content (D159):
`encryptedPart = seal(K_localConfig, AAD_local("bv.v1.local-config"), sodium_pad(CBOR(encrypted part), 256))`.

The cleartext part holds only what CRYPTO-INV-019 allows: `localConfigFormatVersion` (D164),
`vaultId`, `localConfigId`, Argon2id salt and parameters, `mkWrap.deviceKek`, the PRF KEK state
(credential ID, PRF input, `mkWrap.prfKek`), and the replaced `vaultId` while it exists (D96). Both
parts, as CBOR maps, are in `record-content.md` §9.

## 13. Transcripts and MACs (§8, §9.1, D1, D17, D29)

**Noise.** `Noise_XX_25519_ChaChaPoly_BLAKE2b` for admission, `Noise_KK_25519_ChaChaPoly_BLAKE2b`
for sync, `Noise_K_25519_ChaChaPoly_BLAKE2b` for the reconnection payload (D17), from the copied
implementation gated by the official vectors (D157). The handshake hash is 64 bytes.

**Prologues**, in fixed role order (initiator first):

```
prologue_XX = layout("bv.pairing.v1", BLAKE2b-256(payload_initiator), BLAKE2b-256(payload_responder),
                     dtlsFingerprint_initiator, dtlsFingerprint_responder)
prologue_KK = layout("bv.sync.v1",    BLAKE2b-256(reconnection_initiator), BLAKE2b-256(reconnection_responder),
                     dtlsFingerprint_initiator, dtlsFingerprint_responder)
```

Inputs, pinned so both sides hash the same bytes:

- **Initiator** is the Noise handshake initiator; `pairing-protocol.md` and `sync-protocol.md`
  assign the role (in pairing, device A, which shows the first QR).
- **Pairing payload:** the binary payload exactly as exchanged, after base45 decoding, including
  the commitment the initiator's payload carries in every pairing (D199).
- **Reconnection payload:** the `Noise_K` message exactly as transmitted (its ciphertext), not its
  plaintext.
- **DTLS fingerprint:** the 32-byte SHA-256 certificate fingerprint carried in each payload (§8.3).
  Each side also checks that the remote certificate of the live connection matches the
  fingerprint in the peer's payload; the SDP rebuilt from the payload enforces this.

**Re-admission key confirmation (D29):**

```
mac(role) = BLAKE2b-256(key = K_readmission, layout("bv.v1.readmission", role, handshakeHash))
role      = "initiator" | "responder"
```

Each side sends its own MAC and verifies the other's with `sodium_memcmp`.

The SAS derivation, payload formats, the commitment and the `Noise_K` prologue are specified
in `pairing-protocol.md` and `sync-protocol.md`, using the layout encoding.

## 14. CBOR (D10)

- Encoding: RFC 8949 §4.2 core deterministic encoding (`cbor2`, `cde: true`).
- Decoding: strict (`cde`, `rejectDuplicateKeys`, `rejectLongFloats`, `rejectUndefined`,
  `rejectSimple`, `ignoreGlobalTags`, no tags), so non-shortest integers or lengths,
  indefinite lengths, unsorted or duplicate map keys, non-preferred floats, `undefined`, simple
  values and tags are rejected.
- **Re-encode check:** every decode re-encodes the decoded value and requires byte equality with the
  input, as a second barrier against a decoder regression (`architecture.md`).
- **Envelope** types are fixed by section 9.2.
- **Content** may hold any value core deterministic encoding allows, so unknown content from a newer
  app survives a round trip (D52, D59, D98): unsigned and negative integers, byte and text strings,
  arrays, maps, `true`, `false`, `null`, and floats in their shortest form (NaN only as
  `0xf97e00`). Tags, `undefined` and other simple values are rejected. Text MUST be valid UTF-8.

## 15. Test vectors

The same generator writes the `record-content.md` vectors to
`packages/vault/test-vectors/content-v1.json` (`record-content.md` §10), and the
`pairing-protocol.md` §3 vectors to `packages/sync/test-vectors/pairing-v1.json`: base45 (the RFC
9285 examples and rejected texts), valid payloads with their bytes and text, and one invalid payload
per rule of §3.3, tagged with the reason it is refused (`version`, `malformed`, `wrong-role`,
`wrong-session`). `packages/sync` MUST reproduce and reject them the same way.

`tests/vectors/generate.py` computes every vector with Python's `hashlib` (BLAKE2b, `crypto_kdf`)
and PyNaCl (AEAD, Argon2id, `crypto_box_seed_keypair`, padding), independently of the TypeScript
code, and writes `packages/crypto/test-vectors/crypto-v1.json`. Inputs are fixed bytes, nonces
included, so the output is deterministic. Run:

```sh
uv run tests/vectors/generate.py
```

Phase 1 tests in `packages/crypto` MUST reproduce every vector byte for byte, MUST reject every
negative vector at its `expectedStep`, and MUST fail to open every `mustNotOpen` case. The generator
holds a reference implementation of section 9.5 and refuses to write vectors it does not agree
with.

| Section | Covers |
| --- | --- |
| `layout` | field encoding, record AAD (deleted false and true), local wrap AAD per purpose |
| `kdf` | every subkey of section 5, keyslot key pair |
| `ids` | `deviceId`, `versionId`, Vault Key and Recovery Envelope `recordId` |
| `bip39` | entropy ↔ 24-word mnemonic, Recovery KEK chain, accepted and rejected input |
| `argon2id` | Device KEK at 64 MiB, ops 2; normalization (decomposed input, U+00A0, control character rejected, whitespace-only rejected); parameters outside the accepted range |
| `pad` | `sodium_pad` at lengths 0, 1, 255, 256, 257 |
| `records` | full v1 envelopes (Item, purged tombstone, Vault Key, Recovery Envelope, Item Version, Item with unknown float and negative-integer content, Item sharing the Vault Key `recordId`), each with a fresh record key; caps; `mustNotOpen` (wrong AAD field, flipped tag and ciphertext, `mk`/`wk` confusion) |
| `local` | Master Key wraps, Local Config wrap of a valid `record-content.md` §9 encrypted part, `mustNotOpen` (other `localConfigId`, `vaultId`, purpose) |
| `transcripts` | XX and KK prologues, re-admission MACs |
| `negative` | envelopes that MUST be rejected, each violating one rule and tagged with the section 9.5 step that rejects it; size cases given by length |

## 16. TOTP and the password generator (D127, D128, D138)

Neither protects vault data; both live in `packages/crypto` (overview §4).

**TOTP.** RFC 6238 over WebCrypto HMAC (`SHA-1`, `SHA-256`, `SHA-512`): the key is the RFC 4648
base32 decoding of `secret` (trailing bits that do not fill a byte are dropped), the counter is
`floor(floor(nowMs / 1000) / period)` as a `u64`, and the code is the RFC 4226 dynamic truncation
modulo `10^digits`, left-padded with zeros. Codes are tested against the RFC 6238 Appendix B
vectors for the three algorithms. The value is checked against `record-content.md` §4 before
computing.

**`otpauth://` input.** Only `otpauth://totp/<label>?<params>`, with the scheme and type in any
case and no fragment. Parameter names are case-insensitive; a repeated parameter, malformed
percent-encoding, a missing or invalid `secret`, an algorithm other than SHA1, SHA256 or SHA512
(any case), and `digits` or `period` that are not a decimal integer within the §4 range are
rejected, never replaced by a default. `+` in a parameter value decodes as a space. The label is
`issuer:accountName` or `accountName`; the `issuer` parameter wins over the label prefix. Empty
`issuer` or `accountName` are omitted, and a control character in either rejects the URI. Unknown
parameters are ignored. Absent `algorithm`, `digits` and `period` are written as SHA1, 6 and 30.

**Password generator.** Every choice is one `randombytes_uniform(n)` call, with `n` the size of the
alphabet or of the word list, so no modulo bias.

| Setting | Value |
| --- | --- |
| Character sets | `lowercase` a–z, `uppercase` A–Z, `digits` 0–9, `symbols` the 32 ASCII punctuation characters `` !"#$%&'()*+,-./:;<=>?@[\]^_`{\|}~ `` |
| Alphabet | union of the selected sets, in that fixed order (94 characters with all four) |
| Characters | default 20, minimum 12, maximum 128 |
| Words | BIP39 English list (2,048 words), default 6, minimum 4, maximum 24, joined by `-` |
| Entropy | `length × log2(alphabet size)` or `words × 11` bits, exact |

Settings outside these limits produce no value.
