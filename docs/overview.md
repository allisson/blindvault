# BlindVault — Overview

> Normative design document for implementation. It prevails over every other document in this repository.
> Consolidates the original *BlindVault — Technical Design Specification* (2026-10-04, available in git history at commit `6b1ae3a`) and decisions D1–D46 (section 21).
> Status: Proposed · Author: Allisson Azevedo · License: MIT.
> The words MUST, MUST NOT, SHOULD and MAY follow RFC 2119. Terms follow `GLOSSARY.md`.

---

## 1. Vision

BlindVault is a **local-first** encrypted personal vault for any kind of private information. It runs entirely in the browser, can be installed as a PWA, and **has no server that stores user data**. It is intentionally not a cloud password manager: there is no account system and no server-side vault.

> The user's vault belongs to the user, not to a service.

Data exists only on the user's devices or in encrypted backup files the user controls. Synchronization is peer-to-peer between registered devices, each admitted through SAS-confirmed pairing.

BlindVault is derived from BlindPass: it reuses the cryptographic model and domain packages, and removes the server, database, sessions, API and administration layers (section 15).

**v1 success criterion:** a user can create a vault, protect it cryptographically, recover it after losing local storage, pair another device without trusting a server, synchronize safely, and understand exactly what happens if every device except the backup is lost. The criterion is not feature count.

**Highest-priority engineering risks**, in order: pairing protocol correctness, application/PWA integrity, browser storage behavior, recovery UX, and synchronization edge cases. None of them requires abandoning the architecture, but cryptography, pairing, synchronization and recovery MUST be implemented as explicit protocols rather than informal application logic. The project SHOULD resist adding features before these foundations are thoroughly tested.

---

## 2. Principles

1. **No data server.** BlindVault MUST NOT require a server to store vault data, which minimizes the attack surface. Network services are used only for static assets and STUN. None of them receive plaintext vault contents, and STUN providers MUST NOT be treated as trusted data services.
2. **Encryption first.** All sensitive content is encrypted before persistence or synchronization. Keys exist in plaintext only in memory, while the vault is unlocked; the only keys at rest are explicitly encrypted local key-wrapping material.
3. **Local-first.** A browser/PWA application keeps the vault local and portable. Once installed, the app works offline. There is no account, backend, authentication server, cloud database or sync service.
4. **Synchronization is replication**, not a hosted backup service. Every registered device holds a complete encrypted copy of the vault. A `.bvault` file is an additional recovery mechanism.
5. **Small attack surface.** Few dependencies, small security-sensitive modules, clear cryptographic boundaries, deterministic builds, extensive tests, and no unnecessary network functionality.
6. **Generic model.** BlindVault is a vault, not only a password manager. Items are made of typed fields. Templates are a UI convenience and MUST NOT alter the cryptographic model.

---

## 3. Threat model

**Protected assets:** vault contents, secrets, passwords, credentials, recovery material, cryptographic keys, encrypted backups and synchronized records.

**Threats considered:** loss or theft of a device, access to a locked device, network interception, malicious peers, MITM during pairing, compromised STUN, corrupted sync data, browser storage eviction, accidental deletion, stale devices reconnecting, and malicious application hosting.

**Out of scope (MUST be documented to users):** a compromised operating system, malware that reads browser memory, malicious extensions, an attacker holding an unlocked device, keyloggers, a malicious browser, and a malicious JavaScript bundle executed before integrity verification, including the first load (TOFU, see D5).

Cryptographic confidentiality and application integrity are separate properties. A malicious bundle can read vault contents after unlock, even with perfect cryptography; a compromised browser, OS, extension or JavaScript bundle can therefore compromise an unlocked vault and is outside the cryptographic threat model.

**Accepted metadata leakage.** The cleartext record header (section 6) is visible to anyone who can read IndexedDB on a locked device: record types and counts, `keyEpoch`, deletion state, and the HLC of every change (which reveals editing times and the `deviceId` that made them). The header is readable but authenticated (D21), so it cannot be altered without detection. During sync the same header is visible to the peer, never to the network. A `.bvault` file hides all of it (section 10), except the `phraseId` in its header, which links backups of the same vault to each other.

**Device admission.** BlindVault creates a Device record only for the vault creator at vault creation or re-founding (D40), and otherwise only after SAS confirmation in pairing or re-admission (D30); the only later changes to a Device record are its display name and its `retired` flag (D26, D31). Anyone holding the Vault Key can still forge a Device record and introduce it by sync or backup merge. This is accepted: holding the Vault Key already grants full access to the vault.

| Threat | Status | Mitigation |
| --- | --- | --- |
| Server database compromise | Eliminated | No data server |
| Network interception | Protected | Noise over DTLS + encrypted records |
| MITM during pairing | Protected | SAS derived from the handshake + user confirmation |
| Malicious STUN provider | Limited | No vault data; optional LAN-only mode |
| Browser storage eviction | Partially protected | Persistent storage + backup + replication |
| Weak password | Partially protected | Argon2id + password-strength checks |
| Lost device | Partially protected | Local password + auto-lock; a weak local password or a device lost unlocked is a Master Key compromise (section 14) |
| Stolen unlocked device | Out of scope | OS/device security required |
| Malicious extension | Out of scope | Browser security required |
| Malware | Out of scope | Trusted runtime required |
| Malicious PWA host | Partially protected | Reproducible builds + hashes + self-hosting |
| Browser compromise | Out of scope | Trusted browser required |
| Stale device resurrecting data | Protected | Persistent tombstones |
| Retired device reconnecting | Limited | Sync refused by every peer that has received the retirement; retirement cannot be undone; data already replicated stays exposed; a backup it made can still be merged by the user (D31, D41) |
| Sync conflict | Protected (items); limited (folders) | HLC + item history; folders are LWW without history |
| Tampered record header or forged tombstone | Protected | Header bound through AAD (D21) |
| Forged Recovery Envelope from a Master Key holder | Limited | An envelope with the held `phraseId` is immutable; a replacement needs a new `phraseId`, which every device announces (D43, D44) |
| Corrupted record | Protected | AEAD authentication |

---

## 4. Architecture

```
              ┌──────────────────────┐
              │   Static host        │  GitHub Pages or self-hosted
              └──────────┬───────────┘
                         │ application code (verifiable version + hash)
                         ▼
┌──────────────────────────────────────────────────────────┐
│                     BlindVault PWA                        │
│  React / TypeScript                                       │
│  ┌────────┐ ┌────────┐ ┌─────────┐ ┌────────┐ ┌────────┐ │
│  │ crypto │ │ vault  │ │ storage │ │ backup │ │  sync  │ │
│  └────────┘ └────────┘ └────┬────┘ └────────┘ └───┬────┘ │
│                             ▼                     │      │
│                  IndexedDB (encrypted records)    │      │
└───────────────────────────────────────────────────┼──────┘
                                                    │ Noise over DataChannel
                                              WebRTC + STUN (optional: LAN-only)
                         or
                ┌────────────────────┐
                │ .bvault (file)     │
                └────────────────────┘
```

### Packages

| Package | Responsibilities | Constraints |
| --- | --- | --- |
| `packages/crypto` | Key generation, Argon2id, AEAD, X25519, recovery material, recovery KEK, WebAuthn wrapping, RNG, cryptographic serialization (AAD and transcripts) | No UI logic. No dependency on other packages |
| `packages/vault` | Domain model: items, fields, templates, folders, tags, versions, tombstones, key references | No IndexedDB or network access |
| `packages/storage` | IndexedDB schema, encrypted record persistence, transactions, migrations, `navigator.storage` (persistence requests and estimation) | Accepts only already-encrypted records |
| `packages/backup` | `.bvault` format, keyslots, backup encryption, export, import, validation, format migration | — |
| `packages/sync` | Pairing, device authentication, Noise handshake, WebRTC, QR encoding, sync protocol, HLC, merge and conflict resolution, tombstones | Transport abstracted so tests run without WebRTC |
| `apps/web` | PWA, UI, service worker, onboarding | Does not implement cryptography directly |

---

## 5. Cryptography

### 5.1 Primitives

Primary implementation: **libsodium** (`libsodium-wrappers-sumo`). Primitives: Argon2id, XChaCha20-Poly1305 (AEAD), X25519, `secretstream`, `crypto_kdf`, BLAKE2b and a secure RNG.

Custom cryptographic primitives MUST NOT be implemented. Protocols (Noise) MUST come from an existing, validated implementation (D1).

### 5.2 Key hierarchy

```
Local password ──Argon2id──► Device KEK ─┐
WebAuthn PRF (optional) ──► PRF KEK ─────┼──► unwraps ──► Master Key
Recovery Phrase ─crypto_kdf─► Recovery KEK ─┘                 │
        │  (envelope subkey)                                  ├──► Vault Key (per keyEpoch)
        │                                                     │        │
        └─crypto_kdf─► Recovery keyslot keypair (D16)         │        ▼
             public key synchronized, private key             │    Record key (per record)
             derived only from the phrase                     │        │ AEAD
                                                              │        ▼
                                                              │    Encrypted record content
                                                              │
Device Identity (X25519, local, encrypted at rest under a Master Key subkey)
```

