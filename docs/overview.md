# BlindVault — Overview

> Normative reference document for implementation.
> Based on: *BlindVault — Technical Design Specification* (2026-10-04), with amendments D1–D15 (section 18).
> Where this document and the original spec disagree, **this document prevails**.
> The words MUST, MUST NOT, SHOULD and MAY follow RFC 2119.

---

## 1. Vision

BlindVault is a **local-first** encrypted personal vault for any kind of private information. It runs entirely in the browser, can be installed as a PWA, and **has no server that stores user data**.

> The user's vault belongs to the user, not to a service.

Data exists only on the user's devices or in encrypted backup files the user controls. Synchronization is peer-to-peer between explicitly paired devices.

BlindVault is derived from BlindPass: it reuses the cryptographic model and domain packages, and removes the server, database, sessions, API and administration layers.

**v1 success criterion:** a user can create a vault, protect it cryptographically, recover it after losing local storage, pair another device without trusting a server, synchronize safely, and understand exactly what happens if every device except the backup is lost.

---

## 2. Principles

1. **No data server.** Network services are used only for static assets and STUN. None of them receive plaintext vault contents.
2. **Encryption first.** All sensitive content is encrypted before persistence or synchronization. Keys exist in plaintext only in memory, while the vault is unlocked.
3. **Local-first.** Once installed, the app works offline. There is no account, backend, authentication server or sync service.
4. **Synchronization is replication.** Every paired device holds a complete encrypted copy of the vault. A `.bvault` file is an additional recovery mechanism.
5. **Small attack surface.** Few dependencies, small security-sensitive modules, clear cryptographic boundaries, deterministic builds and extensive tests.
6. **Generic model.** Items are made of typed fields. Templates are a UI convenience and do not change the cryptographic model.

---

## 3. Threat model

**Threats considered:** loss or theft of a device, access to a locked device, network interception, malicious peers, MITM during pairing, compromised STUN, corrupted sync data, browser storage eviction, accidental deletion, stale devices reconnecting, and malicious application hosting.

**Out of scope (MUST be documented to users):** a compromised operating system, malware that reads browser memory, malicious extensions, an attacker holding an unlocked device, keyloggers, a malicious browser, and a malicious JavaScript bundle executed before integrity verification, including the first load (TOFU, see D5).

Cryptographic confidentiality and application integrity are separate properties. A malicious bundle can read vault contents after unlock, even with perfect cryptography.

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
| `packages/crypto` | Key generation, Argon2id, AEAD, X25519, recovery KEK, WebAuthn wrapping, RNG, cryptographic serialization (AAD and transcripts) | No UI logic. No dependency on other packages |
| `packages/vault` | Domain model: items, fields, templates, collections, tags, versions, tombstones, key references | No IndexedDB or network access |
| `packages/storage` | IndexedDB schema, encrypted record persistence, transactions, migrations, `navigator.storage` | Accepts only already-encrypted records |
| `packages/backup` | `.bvault` format, keyslots, export, import, validation, format migration | — |
| `packages/sync` | Pairing, Noise handshake, WebRTC, QR encoding, sync protocol, HLC, merge, tombstones | Transport abstracted so tests run without WebRTC |
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
                                                              ├──► Vault Key (per keyEpoch)
                                                              │        │
                                                              │        ▼
                                                              │    Item Key (per item)
                                                              │        │ AEAD
                                                              │        ▼
                                                              │    Encrypted item
                                                              │
