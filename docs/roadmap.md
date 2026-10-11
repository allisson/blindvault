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

- [x] Monorepo with workspaces: `apps/web`, `packages/{crypto,vault,storage,sync,backup}`, `docs/`, `tests/`
- [x] TypeScript in strict mode, ESLint, Prettier
- [x] Vitest configured per package
- [x] Playwright with projects for Chromium, Firefox and WebKit
- [x] CI: lint, typecheck and tests on every push
- [x] Pinned Node version (`.nvmrc` or `engines`) and committed lockfile
- [x] Lint rule preventing `packages/crypto` from importing other packages or React
- [x] `AGENTS.md` at the root pointing to `docs/overview.md` and `docs/roadmap.md`, with the actual commands filled in and the real BlindPass path set
- [x] Use the same package manager as BlindPass (unless there is a documented reason not to)
- [x] `LICENSE` file (MIT)

### BlindPass inventory

- [x] List BlindPass packages and modules (crypto, domain, utilities, tests), read-only
- [x] For each, decide: reuse as is, reuse with changes, or do not reuse, and record the decision in `docs/architecture.md`
- [x] Note every difference between BlindPass crypto and the overview (primitives, AAD, key hierarchy, serialization); the overview wins
- [x] Identify BlindPass test vectors and tests that can be carried over

### Documentation

- [x] Copy `overview.md` and `roadmap.md` into `docs/` (original spec merged into the overview)
- [x] `docs/crypto-spec.md`: key hierarchy, Master Key subkeys (D23), envelopes, AAD (D8, D21), Recovery KEK (D2), Argon2id parameters (D9)
- [x] `docs/security-invariants.md`: CRYPTO-INV-001 to 023, each mapped to the test that covers it (filled in across phases)
- [x] `docs/threat-model.md`: threats, out of scope, TOFU (D5)
- [x] Specification of the binary layout for AAD and transcripts (D10), with test vectors

### Dependency selection

- [x] Noise implementation on top of libsodium: evaluate maintenance, track record, and whether it passes the official test vectors (D1)
- [x] CBOR library with a deterministic mode and a strict decoder (D10)
- [x] Record the justification for each dependency in `docs/architecture.md`

### Spikes (throwaway code, outside `packages/`)

- [ ] **Signal-less pairing:** two tabs, then two phones (iOS Safari and Chromium Android) establish a DataChannel by exchanging only the compact QR payloads (D4)
    - [ ] Measure the actual payload size in bytes and the resulting QR
    - [ ] Test mDNS (`.local`) candidates on the same Wi-Fi network, with and without camera permission on each side, including LAN-only mode, and revise D136 with the result
    - [ ] Test with STUN across different networks (Wi-Fi + 4G)
    - [ ] Test camera QR scanning in the installed PWA on iOS and Android
- [ ] **Argon2id on mobile:** measure time and memory at 64 MiB and above, in Safari iOS and Chromium Android, using libsodium's WASM build (D9)
    - [ ] Measure whether Argon2id at libsodium's `SENSITIVE` limits (1 GiB) runs on each browser of the matrix, for `.blindpass` import, and revise D126 with the result
