# BlindVault — Overview

> Normative design document for implementation. It prevails over every other document in this repository.
> Consolidates the original *BlindVault — Technical Design Specification* (2026-10-04, available in git history at commit `6b1ae3a`) and decisions D1–D20 (section 21).
> Status: Proposed · Author: Allisson Azevedo · License: MIT.
> The words MUST, MUST NOT, SHOULD and MAY follow RFC 2119. Terms follow `GLOSSARY.md`.

---

## 1. Vision

BlindVault is a **local-first** encrypted personal vault for any kind of private information. It runs entirely in the browser, can be installed as a PWA, and **has no server that stores user data**. It is intentionally not a cloud password manager: there is no account system and no server-side vault.

> The user's vault belongs to the user, not to a service.

Data exists only on the user's devices or in encrypted backup files the user controls. Synchronization is peer-to-peer between explicitly paired devices.

BlindVault is derived from BlindPass: it reuses the cryptographic model and domain packages, and removes the server, database, sessions, API and administration layers (section 15).

**v1 success criterion:** a user can create a vault, protect it cryptographically, recover it after losing local storage, pair another device without trusting a server, synchronize safely, and understand exactly what happens if every device except the backup is lost. The criterion is not feature count.

**Highest-priority engineering risks**, in order: pairing protocol correctness, application/PWA integrity, browser storage behavior, recovery UX, and synchronization edge cases. None of them requires abandoning the architecture, but cryptography, pairing, synchronization and recovery MUST be implemented as explicit protocols rather than informal application logic. The project SHOULD resist adding features before these foundations are thoroughly tested.

---

## 2. Principles

1. **No data server.** BlindVault MUST NOT require a server to store vault data, which minimizes the attack surface. Network services are used only for static assets and STUN. None of them receive plaintext vault contents, and STUN providers MUST NOT be treated as trusted data services.
2. **Encryption first.** All sensitive content is encrypted before persistence or synchronization. Keys exist in plaintext only in memory, while the vault is unlocked; the only keys at rest are explicitly encrypted local key-wrapping material.
3. **Local-first.** A browser/PWA application keeps the vault local and portable. Once installed, the app works offline. There is no account, backend, authentication server, cloud database or sync service.
4. **Synchronization is replication**, not a hosted backup service. Every paired device holds a complete encrypted copy of the vault. A `.bvault` file is an additional recovery mechanism.
5. **Small attack surface.** Few dependencies, small security-sensitive modules, clear cryptographic boundaries, deterministic builds, extensive tests, and no unnecessary network functionality.
6. **Generic model.** BlindVault is a vault, not only a password manager. Items are made of typed fields. Templates are a UI convenience and MUST NOT alter the cryptographic model.

---

## 3. Threat model

**Protected assets:** vault contents, secrets, passwords, credentials, recovery material, cryptographic keys, encrypted backups and synchronized records.

**Threats considered:** loss or theft of a device, access to a locked device, network interception, malicious peers, MITM during pairing, compromised STUN, corrupted sync data, browser storage eviction, accidental deletion, stale devices reconnecting, and malicious application hosting.

**Out of scope (MUST be documented to users):** a compromised operating system, malware that reads browser memory, malicious extensions, an attacker holding an unlocked device, keyloggers, a malicious browser, and a malicious JavaScript bundle executed before integrity verification, including the first load (TOFU, see D5).

Cryptographic confidentiality and application integrity are separate properties. A malicious bundle can read vault contents after unlock, even with perfect cryptography; a compromised browser, OS, extension or JavaScript bundle can therefore compromise an unlocked vault and is outside the cryptographic threat model.

**Accepted metadata leakage.** The cleartext record header (section 6) is visible to anyone who can read IndexedDB on a locked device: record types and counts, `keyEpoch`, deletion state, and the HLC of every change (which reveals editing times and the `deviceId` that made them). During sync the same header is visible to the peer, never to the network. A `.bvault` file hides all of it (section 10).

**Device admission.** Anyone holding the Vault Key can write a Device record and so register a device. This is accepted: holding the Vault Key already grants full access to the vault.

