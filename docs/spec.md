# BlindVault — Technical Design Specification & Engineering Handoff

> **Note:** This is the original specification, kept for reference. `docs/overview.md` is the normative document and prevails over this one wherever they differ, including the amendments recorded as decisions in its decision log.

- **Status:** Proposed
- **Date:** October 4, 2026
- **Author:** Allisson Azevedo
- **License:** MIT

---

## 1. Vision

BlindVault is a local-first encrypted personal vault for arbitrary private information.

It runs entirely in the browser, can be installed as a Progressive Web App (PWA), and has no server responsible for storing user data.

BlindVault is derived from BlindPass. It reuses the existing cryptographic model and domain packages where appropriate, while removing the server, database, sessions, API, and administration layers.

The primary design goal is:

> The user's vault belongs to the user, not to a service.

Data exists only on the user's devices or in user-controlled encrypted backup files.

Synchronization is peer-to-peer between explicitly paired devices.

---

## 2. Design Principles

### 2.1 No Data Server

BlindVault MUST NOT require a server to store vault data.

The official application MAY be hosted on a static hosting provider such as GitHub Pages.

Self-hosting MUST be supported by design.

Network services MAY be used for:

- serving static application assets;
- WebRTC connectivity assistance through STUN.

Network services MUST NOT receive plaintext vault contents.

STUN providers MUST NOT be treated as trusted data services.

### 2.2 Encryption First

All sensitive vault contents MUST be encrypted before persistence or synchronization.

Plaintext vault contents MUST NOT be persisted to disk.

Cryptographic keys MUST exist only in volatile memory while the vault is unlocked, except for explicitly encrypted local key-wrapping material.

### 2.3 Local-First

The application MUST remain fully functional without network connectivity after installation and initialization.

Core operations MUST NOT depend on:

- an account;
- a backend;
- an authentication server;
- a cloud database;
- a synchronization service.

### 2.4 Synchronization Is Replication

Synchronization is replication, not a hosted backup service.

Every paired device contains a complete encrypted copy of the vault.

An exported `.bvault` file provides an additional recovery mechanism.

### 2.5 Small Attack Surface

BlindVault SHOULD have:

- few dependencies;
- small security-sensitive modules;
- clear cryptographic boundaries;
- deterministic builds;
- extensive automated testing;
- no unnecessary network functionality.

### 2.6 Generic Vault Model

BlindVault is not fundamentally a password manager.

It stores generic items composed of typed fields.

Examples include:

- login credentials;
- secure notes;
- cards;
- identities;
- developer credentials;
- cryptocurrency wallets;
- documents.

Templates are a UI/data-model convenience and MUST NOT alter the underlying cryptographic model.

---

## 3. Security Model

### 3.1 Protected Assets

BlindVault protects:

- vault contents;
- secrets;
- passwords;
- credentials;
- recovery material;
- cryptographic keys;
- encrypted backups;
- synchronized records.

### 3.2 Assumed Threats

The system MUST consider:

- loss or theft of a device;
- unauthorized access to a locked device;
- network interception;
- malicious peers;
- MITM during device pairing;
- compromised STUN infrastructure;
- corrupted synchronization data;
- browser storage eviction;
- accidental deletion;
- stale devices reconnecting after a long period;
- malicious or compromised application hosting.

### 3.3 Explicitly Out of Scope

BlindVault does not protect against:

- a fully compromised operating system;
- malware capable of reading browser process memory;
- malicious browser extensions with access to the application;
- an attacker controlling an unlocked device;
- keyloggers;
- a malicious browser implementation;
- a malicious JavaScript bundle that executes before the user verifies application integrity.

These limitations MUST be documented to users.

---

## 4. Application Integrity

Cryptographic confidentiality and application integrity are separate security properties.

A malicious JavaScript bundle can potentially access plaintext after the vault is unlocked even if the underlying cryptography is perfect.

Therefore:

> Protecting the vault cryptographically does not protect against a compromised application runtime.

### 4.1 Build Integrity

Official releases SHOULD use:

- reproducible builds;
- published SHA-256 hashes;
- version identifiers;
- signed release artifacts where practical.

The application SHOULD expose its running version and build hash.

### 4.2 Self-Hosting

BlindVault MUST support static self-hosting.

A user who does not trust the official hosting infrastructure SHOULD be able to build and host BlindVault independently.

### 4.3 Service Worker

The service worker MAY pin application resources to a specific release.

The service worker MUST NOT silently upgrade security-sensitive code without a version transition.

---

## 5. Cryptographic Architecture

### 5.1 Cryptographic Libraries

The implementation MUST use well-established cryptographic primitives.

The primary cryptographic implementation is libsodium.

The intended primitives are:

- Argon2id;
- XChaCha20-Poly1305 AEAD;
- X25519;
- secretstream for large encrypted data;
- secure random number generation.

