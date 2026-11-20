# BlindVault — Attachments

> Normative for attachments; `overview.md` prevails on design. Implements D273, D277, D278 and
> D279. The bytes on the wire and in a file are in the documents each section names:
> `record-content.md` §4 (the field), `sync-protocol.md` §10.1 (the blob phase),
> `pairing-protocol.md` §8 and §9 (the blob phase of an admission) and `backup-format.md` (format
> version 2).

## 1. Model

An **attachment** is a file kept with an item. Its content is a **blob**: the file encrypted under
a random key of its own, immutable, stored apart from the records. The item holds an `attachment`
field with the file's name, size and media type, the blob's hash and its key, so the item, its
history, its conflicts and last-write-wins stay as they are for every other field (D273).

- Replacing a file adds a new attachment with a new blob; a blob never changes.
- Every device holds every blob a record it holds cites. There is no fetch on demand: the peer that
  holds a blob may be offline when the file is opened.
- A blob never travels or is stored without its encryption, and its key travels only inside its
  item's encrypted content.

## 2. Blob

**Encryption.** A new random 32-byte key per attachment. The file's bytes are encrypted with
`crypto_secretstream_xchacha20poly1305`, cut as the backup stream (`backup-format.md` §5):

- `init_push(key)` gives a 24-byte stream header;
- the plaintext is cut into chunks of exactly **65,536 bytes**, each pushed with `TAG_MESSAGE`, and
  one last chunk of `size mod 65,536` bytes, possibly empty, pushed with `TAG_FINAL`;
- every chunk has empty additional data: the key is random, used for one file only and held only
  inside its item, which binds the blob to its identity (D278).

```
blob   = streamHeader ‖ chunk1 ‖ … ‖ chunkN
blobId = BLAKE2b-256(blob)                    crypto_generichash, 32 bytes, no key
```

The blob is stored and sent exactly as written. Its `blobId` is the hash of those bytes, so a
receiver checks a blob without its key.

**Sizes.** The plaintext is 1 to **10,485,760 bytes** (10 MiB). A blob is
`24 + size + 17 × (⌊size / 65,536⌋ + 1)` bytes: **42** for a 1-byte file, **10,488,521** for a
10 MiB one (160 full chunks and an empty final chunk). A blob outside 42 to 10,488,521 bytes is
refused before it is hashed.

**Decryption**, for a download only: `init_pull` with the field's `key`, then each chunk read as
`backup-format.md` §5 reads the stream (every chunk but the last pulled with `TAG_MESSAGE`, the
last with `TAG_FINAL`, nothing after it, no `TAG_PUSH` or `TAG_REKEY`). The download is refused as
corrupt when a chunk fails to authenticate, the layout breaks those rules, or the plaintext length
differs from the field's `size`. Since the `blobId` binds the ciphertext and the field is inside
the authenticated item, only a holder of the Master Key can make such a blob.

`packages/crypto` holds the blob stream (`sealBlob`, `openBlob`) and the hash; the key and the
plaintext are wiped once the blob is sealed or the download made.

## 3. Field

The `attachment` value is a map of `name`, `size`, `mediaType`, `blobId` and `key`, fixed in
`record-content.md` §4. The field takes no role and its `label` is optional (D278). An app
without the `attachment` type reads the item as read-only (`record-content.md` §2 rule 2), so the
record format stays at version 1.

**Input.** When the user picks a file:

- `name` is `File.name` with each U+000A and U+000D replaced by U+0020. A name longer than 255 code
  points is cut to 255, keeping the extension after its last `.` when that extension is 1 to 16
  code points. An empty name becomes `attachment`.
- `size` is `File.size`.
- `mediaType` is `File.type`, or `application/octet-stream` when it is empty or not 1 to 255
  characters of U+0021 to U+007E.

`mediaType` is shown as text only: it never chooses how the file opens (section 7).

## 4. Storage

**Object store.** `blobs`, keyed by `blobId` (bstr 32), each value the blob as written. A database
version upgrade adds it, with no data migration. `packages/storage` accepts a blob only with a
`blobId` of 32 bytes and a length within section 2; it never decrypts one.

**Writes.**

- A new attachment's blob and its item are written in one storage transaction, when the item is
  saved (D278).
- A blob received in a sync, an admission or a restore is written in its own transaction, only once
  complete and matching its `blobId`.
- A blob already held is not written again.

**Missing blob.** An attachment whose blob is not held shows as waiting for sync and cannot be
downloaded. It is asked for at every sync until it arrives (`sync-protocol.md` §10.1).

## 5. Lifetime and collection

A blob is **cited** while any held record holds an `attachment` field whose `blobId` is its own:

- an Item, live or trashed;
- an Item Version (D277 keeps each version's cited `blobId`s in its summary);
- a tombstone that still holds content.

A purged tombstone cites nothing. Citations are read from every field of type `attachment` whose
value is a map with a 32-byte `blobId`, whether or not the rest of the item validates, so an item
read-only for newer content keeps its blobs.

**Collection** deletes every held blob that no record cites. It runs:

- after every commit that can drop a last citation: the purge (D7), the history cut (D6), a sync or
  admission merge, a backup merge, an edit that removes an attachment field;
- at unlock, after the Item Versions are verified (D277).

It waits for the Item Version pass of D277, since a version not yet verified cites nothing known,
and it does not run while any Item or Item Version is kept aside as corrupt, whose citations are
unknown.

## 6. Exchange and backup

**Sync** (`sync-protocol.md` §10.1). After both `committed`, and after each live transfer it merges,
a device asks the peer for the blobs its records cite and it lacks; the peer answers each with the
blob or with `blob-missing`. A blob that does not match its `blobId` is rejected and reported like a
rejected record, and the session goes on (D278).

**Pairing and re-admission** (`pairing-protocol.md` §8 and §9, D279). The same phase runs after
`committed`, before the session ends: in a pairing B asks and A answers; in a re-admission both
ask. A paired device therefore holds every attachment A holds when the pairing ends, as a restored
one does. A session cut during the phase keeps every committed record and every blob already
written; the rest is asked for at the next sync.

**Backup** (`backup-format.md`, format version 2). A `.bvault` carries every held blob after the
envelopes. An export with an attachment whose blob is not held still makes the file, and warns,
naming each such item, that the backup lacks its attachment (D279). A restore authenticates the
whole file first, commits the records, then writes each cited blob in its own transaction; an
attachment whose blob is not in the file shows as waiting for sync (D279). A version-1 file still
restores.

## 7. UI

- **Adding.** Every template's editor can add an attachment. An empty file or one above 10 MiB is
  refused before it is read; so is one that `navigator.storage.estimate()` says will not fit (usage plus the blob's
  size above the quota), with the storage-nearly-full text of D196. The file is read, encrypted and
  written when the item is saved, not when it is picked. Adding is blocked while the vault is
  read-only (D73).
- **Editing.** `name` is fixed; `label` is editable. Removing an attachment removes its field;
  collection then deletes the blob once no version cites it.
- **Viewing.** The label, or the name without one, the size and the media type, as text. No
  preview: a PDF, SVG or HTML opened in the app's origin could run as the vault (D273).
- **Downloading** works in a read-only vault and in an item read-only for newer content, for a
  field that validates. The blob is decrypted as section 2 says, wrapped in a `Blob` of type
  `application/octet-stream` whatever `mediaType` says, and saved through an `<a download>` with a
  sanitized name and an object URL revoked right after the click. The sanitized name replaces each
  character U+0000 to U+001F, U+007F, `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>` and `|` with `_`; a
  name that is then empty or only dots becomes `attachment`.
- **Waiting for sync.** An attachment whose blob is not held says so, with no download.

## 8. Import

D124 stands: the import sources' exports carry no files, so a source attachment is dropped and
named in the item's notes.

## 9. Security

- The blob key is random, used once, and travels only inside the encrypted item; the blob carries
  no additional data and no identity of its own (D278).
- A received blob is accepted only when its BLAKE2b-256 equals a `blobId` this device asked for
  (threat A3). The hash is computed on the bytes received, before anything is written
  (CRYPTO-INV-025).
- A blob never reaches the DOM decrypted except as the download's `Blob`; no preview, no
  `mediaType` used to render it (CRYPTO-INV-025).
- Blobs are never loaded at unlock (D277).
- A blob's length reveals its file's size, to 17 bytes per 65,536, to anyone who reads storage;
  inside a `.bvault` and on the wire it is under the stream and the Noise channel, and only the
  total length shows (`threat-model.md`).

## 10. Tests

- **Crypto.** Round trip at 1 byte, 65,535, 65,536, 65,537 and 10 MiB; blobs of 1, 65,536 and
  65,537 bytes with their `blobId`, and edits of them to refuse, in
  `packages/crypto/test-vectors/blob-v1.json` from `tests/vectors/generate.py` (PyNaCl), which
  checks them against its own reader; a tampered chunk, a truncated blob, a missing `TAG_FINAL`,
  a `TAG_FINAL` early, bytes after it and a wrong key refused; a plaintext length differing from
  `size` refused.
- **Content.** The `attachment` cases of `record-content.md` §10.
- **Collection.** A blob cited only by an Item Version, by a trashed item, by a tombstone with
  content: kept; dropped after the purge, the history cut and the removal of its field; kept
  while a record is corrupt; not run before the D277 pass.
- **Sync and admission.** Two devices end a sync holding the same blobs; a blob that does not match
  its `blobId` refused and reported while the session goes on; an unasked blob, a blob out of
  range and chunks past its size abort; a cut session leaves no partial blob; a pairing ends with
  B holding every blob A holds; a re-admission in both directions.
- **Backup.** Export and restore with blobs; a blob no record cites dropped; a duplicate blob and a
  `blobCount` that does not match refused; a version-1 file still restores; an export with a
  missing blob warns.