| Threat | Status | Mitigation |
| --- | --- | --- |
| Server database compromise | Eliminated | No data server |
| Network interception | Protected | Noise over DTLS + encrypted records |
| MITM during pairing | Protected | SAS derived from the handshake + user confirmation |
| Malicious STUN provider | Limited | No vault data; optional LAN-only mode |
| Browser storage eviction | Partially protected | Persistent storage + backup + replication |
| Weak password | Partially protected | Argon2id + password-strength checks |
| Lost device | Partially protected | Local password + auto-lock |
| Stolen unlocked device | Out of scope | OS/device security required |
| Malicious extension | Out of scope | Browser security required |
| Malware | Out of scope | Trusted runtime required |
| Malicious PWA host | Partially protected | Reproducible builds + hashes + self-hosting |
| Browser compromise | Out of scope | Trusted browser required |
| Stale device resurrecting data | Protected | Persistent tombstones |
| Sync conflict | Protected | HLC + history |
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
Device Identity (X25519, local, encrypted at rest under the Master Key)
```

### 5.3 Keys

**Master Key.** Root of the vault, identical on all devices, which is what makes device replication possible. Generated by a CSPRNG. MUST NOT be persisted directly, synchronized in plaintext, or stored directly in IndexedDB. Exists in plaintext only in memory while unlocked. Not rotated in v1 (D11).

**Device KEK.** `KEK = Argon2id(password, local salt, local parameters)`. The salt, parameters, wrapped master key, PRF KEK material and preferences are local and MUST NOT be synchronized. Each device may have a different password, so each device's security is independent. Changing the password on one device MUST NOT require synchronization and only re-wraps the master key. Parameters are **calibrated on the device** at vault creation, targeting about 1 s, with a **64 MiB memory floor** (D9). The application SHOULD reject weak passwords with zxcvbn (or equivalent); strength checks MUST NOT be treated as cryptographic protection.

**Vault Key.** Random (not derived from user credentials), protected by the master key, always tagged with a `keyEpoch` so the key can be rotated later without redesigning the record format.

**Record key (D18).** Random and independent per content record (Item, Item Version, Folder, Device), wrapped by the Vault Key of the record's `keyEpoch` with the record's AAD, and stored in the record. Record keys give record isolation, independent encryption contexts, simpler future rotation, and safer handling of deleted or migrated records. Two records are not encrypted with a record key: the Vault Key record (wrapped by the Master Key) and the Recovery Envelope (wrapped by the Recovery KEK envelope subkey).

### 5.4 Recovery Phrase (D2)

- 256 bits from a CSPRNG, displayed as a 24-word BIP39 phrase. In the UI it is called "Recovery Phrase", never "seed": it represents vault recovery entropy, not a cryptocurrency wallet.
- `Recovery KEK = crypto_kdf_derive_from_key(entropy, fixed context)`. No Argon2, since entropy is already high. The Recovery KEK is never used directly: each use derives its own `crypto_kdf` subkey with a distinct subkey ID (key separation).
- The **envelope subkey** wraps the master key. This Recovery Envelope is a **synchronized record** with a fixed `recordId` per vault, merged by LWW, so every device and future backup holds the current envelope.
- **Recovery keyslot keypair (D16).** A second subkey seeds an X25519 keypair (`crypto_box_seed_keypair`). The Recovery Envelope also carries the **public key** in its encrypted content. Any unlocked device can therefore create a backup's recovery-phrase keyslot (`crypto_box_seal` of the file key) without holding the phrase or any recovery secret. The private key exists only while the phrase is being used.
- Each phrase has a random `phraseId` and a creation date, stored in the Recovery Envelope and in every backup header, and shown to the user when the phrase is generated, when a backup is listed, and when a backup is restored ("opens with the Recovery Phrase from 2026-10-06").
- Combined with a `.bvault` backup, the phrase MUST be sufficient to recover the vault. It MAY be used to set a new local password on a device.
- Shown at creation and, by default, only once, with confirmation that it was written down. MUST NOT be persisted or logged in plaintext.
- **Check Recovery Phrase:** while unlocked, the user can type the phrase and the app confirms whether it matches the current Recovery Envelope.
- **Regeneration:** with the vault unlocked, a new phrase and a new envelope replace the current envelope; this MUST NOT require changing vault contents. The new envelope reaches other devices only when they sync, and the UI MUST show that the new phrase is not yet on other devices. If two devices regenerate concurrently, LWW keeps one envelope; a device that receives an envelope newer than the one it created MUST warn the user that the phrase they wrote down was superseded. **Documented limitations:** older `.bvault` backups can still be opened with the old phrase, and a device that has not yet synced keeps producing backups for the old phrase; the `phraseId` shown with every backup makes this visible.

### 5.5 WebAuthn PRF

Optional, for convenient local unlock, and detected at runtime. Derives a PRF KEK that wraps the master key. It does not replace the hierarchy. Password unlock always remains available. Without support, the app falls back to the password gracefully.

### 5.6 AAD and nonces

Every encrypted record MUST bind its ciphertext to its logical identity through AAD, so ciphertext from one record cannot be substituted for another's:

```
AAD = protocolVersion || recordType || vaultId || recordId || keyEpoch
```

The fields come from the record header (section 6). The same AAD binds the wrapped record key, the Vault Key record and the Recovery Envelope (D8, D18). Nonces follow libsodium requirements: random 24-byte nonces for XChaCha20-Poly1305 and `secretstream` for large data. Nonce reuse under the same key MUST NOT occur.

### 5.7 Serialization and versioning (D10)

- **AAD, transcripts and prologues:** fixed binary layout, every field length-prefixed in a fixed order. No dependencies, with test vectors.
- **Records and protocol messages:** deterministic CBOR (RFC 8949, §4.2). The decoder is strict and rejects non-canonical encodings.
- No binary or textual representation may have multiple equivalent encodings that could produce different cryptographic transcripts.
- The encrypted record format, `.bvault`, the pairing protocol, the sync protocol and cryptographic envelopes MUST be versioned. An incompatible format MUST NOT be silently interpreted as compatible. Downgrade attacks MUST be considered during version negotiation.

---

## 6. Data model

Only the minimum metadata needed for synchronization is in cleartext.

**Record header (D18).** Every synchronized record has the same cleartext header: `recordType`, `recordId`, `hlc`, `deleted`, `keyEpoch`. The header is the source of the AAD (section 5.6) and of the sync summaries (section 9.2). `vaultId` and `protocolVersion` are bound through the AAD.

| Record | Header specifics | Encrypted content |
| --- | --- | --- |
| Item | `recordId` = item ID | Record key (wrapped); `templateId`, `templateVersion`, title, fields, `folderId` (optional), tags, notes |
| Folder (D14) | `recordId` = folder ID | Record key (wrapped); name, `parentId` (optional), `trashOperationId` (when trashed) |
| Item Version (D6) | `recordId` = `versionId` (deterministic, opaque) | Record key (wrapped); `itemId`, `deviceId`, full item snapshot |
| Vault Key | `recordId` fixed per `keyEpoch` | Vault Key wrapped by the Master Key |
| Recovery Envelope (D2, D16) | `recordId` fixed per vault | Master Key wrapped by the envelope subkey; recovery keyslot public key, `phraseId`, phrase creation date |
| Device | `recordId` = `deviceId` | Record key (wrapped); public identity key, display name, `pairedAt` |
| Local Config (not synchronized) | — | Local KEK material, PRF KEK state, encrypted device identity, preferences |

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

**Field types (v1):** text, long text, secret, URL, email, phone, date, number, TOTP, BIP39 seed, wallet fields. Attachments come after v1.

**Factory templates:** Login, Secure Note, Card, Identity, Developer Credential, Crypto Wallet, Document. Templates are data definitions, not separate security models.

---

## 7. Local storage and locking

- IndexedDB stores only already-encrypted records. `localStorage` stores only non-sensitive preferences (theme, language, UI).
- Call `navigator.storage.persist()` at vault creation, show the persistence status, and monitor `navigator.storage.estimate()`.
- Browser storage eviction is a data-availability risk. The application MUST NOT imply that browser storage is permanent.
- If persistence is denied and there is only one device, show a persistent warning recommending a backup and pairing.
- **On lock:** remove plaintext items from state, release keys, clear caches, and block cryptographic operations. Auto-lock is configurable with a conservative default. Memory zeroization in JS is not guaranteed, and this MUST be documented.

---

## 8. Identity and pairing

Pairing is one of the most security-sensitive protocols in BlindVault. It MUST be implemented as a formally specified protocol (`pairing-protocol.md`), not an informal WebRTC exchange.

### 8.1 Identity

Each device has an X25519 key pair, which is the device's **Noise static key**. The private key is local, encrypted at rest under the Master Key, and MUST NOT be synchronized. The public key is synchronized in the Device record. Device identity MUST be authenticated during synchronization.

`deviceId = BLAKE2b-128(static public key)` (D19). It is derived, so a device cannot claim another device's ID with a different key.

### 8.2 Handshake (D1)

- Suite: `Noise_*_25519_ChaChaPoly_BLAKE2b`, an existing implementation on top of libsodium, validated against the official test vectors.
- **Pairing:** `Noise_XX`. **Synchronization:** `Noise_KK`, since both sides already know each other's static key.
- Prologue = versioned protocol label ‖ hash of the initiator's pairing payload ‖ hash of the responder's pairing payload ‖ DTLS fingerprints of both sides, in fixed role order (initiator first). Both pairing payloads are bound, not only the first. The transcript MUST include all security-relevant negotiation values, with a canonical, versioned encoding.
- The SAS is derived from the final handshake hash. It MUST bind both peers and the session, MUST prevent replay across sessions, and MUST be displayed on both devices and explicitly confirmed by the user. SAS length and brute-force analysis, including commitment in copy/paste mode, are defined in `pairing-protocol.md`.
- WebRTC DTLS is transport only and MUST NOT be the trust mechanism. A device MUST NOT be trusted merely because a WebRTC connection succeeded.

### 8.3 Pairing payload and QR (D4)

- Binary pairing payload with version, session ID, DTLS fingerprint (32 bytes), ICE ufrag, ICE pwd, candidates (host and srflx), Noise ephemeral key and capabilities. Encoded in base45 (QR alphanumeric mode). The original spec estimated about 200–300 bytes; this is not yet measured.
- The receiver rebuilds the SDP from the payload. ICE gathering completes before the QR is generated, with no trickle.
- Bidirectional exchange: A shows its QR and B scans it, then B shows its response and A scans it. Copy/paste is the fallback for desktops without a camera.
- Animated QR MUST NOT be implemented without real-world evidence that a static QR is insufficient.
- The pairing payload MUST NOT contain vault data.

### 8.4 Flow

```
B generates its identity (in memory only)
→ A's QR → B's QR → WebRTC/DTLS → Noise_XX handshake → SAS on both devices
→ human confirmation → A writes B's Device record (static key seen in the handshake)
→ Master Key transferred over the Noise channel
→ first full sync over the same channel (sync protocol, no new exchange)
→ B creates local password, derives KEK, wraps Master Key, persists its identity encrypted, (WebAuthn)
→ B is a paired device
```

`Noise_XX` transmits both static keys during the handshake, so B's identity MUST exist before it. B holds the identity only in memory until it has the Master Key, and discards it if pairing aborts.

A writes B's Device record, bound to the static key A authenticated in the handshake, so B cannot choose or alter its registered key.

A mismatched SAS MUST abort. No key or recovery secret is transferred before confirmation, and the transfer MUST occur inside the authenticated Noise channel.

The new device MUST have no vault (D13). If it already holds one, pairing requires the user to explicitly erase it first, after a warning recommending a backup.

---

## 9. Synchronization

QR + WebRTC synchronization avoids any permanent synchronization infrastructure.

### 9.1 Session establishment (D12)

A browser cannot discover peers or accept inbound connections, so every WebRTC session needs a fresh exchange of connection data (SDP and ICE candidates) through some out-of-band channel. In v1 there is no automatic background sync between devices.

- **v1: manual sync.** The user starts a sync on two devices and exchanges a **reconnection payload** by QR (or copy/paste), in both directions. It is smaller than the pairing payload because identities are already known: no SAS and no enrollment, authentication comes from `Noise_KK` (CRYPTO-INV-008). A peer MUST prove possession of the private key for its registered identity, bound to the current session; replaying an old authentication exchange MUST NOT authenticate a device.
- **Live session.** While a DataChannel is open, changes made on either device are pushed immediately, until either side closes the session or locks the vault.
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
→ exchange summaries (recordId, hlc, deleted, keyEpoch, recordType)
→ transfer divergent records (always encrypted) → merge → persist → ack
```