Custom cryptographic primitives MUST NOT be implemented.

---

## 6. Key Hierarchy

The conceptual hierarchy is:

```
Local Password
    |
    | Argon2id
    v
Device KEK
    |
    | decrypt
    v
Master Key
    |
    +----------------------+
    |                      |
    v                      v
Recovery Wrapping       Device Identity
                           |
                           v
                       X25519 Key Pair

Master Key
    |
    | decrypt
    v
Vault Key
    |
    | decrypt
    v
Item Key
    |
    | AEAD
    v
Encrypted Item
```

### 6.1 Master Key

The master key is the root secret for the vault.

All devices belonging to the same vault use the same master key.

The master key:

- MUST be generated using a CSPRNG;
- MUST NOT be persisted directly;
- MUST NOT be synchronized in plaintext;
- MUST exist in plaintext only in volatile memory while unlocked.

### 6.2 Device KEK

Each device has its own local key-encryption key (KEK).

The KEK is derived from the user's local password:

```
KEK = Argon2id(
    password,
    device-local salt,
    device-local parameters
)
```

The following MUST remain local to the device:

- KEK salt;
- Argon2id parameters;
- encrypted master key;
- biometric wrapping material;
- local preferences.

These values MUST NOT be synchronized.

### 6.3 Local Password

Each device MAY have a different local password.

Changing the password on one device MUST NOT require synchronization.

Changing the password MUST only re-wrap the master key under a new local KEK.

The application SHOULD reject weak passwords using zxcvbn or equivalent password-strength analysis.

Password-strength checks MUST NOT be treated as cryptographic protection by themselves.

---

## 7. Vault Key

The vault key protects vault-level encrypted data.

Each vault key MUST have a `keyEpoch`.

The epoch exists to support future key rotation without requiring a redesign of the record format.

A vault key SHOULD be randomly generated rather than deterministically derived from user credentials.

---

## 8. Item Keys

Each encrypted item SHOULD have an independent randomly generated item key.

The item key protects the encrypted representation of the item.

The item key is protected by the vault key or an equivalent vault-level wrapping mechanism.

This provides:

- item isolation;
- simpler future rotation;
- independent encryption contexts;
- safer handling of deleted or migrated records.

---

## 9. AEAD Associated Data

Every encrypted record MUST bind its cryptographic ciphertext to its logical identity.

Associated authenticated data SHOULD include, as applicable:

- record type
- record ID
- vault ID
- key epoch
- schema/version

This prevents ciphertext from one record being substituted for ciphertext belonging to another record.

Example conceptual construction:

```
AAD =
    protocolVersion
    || recordType
    || recordId
    || keyEpoch
```

The exact binary encoding MUST be canonical and unambiguous.

---

## 10. Nonces

All AEAD nonces MUST be generated according to the requirements of the selected cryptographic library.

Nonce reuse MUST NOT occur for the same key.

Random nonces SHOULD be used where appropriate.

For large streaming data, libsodium `secretstream` SHOULD be used.

---

## 11. Recovery Phrase

The recovery mechanism uses a 256-bit CSPRNG-generated secret represented as a BIP39-compatible 24-word phrase.

The user-facing terminology SHOULD be:

> Recovery Phrase

rather than "Bitcoin seed".

The recovery phrase is not intended to represent a cryptocurrency wallet.

It is a human-readable representation of vault recovery entropy.

### 11.1 Recovery Properties

The recovery phrase:

- MUST be shown during vault creation;
- SHOULD be shown only once by default;
- MUST NOT be persisted in plaintext;
- MUST be sufficient to recover the vault when combined with the encrypted backup;
- MAY be used to establish a new local wrapping key.

The application SHOULD require explicit confirmation that the recovery phrase was backed up.

### 11.2 Recovery Phrase Regeneration

A user with an unlocked vault MAY generate a new recovery mechanism.

Changing the recovery phrase MUST NOT require changing the vault contents.

The old recovery mechanism MUST be invalidated only after the new one has been successfully established.

---

## 12. WebAuthn PRF

Biometric/unlock support is optional.

When supported, WebAuthn PRF MAY derive a device-local secret used to wrap the master key.

Conceptually:

```
WebAuthn credential
        |
        v
      PRF
        |
        v
Biometric-derived wrapping key
        |
        v
Encrypted master key
```

The WebAuthn PRF MUST NOT replace the underlying vault cryptographic hierarchy.

Password-based unlock MUST remain available unless the user explicitly chooses another recovery model.

WebAuthn availability MUST be detected at runtime.

Unsupported browsers/authenticators MUST gracefully fall back to password unlock.

---

## 13. Cryptographic Invariants

The following are mandatory security invariants.