Device Identity (X25519, local, encrypted at rest under the Master Key)
```

### 5.3 Keys

**Master Key.** Root of the vault, identical on all devices. Generated by a CSPRNG. MUST NOT be persisted directly, synchronized in plaintext, or stored directly in IndexedDB. Exists in plaintext only in memory while unlocked. Not rotated in v1 (D11).

**Device KEK.** `KEK = Argon2id(password, local salt, local parameters)`. The salt, parameters, wrapped master key, biometric material and preferences are local and MUST NOT be synchronized. Each device may have a different password. Changing the password only re-wraps the master key. Parameters are **calibrated on the device** at vault creation, targeting about 1 s, with a **64 MiB memory floor** (D9). Weak passwords are rejected with zxcvbn, which is not cryptographic protection.

**Vault Key.** Random, protected by the master key, always tagged with a `keyEpoch` to allow future rotation.

**Item Key.** Random and independent per item, wrapped by the vault key with AAD (D8).

### 5.4 Recovery Phrase (D2)

- 256 bits from a CSPRNG, displayed as a 24-word BIP39 phrase. In the UI it is called "Recovery Phrase", never "seed".
- `Recovery KEK = crypto_kdf_derive_from_key(entropy, fixed context)`. No Argon2, since entropy is already high.
- The Recovery KEK wraps the master key. This envelope is a **synchronized record**, so every device and future backup holds the current envelope.
- Shown at creation and, by default, only once, with confirmation that it was written down. MUST NOT be persisted or logged in plaintext.
- **Regeneration:** with the vault unlocked, a new phrase and a new envelope are created. The old one is removed only after the new one is persisted and synchronized. **Documented limitation:** older `.bvault` backups can still be opened with the old phrase.

### 5.5 WebAuthn PRF

Optional and detected at runtime. Derives a local key that wraps the master key. It does not replace the hierarchy. Password unlock always remains available. Without support, the app falls back to the password gracefully.

### 5.6 AAD and nonces

Every encrypted record MUST bind its ciphertext to its logical identity through AAD:

```
AAD = protocolVersion || recordType || vaultId || recordId || keyEpoch
```

This also applies to wrapped item keys (D8) and the recovery envelope. Nonces follow libsodium requirements: random 24-byte nonces for XChaCha20-Poly1305 and `secretstream` for large data. Nonce reuse under the same key MUST NOT occur.

### 5.7 Serialization (D10)

- **AAD, transcripts and prologues:** fixed binary layout, every field length-prefixed in a fixed order. No dependencies, with test vectors.
- **Records and protocol messages:** deterministic CBOR (RFC 8949, §4.2). The decoder is strict and rejects non-canonical encodings.
- Every format is versioned. An incompatible format MUST NOT be silently interpreted as compatible. Downgrade attacks MUST be considered during version negotiation.

---

## 6. Data model

Only the minimum metadata needed for synchronization is in cleartext.

| Record | Cleartext metadata | Encrypted content |
| --- | --- | --- |
| Item | `id`, `hlc`, `deleted`, `keyEpoch` | Template, title, fields, `collectionId` (optional), tags, notes |
| Collection (D14) | `id`, `hlc`, `deleted`, `keyEpoch` | Name, `parentId` (optional) |
| Item Version (D6) | `versionId` (random), `hlc` | `itemId`, `deviceId`, full item snapshot |
| Template | `id`, `hlc`, `deleted` | Name and field definitions |
| Vault Key | `vaultId`, `keyEpoch` | Vault key |
| Recovery Envelope (D2) | `vaultId`, `hlc`, version | Master key wrapped by the Recovery KEK |
| Device | `deviceId`, public identity key, `pairedAt` | Device display name |
| Local Config (not synchronized) | — | Local KEK material, biometric state, preferences |

Collections and tags MUST remain encrypted, including the collection tree structure (`parentId`).

**Collections / folders (D14).** Collections are nested folders with unlimited depth.

- An item belongs to **exactly one** collection or to the vault root (no `collectionId`). It never appears in more than one place. Tags remain flat and are the way to classify items across folders.
- Moving a collection edits its `parentId`; moving an item edits its `collectionId` and creates an item version like any other edit.
- Siblings are sorted alphabetically. There is no manual ordering in v1.
- Deleting a collection sends it, its subcollections and their items to the trash, each with its own tombstone. Restoring from the trash brings the subtree back.
- Collections have no version history. Concurrent edits to the same collection (for example, rename on one device and move on another) are resolved by LWW and one of them is lost; this limitation is documented.
- The tree is **derived at read time** with deterministic rules, so every device shows the same tree without writing anything (see section 9.3).

**Single vault (D13).** Each installation holds exactly one vault, and multiple vaults are not planned. Collections (folders in the UI) and tags are the way to organize items. `vaultId` is still kept in records and AAD, because it prevents mixing records from different vaults during restore, merge or pairing.

**Field types (v1):** text, long text, secret, URL, email, phone, date, number, TOTP, BIP39 seed, wallet fields. Attachments come after v1.

**Factory templates:** Login, Secure Note, Card, Identity, Developer Credential, Crypto Wallet, Document.

---

## 7. Local storage and locking

- IndexedDB stores only already-encrypted records. `localStorage` stores only non-sensitive preferences (theme, language, UI).
- Call `navigator.storage.persist()` at vault creation, show the persistence status, and monitor `navigator.storage.estimate()`.
- If persistence is denied and there is only one device, show a persistent warning recommending a backup and pairing.
- **On lock:** remove plaintext items from state, release keys, clear caches, and block cryptographic operations. Auto-lock is configurable with a conservative default. Memory zeroization in JS is not guaranteed, and this MUST be documented.

---

## 8. Identity and pairing

### 8.1 Identity

Each device has an X25519 key pair, which is the device's **Noise static key**. The private key is local and encrypted at rest. The public key is synchronized in the Device record.

### 8.2 Handshake (D1)

- Suite: `Noise_*_25519_ChaChaPoly_BLAKE2b`, an existing implementation on top of libsodium, validated against the official test vectors.
- **Pairing:** `Noise_XX`. **Synchronization:** `Noise_KK`, since both sides already know each other's static key.
- Prologue = versioned protocol label + hash of the QR payload + DTLS fingerprints of both sides.
- The SAS is derived from the final handshake hash. SAS length and brute-force analysis, including commitment in copy/paste mode, are defined in `pairing-protocol.md`.
- WebRTC DTLS is transport only and MUST NOT be the trust mechanism.

### 8.3 QR (D4)

- Binary payload with version, session ID, DTLS fingerprint (32 bytes), ICE ufrag, ICE pwd, candidates (host and srflx), Noise ephemeral key and capabilities. Encoded in base45 (QR alphanumeric mode).
- The receiver rebuilds the SDP from the payload. ICE gathering completes before the QR is generated, with no trickle.
- Bidirectional exchange: A shows its QR and B scans it, then B shows its response and A scans it. Copy/paste is the fallback for desktops without a camera.
- Animated QR MUST NOT be implemented without evidence that a static QR is insufficient.
- The QR MUST NOT contain vault data.

### 8.4 Flow

```
A's QR → B's QR → WebRTC/DTLS → Noise_XX handshake → SAS on both devices
→ human confirmation → vault key material transferred over the Noise channel
→ B creates local password, derives KEK, wraps master key, generates identity, (WebAuthn) → B trusted
```

A mismatched SAS MUST abort. No key or recovery secret is transferred before confirmation.

The new device MUST have no vault (D13). If it already holds one, pairing requires the user to explicitly erase it first, after a warning recommending a backup.

---

## 9. Synchronization

### 9.1 Session establishment (D12)

A browser cannot discover peers or accept inbound connections, so every WebRTC session needs a fresh exchange of connection data (SDP and ICE candidates) through some out-of-band channel. In v1 there is no automatic background sync between devices.

- **v1: manual sync.** The user starts a sync on two devices and exchanges a **reconnection payload** by QR (or copy/paste), in both directions. It is smaller than the pairing payload because identities are already known: no SAS and no enrollment, authentication comes from `Noise_KK` (CRYPTO-INV-008).
- **Live session.** While a DataChannel is open, changes made on either device are pushed immediately, until either side closes the session or locks the vault.
- **Transport-agnostic payload.** The reconnection payload is defined independently of how it is delivered (QR, copy/paste, or a future relay), and is encrypted to the peer's static key, so a relay added later needs no protocol change.
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

- **Conflicts:** last-write-wins per item, ordered by HLC. The losing version MUST go to history and never be discarded.
- **HLC:** physical time + logical counter, monotonic per device, canonical serialization, and a future-clock bound (timestamps beyond the bound are rejected or normalized).
- **Tombstones:** synchronized and kept indefinitely in v1. A tombstone beats an older edit. A newer edit may restore the item.
- **History:** the latest 20 versions per item, encrypted. Pruning is done locally while unlocked (D6).
- **Trash (D7):** purge date = physical time of the tombstone's HLC + 30 days, computed independently by each device. Only content and history are deleted; the tombstone remains.
- **Network:** default STUN providers are Google and Cloudflare, configurable. A LAN-only mode without STUN MUST exist. No TURN in v1; fallbacks are same-network sync and `.bvault`. STUN sees the public IP and provides no anonymity.

### 9.3 Collection tree rules (D14)

Each collection record converges independently through LWW, which can produce inconsistent trees. The tree is built at read time with these deterministic rules:

- **Cycles.** Concurrent moves (A into B on one device, B into A on another) can create a cycle. The collection in the cycle with the greatest `(hlc, id)` is displayed at the root.
- **Orphans.** An item or collection whose parent is a tombstone or does not exist is displayed at the root.
- **Missing parent on arrival.** A collection or item received before its parent is held at the root until the parent arrives.

These rules never write records; once all devices have the same records, they show the same tree.

---

## 10. `.bvault` backup (D3)

```
[magic][format version][parameters]
[keyslot: recovery phrase]                ← mandatory
[keyslot: export password, Argon2id]      ← optional
[payload: secretstream(file key)]
    ├── encrypted records (as stored in IndexedDB)
    ├── master key recovery envelope
    └── master key wrapped by the file key (for the password slot)