- **Transfer:** only records that differ SHOULD be transferred. Transferred contents always remain encrypted.
- **Conflicts:** last-write-wins per item, ordered by HLC, for simple deterministic v1 conflict handling. The losing version MUST go to history and never be discarded, so no conflict silently loses data.
- **HLC (D19):** `(physicalMs, counter, deviceId)`, compared lexicographically, so two records never tie. Monotonic per device, canonical fixed-length serialization, clock-skew handling, and a future-clock bound so malformed timestamps cannot gain unbounded future dominance (timestamps beyond the bound are rejected or normalized).
- **Tombstones:** a tombstone holds roughly `id`, `hlc` and `deleted = true`. Tombstones are synchronized and kept indefinitely in v1, so a stale offline device cannot resurrect deleted content. A tombstone beats an older edit. A newer edit may restore the item. Tombstones MUST NOT be removed merely because the local device has not seen the item recently. A future version MAY compact tombstones once device membership and acknowledgment state prove that all known devices have observed them.
- **History (D6):** Item Versions are synchronized records. `versionId = BLAKE2b-keyed(version-ID subkey, itemId ‖ hlc)`, where the version-ID subkey is a `crypto_kdf` subkey of the Master Key with its own context. It is deterministic, so when two devices each store the same conflict loser they produce the same record; opaque to anyone without the Master Key; and independent of `keyEpoch`, so re-encrypting a version under a new epoch does not change its ID. Each device keeps the 20 greatest `(hlc, versionId)` per item and drops a received version below that cut on arrival, so every device converges on the same history. Pruning is done while unlocked.
- **Trash (D7):** purge date = physical time of the tombstone's HLC + 30 days, computed independently by each device. Only content and history are deleted; the tombstone remains.
- **Network:** STUN is used only to assist connectivity. Default STUN providers are Google and Cloudflare, configurable. STUN sees the public IP and MUST NOT be assumed to provide anonymity. A LAN-only mode without STUN MUST exist, for users who want network privacy. Symmetric NAT, especially on some cellular networks, may prevent direct connections; v1 MUST NOT require TURN, and the fallbacks are same-network sync and `.bvault`. A future TURN mode MAY be considered only if it preserves the privacy model.

