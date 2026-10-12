# BlindVault — Record Content v1

> Normative for the content of every record and of Local Config; `overview.md` prevails on design.
> Implements overview §6 and D165, and completes `crypto-spec.md` §9.3 and §12, which fix the
> envelope, padding, caps and encryption around this content. Record format version 1: changing
> anything here is a record format change (D32).

## 1. Conventions

- Content is a deterministic CBOR map with text keys, encoded and strictly decoded as in
  `crypto-spec.md` §14. Every map below lists its keys; "optional" means the key is absent when it
  has no value, never present with an empty value.
- **Text** is a CBOR text string. Its length is counted in Unicode code points. **Single-line**
  text holds no U+000A or U+000D. **Trimmed** text has no character with the Unicode `White_Space`
  property at either end. Text is stored as typed unless a rule here normalizes it.
- **ID** is a 16-byte byte string. **Timestamp** is a uint holding Unix time in milliseconds.
- A required key that is absent fails the validation of that key.
- **Ascending**, for an array of IDs or of pairs keyed by an ID, means strictly ascending bytewise,
  so the array holds no duplicates.
- Validation runs on every write, which is refused when it fails, and on every decode.

## 2. Unknown and invalid content (D52, D59, D98, D165)

What a decoder does with content it does not fully recognize depends on the record type:

| Record | Unknown key, type or role | Known key with an invalid value |
| --- | --- | --- |
| Item, Item Version | read-only (D52) | read-only (D52) |
| Folder, Device | kept unchanged on every write, never blocks (D59) | verification failure |
| Recovery Envelope metadata | read-only for regeneration (D98) | verification failure (`crypto-spec.md` §9.5 step 8) |
| Local Config, encrypted part | unlock refused as corrupt | unlock refused as corrupt |

An Item or Item Version holds **content from a newer app version** when any of these is true:

1. its item map has a key not listed in section 3;
2. a field has a `type` not listed in section 4;
3. a field map, or a TOTP value map, has a key not listed for it;
4. a field has a `role` that the item's `templateId` and `templateVersion` do not define;
5. `templateId` is unknown, or `templateVersion` is greater than the one the app knows;
6. a value fails the validation of its known key or type.

Rule 6 makes a malformed item read-only rather than corrected: an app version that relaxes a rule
on a known value MUST use a new key or a new field type instead, so older apps see it as unknown.

A verification failure is handled like those of `crypto-spec.md` §9.5: the record is rejected on
receipt. A held record that fails it is shown as corrupt and is not written.

## 3. Item

| Key | Type | Rule |
| --- | --- | --- |
| `templateId` | text | a factory template ID (section 5) |
| `templateVersion` | uint | ≥ 1 |
| `title` | text | single-line, trimmed, 1 to 512 code points |
| `fields` | array of field maps | in display order; may be empty |
| `tags` | array of text | rules below; may be empty |
| `notes` | text, optional | long text, at least 1 code point |
| `folderId` | ID, optional | absent = vault root (D14) |
| `trashOperationId` | ID, optional | present exactly while the Item record is trashed (D14, D143) |

- `trashOperationId` is present in an Item record if and only if its header has `deleted = true`.
  In an Item Version it marks a version of a trashed state (`crypto-spec.md` §9.4), and restoring
  such a version drops it (D143).
- **Tags.** Each tag is single-line, trimmed, NFC-normalized and 1 to 64 code points. An item holds
  at most 32. Two tags are duplicates when their `String.prototype.toLowerCase()` forms, without a
  locale, are equal; an item holds no duplicates. Tags are stored in ascending order of their UTF-8
  bytes, so reordering tags changes nothing. Display order is the UI's choice.
- **Saving without a change.** A write whose content encodes to the same bytes as the current
  content is not made: no HLC is issued and no Item Version is stored (D6, D165).
- **Duplicate (D135, D165).** The copy's title is the original's with the localized suffix
  " (copy)" ("(cópia)" in pt-BR); `trashOperationId` is never copied. If the suffix takes the
  title past 512 code points or the content past the item cap, Duplicate is refused with a message.

## 4. Fields (D100, D165)

| Key | Type | Rule |
| --- | --- | --- |
| `type` | text | a field type below |
| `value` | per type | below |
| `role` | text, optional | a field role of the item's template (section 5) |
| `label` | text, optional | single-line, trimmed, 1 to 128 code points |

