# BlindVault — Backup Format v2

> Normative for the bytes of a `.bvault` file; `overview.md` prevails on design. Implements
> overview §10 and D3, D16, D43, D64, D78, D95, D178, D181, D273, D278 and D279, using the
> conventions, primitives and encodings of `crypto-spec.md` (§1, §2, §3, §6, §14). Backup format
> version 2, which adds attachment blobs (`attachments.md`); an export writes version 2, and a
> restore reads versions 1 and 2. Test vectors: `packages/backup/test-vectors/backup-v2.json` and,
> for version 1, `backup-v1.json` (section 9).

## 1. Overview

```
file    = header ‖ stream
header  = magic ‖ u16 formatVersion ‖ u32 headerLength ‖ CBOR(headerMap)
stream  = secretstream chunks of the payload, under the file key
payload = u32 len ‖ CBOR(meta) ‖ (u32 len ‖ record envelope) × recordCount ‖ (u32 len ‖ blob) × blobCount
```

Version 1 has no `blobCount` and no blobs; everything else is the same.

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
| `formatVersion` | 2 | `u16`, **2**; **1** still read |
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
`vaultId`, the export date and the record and blob counts are inside the payload.

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
- `TAG_PUSH` or `TAG_REKEY` on any chunk;
- a `TAG_FINAL` chunk of more than 65,552 bytes, so of more than 65,535 bytes of plaintext, which a
  reader that sizes the chunks from the file's length could take as one: the same payload would
  then have two encodings (D306).

## 6. Payload

The concatenated plaintext of the chunks:

```
payload = u32 len(m) ‖ m ‖ u32 len(e1) ‖ e1 ‖ … ‖ u32 len(eN) ‖ eN
m       = CBOR(meta),   1 ≤ len(m) ≤ 256
ei      = a record envelope exactly as stored (crypto-spec §9.2),   1 ≤ len(ei) ≤ 1,049,130
```

followed, in version 2, by

```
‖ u32 len(b1) ‖ b1 ‖ … ‖ u32 len(bM) ‖ bM
bj      = a blob exactly as stored (attachments.md §2),   42 ≤ len(bj) ≤ 10,488,521
```

`meta` has exactly these keys, decoded strictly:

| Key | CBOR type | Value |
| --- | --- | --- |
| `blobCount` | uint | `M`, the number of blobs after the envelopes; version 2 only |
| `exportedAt` | uint | export time, Unix ms |
| `masterKey` | bstr, 32 | the Master Key (D25) |
| `recordCount` | uint | `N`, the number of envelopes that follow |
| `vaultId` | bstr, 16 | the vault's `vaultId` (D25) |

- The envelopes are every record the device holds, of every type: Items, Item Versions, Folders,
  tombstones, Vault Keys, Device records and the Recovery Envelope. Local Config and the device
  identity are local and are not exported.
- The blobs are every blob the device holds (`attachments.md` §4), each once, in any order. Two
  blobs with the same BLAKE2b-256 are rejected.
- The payload ends exactly after `eN` (version 1) or `bM` (version 2): fewer envelopes than
  `recordCount` or blobs than `blobCount`, a length out of range, a length that runs past the
  payload, or any byte after the last one is rejected.
- The length prefixes are inside the stream and reveal nothing outside it.
- A restore reads the file in two passes (D278), never decoding the payload as one CBOR value. The
  **first** pulls the whole stream through the final chunk and parses the payload's structure as
  it goes, the lengths, the counts and the end, hashing each blob, and keeps only the list of
  `blobId`s. The **second** pulls the stream again from the start and decodes it chunk by chunk:
  `meta` and the envelopes are kept for section 8, and each blob is read when section 8 step 11
  reaches it. Neither pass holds the whole payload; the largest single item held is one blob.
- An export builds the file as the parts of a `Blob`: the header, then each encrypted chunk as it
  is pushed, the blobs read from storage one at a time. It never builds the file as one buffer.

## 7. Versions and unknown content

- A wrong `magic` is rejected as not a BlindVault backup; `formatVersion` 0 likewise.
- A `formatVersion` above 2 is rejected before anything else is read: the backup needs a newer app.
- Each version is strict: an unknown key in `headerMap`, a keyslot or `meta` is rejected, and so is
  `blobCount` in a version-1 `meta` or its absence in a version-2 one. Any extension is a new
  `formatVersion`.
- Unknown content inside records is untouched: envelopes travel as stored, so a newer app's content
  keys survive an export and a restore (D98). A record with an unknown `recordFormatVersion` or
  `recordType` rejects the whole restore (D61, D81) as needing a newer app: a `v` above 1, or `v`
  = 1 with a `t` this app does not know. Any other envelope that fails to decode is a corrupt
  record.

