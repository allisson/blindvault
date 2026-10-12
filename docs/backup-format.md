# BlindVault — Backup Format v1

> Normative for the bytes of a `.bvault` file; `overview.md` prevails on design. Implements
> overview §10 and D3, D16, D43, D64, D78, D95 and D178, using the conventions, primitives and
> encodings of `crypto-spec.md` (§1, §2, §3, §6, §14). Backup format version 1.
> Test vectors: `packages/backup/test-vectors/backup-v1.json` (section 9).

## 1. Overview

```
file    = header ‖ stream
header  = magic ‖ u16 formatVersion ‖ u32 headerLength ‖ CBOR(headerMap)
stream  = secretstream chunks of the payload, under the file key
payload = u32 len ‖ CBOR(meta) ‖ (u32 len ‖ record envelope) × recordCount
```

- A random 32-byte **file key** encrypts the payload with
  `crypto_secretstream_xchacha20poly1305`. Each keyslot wraps the file key (D3).
- The **recovery keyslot** is mandatory and seals the file key to the recovery keyslot public key
  held in the Recovery Envelope's metadata, so any unlocked device makes it without the phrase
  (D16). The **password keyslot** is optional and wraps the file key under an Argon2id KEK of the
  export password (D36).
- The header is in the clear and is authenticated as additional data of the first stream chunk
  (section 5), so it is verified only once a keyslot opens (D95).
- Fixed-size chunks with no framing hide the number and size of the records: the file size reveals
  only the size of the payload (§10).

## 2. Header

| Field | Size | Value |
| --- | --- | --- |
| `magic` | 8 | `89 42 56 41 55 4c 54 0a` (`\x89BVAULT\n`) |
| `formatVersion` | 2 | `u16`, **1** |
| `headerLength` | 4 | `u32`, length of `CBOR(headerMap)`, 1 to 4,096 |
| `headerMap` | `headerLength` | deterministic CBOR map, below |

The non-ASCII first byte and the final line feed, as in PNG, make a file damaged by a text-mode
transfer fail the magic check.

`headerMap` has exactly these keys, decoded strictly (`crypto-spec.md` §14):

| Key | CBOR type | Value |
| --- | --- | --- |
| `keyslots` | array of 1 or 2 maps | the recovery keyslot, then the password keyslot when present (section 3) |
| `phraseCreatedAt` | uint | creation date of the Recovery Phrase, Unix ms (§5.4) |
| `phraseId` | bstr, 16 | `phraseId` of the Recovery Phrase that opens the recovery keyslot |
| `stream` | bstr, 24 | the `secretstream` header from `init_push` |

`phraseId` and `phraseCreatedAt` are the only values shown before a keyslot opens, to choose one;
the UI marks them unverified until the stream's first chunk authenticates the header (D95).
`vaultId`, the export date and the record count are inside the payload.

## 3. Keyslots

**Recovery keyslot** (`t` = 1), always first:

| Key | CBOR type | Value |
| --- | --- | --- |
| `t` | uint | 1 |
| `c` | bstr, 80 | `crypto_box_seal(fileKey, keyslotPublicKey)` (32 + 48) |

`keyslotPublicKey` is read from the Recovery Envelope metadata the exporting device holds
(`crypto-spec.md` §11). On restore the phrase derives the keyslot key pair (`crypto-spec.md` §5)
and `crypto_box_seal_open` recovers the file key; the private key is wiped right after.

**Password keyslot** (`t` = 2), optional, always second:

| Key | CBOR type | Value |
| --- | --- | --- |
| `t` | uint | 2 |
| `salt` | bstr, 16 | random, new for every export |
| `ops` | uint | Argon2id `opslimit` |
| `mem` | uint | Argon2id `memlimit`, bytes |
| `n` | bstr, 24 | AEAD nonce |
| `c` | bstr, 48 | wrapped file key (32 + 16) |

```
KEK = crypto_pwhash(32, password, salt, ops, mem, ARGON2ID13)   password normalized as crypto-spec §6
c   = seal(KEK, layout("bv.bvault.v1.keyslot.password"), fileKey)
```

`seal` is `crypto-spec.md` §7. The export password passes the strength check of D134 and D155
before any derivation.

A keyslot map has exactly the keys of its `t`. Any other `t`, a missing or extra key, a wrong type
or length, more than two keyslots, a password keyslot first, or two of the same `t` is rejected.