- A field with a `role` has that role's field type, and an item holds each role at most once.
- A field without a `role`, one the user added, MUST have a `label`.
- A field with a `role` and no `label` is shown with the role's localized name, so a template
  field reads in the viewer's language. A `label` is always the user's own text.
- An empty value is never stored: a field the user leaves empty, or clears, is not written.

| Field type | `value` | Validation |
| --- | --- | --- |
| `text` | text | single-line |
| `long-text` | text | — |
| `secret` | text | may be multi-line (private keys) |
| `url` | text | single-line; any scheme is stored, only `http` and `https` are opened (D83) |
| `email` | text | single-line |
| `phone` | text | single-line |
| `date` | text | `YYYY-MM-DD`, a valid proleptic Gregorian date, or `YYYY-MM` (month precision); year 0001 to 9999 |
| `number` | text | a decimal numeral: `-?[0-9]+(\.[0-9]+)?`, leading zeros kept |
| `totp` | map | below |
| `seed-phrase` | text | below |

Every text value is at least 1 code point. `email` and `phone` are not checked further, since
real values vary too much to reject any.

**TOTP value (D127).**

| Key | Type | Rule |
| --- | --- | --- |
| `secret` | text | base32 alphabet `A–Z2–7`, uppercase, no padding, at least 1 character |
| `algorithm` | text | `SHA1`, `SHA256` or `SHA512` |
| `digits` | uint | 6 to 8 |
| `period` | uint | 15 to 300 (seconds) |
| `issuer` | text, optional | single-line |
| `accountName` | text, optional | single-line |

An `otpauth://` URI or a bare secret is parsed into this map at input, with the defaults SHA1, 6
digits and 30 seconds written explicitly; the URI itself is not stored. Input spaces and lowercase
in the secret are normalized away before validation.

**Seed phrase value.** Words of the BIP39 English list, lowercase, NFKD-normalized, separated by
exactly one U+0020, with 12, 15, 18, 21 or 24 words. A word outside the list is refused at input.
An invalid BIP39 checksum is **not** a validation failure: the value is stored and the UI shows
that the checksum does not match, since the user's own copy, typo included, is the best one there
is. A seed phrase is unrelated to the Recovery Phrase.

## 5. Factory templates (D20, D165)

Templates are definitions in code. A template sets the fields a new item starts with; the item can
then hold fields beyond them, each of a v1 field type (D124). Every template is at
`templateVersion` 1.

| `templateId` | Field roles (field type) |
| --- | --- |
| `login` | `username` (text), `password` (secret), `url` (url) |
| `secure-note` | none: the content is `notes` |
| `card` | `cardholder` (text), `number` (secret), `expiry` (date, month precision), `cvv` (secret), `pin` (secret) |
| `identity` | `firstName` (text), `lastName` (text), `birthDate` (date), `email` (email), `phone` (phone), `address` (long-text) |
| `developer-credential` | `provider` (text), `baseUrl` (url), `keyId` (text), `secret` (secret, multi-line) |
| `crypto-wallet` | `walletName` (text), `network` (text), `seedPhrase` (seed-phrase), `passphrase` (secret), `derivationPath` (text), `address` (text) |
| `document` | `documentType` (text), `number` (text), `fullName` (text), `issuer` (text), `issueDate` (date), `expiryDate` (date) |

A role marked "month precision" accepts only `YYYY-MM`.

**Template versioning.**

- `templateVersion` increases when a template adds or removes a role or changes a role's field
  type. Existing items are never migrated; only new items take the new version.
- A role never changes meaning within a `templateId`: a different meaning takes a new role.
- An item's template cannot be changed in v1.

## 6. Folder (D14, D59)

| Key | Type | Rule |
| --- | --- | --- |
| `name` | text | single-line, trimmed, 1 to 256 code points |
| `parentId` | ID, optional | absent = vault root |
| `trashOperationId` | ID, optional | present exactly while the Folder record is trashed |

Siblings may share a name. They sort by name in the UI's collation, then by `folderId` bytewise, so
every device shows the same order.

## 7. Device (D26, D30, D59)

| Key | Type | Rule |
| --- | --- | --- |
| `publicKey` | bytes, 32 | X25519 static public key, immutable; `recordId` = `deviceId` of it |
| `displayName` | text | single-line, trimmed, 1 to 64 code points |
| `retired` | bool | once true, never false (D31) |
| `registeredAt` | timestamp | |