## 8. Export and restore

**Export**, on an unlocked device (D181):

1. Open the Master Key wrap with the Device KEK of the local password or the PRF KEK of a passkey
   assertion with user verification, both asked for again: the unlocked session holds no Master
   Key. A KEK that does not open it aborts.
2. Read every stored record again and verify it as on receipt (`crypto-spec.md` §9.5); on a
   failure, or with a record kept aside as corrupt at unlock, abort, write no file and name the
   record by its type and the first 8 hex digits of its `recordId` (D64). Warn that the backup may
   be incomplete while Local Config lists peers whose records were rejected (D115).
3. Read `keyslotPublicKey`, `phraseId` and `phraseCreatedAt` from the Recovery Envelope metadata;
   a vault without one cannot export (D179).
4. Generate the file key; build the recovery keyslot and, with an export password, the password
   keyslot at the export parameters of section 4.
5. Encode the header, then stream the payload, envelopes then blobs, as the parts of a `Blob`
   (section 6). Before it starts, it waits for the Item Version pass (D277); an attachment whose
   blob is not held does not stop the export, which warns, naming each such item, that the backup
   lacks its attachment (D279).
6. Wipe the Master Key, the file key and the KEKs. The export's date is recorded as the last backup
   in Local Config (§13.4) only once the app reports the file saved (D291).

**Restore**, in this order; any failure rejects the file and writes nothing (D61, D64). Each
rejection names its reason (in parentheses):

1. `magic`, `formatVersion`, `headerLength` within range; strict decode of `headerMap`
   (sections 2, 3, 7).
2. Show `phraseId` and `phraseCreatedAt` as unverified; the user picks a keyslot.
3. Password keyslot: check `mem` and `ops` against section 4, then derive the KEK and open `c`.
   Recovery keyslot: parse the phrase (`crypto-spec.md` §5.1), derive the key pair and open `c`.
   A wrong secret and a tampered keyslot fail with the same error, which says only that the file
   did not open with that secret (`wrong-secret`).
4. First pass (section 6): pull the stream (section 5); the first chunk authenticates the header,
   after which `phraseId`, `phraseCreatedAt` and the keyslot parameters count as verified
   (`corrupt`). The payload's structure is checked as it goes, a repeated blob included
   (`malformed`).
5. Second pass: pull the stream again and decode `meta` and the envelopes (section 6). A chunk that
   no longer authenticates, or a payload that differs from the first pass, means the file changed
   between the passes (`corrupt`).
6. Verify every record as on receipt (`crypto-spec.md` §9.5) under `meta.vaultId`, with
   `K_vaultKeyWrap` and `K_versionId` derived from `meta.masterKey`: the Vault Key records first,
   since every other record needs the Vault Key of its epoch.
   - A record with an unknown `recordFormatVersion` or `recordType` (section 7) rejects the file
     as needing a newer app, whatever else it holds (`newer-record`).
   - Otherwise the first record, in that order, that fails verification, or that repeats the
     `recordType` and `recordId` of an earlier one, is named by its type and the first 8 hex
     digits of its `recordId` (`corrupt-record`, D64); a record that does not decode (§9.5 steps 1
     to 5) has no type or ID to name. A store never holds two records with one identity, so a
     restore never picks one of two.
   The envelope's metadata is read only once its record verifies, which is why this step comes
   before the next two. Domain checks on record values (D59) run when the records are applied,
   in step 9, and reject the whole restore the same way.
7. A Recovery Envelope MUST be present, and its metadata `phraseId` and `phraseCreatedAt` MUST
   equal the header's (D178) (`envelope-mismatch`). Its `recordId` derives from `vaultId` and its
   AAD binds `meta.vaultId`, so step 6 already refuses one of another vault and a second one.
8. Opened with the phrase: open the payload's Recovery Envelope `mk` with `K_envelope` and require
   it to equal `meta.masterKey` (`sodium_memcmp`); an `mk` that does not open with the phrase
   fails the same way (`master-key-mismatch`). Then require its `keyslotPublicKey` to equal the
   one derived from the phrase (`public-key-mismatch`) (D43). Opened with an export password: the
   restore ends by recommending Check Recovery Phrase (D43).
9. Apply it as a fresh restore or a backup merge (overview §10, D13, D33, D39, D57, D89, D153); a
   backup merge follows `sync-protocol.md` §1 (D182).
10. Wipe the file key, the KEK, the phrase-derived keys, the Vault Keys and subkeys used in step 6
    and, unless the restore committed, the Master Key.