### 9.3 Folder tree rules (D14)

Each folder record converges independently through LWW, which can produce inconsistent trees. The tree is built at read time with these deterministic rules:

- **Cycles.** Concurrent moves (A into B on one device, B into A on another) can create a cycle. The folder in the cycle with the greatest `hlc` (D19) is displayed at the root.
- **Orphans.** An item or folder whose parent is a tombstone or does not exist is displayed at the root.
- **Missing parent on arrival.** A folder or item received before its parent is held at the root until the parent arrives.

These rules never write records; once all devices have the same records, they show the same tree.

---

## 10. `.bvault` backup (D3)

The `.bvault` file gives offline recovery without any network service.

```
[magic][format version][parameters][phraseId, phrase creation date]
[keyslot: recovery phrase, crypto_box_seal]   ← mandatory (D16)
[keyslot: export password, Argon2id]          ← optional
[payload: secretstream(file key)]
    ├── encrypted records (as stored in IndexedDB), including the Recovery Envelope
    └── Master Key wrapped by the file key
```

- The header carries magic, format version, cryptographic and key-derivation parameters, the `phraseId` of the recovery keyslot, and migration/versioning information; the header is authenticated and the payload is integrity-protected.
- A random file key encrypts the payload. Each keyslot wraps the file key, so either slot reaches the payload and the Master Key inside it. The recovery keyslot is sealed to the recovery keyslot public key from the Recovery Envelope (section 5.4), so a device can create it without the phrase.
- The recovery phrase **always** opens the backup. The export password is an extra path.
- The outer layer hides IDs, HLCs and the number of records. A backup MUST remain encrypted when copied to untrusted storage.
- Automatic upload MUST NOT exist. The format is versioned and documented in `backup-format.md`.
- **Restore** MUST support creating a new vault from a backup, restoring after device loss, restoring after browser storage loss, and merging into the existing vault when explicitly requested. Merge uses the same rules as sync. Merge MUST be rejected if the backup's `vaultId` differs from the local vault's (D13); restoring a different vault requires explicitly replacing the local one.