- **CRYPTO-INV-001:** Plaintext vault contents MUST NOT be persisted.
- **CRYPTO-INV-002:** The master key MUST NOT be synchronized in plaintext.
- **CRYPTO-INV-003:** The master key MUST NOT be stored directly in IndexedDB.
- **CRYPTO-INV-004:** Every encrypted record MUST authenticate its identity and key epoch through AEAD associated data.
- **CRYPTO-INV-005:** Cryptographic keys MUST NOT be logged.
- **CRYPTO-INV-006:** Recovery material MUST NOT be logged or persisted in plaintext.
- **CRYPTO-INV-007:** A device MUST NOT become trusted without explicit pairing confirmation.
- **CRYPTO-INV-008:** A peer MUST prove possession of the cryptographic identity associated with an already-paired device before synchronization.
- **CRYPTO-INV-009:** A synchronization message MUST be authenticated and bound to the active synchronization session.
- **CRYPTO-INV-010:** Cryptographic secrets MUST be removed from application-accessible memory when the vault is locked as far as the JavaScript runtime permits.

---

## 14. Data Model

All synchronized records are encrypted except for the minimum metadata required to perform synchronization.

| Record | Cleartext Metadata | Encrypted Content |
| --- | --- | --- |
| Item | `id`, `hlc`, `deleted`, `keyEpoch` | Template, title, fields, collections, tags, notes |
| Item Version | `itemId`, `hlc`, `deviceId` | Complete item snapshot |
| Template | `id`, `hlc`, `deleted` | Name and typed field definitions |
| Vault Key | `vaultId`, `keyEpoch` | Vault key |
| Device | `deviceId`, public identity key, `pairedAt` | Device display name |
| Local Config | None | Local KEK material, biometric state, preferences |

Collections and tags MUST remain encrypted.

This prevents the structure of the user's vault from being exposed through synchronization metadata.

---

## 15. Field Types

The following field types are supported in v1:

- text;
- long text;
- secret;
- URL;
- email;
- phone;
- date;
- number;
- TOTP;
- BIP39 seed;
- wallet-related fields.

Attachments are deferred to a later phase.

---

## 16. Templates

Factory templates include:

- Login;
- Secure Note;
- Card;
- Identity;
- Developer Credential;
- Crypto Wallet;
- Document.

Templates are data definitions rather than separate security models.

User-created templates are a future feature.

---

## 17. Local Storage

BlindVault uses IndexedDB.

All sensitive records stored in IndexedDB MUST already be encrypted.

`localStorage` MUST contain only non-sensitive preferences such as:

- theme;
- language;
- UI settings.

### 17.1 Storage Persistence

The application SHOULD call:

```
navigator.storage.persist()
```

during vault creation.

The application SHOULD display the persistence status.

The application SHOULD monitor storage usage using:

```
navigator.storage.estimate()
```

This becomes especially important when attachments are introduced.

### 17.2 Storage Loss

Browser storage eviction is a data-availability risk.

The application MUST NOT imply that browser storage is permanent.

If persistence is denied and the user has only one device, the application SHOULD display a persistent warning encouraging:

- backup;
- pairing another device.

---

## 18. Locking and Memory

When the vault is locked:

- plaintext items MUST be removed from active application state;
- cryptographic keys SHOULD be released;
- sensitive caches MUST be cleared;
- cryptographic operations MUST no longer be possible without unlocking.

Auto-lock MUST be configurable.

The default auto-lock interval SHOULD be conservative.

JavaScript cannot guarantee complete memory zeroization in all environments. This limitation MUST be documented.

---

## 19. Device Identity

Each device has an X25519 identity key pair.

The private key:

- MUST remain local;
- MUST be encrypted at rest;
- MUST NOT be included in synchronized cleartext metadata.

The public key MAY be synchronized as device identity metadata.

Device identity MUST be authenticated during synchronization.

---

## 20. Pairing Protocol

Pairing is one of the most security-sensitive protocols in BlindVault.

The implementation MUST treat pairing as a formally specified protocol rather than an informal WebRTC exchange.

The conceptual flow is:

```
Device A
    |
    | QR / pairing invitation
    v
Device B
    |
    | QR / pairing response
    v
WebRTC connection
    |
    v
DTLS
    |
    v
Session transcript
    |
    v
Short Authentication String (SAS)
    |
    v
Human confirmation
    |
    v
Device authentication
    |
    v
Encrypted vault transfer
    |
    v
Device enrollment
```

---

## 21. Pairing QR

The pairing QR contains only the information required to establish the session.

The payload MAY include:

- protocol version;
- pairing session identifier;
- WebRTC SDP information;
- ICE username fragment;
- ICE password;
- required candidates;
- cryptographic ephemeral material;
- protocol capability information.

Sensitive vault data MUST NOT be included.

---

## 22. Pairing Authentication