The default `displayName` is built from the user agent ("Chrome on macOS") and can be edited.

## 8. Item Version and Recovery Envelope

Their content is fixed in `crypto-spec.md`: an Item Version is `{"item": <item map of section 3>,
"itemId": ID}` (§9.4), and the Recovery Envelope metadata is in §11.

## 9. Local Config (D58, D121, D164)

Local Config is one value in its own object store, a deterministic CBOR map. Its cleartext part is
exactly the keys below, which CRYPTO-INV-019 allows:

| Key | Type | Rule |
| --- | --- | --- |
| `localConfigFormatVersion` | uint | 1; an unknown value refuses unlock and tells the user to update the app (D164) |
| `vaultId` | ID | |
| `localConfigId` | ID | new with each Local Config |
| `kek` | map | `salt` (bytes 16), `opslimit` (uint), `memlimit` (uint), `mkWrap` (`{n, c}`, `crypto-spec.md` §12) |
| `prf` | map, optional | `credentialId` (bytes, at least 1), `prfInput` (bytes 32), `mkWrap` (`{n, c}`) |
| `replacesVaultId` | ID, optional | the vault this database replaces, until its database is deleted (D96) |
| `encrypted` | map | `{n, c}`: the encrypted part, sealed as in `crypto-spec.md` §12 |

Every `{n, c}` map is exactly those two keys: `n` 24 bytes, and `c` 48 bytes in an `mkWrap` (a
sealed 32-byte key) or at least 16 bytes in `encrypted`. The `kek` and `prf` maps hold exactly the
keys listed; `opslimit` and `memlimit` are checked against the accepted range at unlock
(`crypto-spec.md` §6), not here.

The **encrypted part** holds the v1 keys below. Keys a later phase uses are defined now and stay
absent until written, so no phase changes `localConfigFormatVersion`.

| Key | Type | Phase | Content |
| --- | --- | --- | --- |
| `deviceIdentity` | map | 1 | `publicKey` (bytes 32), `privateKey` (bytes 32): this device's X25519 identity (D67) |
| `preferences` | map | 1 | `autoLockMinutes` (1–60, default 5), `hiddenLockSeconds` (0–900, default 60), `clipboardClearSeconds` (10–120, default 30) (D151) |
| `hlc` | array | 1 | HLC state `[physicalMs, counter, deviceId]` (D62, D109) |
| `lastBackupAt` | timestamp, optional | 2 | last backup made on this device |
| `lastPhraseId` | ID, optional | 2 | `phraseId` of the last Recovery Envelope seen (D43) |
| `lastSyncByPeer` | array, optional | 5 | `[deviceId, timestamp]` pairs, ascending by `deviceId` (D34) |
| `seenDevices` | array of ID, optional | 4 | Device records seen, ascending (D47, D48) |
| `seenRetiredDevices` | array of ID, optional | 4 | Device records seen as retired, ascending |
| `rejectedPeers` | array of ID, optional | 5 | peers whose records were rejected for format or type, ascending (D68, D81, D115) |

`preferences` always holds its three keys, written with their defaults at creation. A preference
outside its range is refused when written and makes unlock report the Local Config as corrupt when
read (D151).

## 10. Test vectors (D170)

`tests/vectors/generate.py` also writes `packages/vault/test-vectors/content-v1.json` from a
reference validator of this document, and refuses to write a case it classifies differently.
Every case is the CBOR of one content map with its expected result:

| Section | Cases | Expected |
| --- | --- | --- |
| `items` | each template, every field type, length limits counted in code points (astral characters), and one case per violation, tagged with its section 2 rule | `valid`, or `read-only` with `rule` |
| `itemVersions` | `{item, itemId}` of a live and a trashed state, and of a newer template | `valid` or `read-only` |
| `folders`, `devices` | valid records, unknown keys to keep (`unknownKeys`), invalid known values | `valid` or `invalid` |
| `localConfig` | cleartext part, with and without PRF state and `replacesVaultId` | `valid`, `corrupt` or `unsupported-version` |
| `localConfigEncrypted` | encrypted part, with every later-phase key, preferences at their limits | `valid` or `corrupt` |

Item cases carry the header's `deleted` flag, which `trashOperationId` must match.