- [ ] **WebAuthn PRF:** verify real support across the browser matrix
- [x] **Safari storage:** measure whether IndexedDB survives several days without use in a Safari tab and in the installed app, on iOS and macOS, and revise D55 with the result (run ended after day 1: no result could relax D55, which now rests on WebKit's documentation, D160)
    - [x] Confirm that the installed app does not share storage with the Safari tab, on iOS and macOS, and revise D103 with the result
    - [x] Check whether the installed app can pair with a Safari tab on the same iPhone, and revise D110 with the result
    - [ ] Record which system UIs (file picker, WebAuthn prompt, camera and other permission prompts) report the app as hidden, per browser in the matrix, and revise D105 with the result
- [ ] **Service-worker integrity:** serve a changed `sw.js` and confirm across the browser matrix that its install code runs, when it activates on its own, and that `skipWaiting` with `clients.claim` takes control of an open app window; measure whether the page reliably detects it (`updatefound`) in time to lock the vault (D142); revise D63 with the result

### Gate 0

- [x] CI green on the empty monorepo
- [x] `crypto-spec.md` reviewed and consistent with the overview
- [ ] Pairing spike result recorded: **go**, or **no-go** with D4 revised
- [ ] Argon2id 64 MiB floor confirmed viable on iOS, or D9 revised
- [x] Noise and CBOR dependencies chosen and justified

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
- [ ] WebAuthn PRF wrapping (optional, detected at runtime), with user verification required and assertions without it rejected (D75)
- [ ] Record content padded with `sodium_pad` to 256-byte blocks before encryption; invalid padding rejected after authentication (D92)
- [ ] Record size cap of 1 MiB of plaintext content: larger writes refused, oversized ciphertext rejected before decryption (D129); item cap leaving room for an Item Version of a trashed state (D139, D143); a received Item or Item Version above the item cap rejected after decryption (D144)
- [ ] TOTP codes with WebCrypto HMAC (SHA1, SHA256, SHA512), `otpauth://` parser copied from BlindPass, RFC 6238 test vectors (D127)
- [ ] Password generator: random characters or BIP39-English passphrase via `randombytes_uniform`, entropy shown, nothing persisted, defaults 20 characters or 6 words and minimums 12 or 4 (D128), characters drawn from the union of the selected sets (D138)

### `packages/vault`

- [ ] Item model with typed fields (list in overview, section 6 "Data model")
- [ ] Factory templates as versioned code definitions; items store `templateId` and `templateVersion` (D20)
- [ ] Folder record with encrypted name and `parentId` (D14)
- [ ] Item `folderId` (optional; absent = vault root); tags inside the encrypted content
- [ ] Tree derivation at read time: cycle rule, orphan rule, alphabetical order (D14)
- [ ] Folder deletion sends the subtree and its items to the trash with one `trashOperationId`; restore from the trash brings back exactly those records (D14)
- [ ] Record header (`recordFormatVersion, recordType, recordId, hlc, deleted, keyEpoch`) for every record type (D18, D32)
- [ ] Tombstone and version representation; deterministic keyed `versionId` (D6)

### `packages/storage`

- [ ] Versioned IndexedDB schema with migrations
- [ ] API that only accepts encrypted records (distinct TypeScript type)
- [ ] Local Config persistence (KEK salt, parameters, wrapped master key); everything not needed for unlock encrypted under the Local Config subkey (D58, CRYPTO-INV-019); every local wrap bound to `vaultId` and `localConfigId` (D121, CRYPTO-INV-023)
- [ ] `navigator.storage.persist()` and `estimate()`
- [ ] Single active app window through an exclusive Web Lock, with take-over (D51)
- [ ] IndexedDB database and Web Lock named by `vaultId`, Local Config in that database (D79, D82)
- [ ] A database counts as a vault only once its Local Config is committed; startup deletes databases without one, and a database replaced by another committed one (D89)

### `apps/web` (minimal)

- [ ] Layout system: mobile, tablet and desktop shells selected by viewport width, sharing one domain layer (D15)
- [ ] Create vault, local password with zxcvbn at score 4 (D71), unlock, lock
- [ ] Item CRUD with templates
- [ ] Duplicate item: new item in the same folder with the current content, a new ID and no history; the item-history view states that old values stay until the original is trashed and purged (D135); blocked for an item from a newer app version, not offered in the trash (D140)
- [ ] Records in the trash allow only restore from the trash and purge; restoring a version of a trashed state drops `trashOperationId` (D143)
- [ ] Folder tree: create, rename, move, delete; move items between folders and the root
- [ ] Secret fields masked by default
- [ ] Search over decrypted state in memory only, never over `secret`, TOTP or seed-phrase values, index cleared on lock (D132)
- [ ] TOTP field: TOTP secret masked, current code shown, copy with clipboard clear (D127)
- [ ] Configurable auto-lock that clears state and keys on lock

### Gate A

- [ ] Encrypt/decrypt tests for every record type
- [ ] Tampered ciphertext, invalid tag, swapped AAD and wrong `keyEpoch` are rejected
- [ ] A record with an unknown or edited `recordFormatVersion` is rejected (D32)
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

- [ ] `docs/backup-format.md`: magic, version, parameters (fixed export `opslimit` and accepted Argon2id range, D78), keyslots and payload (D3)
- [ ] `packages/backup`: `.bvault` serialization with secretstream
- [ ] Recovery phrase keyslot (mandatory) and export password keyslot via Argon2id (optional); export password strength check at an estimated 10^14 guesses, with a generated 6-word passphrase offered (D134) and warning that it yields the Master Key (D36)
- [ ] Recovery Envelope record with recovery keyslot public key and `phraseId` (D2, D16)
- [ ] Recovery keyslot as `crypto_box_seal` of the file key, created without the phrase (D16)
- [ ] "Check Recovery Phrase" while unlocked
- [ ] Export and restore with version and integrity validation
- [ ] Fresh restore, committed in one storage transaction (D33); records beyond the future-clock bound are accepted and read-only until within the bound (D39)
- [ ] Restore with merge into an existing vault (LWW by HLC; reused later by sync), only when `vaultId` matches (D13)
- [ ] Restoring a different vault requires explicitly replacing the local one, after a warning; the new database commits before the old one is deleted (D89)
- [ ] Forgotten local password recovery via recovery phrase
- [ ] Recovery phrase regeneration replaces the envelope; UI shows it is not yet on other devices, prompts for a new backup, and backups show their `phraseId` (D2)
- [ ] Restored device writes no Device record; UI recommends re-admission with a non-retired device and offers to retire devices that no longer exist (D30)
- [ ] Re-founding: new keys, phrase and identity, live items and folders re-encrypted, new vault committed to its own database before the old one is deleted (D28, D89); warning that trash and history are emptied, with an offer to restore from the trash first (D72)
- [ ] UI: phrase display during onboarding, confirmation it was written down, last backup date, reminder every 30 days

### Gate B

- [ ] Create vault → backup → destroy local storage → restore → all records match
- [ ] Restore with the recovery phrase and also with the export password
- [ ] Truncated (no final tag, or data after it), tampered or unknown-version `.bvault` is rejected with a clear error (D95); header values shown before a keyslot opens are marked unverified
- [ ] Wrong recovery phrase fails without leaking information
- [ ] The phrase never appears in IndexedDB, `localStorage` or logs (CRYPTO-INV-006)
- [ ] Regenerating the phrase does not change vault contents, and the new phrase restores the new backup
- [ ] Backup merge preserves the losing version in history
- [ ] Merging a backup with a different `vaultId` is rejected (D13)
- [ ] Restore interrupted midway leaves storage untouched (D33)
- [ ] A fresh restore of a backup whose HLCs are beyond the future-clock bound keeps every record, read-only until within the bound (D39)
- [ ] Re-founding interrupted midway, or locked before its commit, leaves the old vault intact; interrupted after the new database commits, startup keeps only the new vault; afterwards old backups and old devices cannot open or sync with the new vault (D28, D89, D93)

---

## Phase 3 — PWA and application integrity

**Goal:** an installable, offline app with verifiable code and no silent updates.

### Tasks

- [ ] PWA manifest and installation
- [ ] Cache-first service worker with a versioned cache (D5)
- [ ] Update flow: asset bundles switched by the running service worker only after confirmation, version and manifest hash shown; changed `sw.js` detected and warned, locking the vault at once (D63, D142); all code and WebAssembly loaded before the first unlock, none afterwards (D142)
- [ ] Reproducible build: `SOURCE_DATE_EPOCH`, deterministic Vite output, pinned Node and lockfile
- [ ] CI job that builds twice and compares the asset manifest hash
- [ ] Choose and configure the dedicated custom domain for the official build (D90)
- [ ] Version and hash published on GitHub Releases; deployed to GitHub Pages under the dedicated custom domain only (D90)
- [ ] Startup warning when served under a sub-path of a `github.io` host (D90)
- [ ] Strict CSP by `<meta>` starting from `default-src 'none'`, Trusted Types where supported, unlock refused while framed (D83, D91)
- [ ] "About" screen with the version and hash of the running build
- [ ] Self-hosting instructions, including the dedicated-origin requirement and that changing origin means backup and restore (D90)
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
- [ ] New device initialization: local password and KEK before the handshake, display name sent with the acknowledgement, Device record written by A, records and Local Config persisted in one transaction after the first sync, commit acknowledgement (D30, D33)
- [ ] Last completed sync per peer in Local Config, shown next to `registeredAt`; a pairing without commit acknowledgement shown as not completed (D34)
- [ ] Retire a Device record: irreversible, confirmed, UI stating it is not revocation and pointing to re-founding (D30, D31)
- [ ] Pairing only into a device without a vault; an existing vault must be explicitly erased first, after a warning (D13)
- [ ] Pairing from an unregistered device writes both Device records; re-admission recommended when other non-retired devices exist (D141)
- [ ] Re-admission of an unregistered device: SAS, mutual Master Key confirmation bound to the handshake hash, Device records written by the registered side (initiator if neither is), merge sync, no Master Key transfer (D22, D29, D35)
- [ ] Camera QR scanning and copy/paste fallback
- [ ] Pairing session expiration; a lock on either device aborts the pairing (D93)
- [ ] LAN-only mode (no STUN) and configurable STUN list

### Gate C

- [ ] Full pairing between two browsers (Playwright) and between iOS and Android (manual, recorded)
- [ ] Mismatched SAS aborts without transferring anything (CRYPTO-INV-011)
- [ ] Replay of an old pairing session fails
- [ ] A modified QR payload or SDP makes the handshake or SAS fail
- [ ] A wrong identity is rejected
- [ ] Pairing interrupted at any step before the commit, including a failed first sync, leaves the new device's storage empty (D33)
- [ ] Duplicate pairing and expired sessions handled
- [ ] A lock or hidden-app lock on either device aborts the pairing, leaving the joining device's storage empty (D93)
- [ ] Pairing into a device that already holds a different vault is blocked until the user erases it (D13)
- [ ] An unregistered device is re-admitted and then syncs; re-admission with a different Master Key aborts before any Device record is written (D22, D29, CRYPTO-INV-014)
- [ ] No Device record is written outside vault creation, re-founding or a SAS-confirmed pairing or re-admission (CRYPTO-INV-007)
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
- [ ] End an open session when the peer's Device record becomes retired, after sending it that record, or when this device receives its own record as retired (D69)
- [ ] Reject records in an unknown `recordFormatVersion` in sync, record it in Local Config, warn at export until cleared; abort a pairing before commit when its first full sync holds one (D68)
- [ ] Messages bound to the session (CRYPTO-INV-009)
- [ ] HLC `(physicalMs, counter, deviceId)`: monotonic, no ties, canonical serialization, 24-hour future-clock bound (D19, D76); no new HLC issued while the device clock is behind its HLC state, the greatest HLC issued or accepted (D73, D109)
- [ ] Summary exchange and transfer of divergent records only
- [ ] Per-item LWW merge, with the losing version stored in history
- [ ] An Item Version is dropped for a purged item only once the whole transfer is merged, so a restore from the trash arriving with its versions keeps them (D137)
- [ ] History pruned deterministically to the 20 greatest `(hlc, versionId)` per item (D6); the dropped-loser notice only for a state this device wrote (D70)
- [ ] Tombstones synchronized and kept indefinitely
- [ ] Trash with deterministic, automatic-only purge; no manual purge (D7, D94)
- [ ] Recovery Envelope synchronization; a device superseded by a concurrent regeneration warns the user, naming the superseded phrase and offering a new backup (D2, D145)
- [ ] Live push of changes while the DataChannel is open; session ends on close or lock
- [ ] UI: sync state and last successful sync date; only devices with a known Device record are offered as peers

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
- [ ] A Device rename and a Recovery Phrase regeneration are blocked while the held record is beyond the bound; retirement is not (D74)
- [ ] An interrupted connection resumes without inconsistency
- [ ] A peer without a registered identity cannot sync
- [ ] A retired peer cannot sync, and a forged newer non-retired Device record, even one claiming another device's HLC, never un-retires it (D31, CRYPTO-INV-015)
- [ ] A reconnection payload from an old session, or addressed to another device, is rejected
- [ ] During a sync session, an edit on one device reaches the other without a new exchange
- [ ] Locking the vault on either side ends the sync session
- [ ] Simulation with 3 or more devices and injected failures, over the in-memory transport

---

## Phase 6 — Import and final review

**Goal:** Import from BlindPass and other password managers, and security validation before v1.0.

### Tasks

- [ ] `docs/blindpass-format.md`: BlindPass export format (plaintext `.json`, encrypted `.blindpass`) (D123)
- [ ] Justify `fflate` in `docs/architecture.md` (D125)
- [ ] Copy and adapt the BlindPass parsers into `packages/vault`: BlindPass, Chrome, LastPass, Apple Passwords, KeePassXC, Bitwarden, Proton Pass, 1Password, Dashlane (D123)
- [ ] `.blindpass` export decryption in `packages/crypto` with BlindPass's fixed Argon2id parameters and `crypto_secretbox` (D125, D126)
- [ ] Mapping: TOTP as a field, unknown categories as Secure Notes, secret-looking keys as `secret` fields, dropped attachments named in notes (D124); `otpauth://` URIs as `totp` fields whatever their key, bare base32 values only under TOTP-looking keys (D131, D133)
- [ ] Import flow: plaintext-export warning, 100 MB file cap (D130), preview counting items above the item cap (D129, D139), landing folder, one-transaction commit, lock abort, delete-the-file reminder (D123, D125); encrypted Bitwarden and Proton Pass exports rejected with a message to export unencrypted (D146)
- [ ] Import tests per format with valid, malformed and oversized input (section 18)
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