## 4. Argon2id parameters (D78)

| | `memlimit` | `opslimit` |
| --- | --- | --- |
| **Export**, fixed | 64 MiB (67,108,864) | **12** |
| **Accepted on restore** | 64 MiB to 256 MiB | 2 to 64 |

- The export parameters are fixed, not calibrated, so a backup made on a desktop opens on a phone
  (§10). Ops 12 is the first value that reached 1 s at 64 MiB on the slowest device measured, a
  Samsung A54 (1,074 ms, `docs/spikes/argon2id.md`).
- The accepted range is the local unlock range (`crypto-spec.md` §6), so a later version can raise
  the export parameters without changing the rule. A restore checks `mem` and `ops` against it
  before running Argon2id, since the header is not yet authenticated: a tampered header bounds the
  memory and the passes it can demand, never exceeds them.
- Every derivation runs in the Argon2id worker.

## 5. Stream

- `init_push(fileKey)` gives the 24-byte `stream` header of section 2.
- The payload (section 6) is cut into chunks of exactly **65,536 bytes** of plaintext, each pushed
  with `TAG_MESSAGE`, and one last chunk of `len(payload) mod 65,536` bytes, possibly empty, pushed
  with `TAG_FINAL`. A final chunk therefore holds 0 to 65,535 bytes.
- The **first chunk**, final or not, is pushed with additional data = the header bytes exactly as
  written, from `magic` to the end of `CBOR(headerMap)`. Every other chunk has empty additional data.
- Chunks follow the header with no framing. A chunk's ciphertext is its plaintext plus 17 bytes
  (`ABYTES`): 65,553 bytes for a `TAG_MESSAGE` chunk and 17 to 65,552 for the final one.

**Reading.** With `r` the bytes left after the header: while `r` > 65,552, the next 65,553 bytes
are a chunk that MUST pull with `TAG_MESSAGE`; then the last `r` bytes, at least 17, are a chunk
that MUST pull with `TAG_FINAL`. Rejected (D95):

- a chunk that fails to authenticate, including the first under a changed header;
- `TAG_FINAL` on any chunk but the last, or a last chunk without it (truncation);
- bytes after the `TAG_FINAL` chunk, or fewer than 17 bytes where a chunk must be;
- `TAG_PUSH` or `TAG_REKEY` on any chunk.

## 6. Payload

The concatenated plaintext of the chunks:

```
payload = u32 len(m) ‖ m ‖ u32 len(e1) ‖ e1 ‖ … ‖ u32 len(eN) ‖ eN
m       = CBOR(meta),   1 ≤ len(m) ≤ 256
ei      = a record envelope exactly as stored (crypto-spec §9.2),   1 ≤ len(ei) ≤ 1,049,130
```

`meta` has exactly these keys, decoded strictly:

| Key | CBOR type | Value |
| --- | --- | --- |
| `exportedAt` | uint | export time, Unix ms |
| `masterKey` | bstr, 32 | the Master Key (D25) |
| `recordCount` | uint | `N`, the number of envelopes that follow |
| `vaultId` | bstr, 16 | the vault's `vaultId` (D25) |

- The envelopes are every record the device holds, of every type: Items, Item Versions, Folders,
  tombstones, Vault Keys, Device records and the Recovery Envelope. Local Config and the device
  identity are local and are not exported.
- The payload ends exactly after `eN`: fewer envelopes than `recordCount`, a length out of range, a
  length that runs past the payload, or any byte after `eN` is rejected.
- The length prefixes are inside the stream and reveal nothing outside it.
- A restore reads envelopes one by one as chunks are pulled, never decoding the payload as one CBOR
  value.

## 7. Versions and unknown content

- A wrong `magic` is rejected as not a BlindVault backup; `formatVersion` 0 likewise.
- A `formatVersion` above 1 is rejected before anything else is read: the backup needs a newer app.
- Format v1 is strict: an unknown key in `headerMap`, a keyslot or `meta` is rejected. Any
  extension is a new `formatVersion`.
- Unknown content inside records is untouched: envelopes travel as stored, so a newer app's content
  keys survive an export and a restore (D98). A record with an unknown `recordFormatVersion` or
  `recordType` rejects the whole restore (D61, D81).

## 8. Export and restore

