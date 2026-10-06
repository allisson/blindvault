# BlindVault — Implementation Roadmap

> Complements `overview.md`, which is the normative reference. `Dn` references point to the decision log (overview, section 21 "Decision log").
> Hobby project, one developer, no deadline: **the phase order and the gates are the commitment, not dates.**

---

## How to execute

- Phases are **sequential**. A phase is done only when every criterion of its gate passes.
- Cryptographic and protocol code is written **tests first**, including negative tests and test vectors.
- Every protocol is specified in `docs/` **before** it is implemented.
- Any change that contradicts `overview.md` requires updating the overview first and recording a new `Dn` decision.
- If a Phase 0 spike fails, revise the overview before moving on. Do not work around the problem in code.

```
Phase 0 Foundations and spikes ──► Gate 0
Phase 1 Crypto and local vault ──► Gate A
Phase 2 Backup and recovery ──► Gate B
Phase 3 PWA and integrity ──► PWA Gate
Phase 4 Pairing ──► Gate C
Phase 5 Synchronization ──► Gate D
Phase 6 Import and final review ──► Security Gate ──► v1.0
```

---

## Phase 0 — Foundations and risk spikes

**Goal:** a ready repository, and no remaining technical unknowns that could change the product.

### Repository and CI

- [ ] Monorepo with workspaces: `apps/web`, `packages/{crypto,vault,storage,sync,backup}`, `docs/`, `tests/`
- [ ] TypeScript in strict mode, ESLint, Prettier
- [ ] Vitest configured per package
- [ ] Playwright with projects for Chromium, Firefox and WebKit
- [ ] CI: lint, typecheck and tests on every push
- [ ] Pinned Node version (`.nvmrc` or `engines`) and committed lockfile
- [ ] Lint rule preventing `packages/crypto` from importing other packages or React
- [ ] `AGENTS.md` at the root pointing to `docs/overview.md` and `docs/roadmap.md`, with the actual commands filled in and the real BlindPass path set
- [ ] Use the same package manager as BlindPass (unless there is a documented reason not to)
- [ ] `LICENSE` file (MIT)

### BlindPass inventory

- [ ] List BlindPass packages and modules (crypto, domain, utilities, tests), read-only
- [ ] For each, decide: reuse as is, reuse with changes, or do not reuse, and record the decision in `docs/architecture.md`
- [ ] Note every difference between BlindPass crypto and the overview (primitives, AAD, key hierarchy, serialization); the overview wins
- [ ] Identify BlindPass test vectors and tests that can be carried over

### Documentation

- [x] Copy `overview.md` and `roadmap.md` into `docs/` (original spec merged into the overview)
- [ ] `docs/crypto-spec.md`: key hierarchy, Master Key subkeys (D23), envelopes, AAD (D8, D21), Recovery KEK (D2), Argon2id parameters (D9)
- [ ] `docs/security-invariants.md`: CRYPTO-INV-001 to 010, each mapped to the test that covers it (filled in across phases)
- [ ] `docs/threat-model.md`: threats, out of scope, TOFU (D5)
- [ ] Specification of the binary layout for AAD and transcripts (D10), with test vectors

### Dependency selection

- [ ] Noise implementation on top of libsodium: evaluate maintenance, track record, and whether it passes the official test vectors (D1)
- [ ] CBOR library with a deterministic mode and a strict decoder (D10)
- [ ] Record the justification for each dependency in `docs/architecture.md`

### Spikes (throwaway code, outside `packages/`)

- [ ] **Signal-less pairing:** two tabs, then two phones (iOS Safari and Chromium Android) establish a DataChannel by exchanging only the compact QR payloads (D4)
    - [ ] Measure the actual payload size in bytes and the resulting QR
    - [ ] Test mDNS (`.local`) candidates on the same Wi-Fi network
    - [ ] Test with STUN across different networks (Wi-Fi + 4G)
    - [ ] Test camera QR scanning in the installed PWA on iOS and Android
- [ ] **Argon2id on mobile:** measure time and memory at 64 MiB and above, in Safari iOS and Chromium Android, using libsodium's WASM build (D9)
- [ ] **WebAuthn PRF:** verify real support across the browser matrix

### Gate 0

- [ ] CI green on the empty monorepo
- [ ] `crypto-spec.md` reviewed and consistent with the overview
- [ ] Pairing spike result recorded: **go**, or **no-go** with D4 revised
- [ ] Argon2id 64 MiB floor confirmed viable on iOS, or D9 revised
- [ ] Noise and CBOR dependencies chosen and justified

---

## Phase 1 — Cryptography and local vault

**Goal:** a vault that can be created, encrypted, persisted, locked and unlocked on a single device.