---

## 11. Application integrity (D5)

- The service worker serves cache-first with a versioned cache. A new version is activated **only after explicit user confirmation**, showing the version and hash. Code is never upgraded silently.
- Reproducible build with pinned lockfile and Node version and `SOURCE_DATE_EPOCH`, to make application integrity verifiable. CI rebuilds and compares the hash.
- The asset manifest hash (SHA-256) is published on GitHub Releases and displayed in the app together with the running version.
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
- show the last successful backup and the last successful synchronization;
- warn about storage persistence problems.

### 13.3 Onboarding

The onboarding flow SHOULD be:

```
Create vault → Generate Recovery Phrase → Confirm Recovery Phrase → Create local password
→ Optional WebAuthn setup → Vault ready → Recommend backup → Recommend pairing another device
```

Onboarding MUST explain that BlindVault has no server that can reset the user's vault, which is why the Recovery Phrase is critical.

### 13.4 Backup reminders

The application SHOULD record the last backup date and the last synchronization date, and SHOULD warn when the configured backup interval expires. The default recommendation is 30 days.

### 13.5 UX principles

BlindVault favors explicit security decisions, understandable warnings, safe defaults, minimal configuration and clear recovery flows. Security-critical operations MUST NOT be hidden behind ambiguous UI.

---