WebRTC/DTLS encryption alone is not sufficient to establish user-level device trust.

The two devices MUST derive an authentication value from the complete handshake transcript.

The transcript MUST include all security-relevant negotiation values.

The resulting Short Authentication String (SAS):

- MUST be cryptographically derived;
- MUST bind both peers;
- MUST bind the session;
- MUST prevent replay across sessions;
- MUST be displayed on both devices;
- MUST be explicitly confirmed by the user.

The exact transcript encoding MUST be canonical and versioned.

---

## 23. Pairing MITM Protection

A pairing session MUST NOT automatically trust a new device merely because a WebRTC connection succeeded.

The user MUST confirm that the SAS displayed by both devices matches.

If the values do not match:

> The pairing MUST be aborted.

No vault key or recovery secret may be transferred before successful authentication.

---

## 24. Secure Vault Transfer

After successful pairing authentication, the existing device MAY transfer the encrypted vault key material required to initialize the new device.

The transfer MUST occur inside the authenticated secure channel.

The protocol MUST NOT rely solely on DTLS as the application-level trust mechanism.

The new device then:

1. generates its own local password;
2. derives its own KEK;
3. stores the master key only as encrypted local material;
4. generates its own device identity;
5. optionally configures WebAuthn;
6. becomes a trusted device.

---

## 25. Synchronization Protocol

Already-paired devices use their previously registered device identities.

The synchronization flow is:

```
connect
  ↓
authenticate device identities
  ↓
establish authenticated session
  ↓
exchange record summaries
  ↓
identify missing/different records
  ↓
transfer encrypted records
  ↓
merge
  ↓
persist
  ↓
acknowledge
```

---

## 26. Sync Authentication

A device MUST prove possession of the private identity key corresponding to its registered public key.

The authentication MUST be bound to the current session.

Replay of an old authentication exchange MUST NOT authenticate a device.

---

## 27. Record Synchronization

Each side initially exchanges a summary containing the minimum information required to identify divergent records.

Example:

```
recordId
hlc
deleted
keyEpoch
recordType
```

Only records that differ SHOULD be transferred.

All transferred record contents remain encrypted.

---

## 28. Conflict Resolution

BlindVault v1 uses last-write-wins per item.

Hybrid Logical Clocks (HLC) determine ordering.

For concurrent changes:

```
Device A ── edit X
Device B ── edit Y

             ↓

           HLC

             ↓

        winning version
             +
        losing version
             ↓
          history
```

The losing version MUST NOT be silently discarded.

---

## 29. HLC Requirements

The HLC implementation MUST:

- combine physical time and logical counters;
- remain monotonic for a given device;
- serialize timestamps canonically;
- handle clock skew;
- prevent malformed timestamps from causing unbounded future dominance.

The implementation SHOULD reject or normalize timestamps that exceed a reasonable future-clock bound.

---

## 30. Tombstones

Deleted items become tombstones.

A tombstone contains approximately:

```
id
hlc
deleted = true
```

Tombstones MUST remain synchronized.

A tombstone MUST win over an older edit.

A newer edit MAY restore an item.

Tombstones MUST NOT be removed merely because the local device has not seen the item recently.

---

## 31. Tombstone Compaction

In v1, tombstones are retained indefinitely.

This prevents an offline device from later resurrecting deleted content.

A future version MAY compact tombstones once the system can prove that all known devices have observed them.

Device membership and acknowledgment state MUST be sufficient to safely perform such compaction.

---

## 32. Version History

BlindVault stores the latest 20 versions of each item.

The losing side of a synchronization conflict MUST be preserved in history whenever possible.

History is encrypted like the rest of the item.

---

## 33. Trash

Deleted items enter the trash.

The item contents and historical versions SHOULD be permanently purged after 30 days.

The deletion tombstone remains.

The purge policy MUST NOT delete the tombstone prematurely.

---

## 34. WebRTC Connectivity

BlindVault uses WebRTC DataChannels.

STUN is used only to assist peer discovery.

The default STUN providers are:

- Google;
- Cloudflare.

The provider list SHOULD be configurable.

STUN infrastructure MUST NOT receive vault contents.

---

## 35. Network Privacy

A STUN provider can observe the public IP address of a device participating in synchronization.

It MUST NOT be assumed to provide anonymity.

A local-network-only mode MUST be supported.

In local-network-only mode, STUN is not required.

---

## 36. NAT Limitations

Symmetric NAT, especially on some cellular networks, may prevent direct peer-to-peer connectivity.

BlindVault v1 MUST NOT require TURN infrastructure.

Fallback mechanisms are:

1. same-network synchronization;
2. `.bvault` export/import.

A future TURN-based mode MAY be considered if it can preserve the project's privacy model.

---

## 37. QR Size

The initial design targets a single static QR containing the minimum WebRTC negotiation payload.