### `packages/crypto`

- [ ] Async libsodium initialization and RNG
- [ ] Binary AAD serialization with test vectors (D10)
- [ ] AEAD envelope (XChaCha20-Poly1305) with mandatory AAD
- [ ] Generation of master key, vault key (with `keyEpoch`) and record keys (D18)
- [ ] Key wrap and unwrap with AAD (D8)
- [ ] Device KEK derivation with Argon2id and local calibration (D9)
- [ ] Recovery KEK generation and derivation with `crypto_kdf`, used only through subkeys (D2); recovery keyslot keypair from a subkey (D16)
- [ ] Recovery phrase generation with `@scure/bip39` (encoding only, not wallet usage)
- [ ] Device X25519 identity generation; `deviceId` = BLAKE2b-128 of the public key (D19)
- [ ] WebAuthn PRF wrapping (optional, detected at runtime)

### `packages/vault`

- [ ] Item model with typed fields (list in overview, section 6 "Data model")
- [ ] Factory templates as versioned code definitions; items store `templateId` and `templateVersion` (D20)
- [ ] Folder record with encrypted name and `parentId` (D14)
- [ ] Item `folderId` (optional; absent = vault root); tags inside the encrypted content
- [ ] Tree derivation at read time: cycle rule, orphan rule, alphabetical order (D14)
- [ ] Folder deletion sends the subtree and its items to the trash with one `trashOperationId`; restore brings back exactly those records (D14)
- [ ] Record header (`recordType, recordId, hlc, deleted, keyEpoch`) for every record type (D18)
- [ ] Tombstone and version representation; deterministic keyed `versionId` (D6)

### `packages/storage`

- [ ] Versioned IndexedDB schema with migrations
- [ ] API that only accepts encrypted records (distinct TypeScript type)
- [ ] Local Config persistence (KEK salt, parameters, wrapped master key)
- [ ] `navigator.storage.persist()` and `estimate()`

### `apps/web` (minimal)

- [ ] Layout system: mobile, tablet and desktop shells selected by viewport width, sharing one domain layer (D15)
- [ ] Create vault, local password with zxcvbn, unlock, lock
- [ ] Item CRUD with templates
- [ ] Folder tree: create, rename, move, delete; move items between folders and the root
- [ ] Secret fields masked by default
- [ ] Configurable auto-lock that clears state and keys on lock

### Gate A

- [ ] Encrypt/decrypt tests for every record type
- [ ] Tampered ciphertext, invalid tag, swapped AAD and wrong `keyEpoch` are rejected
- [ ] An edited header (`hlc`, `deleted`), a forged tombstone and older ciphertext replayed under a newer `hlc` are rejected (D21)
- [ ] Test that substituting one item's ciphertext for another's fails
- [ ] Wrong password fails without leaking information
- [ ] Inspecting IndexedDB after use finds no plaintext content or keys (CRYPTO-INV-001, 003)
- [ ] After locking, no cryptographic operation works without a new unlock (CRYPTO-INV-010)
- [ ] Logs contain no keys or secrets (CRYPTO-INV-005)
- [ ] Changing the local password re-wraps the master key without changing records
- [ ] Playwright runs the core flows (unlock, CRUD, lock) at mobile, tablet and desktop widths
- [ ] Tree tests: an item is never shown in two places; cycles and orphans are resolved by the D14 rules (property tests over random trees)
- [ ] Folder names and `parentId` never appear in cleartext metadata

---

## Phase 2 — Backup and recovery

**Goal:** recover the vault from a file, even after losing all local storage.

### Tasks

- [ ] `docs/backup-format.md`: magic, version, parameters, keyslots and payload (D3)
- [ ] `packages/backup`: `.bvault` serialization with secretstream
- [ ] Recovery phrase keyslot (mandatory) and export password keyslot via Argon2id (optional)
- [ ] Recovery Envelope record with recovery keyslot public key and `phraseId` (D2, D16)
- [ ] Recovery keyslot as `crypto_box_seal` of the file key, created without the phrase (D16)
- [ ] "Check Recovery Phrase" while unlocked
- [ ] Export and import with version and integrity validation
- [ ] Restore as a new vault
- [ ] Restore with merge into an existing vault (LWW by HLC; reused later by sync), only when `vaultId` matches (D13)
- [ ] Restoring a different vault requires explicitly replacing the local one, after a warning
- [ ] Forgotten local password recovery via recovery phrase
- [ ] Recovery phrase regeneration replaces the envelope; UI shows it is not yet on other devices, prompts for a new backup, and backups show their `phraseId` (D2)
- [ ] Restored device writes no Device record; UI recommends re-admission with a non-retired device and offers to retire devices that no longer exist (D30)
- [ ] Re-founding: new keys, phrase and identity, live items and folders re-encrypted, vault swapped in one transaction (D28)
- [ ] UI: phrase display during onboarding, confirmation it was written down, last backup date, reminder every 30 days