```

- A random file key encrypts the payload. Each keyslot wraps the file key.
- The recovery phrase **always** opens the backup. The export password is an extra path.
- The outer layer hides IDs, HLCs and the number of records.
- Automatic upload MUST NOT exist. The format is versioned and documented in `backup-format.md`.
- Restore creates a new vault or merges into an existing one, using the same rules as sync. Merge MUST be rejected if the backup's `vaultId` differs from the local vault's (D13); restoring a different vault requires explicitly replacing the local one.

---

## 11. Application integrity (D5)

- The service worker serves cache-first with a versioned cache. A new version is activated **only after explicit user confirmation**, showing the version and hash. Code is never upgraded silently.
- Reproducible build with pinned lockfile and Node version and `SOURCE_DATE_EPOCH`. CI rebuilds and compares the hash.
- The asset manifest hash is published on GitHub Releases and displayed in the app.
- Static self-hosting MUST work.
- The first load relies on trust on first use, and this is recorded in the threat model.

---

## 12. User interface and layouts (D15)

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
- The UI requirements in `spec.md` section 56 (lock state, masking, backup and sync status, persistence warnings) apply to all three layouts.

---

## 13. Recovery

| Situation | Recovery |
| --- | --- |
| Local password forgotten | Recovery phrase or re-pair from another device |
| Device lost | Pair a new device or restore `.bvault` |
| All devices lost | `.bvault` + recovery phrase |
| Browser storage erased | `.bvault` or another paired device |
| Master key compromised (D11) | Create a new vault and import the content |

There is no administrator recovery. Losing all data and all recovery mechanisms means permanent loss, and this MUST be communicated to users.

---

## 14. Stack and repository

**Stack:** TypeScript, React, Vite, Tailwind, `libsodium-wrappers-sumo`, `@scure/bip39`, `zxcvbn` (or equivalent), a Noise implementation on top of libsodium, a CBOR library with a deterministic mode, Vitest and Playwright.

**Dependency policy:** every new dependency needs a justification. Cryptographic dependencies must be actively maintained and have a good security history. Updates are reviewed for cryptographic or serialization changes.

```
apps/web/
packages/{crypto,vault,storage,sync,backup}/
docs/
    architecture.md  crypto-spec.md  threat-model.md
    pairing-protocol.md  sync-protocol.md
    security-invariants.md  backup-format.md