Expected payload size is approximately 200–300 bytes.

QR animation MUST NOT be implemented unless real-world interoperability testing demonstrates that a static QR is insufficient.

Desktop devices without cameras MAY use text copy/paste.

---

## 38. Backup Format

BlindVault uses a dedicated `.bvault` file format.

The format MUST have:

- magic/header;
- format version;
- cryptographic parameters;
- key derivation parameters;
- encrypted vault data;
- integrity protection;
- migration/versioning information.

The `.bvault` format SHOULD be formally versioned and documented.

---

## 39. Backup Encryption

A backup MAY be protected using:

1. the recovery phrase; or
2. a dedicated export password selected during export.

The backup MUST remain encrypted even when copied to an untrusted storage location.

The application MUST NOT upload `.bvault` files automatically.

---

## 40. Restore

Restore MUST support:

- creating a new vault from backup;
- restoring after device loss;
- restoring after browser storage loss;
- merging with an existing vault when explicitly requested.

Merge MUST use the same conflict-resolution rules as device synchronization.

---

## 41. Recovery Scenarios

| Situation | Recovery |
| --- | --- |
| Local password forgotten | Recovery phrase or re-pair from another trusted device |
| Device lost | Pair a new device or restore `.bvault` |
| All devices lost | `.bvault` + recovery phrase |
| Browser storage erased | `.bvault` or another paired device |
| Recovery mechanism replaced | Generate a new one while unlocked |

Users MUST be warned that losing both the vault data and all recovery mechanisms can result in permanent data loss.

There MUST NOT be a hidden administrator recovery mechanism.

---

## 42. BlindPass Import

BlindVault SHOULD support migration from BlindPass.

The importer MUST:

1. decrypt the BlindPass representation;
2. validate the source data;
3. transform it into BlindVault's domain model;
4. encrypt the resulting records using BlindVault's cryptographic format;
5. never persist plaintext migration data after import.

The BlindPass cryptographic implementation SHOULD be reused where possible.

---

## 43. Security Threat Matrix

| Threat | Status | Mitigation |
| --- | --- | --- |
| Server database compromise | Eliminated | No data server |
| Network interception | Protected | WebRTC/DTLS + application authentication + encrypted records |
| MITM during pairing | Protected | Transcript-derived SAS + user confirmation |
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

## 44. Device Revocation

Device revocation is intentionally outside v1.

The fundamental limitation is:

> Revocation cannot erase data that a device has already received.

Once a device has a complete vault copy, rotating the vault key only protects data encrypted after the rotation.

Future revocation MAY:

1. establish a new key epoch;
2. generate new vault keys;
3. re-encrypt future records;
4. exclude the revoked device from future synchronization.

Historical data already available to the revoked device remains compromised.

This limitation MUST be explicit in the product documentation.

---

## 45. Application Architecture

The project SHOULD retain the BlindPass monorepo structure where practical.

Expected packages:

```
packages/
    crypto/
    vault/
    sync/
    storage/
    backup/
```

### 45.1 `packages/crypto`

Responsibilities:

- key generation;
- Argon2id;
- AEAD;
- X25519;
- recovery material;
- WebAuthn wrapping primitives;
- secure random generation;
- cryptographic serialization.

This package MUST contain no UI logic.

### 45.2 `packages/vault`

Responsibilities:

- vault domain model;
- item model;
- templates;
- collections;
- tags;
- versions;
- tombstones;
- key references.

### 45.3 `packages/storage`

Responsibilities:

- IndexedDB schema;
- encrypted record persistence;
- transactions;
- migrations;
- storage estimation;
- persistence requests.

### 45.4 `packages/sync`

Responsibilities:

- pairing protocol;
- device authentication;
- WebRTC;
- synchronization protocol;
- HLC;
- merge;
- conflict resolution;
- tombstones.

### 45.5 `packages/backup`

Responsibilities:

- `.bvault` serialization;
- backup encryption;
- export;
- import;
- validation;
- migration.

---

## 46. Technology Stack

The intended stack is:

- TypeScript;
- React;
- Vite;
- Tailwind;
- libsodium-wrappers-sumo;
- `@scure/bip39`;
- Vitest;
- Playwright.

Existing BlindPass cryptographic and domain packages SHOULD be reused when appropriate.

The following BlindPass components are removed:

- server application;
- API schema;
- PostgreSQL;
- Redis;
- Docker;
- Terraform.

---

## 47. Dependency Policy

Security-sensitive dependencies SHOULD be minimized.

New dependencies MUST have a clear justification.

Cryptographic dependencies MUST:

- be actively maintained;
- have a stable security history;
- avoid custom cryptographic implementations.

Dependency updates SHOULD be reviewed for cryptographic or serialization changes.

---

## 48. Serialization