### Gate B

- [ ] Create vault → backup → wipe storage → restore → all records match
- [ ] Restore with the recovery phrase and also with the export password
- [ ] Truncated, tampered or unknown-version `.bvault` is rejected with a clear error
- [ ] Wrong recovery phrase fails without leaking information
- [ ] The phrase never appears in IndexedDB, `localStorage` or logs (CRYPTO-INV-006)
- [ ] Regenerating the phrase does not change vault contents, and the new phrase restores the new backup
- [ ] Restore merge preserves the losing version in history
- [ ] Merging a backup with a different `vaultId` is rejected (D13)
- [ ] Re-founding interrupted midway leaves the old vault intact; afterwards old backups and old devices cannot open or sync with the new vault (D28)

---

## Phase 3 — PWA and application integrity

**Goal:** an installable, offline app with verifiable code and no silent updates.

### Tasks

- [ ] PWA manifest and installation
- [ ] Cache-first service worker with a versioned cache (D5)
- [ ] Update flow: new-version notice, version and hash shown, activation only after confirmation
- [ ] Reproducible build: `SOURCE_DATE_EPOCH`, deterministic Vite output, pinned Node and lockfile
- [ ] CI job that builds twice and compares the asset manifest hash
- [ ] Version and hash published on GitHub Releases; deployed to GitHub Pages
- [ ] "About" screen with the version and hash of the running build
- [ ] Self-hosting instructions
- [ ] State UI: locked/unlocked, persistence status, last backup, storage warnings, in all three layouts
- [ ] Layout polish per form factor: drill-down navigation on mobile, drawer on tablet, three panes and keyboard shortcuts on desktop (D15)
- [ ] Input adaptation via `pointer`/`hover` media queries (44 px touch targets)
- [ ] Full onboarding with three starts (create, pair, restore), making clear that no server can reset the vault

### PWA Gate

- [ ] Two builds of the same commit produce the same hash in CI
- [ ] App works offline after installation
- [ ] A new deploy does not replace the code without user confirmation (Playwright test)
- [ ] The hash shown in the app matches the one published in the release
- [ ] Self-hosting tested on another static host
- [ ] Visual and flow tests pass at all three layout widths, including resizing across breakpoints without losing state
- [ ] Secrets are masked by default and lock state is visible in every layout

---

## Phase 4 — Pairing

**Goal:** add a second device without trusting a server, resisting MITM.

### Tasks

- [ ] `docs/pairing-protocol.md`: messages, prologue, SAS derivation and length, brute-force analysis and commitment in copy/paste mode, versioning
- [ ] Transport abstraction in `packages/sync` (real WebRTC and an in-memory transport for tests)
- [ ] QR payload encoding/decoding in base45 and SDP reconstruction (D4)
- [ ] `Noise_XX` handshake integration with the defined prologue (D1)
- [ ] SAS derivation and display on both devices, with explicit confirmation
- [ ] Vault key material transferred over the Noise channel only after confirmation
- [ ] New device initialization: display name sent with the acknowledgement, local password, KEK, wrapped master key, identity, Device record written by A (D30)
- [ ] Startup cleanup of an incomplete pairing (records without Local Config) (D30)
- [ ] Retire a Device record: irreversible, confirmed, UI stating it is not revocation and pointing to re-founding (D30, D31)
- [ ] Pairing only into a device without a vault; an existing vault must be explicitly erased first, after a warning (D13)
- [ ] Re-admission of a device restored from backup: SAS, mutual Master Key confirmation bound to the handshake hash, Device records, merge sync, no Master Key transfer (D22, D29)
- [ ] Camera QR scanning and copy/paste fallback
- [ ] Pairing session expiration
- [ ] LAN-only mode (no STUN) and configurable STUN list

### Gate C

- [ ] Full pairing between two browsers (Playwright) and between iOS and Android (manual, recorded)
- [ ] Mismatched SAS aborts without transferring anything (CRYPTO-INV-007)
- [ ] Replay of an old pairing session fails
- [ ] A modified QR payload or SDP makes the handshake or SAS fail
- [ ] A wrong identity is rejected
- [ ] Pairing interrupted midway leaves no partially trusted device
- [ ] Duplicate pairing and expired sessions handled
- [ ] Pairing into a device that already holds a different vault is blocked until the user erases it (D13)
- [ ] A device restored from backup is re-admitted and then syncs; re-admission with a different Master Key aborts before any Device record is written (D22, D29, CRYPTO-INV-014)
- [ ] No Device record is written outside vault creation or a SAS-confirmed pairing (CRYPTO-INV-007)
- [ ] Official Noise test vectors pass in CI