**Export**, on an unlocked device:

1. Verify every held record as on receipt (`crypto-spec.md` §9.5); on a failure, abort, write no
   file and name the record (D64). Warn that the backup may be incomplete while Local Config lists
   peers whose records were rejected (D115).
2. Read `keyslotPublicKey`, `phraseId` and `phraseCreatedAt` from the Recovery Envelope metadata.
3. Generate the file key; build the recovery keyslot and, with an export password, the password
   keyslot at the export parameters of section 4.
4. Encode the header, then stream the payload.
5. Wipe the file key and the KEK. Record the date of the last backup in Local Config (§13.4).

**Restore**, in this order; any failure rejects the file and writes nothing (D61, D64):

1. `magic`, `formatVersion`, `headerLength` within range; strict decode of `headerMap`
   (sections 2, 3, 7).
2. Show `phraseId` and `phraseCreatedAt` as unverified; the user picks a keyslot.
3. Password keyslot: check `mem` and `ops` against section 4, then derive the KEK and open `c`.
   Recovery keyslot: parse the phrase (`crypto-spec.md` §5.1), derive the key pair and open `c`.
   A wrong secret and a tampered keyslot fail with the same error, which says only that the file
   did not open with that secret.
4. Pull the stream (section 5); the first chunk authenticates the header, after which `phraseId`,
   `phraseCreatedAt` and the keyslot parameters count as verified.
5. Decode `meta` and the envelopes (section 6).
6. Exactly one Recovery Envelope MUST be present for `meta.vaultId`, and its metadata `phraseId`
   and `phraseCreatedAt` MUST equal the header's (D178).
7. Opened with the phrase: open the payload's Recovery Envelope `mk` with `K_envelope` and require
   it to equal `meta.masterKey` (`sodium_memcmp`), and its `keyslotPublicKey` to equal the one
   derived from the phrase (D43). Opened with an export password: the restore ends by recommending
   Check Recovery Phrase (D43).
8. Verify every record as on receipt (`crypto-spec.md` §9.5) under `meta.vaultId`, with the Vault
   Keys unwrapped by `meta.masterKey`.
9. Apply it as a fresh restore or a backup merge (overview §10, D13, D33, D39, D57, D89, D153).
10. Wipe the file key, the KEK, the phrase-derived keys and, unless the restore committed, the
    Master Key.

## 9. Test vectors

`tests/vectors/generate.py` writes `packages/backup/test-vectors/backup-v1.json` with PyNaCl
(`crypto_secretstream_xchacha20poly1305_*`, `crypto_box_seal`, Argon2id), independently of the
TypeScript code (`crypto-spec.md` §15). `crypto_box_seal` and `init_push` draw their own randomness,
so the vectors are whole files that `packages/backup` MUST open, and files it MUST reject, each
tagged with the restore step of section 8 that rejects it:

- valid: opened by the recovery keyslot and by the password keyslot; a payload whose length is an
  exact multiple of 65,536 (empty final chunk); a payload of more than one chunk;
- rejected: wrong magic; `formatVersion` 0 and 2; unknown header key; three keyslots; password
  keyslot first; parameters below and above the range; header byte changed; keyslot byte changed;
  truncated before `TAG_FINAL`; bytes after `TAG_FINAL`; `TAG_FINAL` on an earlier chunk;
  `recordCount` too high and too low; trailing payload byte; header `phraseId` different from the
  Recovery Envelope's; Recovery Envelope whose Master Key differs from `meta.masterKey`.

Every file carries the fixed file key in `inputs.fileKey`, so the stream cases run without a keyslot.
A rejected file is given whole, or as an `edit` of a valid one (`base`, then `flip` one byte at an
offset, `keep` a prefix, `append` hex) so the large files are not repeated. Since the sealed box and
the stream header are random, every run of the generator rewrites this file with new bytes; the
generator checks every file against its own reference reader before writing it.
`inputs.phraseEntropy` and `inputs.exportPassword` open the recovery and password keyslots of every
valid file, and `inputs.passwordKek` is the KEK PyNaCl derived at the export parameters.
`rejectPasswordKeyslot` holds password keyslots whose parameters are outside the accepted range,
refused before Argon2id runs while the recovery keyslot of the same file still opens. The restore
checks of section 8 (the phrase and Master Key checks) are added with that step.