The Master Key is never used directly as an encryption key: every use derives its own `crypto_kdf` subkey with a distinct subkey ID (D23).

### 5.3 Keys

**Master Key.** Root of the vault, identical on all devices, which is what makes device replication possible. Generated by a CSPRNG. MUST NOT be persisted directly, synchronized in plaintext, or stored directly in IndexedDB. Exists in plaintext only in memory while unlocked. Not rotated in v1 (D11). Used only through `crypto_kdf` subkeys, one per purpose: Vault Key wrapping, device identity wrapping, `versionId` derivation, and re-admission key confirmation (D23, D29).

**Device KEK.** `KEK = Argon2id(password, local salt, local parameters)`. The salt, parameters, wrapped Master Key, PRF KEK material and security preferences are local and MUST NOT be synchronized. Each device may have a different password, so each device's security is independent. Changing the password on one device MUST NOT require synchronization and only re-wraps the Master Key. Parameters are **calibrated on the device** at vault creation, targeting about 1 s, with a **64 MiB memory floor** (D9). The application SHOULD reject weak passwords with zxcvbn (or equivalent); strength checks MUST NOT be treated as cryptographic protection.

**Vault Key.** Random (not derived from user credentials), protected by the Master Key, always tagged with a `keyEpoch` so the key can be rotated later without redesigning the record format.