tests/{crypto,pairing,sync,recovery,integration}/
```

**Browser matrix:** Chromium desktop, Firefox desktop, Safari macOS, Safari iOS and Chromium Android. Track IndexedDB, persistent storage, DataChannel, WebAuthn, WebAuthn PRF, PWA installation, camera and QR scanning. Missing capabilities degrade gracefully.

---

## 15. Security invariants

| ID | Invariant |
| --- | --- |
| CRYPTO-INV-001 | Plaintext vault contents MUST NOT be persisted |
| CRYPTO-INV-002 | The master key MUST NOT be synchronized in plaintext |
| CRYPTO-INV-003 | The master key MUST NOT be stored directly in IndexedDB |
| CRYPTO-INV-004 | Every encrypted record authenticates its identity and `keyEpoch` via AAD |
| CRYPTO-INV-005 | Keys MUST NOT appear in logs |
| CRYPTO-INV-006 | Recovery material MUST NOT be logged or persisted in plaintext |
| CRYPTO-INV-007 | No device becomes trusted without explicit SAS confirmation |
| CRYPTO-INV-008 | Before syncing, a peer proves possession of its registered identity (Noise_KK) |
| CRYPTO-INV-009 | Every sync message is authenticated and bound to the active session |
| CRYPTO-INV-010 | Secrets are removed from application-accessible memory on lock, as far as JS permits |

Every invariant MUST have at least one associated negative test.

---

## 16. Rules for AI agents

This document is **normative**.

**Agents MUST NOT:** invent cryptographic primitives; replace a specified primitive or protocol without explicit approval; weaken authentication for convenience; persist plaintext secrets for debugging; add telemetry containing vault data; add a backend to simplify sync; silently change the key hierarchy or the backup format; remove security checks to make tests pass.

**Agents SHOULD:** read package boundaries before changing a package; preserve the invariants; add tests for all security-sensitive behavior; explain any security-model change **before** implementing it.

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

## 17. Out of scope for v1

- **Device revocation.** Revocation cannot erase data already replicated. Rotating the vault key only protects future data. `keyEpoch` is already reserved.
- **Master key rotation** (D11).
- **Attachments** (up to 10 MB, chunked `secretstream`). They must not complicate the basic sync protocol.
- **Sharing between people.** Requires a different trust model and MUST NOT reuse device pairing.
- **Browser extension and autofill**, which are a separate security boundary.
- **Cloud storage plugins** (Drive, Dropbox), which would only receive `.bvault`-format data.
- **TURN.**
- **Signaling relay for automatic sync** (D12): mailbox interface with Nostr and ntfy adapters, off by default, no official instance. Must never receive vault data.
- **User-created templates.**
- **Multiple vaults:** not planned at all (D13).

---

## 18. Decision log

| # | Topic | Decision |
| --- | --- | --- |
| D1 | Device authentication | Noise `25519_ChaChaPoly_BLAKE2b`: XX for pairing, KK for sync. Prologue binds the QR and DTLS fingerprints; SAS derived from the handshake hash |
| D2 | Recovery Phrase | Recovery KEK via `crypto_kdf` wraps the master key; envelope is synchronized; older backups remain openable with the old phrase |
| D3 | `.bvault` | File key + secretstream; keyslots: recovery (mandatory) and Argon2id password (optional) |
| D4 | QR and SDP | Minimal binary payload in base45, SDP rebuilt by the receiver, no ICE trickle, bidirectional exchange, copy/paste fallback, SAS always required |
| D5 | PWA integrity | Updates only with user confirmation, reproducible build verified in CI, hash published and displayed, TOFU documented |
| D6 | Version metadata | Only `versionId` and `hlc` in cleartext |
| D7 | Trash | Purge = physical time of the tombstone's HLC + 30 days; tombstone remains |
| D8 | Item key AAD | `vaultId`, `recordId`, `keyEpoch`, record type |
| D9 | Argon2id | Calibrated on device, ~1 s, 64 MiB floor |
| D10 | Serialization | Fixed length-prefixed binary for AAD and transcripts; strict deterministic CBOR for records and messages |
| D11 | Master key rotation | Out of v1; compromise = new vault + import |
| D12 | Session establishment | v1 sync is manual: reconnection payload exchanged by QR or copy/paste, then live push while the session is open. Payload is transport-agnostic and encrypted to the peer's static key. After v1: optional relay through a mailbox interface, with Nostr (first) and ntfy adapters, off by default, user-configured, no official instance. No sync while the app is closed |
| D13 | Number of vaults | One vault per installation, permanently; organization through collections (folders) and tags. `vaultId` kept to reject cross-vault merge, restore and pairing |
| D14 | Collections / folders | Nested, unlimited depth; separate encrypted Collection record with encrypted `parentId`. An item is in exactly one collection or at the root. Alphabetical order, no collection history, subtree delete to trash. Cycles and orphans resolved deterministically at read time |
| D15 | Layouts | Dedicated mobile, tablet and desktop layouts chosen by viewport width (< 640, 640–1023, ≥ 1024 px); input adapts via pointer/hover queries; one domain layer with three layout shells; identical security behavior in all layouts |