All protocol and cryptographic serialization formats MUST be:

- canonical;
- versioned;
- unambiguous;
- deterministic where ordering matters.

Binary and textual representations MUST NOT have multiple equivalent encodings that could result in different cryptographic transcripts.

---

## 49. Protocol Versioning

The following MUST be versioned:

- encrypted record format;
- `.bvault`;
- pairing protocol;
- synchronization protocol;
- cryptographic envelopes.

A future implementation MUST NOT silently interpret an incompatible older format as compatible.

Downgrade attacks MUST be considered when protocol versions are negotiated.

---

## 50. Testing Strategy

Security correctness MUST be tested independently of UI correctness.

Testing layers:

```
Unit tests
    ↓
Property tests
    ↓
Protocol tests
    ↓
Integration tests
    ↓
Browser tests
    ↓
Multi-device tests
    ↓
Security gates
```

---

## 51. Cryptographic Tests

Tests MUST cover:

- key generation;
- Argon2id parameter handling;
- encryption/decryption;
- invalid ciphertext;
- invalid authentication tags;
- AAD mismatch;
- key epoch mismatch;
- nonce handling;
- recovery;
- key wrapping;
- migration;
- corrupted backup files.

---

## 52. Pairing Tests

Tests MUST cover:

- successful pairing;
- rejected SAS mismatch;
- replayed pairing;
- modified QR payload;
- modified SDP;
- wrong device identity;
- aborted pairing;
- duplicate pairing;
- interrupted transfer;
- reconnect;
- session expiration.

---

## 53. Synchronization Tests

Tests MUST cover:

- identical vaults;
- one-way changes;
- bidirectional changes;
- concurrent edits;
- delete vs edit;
- edit vs delete;
- restore;
- stale devices;
- tombstones;
- history;
- duplicate records;
- duplicate messages;
- out-of-order messages;
- corrupted records.

---

## 54. Recovery Tests

At minimum:

```
Create vault
    ↓
Backup
    ↓
Destroy local storage
    ↓
Restore
    ↓
Verify all records
```

Additional tests:

```
Device A
   ↓
Pair Device B
   ↓
Destroy A
   ↓
Continue with B
```

and:

```
Destroy A
Destroy B
   ↓
Restore from .bvault
   ↓
Recovery phrase
   ↓
Verify vault
```

---

## 55. Browser Compatibility

The project MUST maintain a tested browser matrix.

At minimum, test:

- Chromium desktop;
- Firefox desktop;
- Safari/macOS;
- Safari/iOS;
- Chromium Android.

The test matrix MUST explicitly track support for:

- IndexedDB;
- persistent storage;
- WebRTC DataChannel;
- WebAuthn;
- WebAuthn PRF;
- PWA installation;
- camera access;
- QR scanning.

Unsupported capabilities MUST degrade gracefully.

---

## 56. UI Security Requirements

The UI MUST:

- clearly indicate locked/unlocked state;
- avoid displaying secrets unnecessarily;
- mask secret fields by default;
- require explicit action to reveal secrets;
- provide clear backup/recovery warnings;
- clearly show synchronization state;
- show the last successful backup;
- show the last successful synchronization;
- warn about storage persistence problems.

---

## 57. Onboarding

The onboarding flow SHOULD be:

```
Create Vault
    ↓
Generate Recovery Phrase
    ↓
Confirm Recovery Phrase
    ↓
Create Local Password
    ↓
Optional WebAuthn Setup
    ↓
Vault Ready
    ↓
Recommend Backup
    ↓
Recommend Pairing Another Device
```

The onboarding MUST explain that:

> BlindVault has no server that can reset the user's vault.

The recovery phrase is therefore critical.

---

## 58. Backup Reminders

The application SHOULD record:

- last backup date;
- last synchronization date.

The application SHOULD warn when the configured backup interval expires.

The default recommendation is 30 days.

---

## 59. UX Philosophy

BlindVault should favor:

- explicit security decisions;
- understandable warnings;
- safe defaults;
- minimal configuration;
- clear recovery flows.

Security-critical operations MUST NOT be hidden behind ambiguous UI.

---

## 60. Roadmap

### Phase 1 — Cryptography and Local Vault

Implement:

- crypto package reuse;
- master key;
- local KEK;
- vault key;
- item keys;
- encrypted records;
- IndexedDB;
- lock/unlock;
- basic templates.

**Gate A** — must pass:

- cryptographic invariants;
- encryption/decryption tests;
- persistence tests;
- lock/unlock tests;
- corrupted ciphertext tests.

### Phase 2 — Backup and Recovery

Implement:

- `.bvault`;
- export;
- import;
- recovery phrase;
- restore;
- BlindPass migration.

**Gate B** — must pass:

- full backup/restore;
- destroyed-storage recovery;
- corrupted backup handling;
- recovery failure scenarios.