---

## Phase 5 — Synchronization

**Goal:** registered devices converge safely without losing data in conflicts.

### Tasks

- [ ] `docs/sync-protocol.md`: reconnection payload, messages, summaries, ordering, idempotency, versioning
- [ ] Transport-agnostic reconnection payload, encrypted to the peer with `Noise_K` (D12, D17)
- [ ] Keep payload delivery behind an interface so a mailbox transport (Nostr, ntfy) can be added after v1 without protocol changes
- [ ] Manual sync flow: start sync on both devices, exchange the reconnection payload by QR or copy/paste in both directions
- [ ] `Noise_KK` handshake with the registered identities (CRYPTO-INV-008)
- [ ] End the session right after `Noise_KK` when the peer's Device record is retired; a retired Device record always beats a non-retired one in merge (D31)
- [ ] Messages bound to the session (CRYPTO-INV-009)
- [ ] HLC `(physicalMs, counter, deviceId)`: monotonic, no ties, canonical serialization, future-clock bound (D19)
- [ ] Summary exchange and transfer of divergent records only
- [ ] Per-item LWW merge, with the losing version stored in history
- [ ] History pruned deterministically to the 20 greatest `(hlc, versionId)` per item (D6)
- [ ] Tombstones synchronized and kept indefinitely
- [ ] Trash with deterministic purge (D7)
- [ ] Recovery Envelope synchronization; a device superseded by a concurrent regeneration warns the user (D2)
- [ ] Live push of changes while the DataChannel is open; session ends on close or lock
- [ ] UI: sync state and last successful sync date

### Gate D

- [ ] Identical vaults, one-way and bidirectional changes converge
- [ ] Concurrent edits: winner by HLC, loser stored in history
- [ ] Delete vs. edit and edit vs. delete follow the rule; a newer edit restores
- [ ] A stale device does not resurrect a deleted item
- [ ] Concurrent moves creating a cycle produce the same tree on every device (D14)
- [ ] Deleting a folder on one device while adding an item to it on another leaves the item visible at the root
- [ ] A child received before its parent appears at the root, then moves under the parent when it arrives
- [ ] Duplicate, out-of-order and repeated messages are idempotent
- [ ] A corrupted record is rejected without affecting the others
- [ ] An HLC timestamp beyond the future-clock bound is rejected, then accepted once within the bound (D19)
- [ ] An interrupted connection resumes without inconsistency
- [ ] A peer without a registered identity cannot sync
- [ ] A retired peer cannot sync, and a forged newer non-retired Device record, even one claiming another device's HLC, never un-retires it (D31, CRYPTO-INV-015)
- [ ] A reconnection payload from an old session, or addressed to another device, is rejected
- [ ] During a sync session, an edit on one device reaches the other without a new exchange
- [ ] Locking the vault on either side ends the sync session
- [ ] Simulation with 3 or more devices and injected failures, over the in-memory transport

---

## Phase 6 — Import and final review

**Goal:** BlindPass migration and security validation before v1.0.

### Tasks

- [ ] BlindPass importer: decrypt, validate, transform, encrypt in BlindVault format, without persisting plaintext
- [ ] Map BlindPass single-level collections to root folders; if a BlindPass item belongs to more than one collection, place it in the first and convert the others to tags (D14)
- [ ] Importer tests with valid, corrupted and partial data
- [ ] Publish the spec and protocol docs and request community review (ideally starting in Phase 4)
- [ ] Dependency review
- [ ] Threat-model review against what was implemented
- [ ] User documentation: limitations (memory zeroization, revocation, TOFU, old backups and old phrase, permanent loss)

### Security Gate → v1.0

- [ ] Cryptographic and protocol review complete, findings resolved
- [ ] Every invariant in `security-invariants.md` has an associated passing test
- [ ] Reproducible build validated on the release candidate
- [ ] Browser matrix tested and recorded
- [ ] Recovery scenarios tested:
    - [ ] Destroy A, continue with B
    - [ ] Destroy A and B, restore `.bvault` with the recovery phrase
    - [ ] Forgotten local password, recover with the phrase

---

## After v1

Optional signaling relay for automatic sync (D12: mailbox interface, Nostr adapter first, then ntfy; off by default, no official instance), attachments (up to 10 MB, chunked secretstream), storage quotas, device revocation via `keyEpoch`, master key rotation, cloud storage plugins, sharing between people, and a browser extension. Details in the overview, section 20 "Out of scope for v1".