11. Version 2, once step 9 committed: read the blobs (second pass) one at a time. A blob whose
    `blobId` a committed record cites and that the device lacks is written in its own transaction;
    any other is dropped (D278, D279). A chunk that fails here, the file having changed after the
    first pass, stops the reading: the committed records stay, the blobs not yet written show as
    waiting for sync, and the result says so. The result also names each item whose attachment's
    blob was not in the file.

Steps 3 to 8 run in `packages/backup` and return the `vaultId`, the export date, the Master Key,
every envelope with its `recordType` and `recordId`, exactly as in the file, whether the phrase or
an export password opened it, and, in version 2, the `blobId`s of the file and a reader of its
blobs in order. Nothing is written before step 9, and no blob before the records commit.

## 9. Test vectors

**Frozen backups** (D310). The vectors below follow the current spec, and every run of the
generator rewrites them, so a change made at once to this document, the generator and the reader
passes them. `tests/fixtures/backups` holds instead `.bvault` files exported by published builds
of the app, each with its Recovery Phrase, its export password and a summary of the vault it holds,
never regenerated: `tests/frozen-backups.test.ts` restores each with the phrase and with the
password, through IndexedDB, and compares the vault with the summary. A release that changes this
format or the content of a record adds its own file and keeps every earlier one (`build.md`).

`tests/vectors/generate.py` writes `packages/backup/test-vectors/backup-v2.json`, and keeps
`backup-v1.json` for version 1, with PyNaCl
(`crypto_secretstream_xchacha20poly1305_*`, `crypto_box_seal`, Argon2id), independently of the
TypeScript code (`crypto-spec.md` §15). `crypto_box_seal` and `init_push` draw their own randomness,
so the vectors are whole files that `packages/backup` MUST open, and files it MUST reject, each
tagged with the restore step of section 8 that rejects it:

- valid: opened by the recovery keyslot and by the password keyslot; a payload whose length is an
  exact multiple of 65,536 (empty final chunk); a payload of more than one chunk; in version 2, no
  blob, a blob cited by an Item and one cited only by an Item Version, a blob no record cites (kept
  by the reader, dropped by step 11) and a blob of more than one chunk;
- rejected: wrong magic; `formatVersion` 0; unknown header key; three keyslots; password
  keyslot first; parameters below and above the range; header byte changed; keyslot byte changed;
  truncated before `TAG_FINAL`; bytes after `TAG_FINAL`; `TAG_FINAL` on an earlier chunk;
  `recordCount` too high and too low; trailing payload byte; in version 2, `formatVersion` 3,
  `blobCount` absent, `blobCount` too high and too low, a blob length of 41 and 10,488,522, and the
  same blob twice; in version 1, `blobCount` present;
- rejected by the restore checks of section 8, each opened with the phrase and with the export
  password: a record with `recordFormatVersion` 2 and one with an unknown `recordType` (step 6,
  `newer-record`); a record whose `ct` does not authenticate, a record of an epoch without its Vault
  Key, the same record twice, a second Recovery Envelope, a Recovery Envelope of another `vaultId`,
  and a `meta.masterKey` that opens no Vault Key (step 6, `corrupt-record`); no Recovery Envelope, a
  header `phraseId` and a header `phraseCreatedAt` different from the envelope's (step 7); an
  envelope whose `mk` holds another Master Key, one whose `mk` is sealed under another phrase, and
  one whose `keyslotPublicKey` is not the phrase's (step 8, phrase only).

Every file carries the fixed file key in `inputs.fileKey`, so the stream cases run without a keyslot.
A rejected file is given whole, or as an `edit` of a valid one (`base`, then `flip` one byte at an
offset, `keep` a prefix, `append` hex) so the large files are not repeated. Since the sealed box and
the stream header are random, every run of the generator rewrites this file with new bytes; the
generator checks every file against its own reference reader before writing it.
`inputs.phraseEntropy` and `inputs.exportPassword` open the recovery and password keyslots of every
valid file, and `inputs.passwordKek` is the KEK PyNaCl derived at the export parameters.
`rejectPasswordKeyslot` holds password keyslots whose parameters are outside the accepted range,
refused before Argon2id runs while the recovery keyslot of the same file still opens.
Every record of a valid file is a real record of the vectors' vault, which steps 6 to 8 accept:
the Vault Key record, the Recovery Envelope, and Items (the large ones make the payloads of more
than one chunk). `rejectRestore` holds the files of the last item above, each with its step and
reason, `phraseOnly` when only a restore opened with the phrase rejects it, and for
`corrupt-record` the `record` it names (`recordType` and the first 4 bytes of `recordId`), or `null`
for a record that does not decode.