**Record key (D18).** Random and independent per content record (Item, Item Version, Folder, Device, and the Recovery Envelope's metadata, D24), wrapped by the Vault Key of the record's `keyEpoch` with the record's AAD, and stored in the record. Because the AAD includes `hlc` and `deleted` (D21), the record key is re-wrapped on every write. Record keys give record isolation, independent encryption contexts, simpler future rotation, and safer handling of deleted or migrated records. Two keys are not protected by a record key: the Vault Key, wrapped by the Master Key's Vault Key wrapping subkey, and the Master Key inside the Recovery Envelope, wrapped by the Recovery KEK envelope subkey (D24).

### 5.4 Recovery Phrase (D2)

- 256 bits from a CSPRNG, displayed as a 24-word BIP39 phrase. In the UI it is called "Recovery Phrase", never "seed": it represents vault recovery entropy, not a cryptocurrency wallet.
- `Recovery KEK = crypto_kdf_derive_from_key(entropy, fixed context)`. No Argon2, since entropy is already high. The Recovery KEK is never used directly: each use derives its own `crypto_kdf` subkey with a distinct subkey ID (key separation).
- The **envelope subkey** wraps the Master Key. This Recovery Envelope is a **synchronized record** with a fixed `recordId` per vault, merged by LWW, so every device and future backup holds the current envelope.
- **Recovery keyslot keypair (D16).** A second subkey seeds an X25519 keypair (`crypto_box_seed_keypair`). The Recovery Envelope also carries the **public key** in its metadata, which is encrypted with a record key wrapped by the Vault Key, not with a phrase-derived key (D24). Any unlocked device can therefore read it and create a backup's recovery-phrase keyslot (`crypto_box_seal` of the file key) without holding the phrase or any recovery secret. The private key exists only while the phrase is being used.
- Each phrase has a random `phraseId` and a creation date, stored in the Recovery Envelope and in every backup header, and shown to the user when the phrase is generated, when a backup is listed, and when a backup is restored ("opens with the Recovery Phrase from 2026-10-06").
- Combined with a `.bvault` backup, the phrase MUST be sufficient to recover the vault. It MAY be used to set a new local password on a device.
- Shown only once, at creation or regeneration, with confirmation that it was written down. The entropy is never stored, so the phrase cannot be shown again. MUST NOT be persisted or logged in plaintext.
- **Check Recovery Phrase:** while unlocked, the user can type the phrase and the app confirms whether it opens the current Recovery Envelope and whether the envelope's recovery keyslot public key is the one derived from the phrase. A mismatched public key means backups cannot be opened with that phrase, and the UI MUST say so.
- **Regeneration:** with the vault unlocked, a new phrase and a new envelope replace the current envelope; this MUST NOT require changing vault contents. The new envelope reaches other devices only when they sync, and the UI MUST show that the new phrase is not yet on other devices. If two devices regenerate concurrently, LWW keeps one envelope; a device that receives an envelope newer than the one it created MUST warn the user that the phrase they wrote down was superseded. Every other device that receives an envelope whose `phraseId` differs from the last one it has seen MUST show a one-time notice that the Recovery Phrase was regenerated, with its creation date, that new backups open only with the new phrase, and an offer to Check Recovery Phrase (D43); this also exposes a regeneration made by a device that should not have made it, such as a retired one. An envelope cannot be replaced without a new `phraseId` (D44, section 9.2), so no replacement escapes this notice. After regeneration the UI MUST prompt for a new backup at once, since existing backups open only with the old phrase. **Documented limitations:** older `.bvault` backups can still be opened with the old phrase, and a device that has not yet synced keeps producing backups for the old phrase; the `phraseId` shown with every backup makes this visible.
- **Regeneration is for a lost phrase, not an exposed one.** Anyone holding an old phrase can open any older backup or the Recovery Envelope from any device's storage, and so obtain the Master Key, which regeneration does not rotate (D11). An exposed phrase is a Master Key compromise (section 14), and the regeneration UI MUST say so.

### 5.5 WebAuthn PRF

Optional, for convenient local unlock, and detected at runtime. Derives a PRF KEK that wraps the Master Key. It does not replace the hierarchy. Password unlock always remains available. Without support, the app falls back to the password gracefully.

### 5.6 AAD and nonces

Every encrypted record MUST bind its ciphertext to its logical identity through AAD, so ciphertext from one record cannot be substituted for another's:

```
AAD = recordFormatVersion || recordType || vaultId || recordId || keyEpoch || hlc || deleted
```

The fields come from the record header (section 6), except `vaultId`, which comes from Local Config. The same AAD binds the wrapped record key, the Vault Key record and the Recovery Envelope (D8, D18). Binding `hlc` and `deleted` (D21) means the whole cleartext header is authenticated: a header cannot be edited to win LWW, to delete a record, or to replay older ciphertext as a newer write. Local wraps, which are not records (the Master Key under the Device KEK or the PRF KEK, and the device identity under its Master Key subkey), use `AAD = versioned purpose label || vaultId`, so a wrap cannot be moved to another purpose or another vault. Nonces follow libsodium requirements: random 24-byte nonces for XChaCha20-Poly1305 and `secretstream` for large data. Nonce reuse under the same key MUST NOT occur.

### 5.7 Serialization and versioning (D10)

- **AAD, transcripts and prologues:** fixed binary layout, every field length-prefixed in a fixed order. No dependencies, with test vectors.
- **Records and protocol messages:** deterministic CBOR (RFC 8949, §4.2). The decoder is strict and rejects non-canonical encodings.
- No binary or textual representation may have multiple equivalent encodings that could produce different cryptographic transcripts.
- The encrypted record format, `.bvault`, the pairing protocol, the sync protocol and cryptographic envelopes MUST be versioned.
- **Record format version (D32).** Each record carries its own `recordFormatVersion` in the cleartext header, bound through the AAD. It is independent of the pairing and sync protocol versions: a protocol version change MUST NOT change the AAD of stored records. Records of an older supported format stay readable and are migrated by re-encryption (D38): migration rewrites only `recordFormatVersion` in the header, keeps `hlc` and every other header field, re-wraps the record key under the new AAD, and creates no Item Version. When two devices hold the same `recordId` and `hlc`, the higher `recordFormatVersion` wins in sync. The Recovery Envelope's Master Key wrap is bound to `recordFormatVersion` and can be rewritten only with the Recovery Phrase, so the envelope migrates only at regeneration or Check Recovery Phrase, and a record format stays supported as long as any Recovery Envelope may still use it. A record with an unknown `recordFormatVersion` is rejected; a device that does not support a newer format keeps its own copy until it is upgraded. An incompatible format MUST NOT be silently interpreted as compatible. Downgrade attacks MUST be considered during version negotiation.

---

## 6. Data model

Only the minimum metadata needed for synchronization is in cleartext.

**Record header (D18, D21, D32).** Every synchronized record has the same cleartext header: `recordFormatVersion`, `recordType`, `recordId`, `hlc`, `deleted`, `keyEpoch`. The header is the source of the AAD (section 5.6) and of the sync summaries (section 9.2), and every header field is authenticated through the AAD. `vaultId` is not in the header but is bound through the AAD.

| Record | Header specifics | Encrypted content |
| --- | --- | --- |
| Item | `recordId` = item ID | Record key (wrapped); `templateId`, `templateVersion`, title, fields, `folderId` (optional), tags, notes |
| Folder (D14) | `recordId` = folder ID | Record key (wrapped); name, `parentId` (optional), `trashOperationId` (when trashed) |
| Item Version (D6) | `recordId` = `versionId` (deterministic, opaque); `hlc` = the snapshot's `hlc` | Record key (wrapped); `itemId`, full item snapshot |
| Vault Key | `recordId` fixed per `keyEpoch` | Vault Key wrapped by the Master Key's wrapping subkey (D23) |
| Recovery Envelope (D2, D16, D24) | `recordId` fixed per vault; `keyEpoch` = epoch of the Vault Key that wraps its record key | Master Key wrapped by the envelope subkey; record key (wrapped) protecting the metadata: recovery keyslot public key, `phraseId`, phrase creation date |
| Device (D26, D30) | `recordId` = `deviceId` | Record key (wrapped); public identity key (immutable), display name, `retired` flag, `pairedAt` |
| Local Config (not synchronized) | — | `vaultId` (D25), local KEK material, PRF KEK state, encrypted device identity, security preferences (auto-lock and similar), date of the last completed sync with each peer (D34), date of the last backup made on this device, `phraseId` of the last Recovery Envelope seen (D43) |

An Item also carries `trashOperationId` in its encrypted content while trashed. Templates are not records in v1 (D20): factory templates are versioned definitions in code, and an item references one by `templateId` and `templateVersion`. The `Template` record type is reserved for user-created templates after v1.

Folders and tags MUST remain encrypted, including the folder tree structure (`parentId`), so synchronization metadata does not expose how the user organizes the vault.

**Folders (D14).** Folders nest with unlimited depth.

- An item belongs to **exactly one** folder or to the vault root (no `folderId`). It never appears in more than one place. Tags remain flat and are the way to classify items across folders.
- Moving a folder edits its `parentId`; moving an item edits its `folderId` and creates an item version like any other edit.
- Siblings are sorted alphabetically. There is no manual ordering in v1.
- Deleting a folder sends it, its subfolders and their items to the trash, each with its own tombstone, and records the same random `trashOperationId` in every record trashed by that action. Restoring the folder restores exactly the records carrying that `trashOperationId`; an item trashed earlier by a separate action stays in the trash.
- Folders have no version history. Concurrent edits to the same folder (for example, rename on one device and move on another) are resolved by LWW and one of them is lost; this limitation is documented.
- The tree is **derived at read time** with deterministic rules, so every device shows the same tree without writing anything (see section 9.3).

**Single vault (D13).** Each installation holds exactly one vault, and multiple vaults are not planned. Folders and tags are the way to organize items. `vaultId` is still kept in AAD, because it prevents mixing records from different vaults during restore, merge or pairing.

**Field types (v1):** text, long text, secret, URL, email, phone, date, number, TOTP, seed phrase (a wallet's BIP39 phrase, unrelated to the Recovery Phrase), wallet fields. Attachments come after v1.

**Factory templates:** Login, Secure Note, Card, Identity, Developer Credential, Crypto Wallet, Document. Templates are data definitions, not separate security models.

---

## 7. Local storage and locking

- IndexedDB stores only already-encrypted records. `localStorage` stores only non-sensitive UI preferences (theme, language, layout). Security preferences such as auto-lock live in Local Config.
- Call `navigator.storage.persist()` when a vault is created, paired or restored on the device, show the persistence status, and monitor `navigator.storage.estimate()`.
- Browser storage eviction is a data-availability risk. The application MUST NOT imply that browser storage is permanent.
- If persistence is denied and there is only one device, show a persistent warning recommending a backup and pairing.
- **On lock:** remove plaintext items from state, release keys, clear caches, and block cryptographic operations. Auto-lock is configurable with a conservative default. Memory zeroization in JS is not guaranteed, and this MUST be documented.

---

## 8. Identity and pairing

Pairing is one of the most security-sensitive protocols in BlindVault. It MUST be implemented as a formally specified protocol (`pairing-protocol.md`), not an informal WebRTC exchange.

### 8.1 Identity

Each device has an X25519 key pair, which is the device's **Noise static key**. The private key is local, encrypted at rest under a Master Key subkey (D23), and MUST NOT be synchronized. The public key is synchronized in the Device record. Device identity MUST be authenticated during synchronization.

`deviceId = BLAKE2b-128(static public key)` (D19). It is derived, so a device cannot claim another device's ID with a different key.

### 8.2 Handshake (D1)

- Suite: `Noise_*_25519_ChaChaPoly_BLAKE2b`, an existing implementation on top of libsodium, validated against the official test vectors.
- **Pairing:** `Noise_XX`. **Synchronization:** `Noise_KK`, since both sides already know each other's static key.
- Prologue = versioned protocol label ‖ hash of the initiator's pairing payload ‖ hash of the responder's pairing payload ‖ DTLS fingerprints of both sides, in fixed role order (initiator first). Both pairing payloads are bound, not only the first. The transcript MUST include all security-relevant negotiation values, with a canonical, versioned encoding.
- The SAS is derived from the final handshake hash. It MUST bind both peers and the session, MUST prevent replay across sessions, and MUST be displayed on both devices and explicitly confirmed by the user. SAS length and brute-force analysis, including commitment in copy/paste mode, are defined in `pairing-protocol.md`.
- WebRTC DTLS is transport only and MUST NOT be the trust mechanism. A device MUST NOT be trusted merely because a WebRTC connection succeeded.

### 8.3 Pairing payload and QR (D4)

- Binary pairing payload with version, session ID, DTLS fingerprint (32 bytes), ICE ufrag, ICE pwd, candidates (host and srflx) and capabilities. Noise keys are not in the payload: ephemeral and static keys travel only in the `Noise_XX` handshake messages. Copy/paste mode adds a commitment, defined in `pairing-protocol.md`. Encoded in base45 (QR alphanumeric mode). The original spec estimated about 200–300 bytes; this is not yet measured.
- The receiver rebuilds the SDP from the payload. ICE gathering completes before the QR is generated, with no trickle.
- Bidirectional exchange: A shows its QR and B scans it, then B shows its response and A scans it. Copy/paste is the fallback for desktops without a camera.
- Animated QR MUST NOT be implemented without real-world evidence that a static QR is insufficient.
- The pairing payload MUST NOT contain vault data.

### 8.4 Flow

```
B generates its identity, creates the local password and derives the Device KEK (all in memory only)
→ A's QR → B's QR → WebRTC/DTLS → Noise_XX handshake → SAS on both devices
→ human confirmation → Master Key and vaultId transferred over the Noise channel
→ B acknowledges receipt and sends its display name
→ A writes B's Device record (static key seen in the handshake, B's display name)
→ first full sync over the same channel (sync protocol, no new exchange); B keeps the received records in memory
→ B wraps the Master Key and its identity, and persists the records and Local Config in one storage transaction (D33)
→ B sends a commit acknowledgement; A records the completed sync with B (D34)
→ B is a registered device → optional WebAuthn setup
```

`Noise_XX` transmits both static keys during the handshake, so B's identity MUST exist before it. B holds the identity, the Device KEK and the Master Key only in memory until the commit, and discards them if pairing aborts.

A writes B's Device record only after B acknowledges receiving the Master Key, bound to the static key A authenticated in the handshake, so B cannot choose its key at registration; the key is immutable afterwards (D26). Every device MUST reject a Device record whose `recordId` is not `BLAKE2b-128` of its public key, or whose public key differs from the one already stored for that `recordId`. Only the display name and the `retired` flag can change, and `retired` only from false to true (D30, D31). Device records cannot be deleted in v1, so a pairing interrupted after the record was written leaves it in place.

**Last sync per peer (D34).** No synchronized record says whether a device has ever synced. Each device keeps, in Local Config, the date of its last completed sync with each peer, and the UI shows it next to the Device record's `pairedAt` ("last synced with this device: never" or a date). In pairing, A records the sync only when it receives B's commit acknowledgement.

**Who creates Device records (D30, D35, D40).** The vault creator creates its own Device record at vault creation; a re-founding device is the creator of the new vault and does the same (D40). Every other Device record is created after SAS confirmation, in pairing or re-admission, by a device that holds the vault: in pairing, A writes B's record and, if A is an unregistered device (section 10), its own as well, since both static keys were authenticated in the confirmed handshake. In re-admission, the registered side writes the unregistered side's record; if both are unregistered, the initiator writes both. No device creates a Device record in any other situation; the only later changes to one are its display name and its `retired` flag (D26, D31).

**Retired devices (D30, D31, D41).** Any device holding the unlocked vault, registered or not, can mark any Device record other than its own as retired, for a device that was lost, wiped or never finished pairing. Retirement hides the device in the UI, removes it from recovery recommendations, and blocks it from syncing: a device ends a sync session as soon as `Noise_KK` authenticates a peer whose Device record is retired, before any summary is exchanged. Before closing, it sends that peer its own retired Device record, the only record it sends, so the retired device learns of its retirement (D45); the receiver validates it like any Device record (D26).

Retirement is **irreversible**. The HLC's `deviceId` is not authenticated as the writer, so any holder of the Master Key, including the retired device, can forge a write that appears to come from another device; a reversible flag could therefore be undone through a peer that has not yet received the retirement. Instead, a Device record with `retired = true` is never replaced by one with `retired = false`, whatever their HLCs; among records with the same `retired` value, LWW applies as usual. Every device converges on the retirement, and no write can undo it. A device retired by mistake must be erased and paired again, getting a new identity. The UI MUST ask for confirmation stating that retirement cannot be undone.

Retirement is not revocation (section 20). The retired device keeps everything it already had and still holds the Master Key, and until the retirement reaches a peer it can still sync with that peer. A retirement also does not block backups: a backup carries no proof of which device made it, so a backup made by the retired device can still be merged by the user (D41). The UI MUST say so, and MUST point to re-founding (D28) when the device may be in someone else's hands.

**Own retirement (D41, D45).** A device that receives its own Device record with `retired = true` MUST show a persistent notice that it was retired and must be erased and paired again to sync, and MUST stop offering sync, pairing and re-admission. Its local vault stays usable, including making backups.

**Retired peer in pairing (D45).** A device may not yet know it was retired. The joining device in a pairing MUST abort before its commit if the first full sync shows the peer's own Device record as retired, so its storage stays empty (D33). In re-admission, the unregistered side MUST abort as soon as the Device records it holds or receives show the peer as retired. Otherwise the new device would be registered only on a retired device, which no other device syncs with.

**Interrupted pairing (D33).** B persists nothing before the single commit transaction, so an interruption at any earlier step, including a failed first sync, leaves B's storage empty and the user pairs again. If A wrote B's Device record but never received the commit acknowledgement, A shows the pairing as not completed and offers to mark that record retired. Because retirement cannot be undone, the offer MUST first ask the user to check B: if B shows the vault as ready, the commit succeeded and the user syncs with B instead (D41). If the commit succeeded but the acknowledgement was lost, B is a registered device and A updates its last-sync date at their next sync.

A mismatched SAS MUST abort. No key or recovery secret is transferred before confirmation, and the transfer MUST occur inside the authenticated Noise channel.

The new device MUST have no vault (D13), except for re-admission (below). If it holds a different vault, pairing requires the user to explicitly erase it first, after a warning recommending a backup.

**Re-admission (D22, D29).** An unregistered device holding the same vault (typically restored from a `.bvault`) joins through the same `Noise_XX` pairing with SAS confirmation. After confirmation, each side sends a key-confirmation MAC inside the Noise channel: BLAKE2b keyed by the Master Key's re-admission subkey (D23) over its role label (initiator or responder) and the final handshake hash. Each side verifies the other's MAC; a mismatch aborts the pairing. This proves both devices hold the same Master Key, bound to this session, and reveals nothing when they do not. Comparing `vaultId` is not enough, because `vaultId` is not secret. The Device records are then written as described above (D35), and the two devices run a full merge sync; no Master Key is transferred, since both already hold it. This keeps one admission rule: a device joins the set of synchronizing devices only through SAS confirmation.

---

## 9. Synchronization

QR + WebRTC synchronization avoids any permanent synchronization infrastructure. Sync requires the vault to be unlocked on both devices, because the Noise static private key is wrapped under a Master Key subkey.

### 9.1 Session establishment (D12)

A browser cannot discover peers or accept inbound connections, so every WebRTC session needs a fresh exchange of connection data (SDP and ICE candidates) through some out-of-band channel. In v1 there is no automatic background sync between devices.

- **v1: manual sync.** The user starts a sync on two devices and exchanges a **reconnection payload** by QR (or copy/paste), in both directions. It is smaller than the pairing payload because identities are already known: no SAS and no new Device record, authentication comes from `Noise_KK` (CRYPTO-INV-008). The `Noise_KK` prologue is the versioned protocol label ‖ hash of the initiator's reconnection payload ‖ hash of the responder's reconnection payload ‖ DTLS fingerprints of both sides, in fixed role order, mirroring pairing (D17). A peer MUST prove possession of the private key for its registered identity, bound to the current session; replaying an old authentication exchange MUST NOT authenticate a device.
- **Known peers only.** `Noise_K` and `Noise_KK` need each side to hold the other's Device record. A device that has not yet received a peer's Device record cannot sync with it: if A pairs C, B can sync with C only after B has synced with A (or another device holding C's record). This follows from the admission rule (CRYPTO-INV-007) and is a documented limitation. The UI offers as sync peers only the devices whose Device records it holds, and tells the user to sync first with the device that paired a new one.
- **Sync session.** While a DataChannel is open, changes made on either device are pushed immediately, until either side closes the session or locks the vault.
- **Transport-agnostic payload.** The reconnection payload is defined independently of how it is delivered (QR, copy/paste, or a future relay), so a relay added later needs no protocol change. It is encrypted to the peer with the one-way pattern `Noise_K` (both static keys known, sender authenticated), same suite as D1 (D17). No ad-hoc construction such as `crypto_box_seal` on the Noise static key is used. `Noise_K` gives no replay protection; that comes from the `Noise_KK` session that follows. Details are in `sync-protocol.md`.
- **After v1: optional signaling relay.** Devices drop encrypted reconnection payloads for each other in a mailbox, enabling automatic sync when both are online. The plan:
    - `packages/sync` defines a minimal **mailbox interface**: publish a blob to a topic, subscribe to a topic. Everything above it (payload format, `Noise_KK`) stays unchanged.
    - **First adapter: Nostr**, used directly (not through Trystero). Payloads are published as ephemeral events, which relays do not store, to several relays at once for redundancy. No account is needed and relays can be self-hosted.
    - **Second adapter: ntfy**, for users who want the simplest self-hosted option.
    - The project MUST NOT operate an official relay instance, keeping static hosting as the only operational infrastructure.
    - Off by default. Relays are configured by the user. The topic is derived from a vault secret so outsiders cannot find the user's devices.
    - Relays see only opaque blobs, timing and IP addresses, the same trust level as STUN, and never vault data. Authentication still comes only from `Noise_KK`; a malicious relay can at most disrupt connectivity.
    - Libraries that also manage WebRTC connections (Trystero, PeerJS) are not used, because BlindVault manages its own connections.
- **Limitation of any relay:** "automatic" means syncing whenever BlindVault is open on both devices at the same time. Browsers do not allow WebRTC in service workers and PWAs cannot run reliably in the background, especially on iOS, so there is no sync while the app is closed.

### 9.2 Sync flow

```
connect → Noise_KK (proves possession of the registered identity, bound to the session)
→ if the peer's Device record is retired, send it that record and end the session (D31, D45)
→ exchange summaries (recordFormatVersion, recordType, recordId, hlc, deleted, keyEpoch)
→ transfer divergent records (always encrypted) → merge → persist → ack
```

- **Transfer:** only records that differ SHOULD be transferred. Transferred contents always remain encrypted.
- **Conflicts:** last-write-wins per item, ordered by HLC, for simple deterministic v1 conflict handling. The losing version MUST go to history, subject to the history cap (D6): a loser whose `(hlc, versionId)` falls below the cut is dropped, and the device that drops it MUST show the user a one-time notice naming the item, so no item conflict loses data silently. Folder conflicts lose the older write (section 6). Device records are the one exception to plain LWW: a retired version always beats a non-retired one (D31).
- **Vault Key, Recovery Envelope and Device records (D42):** these records are never deleted, and a device MUST reject any received with `deleted = true`. The Vault Key record of an epoch is immutable: once a device holds it, the device MUST reject any other version of it, except a format migration (D38) with the same `hlc` that unwraps to the same Vault Key. The Recovery Envelope is immutable per `phraseId` (D44): a device MUST reject a received envelope with the same `phraseId` as the one it holds unless it has the same `hlc` and the same metadata (recovery keyslot public key, `phraseId`, creation date), which only a format migration produces. A legitimate replacement is a regeneration and always carries a new `phraseId`, which triggers the D43 notice. This keeps a retired or faulty device holding the Master Key from making the vault unreadable through LWW, or from silently replacing the envelope so that the Recovery Phrase no longer opens new backups. **Residual risk:** the envelope's Master Key wrap cannot be verified without the phrase, so a forged migration (same `hlc` and metadata, a higher supported `recordFormatVersion`, junk wrap) would be accepted. This is possible only once a second record format exists, and a future format migration design MUST address it.
- **HLC (D19):** `(physicalMs, counter, deviceId)`, compared lexicographically, so two records never tie. Monotonic per device, canonical fixed-length serialization, clock-skew handling, and a future-clock bound so malformed timestamps cannot gain unbounded future dominance. In sync and in a backup merge, a record whose timestamp is beyond the bound is rejected, never normalized, and the UI warns; it is accepted once the receiver's clock brings it within the bound. A fresh restore is the exception (D37, D39): it accepts every record. The local HLC never exceeds the physical clock plus the bound, including after a fresh restore, so this device's own writes always stay acceptable to peers. A restored record whose timestamp is beyond the bound is read-only until the clock brings it within the bound: no edit, move, trash or restore from the trash, since any such write would lose LWW to the record itself. Purge is not blocked, because it does not change the header. The UI shows when the record becomes editable, and peers reject it in sync until then.
- **Tombstones (D27):** a tombstone is a record with `deleted = true`. Until purge it keeps its encrypted content, so it can be restored from the trash. After purge only the header, the wrapped record key and an AEAD tag over empty content remain, so it stays authenticated (D21). Tombstones are synchronized and kept indefinitely in v1, so a stale offline device cannot resurrect deleted content. A tombstone beats an older edit. A newer edit may restore the item. Tombstones MUST NOT be removed merely because the local device has not seen the item recently. A future version MAY compact tombstones once device membership and acknowledgment state prove that all known devices have observed them.
- **History (D6):** Item Versions are synchronized records. `versionId = BLAKE2b-keyed(version-ID subkey, itemId ‖ hlc)`, where the version-ID subkey is a `crypto_kdf` subkey of the Master Key with its own context. It is deterministic, so when two devices each store the same conflict loser they produce the same record; opaque to anyone without the Master Key; and independent of `keyEpoch`, so re-encrypting a version under a new epoch does not change its ID. A version record's header `hlc` is the `hlc` of the snapshotted state, so devices that store the same loser produce the same header. Each device keeps the 20 greatest `(hlc, versionId)` per item and drops a received version below that cut, or belonging to a purged item, on arrival, so every device converges on the same history. A conflict loser dropped by the cut triggers the notice described under Conflicts; this is a documented limitation for a device that edits an item while offline during more than 20 newer edits. Pruned and purged versions are dropped without a tombstone. Pruning is done while unlocked.
- **Trash (D7, D27):** moving a record to the trash writes its tombstone. Purge date = physical time of the tombstone's HLC + 30 days, computed independently by each device. Purge is local: each device re-encrypts the record with empty content under the same header, so the header and `hlc` do not change and nothing is synchronized. Purge requires the vault to be unlocked. Only content and history are deleted; the tombstone remains. A tombstone received with content after its purge date is purged on arrival. Restoring from the trash is a newer write with `deleted = false`.
- **Network:** STUN is used only to assist connectivity. Default STUN providers are Google and Cloudflare, configurable. STUN sees the public IP and MUST NOT be assumed to provide anonymity. A LAN-only mode without STUN MUST exist, for users who want network privacy. Symmetric NAT, especially on some cellular networks, may prevent direct connections; v1 MUST NOT require TURN, and the fallbacks are same-network sync and `.bvault`. A future TURN mode MAY be considered only if it preserves the privacy model.

### 9.3 Folder tree rules (D14)

Each folder record converges independently through LWW, which can produce inconsistent trees. The tree is built at read time with these deterministic rules:

- **Cycles.** Concurrent moves (A into B on one device, B into A on another) can create a cycle. The folder in the cycle with the greatest `hlc` (D19) is displayed at the root.
- **Orphans.** An item or folder whose parent is a tombstone or is missing, including a parent not yet received, is displayed at the root. It moves under its parent once the parent arrives.

These rules never write records; once all devices have the same records, they show the same tree.

---

## 10. `.bvault` backup (D3)

The `.bvault` file gives offline recovery without any network service.

```
[magic][format version][parameters][phraseId, phrase creation date]
[keyslot: Recovery Phrase, crypto_box_seal]   ← mandatory (D16)
[keyslot: export password, Argon2id, fixed]   ← optional
[payload: secretstream(file key)]
    ├── encrypted records (as stored in IndexedDB), including the Recovery Envelope
    └── Master Key and vaultId (D25), wrapped by the file key
```

- The header carries magic, format version, cryptographic and key-derivation parameters, the `phraseId` of the recovery keyslot, and migration/versioning information; the header is authenticated and the payload is integrity-protected.
- A random file key encrypts the payload. Each keyslot wraps the file key, so either slot reaches the payload and the Master Key inside it. The recovery keyslot is sealed to the recovery keyslot public key from the Recovery Envelope (section 5.4), so a device can create it without the phrase.
- The Recovery Phrase **always** opens the backup. The export password is an extra path. Because the payload holds the Master Key, which v1 never rotates (D11), anyone who opens a backup with its export password holds the Master Key permanently: a weak or exposed export password is a Master Key compromise (section 14). The export password MUST pass the same strength check as the local password, and the export UI MUST state this consequence (D36). Its Argon2id parameters are fixed at the D9 floor (64 MiB, about 1 s on a mid-range phone), not calibrated on the exporting device, so a backup made on a desktop can be opened on a phone; the parameters are stored in the header.
- The outer layer hides IDs, HLCs and the number of records; the file size still reveals the vault's approximate size. A backup MUST remain encrypted when copied to untrusted storage.
- Automatic upload MUST NOT exist. The format is versioned and documented in `backup-format.md`.
- **Restore** MUST support a **fresh restore** (onto a device that does not hold the vault: after device loss, after browser storage loss, or to install the vault on another device) and a **backup merge** into the existing vault when explicitly requested. A backup merge uses the same rules as sync. A backup merge MUST be rejected if the backup's `vaultId` differs from the local vault's (D13); restoring a different vault requires explicitly replacing the local one. A fresh restore persists the records and the new Local Config in one storage transaction, as in pairing (D33). A restore opened with the Recovery Phrase MUST also open the Recovery Envelope in the payload with the phrase and reject the backup if that Master Key differs from the payload's; a restore opened with an export password ends by recommending Check Recovery Phrase (D43). After a fresh restore the device is an unregistered device: it has a new identity that other devices do not know, and it does not write its own Device record (D30); to sync with them it must be re-admitted (D22). After a fresh restore, if the vault holds Device records not marked retired, the UI SHOULD recommend re-admission with one of them, warn that until then this device exchanges data only through backups, and offer to mark devices that no longer exist as retired. An unregistered device that is the only one left gets its own Device record the first time it pairs another device (D30).

---

## 11. Application integrity (D5)

- The service worker serves cache-first with a versioned cache. A new version is activated **only after explicit user confirmation**, showing the version and hash. Code is never upgraded silently.
- Reproducible build with pinned lockfile and Node version and `SOURCE_DATE_EPOCH`, to make application integrity verifiable. CI rebuilds and compares the hash.
- The asset manifest hash (SHA-256) is published on GitHub Releases and displayed in the app together with the running version. The hash a build displays about itself is informational only, since a malicious bundle can display any value. The meaningful checks are the hash of an update computed by the previous, already trusted service worker before activation, and verification outside the app (rebuilding from source, or comparing the served assets with the release).
- Static self-hosting MUST work, so a user who does not trust the official host can build and host BlindVault independently.
- The first load relies on trust on first use, and this is recorded in the threat model.

---

## 12. Release and distribution

- The official application SHOULD be distributed as a static web application: GitHub Pages by default, any compatible static host for self-hosting. Static hosting means there is no operational backend.
- Each release SHOULD publish the source code, release version, build hash, reproducible-build instructions and release notes. Release artifacts SHOULD be signed where practical.
- The project is open source under the MIT license.

---

## 13. User interface

### 13.1 Layouts (D15)

Unlike BlindPass, which uses a single mobile layout everywhere, BlindVault has a dedicated layout per form factor.

| Layout | Available width | Structure |
| --- | --- | --- |
| Mobile | < 640 px | One column with drill-down navigation: folders → items → item detail. Bottom navigation |
| Tablet | 640–1023 px | Two panes: item list and item detail. Folder tree in a collapsible drawer |
| Desktop | ≥ 1024 px | Three panes: folder tree sidebar, item list, item detail |

- Layout is chosen by **available viewport width**, never by user-agent or device detection. A narrow desktop window shows the mobile layout; a tablet in landscape may show the desktop layout. Changing width switches layout without losing state or locking the vault.
- **Input adapts separately from layout**, using `pointer` and `hover` media queries: touch targets of at least 44 px on coarse pointers, hover affordances only where hover exists, and keyboard shortcuts on desktop (search, new item, lock).
- One set of domain state and components, with three layout shells. Layout code MUST NOT duplicate business or security logic.
- **Security rules are identical in every layout.** Secrets stay masked by default even when wider layouts show more at once, revealing requires an explicit action, lock/unlock state is always visible, and auto-lock behaves the same.
- The UI security requirements (section 13.2) apply to all three layouts.

### 13.2 UI security requirements

The UI MUST:

- clearly indicate locked/unlocked state;
- avoid displaying secrets unnecessarily;
- mask secret fields by default;
- require explicit action to reveal secrets;
- provide clear backup and recovery warnings;
- clearly show synchronization state;
- show the last successful backup made on this device and the last successful synchronization;
- warn about storage persistence problems.

### 13.3 Onboarding

A new installation offers three starts. The flows SHOULD be:

```
Create vault → Generate Recovery Phrase → Confirm Recovery Phrase → Create local password
→ Optional WebAuthn setup → Vault ready → Recommend backup → Recommend pairing another device

Pair with an existing device → Create local password → Pairing (section 8.4)
→ Optional WebAuthn setup → Vault ready → Recommend backup

Restore from backup → Choose .bvault → Recovery Phrase or export password → Create local password
→ Optional WebAuthn setup → Vault ready → Recommend Check Recovery Phrase (export password only, D43)
→ Recommend re-admission, or pairing another device if no Device record is left unretired (section 10)
→ Recommend backup
```

Every start generates the device identity and requests persistent storage (section 7). Creating the vault also writes the creator's own Device record; pairing and restore do not (D30).

Onboarding MUST explain that BlindVault has no server that can reset the user's vault, which is why the Recovery Phrase is critical.

### 13.4 Backup reminders

The application SHOULD record, in Local Config, the date of the last backup made on this device and the last synchronization date, and SHOULD warn when the configured backup interval expires. The date is local and not synchronized, so the UI MUST present it as "last backup made on this device". The default recommendation is 30 days.

### 13.5 UX principles

BlindVault favors explicit security decisions, understandable warnings, safe defaults, minimal configuration and clear recovery flows. Security-critical operations MUST NOT be hidden behind ambiguous UI.

---

## 14. Recovery

| Situation | Recovery |
| --- | --- |
| Local password forgotten | Recovery Phrase (keeps changes that exist only on this device), or erase local data and pair as a new device (loses them; mark the old Device record retired) |
| Device lost | Pair a new device, or restore `.bvault` and re-admit it (D22); mark the lost device retired (D30). If that device's local password was weak or the device was unlocked when lost, treat it as a Master Key compromise |
| All devices lost | `.bvault` + Recovery Phrase; mark the old devices retired (D30) |
| Browser storage erased | Pair again with another device, or restore `.bvault` and re-admit it (D22); mark the old Device record retired (D30) |
| Recovery Phrase lost | Regenerate it while unlocked (section 5.4), then make a new backup |
| Recovery Phrase exposed | Master Key compromise: re-found the vault (D28), pair the other devices again, destroy old backups |
| Export password exposed, with its backup (D36) | Master Key compromise: re-found the vault (D28), pair the other devices again, destroy old backups |
| Master Key compromised (D11) | Sync every device still in hand with one of them, re-found the vault there (D28, D46), pair the other devices again, destroy old backups |

**Re-founding (D28).** The v1 response to a Master Key compromise, in place of Master Key rotation (D11). On an unlocked device, re-founding keeps the vault's current content under entirely new keys. Before it starts, the UI MUST tell the user to sync this device with every other device still in their hands, and state that changes not on this device are lost: other devices must be erased afterwards, and a backup merge of the old vault is rejected because its `vaultId` differs (D46). Syncing from a possibly compromised device adds no risk, since its holder already has the Master Key. Re-founding:

- generates a new Master Key, `vaultId`, Vault Key and Recovery Phrase; the user confirms the phrase as at creation and sets the local password again (new Local Config);
- re-encrypts every Item and Folder that is not a tombstone under new record keys and new HLCs, keeping item and folder IDs;
- drops history, tombstones, the trash and every Device record, generates a new device identity, and writes its own Device record as the creator of the new vault (D40);
- builds the new vault in memory and replaces the old one in one storage transaction, so plaintext is never persisted and an interruption leaves the old vault intact.

Other devices still hold the old vault and can no longer sync with this one; each must be erased and paired again. Old backups open the old vault with the old phrase and MUST be destroyed. Re-founding protects only what happens afterwards: an attacker who already copied the old vault keeps it, and the UI MUST say so.

There is no administrator recovery, hidden or otherwise. Losing all data and all recovery mechanisms means permanent loss, and this MUST be communicated to users.

---

## 15. BlindPass import and reuse

BlindVault SHOULD support migration from BlindPass. The importer MUST:

1. decrypt the BlindPass representation;
2. validate the source data;
3. transform it into BlindVault's domain model;
4. encrypt the resulting records using BlindVault's cryptographic format;
5. never persist plaintext migration data after import.

The BlindPass storage and encryption format is documented in `blindpass-format.md`.

**Code reuse.** BlindPass cryptographic and domain code is **copied** into the matching BlindVault package, never imported at runtime or linked as a dependency. Where BlindPass differs on a primitive, AAD layout, key hierarchy or serialization, this document wins and the difference is recorded in `architecture.md`. Copied cryptographic code gets the same tests and review as new code. The BlindPass server application, API schema, PostgreSQL, Redis, Docker and Terraform code are not reused.

---

## 16. Stack and repository

**Stack:** TypeScript, React, Vite, Tailwind, `libsodium-wrappers-sumo`, `@scure/bip39`, `zxcvbn` (or equivalent), a Noise implementation on top of libsodium, a CBOR library with a deterministic mode, Vitest and Playwright.

**Dependency policy:** security-sensitive dependencies SHOULD be minimized, and every new dependency needs a justification. Cryptographic dependencies must be actively maintained, have a good security history, and avoid custom cryptographic implementations. Updates are reviewed for cryptographic or serialization changes.

```
apps/web/
packages/{crypto,vault,storage,sync,backup}/
docs/
    architecture.md  crypto-spec.md  threat-model.md
    pairing-protocol.md  sync-protocol.md
    security-invariants.md  backup-format.md  blindpass-format.md
tests/{crypto,pairing,sync,recovery,integration}/
```

**Browser matrix:** Chromium desktop, Firefox desktop, Safari macOS, Safari iOS and Chromium Android. Track IndexedDB, persistent storage, DataChannel, WebAuthn, WebAuthn PRF, PWA installation, camera and QR scanning. Missing capabilities degrade gracefully.

---

## 17. Security invariants

| ID | Invariant |
| --- | --- |
| CRYPTO-INV-001 | Plaintext vault contents MUST NOT be persisted |
| CRYPTO-INV-002 | The Master Key MUST NOT be synchronized in plaintext |
| CRYPTO-INV-003 | The Master Key MUST NOT be stored directly in IndexedDB |
| CRYPTO-INV-004 | Every encrypted record and tombstone authenticates its identity, `keyEpoch`, `hlc` and deletion state via AAD |
| CRYPTO-INV-005 | Keys MUST NOT appear in logs |
| CRYPTO-INV-006 | Recovery material MUST NOT be logged or persisted in plaintext |
| CRYPTO-INV-007 | A Device record is created only for the vault creator at creation or re-founding (D40), or after explicit SAS confirmation (D30); afterwards only its display name and `retired` flag change |
| CRYPTO-INV-008 | Before syncing, a peer proves possession of its registered identity (Noise_KK) |
| CRYPTO-INV-009 | Every sync message is authenticated and bound to the active session |
| CRYPTO-INV-010 | Secrets are removed from application-accessible memory on lock, as far as JS permits |
| CRYPTO-INV-011 | No Master Key or recovery secret is transferred before SAS confirmation |
| CRYPTO-INV-012 | Unknown or incompatible format and protocol versions are rejected, never interpreted as compatible |
| CRYPTO-INV-013 | Within a vault, a tombstone is never removed in v1, and a write older than a record's tombstone never restores it (re-founding creates a new vault, D28) |
| CRYPTO-INV-014 | Re-admission writes no Device record until both devices prove, bound to the session, that they hold the same Master Key (D29) |
| CRYPTO-INV-015 | No sync summary or record is exchanged with a peer whose Device record is retired, except that peer's own retired Device record (D45), and a retired Device record never becomes non-retired (D31) |
| CRYPTO-INV-016 | Vault Key, Recovery Envelope and Device records are never accepted with `deleted = true`, a held Vault Key record is never replaced by a different key (D42), and a held Recovery Envelope is never replaced by one with the same `phraseId` and a different `hlc` or metadata (D44) |

Every invariant MUST have at least one associated negative test.

The following limitations are not testable invariants but MUST hold in the design and be stated in user documentation: application integrity is separate from cryptographic confidentiality (section 3); device revocation cannot erase already-replicated data (section 20); there is no administrator recovery, and losing every copy and every recovery mechanism means permanent loss (section 14).

---

## 18. Testing

Security correctness MUST be tested independently of UI correctness. Layers, from fastest to broadest: unit, property, protocol, integration, browser, multi-device, and security gates.

**Cryptographic tests** MUST cover: key generation, Argon2id parameter handling, encryption/decryption, invalid ciphertext, invalid authentication tags, AAD mismatch, key epoch mismatch, nonce handling, recovery, key wrapping, migration, and corrupted backup files.

**Pairing tests** MUST cover: successful pairing, rejected SAS mismatch, replayed pairing, modified QR payload, modified SDP, wrong device identity, aborted pairing, duplicate pairing, interrupted transfer, interrupted commit and lost commit acknowledgement (D33, D34), re-admission key-confirmation mismatch (D29), pairing or re-admission with a retired peer (D45), reconnect, and session expiration. Pairing and sync session timeouts are defined in `pairing-protocol.md` and `sync-protocol.md`.

**Synchronization tests** MUST cover: identical vaults, one-way changes, bidirectional changes, concurrent edits, delete vs edit, edit vs delete, restore, stale devices, tombstones, history, the history-cap notice for a dropped conflict loser (D6), duplicate records, duplicate messages, out-of-order messages, corrupted records, retired peers, delivery of the retired record to the retired peer, and irreversible retirement (D31, D41, D45), deleted or replaced Vault Key, Recovery Envelope and Device records (D42), a Recovery Envelope replaced under the same `phraseId` (D44), record format migration, downgrade and the equal-`hlc` tie-break (D38), and timestamps beyond the future-clock bound (D19, D39).

**Recovery tests**, at minimum:

```
Create vault → Backup → Destroy local storage → Restore → Verify all records
Device A → Pair device B → Destroy A → Continue with B
Destroy A and B → Restore from .bvault with the Recovery Phrase → Verify vault
Fresh restore with records beyond the future-clock bound → Verify they are read-only until within the bound (D39)
Restore a backup whose Recovery Envelope does not match its Master Key → Verify it is rejected (D43)
Re-found → Interrupt before the commit → Verify the old vault is intact (D28)
```

---

## 19. Rules for AI agents

This document is **normative**.

**Agents MUST NOT:** invent cryptographic primitives; replace a specified primitive or protocol without explicit approval; weaken authentication for convenience; persist plaintext secrets for debugging; add telemetry containing vault data; add a backend to simplify sync; silently change the key hierarchy or the backup format; remove security checks to make tests pass.

**Agents SHOULD:** read package boundaries before changing a package; batch-read related files when investigating architecture; preserve the invariants; add tests for all security-sensitive behavior; explain any security-model change **before** implementing it.

### Definition of Done for security-sensitive changes

1. Design documented.
2. Relevant invariant identified.
3. Implementation complete.
4. Negative tests exist.
5. Migration implications understood.
6. Protocol or version changes documented.
7. Existing tests pass.
8. No plaintext secret handling introduced.
9. Threat-model implications reviewed.

---

## 20. Out of scope for v1

- **Device revocation**, deferred because it is complex and of limited benefit: revocation cannot erase data already replicated, and rotating the vault key only protects data encrypted afterwards. `keyEpoch` is already reserved. A future revocation SHOULD: revoke the device → new key epoch → new vault key → re-encrypt active data → exclude the revoked device from future sync. Because the Vault Key record is wrapped by the Master Key, which a revoked device holds, a new key epoch alone does not exclude it: revocation MUST either distribute the new Vault Key only to remaining devices (wrapped to each device's static key, with the Recovery Envelope handled accordingly) or rotate the Master Key (revisiting D11). The Recovery Envelope's Master Key wrap is bound to the envelope's header through the AAD, including `keyEpoch` and `hlc`, so moving the envelope to a new epoch rewrites that wrap and needs the Recovery Phrase or a regeneration; a future revocation design MUST account for this. Documentation MUST keep stating that previous copies cannot be remotely erased.
- **Master Key rotation** (D11). Re-founding (D28) is the v1 response to a compromise.
- **Attachments** (up to 10 MB, chunked `secretstream`, encrypted blob sync, storage quota management), deferred to keep v1 simple. They MUST NOT complicate the basic sync protocol. Improved backup workflows come with them.
- **Sharing between people.** Requires a different trust model (multiple principals, independent identities, permissions, revocation, partial access, key rotation, auditability), MUST be designed separately and MUST NOT reuse device pairing.
- **Browser extension and autofill**, which are a separate security boundary with a much larger attack surface.
- **Cloud storage plugins** (Drive, Dropbox), which would only receive `.bvault`-format data. The core app MUST remain functional without them.
- **TURN.**
- **Signaling relay for automatic sync** (D12): mailbox interface with Nostr and ntfy adapters, off by default, no official instance. Must never receive vault data.
- **User-created templates**, which will use the reserved `Template` record type (D20).
- **Multiple vaults:** not planned at all (D13).

---

## 21. Decision log

| # | Topic | Decision |
| --- | --- | --- |
| D1 | Device authentication | Noise `25519_ChaChaPoly_BLAKE2b`: XX for pairing, KK for sync. Prologue binds both pairing payloads and both DTLS fingerprints; SAS derived from the handshake hash. The joining device's identity exists before the handshake, and the existing device writes its Device record. *Amended by D35.* |
| D2 | Recovery Phrase | Recovery KEK via `crypto_kdf`, used only through subkeys; the envelope subkey wraps the Master Key; one synchronized Recovery Envelope per vault (LWW) carrying a `phraseId`; older backups remain openable with the old phrase; concurrent regeneration warns the superseded device. *Amended by D24, D43.* |
| D3 | `.bvault` | File key + secretstream; keyslots: recovery (mandatory) and Argon2id password (optional). *Amended by D43.* |
| D4 | QR and SDP | Minimal binary pairing payload in base45 with no Noise keys, SDP rebuilt by the receiver, no ICE trickle, bidirectional exchange, copy/paste fallback, SAS always required |
| D5 | PWA integrity | Updates only with user confirmation, reproducible build verified in CI, hash published and displayed, TOFU documented |
| D6 | Version metadata | Standard record header only (D18); `itemId` stays encrypted. `versionId` is a BLAKE2b of `itemId ‖ hlc` keyed by a Master Key subkey, so duplicates collapse and IDs survive key epochs; header `hlc` = the snapshot's `hlc`; each device keeps the 20 greatest `(hlc, versionId)` per item; pruned and purged versions are dropped without tombstones; a conflict loser that falls below the cut is dropped with a one-time notice naming the item |
| D7 | Trash | Purge = physical time of the tombstone's HLC + 30 days; tombstone remains. *Amended by D27.* |
| D8 | Wrapped key AAD | Wrapped record keys use the same AAD layout as records (section 5.6), including `hlc` and `deleted` (D21). *Amended by D21.* |
| D9 | Argon2id | Calibrated on device, ~1 s, 64 MiB floor |
| D10 | Serialization | Fixed length-prefixed binary for AAD and transcripts; strict deterministic CBOR for records and messages |
| D11 | Master Key rotation | Out of v1; compromise = re-founding (D28). *Amended by D28.* |
| D12 | Session establishment | v1 sync is manual: reconnection payload exchanged by QR or copy/paste, then live push while the session is open. Payload is transport-agnostic and encrypted to the peer's static key. After v1: optional relay through a mailbox interface, with Nostr (first) and ntfy adapters, off by default, user-configured, no official instance. No sync while the app is closed |
| D13 | Number of vaults | One vault per installation, permanently; organization through folders and tags. `vaultId` kept to reject cross-vault merge, restore and pairing; same-vault devices join by re-admission (D22). *Amended by D22.* |
| D14 | Folders | Nested, unlimited depth; separate encrypted Folder record with encrypted `parentId`. An item is in exactly one folder or at the root. Alphabetical order, no folder history, subtree delete to trash tagged with a `trashOperationId` so restore brings back exactly that action's records. Cycles and orphans resolved deterministically at read time. "Folder" is the term in code, docs and UI |
| D15 | Layouts | Dedicated mobile, tablet and desktop layouts chosen by viewport width (< 640, 640–1023, ≥ 1024 px); input adapts via pointer/hover queries; one domain layer with three layout shells; identical security behavior in all layouts |
| D16 | Recovery keyslot | A `crypto_kdf` subkey of the Recovery KEK seeds an X25519 keypair; the public key is stored in the Recovery Envelope's metadata (D24); every backup's recovery keyslot is a `crypto_box_seal` of the file key to it, so devices create backups without holding the phrase. *Amended by D24.* |
| D17 | Reconnection payload encryption | Noise one-way pattern `Noise_K` with the D1 suite and the devices' static keys; no ad-hoc construction; replay protection comes from the following `Noise_KK` session, whose prologue binds both reconnection payloads and both DTLS fingerprints, as in pairing |
| D18 | Record header and record keys | Every synchronized record has the cleartext header `recordType, recordId, hlc, deleted, keyEpoch`, the source of AAD and sync summaries. Content records use a random record key wrapped by the epoch's Vault Key; the Vault Key and the Master Key inside the Recovery Envelope are the explicit exceptions (D24). *Amended by D21, D24, D32, D42.* |
| D19 | HLC and device ID | HLC = `(physicalMs, counter, deviceId)`, compared lexicographically, so there are no ties; `deviceId = BLAKE2b-128(static public key)`; timestamps beyond the future-clock bound are rejected, never normalized. *Amended by D37, D39.* |
| D20 | Templates in v1 | Factory templates are versioned definitions in code; items reference `templateId` and `templateVersion`; no Template record in v1, type reserved for user templates |
| D21 | Header authentication | AAD = `protocolVersion ‖ recordType ‖ vaultId ‖ recordId ‖ keyEpoch ‖ hlc ‖ deleted`, so the whole cleartext header is authenticated and cannot be edited to win LWW, delete a record or replay older ciphertext as newer. Record keys are re-wrapped on every write. A tombstone keeps its wrapped record key and an AEAD tag over empty content. Amends D8 and D18. *Amended by D27, D32.* |
| D22 | Re-admission | A device holding the same `vaultId` without a registered identity (restored from backup) joins through `Noise_XX` pairing with SAS and mutual Master Key confirmation (D29); A writes its Device record, then a merge sync; no Master Key transfer. Exception to D13's empty-device rule. *Amended by D29, D35.* |
| D23 | Master Key use | The Master Key is used only through `crypto_kdf` subkeys, one per purpose (Vault Key wrapping, device identity wrapping, `versionId`, re-admission key confirmation), never directly as an encryption key. *Amended by D29.* |
| D24 | Recovery Envelope metadata | The Recovery Envelope has two parts: the Master Key wrapped by the envelope subkey, and metadata (recovery keyslot public key, `phraseId`, phrase creation date) encrypted with a record key wrapped by the Vault Key, so any unlocked device can read the public key without the phrase. Check Recovery Phrase also verifies the public key against the phrase. Amends D2, D16 and D18 |
| D25 | `vaultId` | Random, generated at vault creation, stored in Local Config, transferred with the Master Key during pairing and stored next to it in the `.bvault` payload. Bound into the AAD of records and local wraps. Re-admission no longer compares it (D29). *Amended by D29.* |
| D26 | Device records | `recordId` MUST equal `BLAKE2b-128` of the public key; the public key is immutable and only the display name and the `retired` flag (D30) can change; Device records cannot be deleted in v1; A writes B's record only after B acknowledges the Master Key; a never-synced device is shown as such. *Amended by D30, D34.* |
| D27 | Trash and tombstones | Trashing writes the tombstone (`deleted = true`) and keeps the content until purge; purge is local, re-encrypts empty content under the unchanged header and requires unlock; restore is a newer write. Amends D7 and D21 |
| D28 | Re-founding | Response to a Master Key compromise in v1: an unlocked device creates a new Master Key, `vaultId`, Vault Key, Recovery Phrase and device identity, re-encrypts live Items and Folders (same IDs, new HLCs), drops history, tombstones, trash and Device records, and swaps vaults in one storage transaction without persisting plaintext. Other devices pair again; old backups are destroyed. Amends D11 and section 14. *Amended by D40, D46.* |
| D29 | Re-admission key confirmation | After SAS, each side sends BLAKE2b keyed by a Master Key re-admission subkey over its role label and the final handshake hash; a mismatch aborts. Replaces the `vaultId` comparison, since `vaultId` is not secret. Amends D22, D23 and D25 |
| D30 | Device admission and retirement | Device records are written only for the vault creator at creation, or by A after SAS confirmation: B's record, plus A's own if A has none (restored device). B sends its display name with its Master Key acknowledgement. A synchronized `retired` flag hides a device and removes it from recovery recommendations; it is not revocation (sync block and irreversibility added by D31). Records found without Local Config at startup are an incomplete pairing and are erased after a notice. Local wraps use `AAD = purpose label ‖ vaultId`. Amends D26. *Amended by D31, D33, D35, D40, D41.* |
| D31 | Retirement blocks sync | A device ends a sync session right after `Noise_KK` when the peer's Device record is retired. Retirement is irreversible: a retired Device record is never replaced by a non-retired one, whatever the HLCs, because the HLC's `deviceId` is not authenticated and a reversible flag could be undone by a forged write through a lagging peer. A device retired by mistake is erased and paired again. Not revocation: past data stays exposed and the block applies only at peers that have received the retirement. Amends D30. *Amended by D41, D45.* |
| D32 | Record format version | `recordFormatVersion` is a cleartext header field, bound through the AAD in place of `protocolVersion`, and included in sync summaries. It is independent of the pairing and sync protocol versions, so a protocol change never invalidates stored records. Older supported formats stay readable and are migrated by re-encryption; unknown ones are rejected. Amends D18 and D21. *Amended by D38.* |
| D33 | Atomic pairing and restore commit | The joining device creates its local password and derives its Device KEK before the handshake, keeps everything received in memory, and persists records, Local Config and its encrypted identity in one storage transaction after the first full sync, then sends a commit acknowledgement. An interruption before the commit leaves its storage empty. A fresh restore commits the same way. Replaces D30's startup cleanup of records found without Local Config |
| D34 | Last sync per peer | Each device keeps in Local Config the date of its last completed sync with each peer; the UI shows it next to `pairedAt`. A pairing whose commit acknowledgement never arrived is shown as not completed, with an offer to retire the record. Replaces D26's "never synced" label. *Amended by D41.* |
| D35 | Device record writer in re-admission | The registered side writes the unregistered side's Device record; if neither is registered, the initiator writes both. Amends D30 |
| D36 | Export password | Subject to the same strength check as the local password; the export UI states that opening a backup yields the Master Key, so an exposed export password with its backup is a Master Key compromise handled by re-founding |
| D37 | Future-clock bound on restore | The bound applies to sync and backup merge. A fresh restore accepts every record, advances the local HLC past the greatest one, and warns if any timestamp is beyond the bound. Amends D19. *Amended by D39.* |
| D38 | Record format migration | Migration re-encrypts a record under a newer `recordFormatVersion`, keeping `hlc` and every other header field, and creates no Item Version; with equal `recordId` and `hlc`, the higher `recordFormatVersion` wins in sync. The Recovery Envelope migrates only at regeneration or Check Recovery Phrase, since its Master Key wrap needs the phrase; a format stays supported while any envelope may use it. Amends D32 |
| D39 | HLC cap after fresh restore | The local HLC never exceeds the physical clock plus the future-clock bound. A record from a fresh restore whose timestamp is beyond the bound is read-only (no edit, move, trash or restore) until the clock brings it within the bound; purge is allowed, and the UI shows when it becomes editable. Replaces D37's advance past the greatest record and its LWW warning. Amends D19 and D37 |
| D40 | Re-founding device as creator | Re-founding creates a new vault, so the re-founding device is its creator and writes its own Device record, as at vault creation; the admission rule and CRYPTO-INV-007 name re-founding explicitly. Amends D28 and D30 |
| D41 | Retirement rules | Any device holding the unlocked vault, registered or not, can retire any Device record except its own. A device that receives its own record as retired shows a persistent notice, stops offering sync and keeps its vault usable. Retirement does not block a backup merge, since a backup carries no proof of its maker; this is a documented limitation. The offer to retire after a missing commit acknowledgement first asks the user to check whether B shows the vault as ready. Amends D30, D31 and D34. *Amended by D45.* |
| D42 | Non-deletable and immutable records | Vault Key, Recovery Envelope and Device records with `deleted = true` are rejected. The Vault Key record of an epoch is immutable once held, except for a format migration with the same `hlc` and the same key, so a retired or faulty device cannot make the vault unreadable through LWW. Adds CRYPTO-INV-016. Amends D18. *Amended by D44.* |
| D43 | Recovery Phrase change and restore checks | Every device shows a one-time notice when the Recovery Envelope's `phraseId` changes, tracked by the last `phraseId` seen in Local Config. A restore opened with the Recovery Phrase rejects a backup whose envelope does not yield the payload's Master Key; a restore opened with an export password ends by recommending Check Recovery Phrase. Amends D2 and D3. *Amended by D44.* |
| D44 | Recovery Envelope immutable per `phraseId` | A device rejects a received Recovery Envelope with the `phraseId` it holds unless `hlc` and metadata are also unchanged (a format migration). A Master Key holder therefore cannot replace the envelope, with a different recovery keyslot public key or a junk Master Key wrap, without a new `phraseId`, which triggers the D43 notice. Residual risk: a forged format migration with a junk wrap, possible only once a second record format exists, which a future migration design MUST address. Extends CRYPTO-INV-016. Amends D42 and D43 |
| D45 | Retirement reaches the retired device and blocks its admissions | A device that ends a sync session with a retired peer first sends it the peer's own retired Device record, the only exception to CRYPTO-INV-015, so the D41 notice is reachable. A device that knows it is retired stops offering pairing and re-admission as well as sync. A joining device aborts a pairing before its commit, and an unregistered device aborts a re-admission, when the peer's own Device record is retired. Amends D31 and D41 |
| D46 | Sync before re-founding | Before re-founding, the UI tells the user to sync every other device still in their hands with the re-founding device and states that changes not on it are lost, since other devices are erased afterwards and a backup merge of the old vault is rejected by `vaultId`. Amends D28 |