## 14. Recovery

| Situation | Recovery |
| --- | --- |
| Local password forgotten | Recovery phrase or re-pair from another device |
| Device lost | Pair a new device or restore `.bvault` |
| All devices lost | `.bvault` + recovery phrase |
| Browser storage erased | `.bvault` or another paired device |
| Recovery Phrase lost or exposed | Regenerate it while unlocked (section 5.4) |
| Master key compromised (D11) | Create a new vault and import the content |

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
| CRYPTO-INV-002 | The master key MUST NOT be synchronized in plaintext |
| CRYPTO-INV-003 | The master key MUST NOT be stored directly in IndexedDB |
| CRYPTO-INV-004 | Every encrypted record authenticates its identity and `keyEpoch` via AAD |
| CRYPTO-INV-005 | Keys MUST NOT appear in logs |
| CRYPTO-INV-006 | Recovery material MUST NOT be logged or persisted in plaintext |
| CRYPTO-INV-007 | No device becomes a paired device without explicit SAS confirmation |
| CRYPTO-INV-008 | Before syncing, a peer proves possession of its registered identity (Noise_KK) |
| CRYPTO-INV-009 | Every sync message is authenticated and bound to the active session |
| CRYPTO-INV-010 | Secrets are removed from application-accessible memory on lock, as far as JS permits |

Every invariant MUST have at least one associated negative test.

The following limitations are not testable invariants but MUST hold in the design and be stated in user documentation: application integrity is separate from cryptographic confidentiality (section 3); device revocation cannot erase already-replicated data (section 20); there is no administrator recovery, and losing every copy and every recovery mechanism means permanent loss (section 14).

---

## 18. Testing

Security correctness MUST be tested independently of UI correctness. Layers, from fastest to broadest: unit, property, protocol, integration, browser, multi-device, and security gates.

**Cryptographic tests** MUST cover: key generation, Argon2id parameter handling, encryption/decryption, invalid ciphertext, invalid authentication tags, AAD mismatch, key epoch mismatch, nonce handling, recovery, key wrapping, migration, and corrupted backup files.

**Pairing tests** MUST cover: successful pairing, rejected SAS mismatch, replayed pairing, modified QR payload, modified SDP, wrong device identity, aborted pairing, duplicate pairing, interrupted transfer, reconnect, and session expiration.

**Synchronization tests** MUST cover: identical vaults, one-way changes, bidirectional changes, concurrent edits, delete vs edit, edit vs delete, restore, stale devices, tombstones, history, duplicate records, duplicate messages, out-of-order messages, and corrupted records.

**Recovery tests**, at minimum:

```
Create vault → Backup → Destroy local storage → Restore → Verify all records
Device A → Pair device B → Destroy A → Continue with B
Destroy A and B → Restore from .bvault with the Recovery Phrase → Verify vault
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

- **Device revocation**, deferred because it is complex and of limited benefit: revocation cannot erase data already replicated, and rotating the vault key only protects data encrypted afterwards. `keyEpoch` is already reserved. A future revocation SHOULD: revoke the device → new key epoch → new vault key → re-encrypt active data → exclude the revoked device from future sync. Because the Vault Key record is wrapped by the Master Key, which a revoked device holds, a new key epoch alone does not exclude it: revocation MUST either distribute the new Vault Key only to remaining devices (wrapped to each device's static key, with the Recovery Envelope handled accordingly) or rotate the Master Key (revisiting D11). Documentation MUST keep stating that previous copies cannot be remotely erased.
- **Master key rotation** (D11).
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
| D1 | Device authentication | Noise `25519_ChaChaPoly_BLAKE2b`: XX for pairing, KK for sync. Prologue binds both pairing payloads and both DTLS fingerprints; SAS derived from the handshake hash. The joining device's identity exists before the handshake, and the existing device writes its Device record |
| D2 | Recovery Phrase | Recovery KEK via `crypto_kdf`, used only through subkeys; the envelope subkey wraps the master key; one synchronized Recovery Envelope per vault (LWW) carrying a `phraseId`; older backups remain openable with the old phrase; concurrent regeneration warns the superseded device |
| D3 | `.bvault` | File key + secretstream; keyslots: recovery (mandatory) and Argon2id password (optional) |
| D4 | QR and SDP | Minimal binary pairing payload in base45, SDP rebuilt by the receiver, no ICE trickle, bidirectional exchange, copy/paste fallback, SAS always required |
| D5 | PWA integrity | Updates only with user confirmation, reproducible build verified in CI, hash published and displayed, TOFU documented |
| D6 | Version metadata | Standard record header only (D18); `itemId` stays encrypted. `versionId` is a BLAKE2b of `itemId ‖ hlc` keyed by a Master Key subkey, so duplicates collapse and IDs survive key epochs; each device keeps the 20 greatest `(hlc, versionId)` per item |
| D7 | Trash | Purge = physical time of the tombstone's HLC + 30 days; tombstone remains |
| D8 | Wrapped key AAD | Wrapped record keys use the same AAD layout as records (section 5.6) |
| D9 | Argon2id | Calibrated on device, ~1 s, 64 MiB floor |
| D10 | Serialization | Fixed length-prefixed binary for AAD and transcripts; strict deterministic CBOR for records and messages |
| D11 | Master key rotation | Out of v1; compromise = new vault + import |
| D12 | Session establishment | v1 sync is manual: reconnection payload exchanged by QR or copy/paste, then live push while the session is open. Payload is transport-agnostic and encrypted to the peer's static key. After v1: optional relay through a mailbox interface, with Nostr (first) and ntfy adapters, off by default, user-configured, no official instance. No sync while the app is closed |
| D13 | Number of vaults | One vault per installation, permanently; organization through folders and tags. `vaultId` kept to reject cross-vault merge, restore and pairing |
| D14 | Folders | Nested, unlimited depth; separate encrypted Folder record with encrypted `parentId`. An item is in exactly one folder or at the root. Alphabetical order, no folder history, subtree delete to trash tagged with a `trashOperationId` so restore brings back exactly that action's records. Cycles and orphans resolved deterministically at read time. "Folder" is the term in code, docs and UI |
| D15 | Layouts | Dedicated mobile, tablet and desktop layouts chosen by viewport width (< 640, 640–1023, ≥ 1024 px); input adapts via pointer/hover queries; one domain layer with three layout shells; identical security behavior in all layouts |
| D16 | Recovery keyslot | A `crypto_kdf` subkey of the Recovery KEK seeds an X25519 keypair; the public key is stored in the Recovery Envelope; every backup's recovery keyslot is a `crypto_box_seal` of the file key to it, so devices create backups without holding the phrase |
| D17 | Reconnection payload encryption | Noise one-way pattern `Noise_K` with the D1 suite and the devices' static keys; no ad-hoc construction; replay protection comes from the following `Noise_KK` session |
| D18 | Record header and record keys | Every synchronized record has the cleartext header `recordType, recordId, hlc, deleted, keyEpoch`, the source of AAD and sync summaries. Content records use a random record key wrapped by the epoch's Vault Key; the Vault Key and Recovery Envelope are the explicit exceptions |
| D19 | HLC and device ID | HLC = `(physicalMs, counter, deviceId)`, compared lexicographically, so there are no ties; `deviceId = BLAKE2b-128(static public key)` |
| D20 | Templates in v1 | Factory templates are versioned definitions in code; items reference `templateId` and `templateVersion`; no Template record in v1, type reserved for user templates |