### Phase 3 — Device Pairing

Implement:

- device identity;
- QR pairing;
- WebRTC;
- authenticated transcript;
- SAS;
- encrypted initial vault transfer.

**Gate C** — must pass:

- successful pairing;
- MITM/SAS mismatch;
- replay;
- modified QR;
- interrupted pairing;
- device identity verification.

### Phase 4 — Synchronization

Implement:

- authenticated peers;
- record summaries;
- HLC;
- merge;
- conflict history;
- tombstones;
- trash.

**Gate D** — must pass:

- multi-device conflict tests;
- stale device tests;
- tombstone tests;
- replay/idempotency tests;
- network interruption tests.

### Security Gate

Before v1.0:

- cryptographic review;
- protocol review;
- threat-model review;
- dependency review;
- reproducible build validation;
- browser compatibility testing;
- recovery testing;
- security invariant verification.

Only after the Security Gate should the project be considered v1.0.

---

## 61. Phase 4+ Features

After the core v1:

- attachments up to 10 MB;
- encrypted blob synchronization;
- chunked `secretstream`;
- storage quota management;
- improved backup workflows.

Attachments MUST NOT be allowed to complicate the basic synchronization protocol.

---

## 62. Future Device Revocation

A future implementation MAY add device revocation.

The design already reserves `keyEpoch`.

Revocation SHOULD:

```
revoke device
      ↓
new key epoch
      ↓
new vault key
      ↓
re-encrypt active data
      ↓
future sync excludes revoked device
```

The system MUST continue to document that previous copies cannot be remotely erased.

---

## 63. Future Cloud Storage Plugins

A future optional plugin MAY support user-controlled storage such as:

- Google Drive;
- Dropbox;
- other storage providers.

Cloud storage MUST only receive encrypted `.bvault`-like data.

The core application MUST remain functional without these integrations.

---

## 64. Future Sharing

Sharing between people is explicitly outside v1.

A future sharing architecture MUST NOT simply reuse device pairing.

Sharing introduces a different trust model involving:

- multiple principals;
- independent identities;
- permissions;
- revocation;
- partial access;
- key rotation;
- auditability.

It MUST be designed separately.

---

## 65. Future Browser Extension

Browser autofill is outside the scope of BlindVault v1.

An extension introduces a substantially larger attack surface.

It SHOULD be treated as a separate security boundary.

---

## 66. Release and Distribution

The official application SHOULD be distributed as a static web application.

- **Default hosting:** GitHub Pages
- **Self-hosting:** any compatible static host

The project SHOULD publish:

- source code;
- release version;
- build hash;
- reproducible-build instructions;
- release notes.

---

## 67. Repository Structure

A suggested structure:

```
apps/
    web/

packages/
    crypto/
    vault/
    storage/
    sync/
    backup/

docs/
    architecture.md
    crypto-spec.md
    threat-model.md
    pairing-protocol.md
    sync-protocol.md
    security-invariants.md
    backup-format.md

tests/
    crypto/
    pairing/
    sync/
    recovery/
    integration/
```

This documentation structure is recommended even if the primary specification remains consolidated.

---

## 68. Engineering Rules for AI Coding Agents

AI coding agents working on BlindVault MUST treat this specification as normative.

Agents MUST NOT:

- invent cryptographic primitives;
- replace a specified primitive without explicit approval;
- weaken authentication for convenience;
- persist plaintext secrets for debugging;
- add telemetry containing vault data;
- add a backend merely to simplify synchronization;
- silently change the key hierarchy;
- silently change the backup format;
- remove security checks to make tests pass.

Agents SHOULD:

- read relevant package boundaries before modifying code;
- batch-read related files when investigating architecture;
- preserve existing cryptographic invariants;
- add tests for security-sensitive behavior;
- explain any proposed security-model change before implementation.

---

## 69. Definition of Done for Security-Sensitive Changes

A security-sensitive change is complete only when:

1. the design is documented;
2. the relevant invariant is identified;
3. implementation is complete;
4. negative tests exist;
5. migration implications are understood;
6. protocol/version changes are documented;
7. existing tests pass;
8. no plaintext secret handling was introduced;
9. threat-model implications are reviewed.

---

## 70. Current Architectural Decisions

| # | Decision | Reason |
| --- | --- | --- |
| 1 | No data server | Minimize attack surface |
| 2 | Browser/PWA application | Local-first and portable |
| 3 | QR + WebRTC synchronization | Avoid permanent synchronization infrastructure |
| 4 | File backup as fallback | Recovery without network services |
| 5 | Local password per device | Independent device security |
| 6 | Shared vault master key | Enables device replication |
| 7 | Vault key layer | Enables future key rotation |
| 8 | Item-level encryption | Isolation and flexible rotation |
| 9 | WebAuthn PRF optional | Convenient local unlock |
| 10 | Generic typed items | Vault rather than password-manager-only model |
| 11 | Encrypted collections/tags | Minimize metadata leakage |
| 12 | HLC + LWW | Simple deterministic v1 conflict handling |
| 13 | Preserve losing versions | Avoid silent conflict data loss |
| 14 | Indefinite v1 tombstones | Prevent stale-device resurrection |
| 15 | `.bvault` backup | Offline recovery |
| 16 | BlindPass import | Migration path |
| 17 | Attachments deferred | Keep v1 simple |
| 18 | Device revocation deferred | Complex and limited benefit |
| 19 | Self-hosting | Reduce trust in official host |
| 20 | Reproducible builds | Improve application-integrity verification |
| 21 | MIT license | Open-source distribution |
| 22 | No browser extension in v1 | Reduce attack surface |
| 23 | No sharing in v1 | Different trust model |
| 24 | Static hosting | No operational backend |
| 25 | Local-network-only sync mode | Optional network privacy |

---

## 71. Security Invariants Summary

The following statements summarize the core security model:

1. Plaintext vault contents never belong on persistent storage.
2. The master key exists in plaintext only while the vault is unlocked.
3. The master key is never synchronized in plaintext.
4. Every encrypted record authenticates its identity and key epoch.
5. A device is trusted only after authenticated pairing.
6. A synchronization peer proves possession of its registered identity key.
7. The user explicitly confirms the pairing SAS.
8. Recovery material is never logged or persisted plaintext.
9. Deleted records remain represented by tombstones until safe compaction.
10. Application integrity is a separate concern from cryptographic confidentiality.
11. A compromised browser, OS, extension, or malicious JavaScript bundle can compromise an unlocked vault and is therefore outside the cryptographic threat model.
12. Device revocation cannot erase data that has already been replicated.
13. The system has no administrator recovery mechanism.
14. Loss of all copies and all recovery mechanisms can result in permanent data loss.

---

## 72. Final Architecture

The resulting architecture is:

```
                         ┌──────────────────────┐
                         │   Static PWA Host    │
                         │ GitHub Pages / Self  │
                         └──────────┬───────────┘
                                    │
                                    │ application code
                                    ▼
┌─────────────────────────────────────────────────────────────┐
│                       BlindVault PWA                         │
│                                                             │
│  React / TypeScript                                         │
│                                                             │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ │
│  │    Vault   │ │   Crypto   │ │  Storage   │ │  Backup  │ │
│  └────────────┘ └────────────┘ └────────────┘ └──────────┘ │
│                                           │                 │
│                                           ▼                 │
│                                      IndexedDB              │
│                                  encrypted records          │
└─────────────────────────────────────────────────────────────┘
                    │
                    │ authenticated P2P
                    │
              ┌─────▼──────┐
              │  WebRTC    │
              │ DataChannel│
              └─────┬──────┘
                    │
             ┌──────▼──────┐
             │    STUN     │
             │ connectivity│
             └─────────────┘

                         OR

                ┌────────────────┐
                │    .bvault     │
                │ encrypted file │
                └────────────────┘
```

The cryptographic hierarchy remains:

```
                 Recovery Phrase
                        │
                        │ recovery
                        ▼
                   Master Key
                        │
              ┌─────────┴─────────┐
              │                   │
        Device-local          Device identity
             KEK                  X25519
              │
              ▼
       Encrypted Master Key
              │
              ▼
          Master Key
              │
              ▼
          Vault Key
              │
              ▼
          Item Key
              │
              ▼
       Encrypted Item
```

---

## 73. Final Assessment

BlindVault is intentionally not a cloud password manager.

It is a local encrypted data system with:

- no data server;
- no account system;
- no server-side vault;
- explicit device pairing;
- peer-to-peer synchronization;
- encrypted offline backups;
- local cryptographic control;
- generic structured data.

The architecture is considered viable for v1 provided that the cryptographic, pairing, synchronization, and recovery specifications above are implemented as explicit protocols rather than informal application logic.

The highest-priority engineering risks are:

1. pairing protocol correctness;
2. application/PWA integrity;
3. browser storage behavior;
4. recovery UX;
5. synchronization edge cases.

None of these currently requires abandoning the core architecture.

The recommended implementation strategy is therefore:

```
Crypto
   ↓
Local Vault
   ↓
Backup / Recovery
   ↓
Pairing Protocol
   ↓
Synchronization
   ↓
Security Gate
   ↓
v1.0
```

The project SHOULD resist adding features before these foundations are thoroughly tested.

The primary success criterion for v1 is not feature count.

It is:

> A user can create a vault, protect it cryptographically, recover it after losing local storage, pair another device without trusting a server, synchronize safely, and understand exactly what happens if every device except the backup is lost.
