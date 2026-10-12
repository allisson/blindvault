# BlindVault — Security Invariants

> The invariants are defined in `overview.md` §17, which prevails; this document maps each one to
> the tests that cover it. Every invariant MUST have at least one negative test. A row stays
> **pending** until its tests exist and pass in CI; the phase is the roadmap phase whose gate
> requires them.

Test vectors in `packages/crypto/test-vectors/crypto-v1.json` (`crypto-spec.md` §15) already hold
negative cases for some rows; they are inputs for the tests, not tests.

| ID | Invariant (short form, see overview §17) | Phase | Vectors | Tests |
| --- | --- | --- | --- | --- |
| CRYPTO-INV-001 | No plaintext vault content persisted | 1 (Gate A) | — | partial: `packages/vault/src/session.test.ts` › persists no plaintext content (records and Local Config the session commits); `tests/vault-storage.test.ts` › persists only sealed records and the allowed Local Config (every value in IndexedDB, on `fake-indexeddb`); `packages/storage/src/database.test.ts` › refuses bytes that are not an envelope, writing nothing; stores exactly the bytes of each value, never the rest of its buffer; inspection in a real browser (Gate A) pending |
| CRYPTO-INV-002 | Master Key never synchronized in plaintext | 4 (Gate C) | — | pending |
| CRYPTO-INV-003 | Master Key never stored directly in IndexedDB | 1 (Gate A) | `local` | pending |
| CRYPTO-INV-004 | Record header authenticated through AAD | 1 (Gate A) | `layout.recordAad`, `records.mustNotOpen` | `packages/crypto/src/layout.test.ts` › record AAD changes when each header field changes; `packages/crypto/src/aead.test.ts` › must not open (records), open rejects |
| CRYPTO-INV-005 | No keys in logs | 1 (Gate A) | — | partial: `packages/crypto/src/keys.test.ts` › reveals no key bytes when logged or serialized; `identity.test.ts` › hides the private key from logs and JSON; `password.test.ts` › names the reason without echoing the password; app logs pending |
| CRYPTO-INV-006 | Recovery material never logged or persisted in plaintext | 2 (Gate B) | — | pending |
| CRYPTO-INV-007 | Device records created only at creation, re-founding or after SAS | 4 (Gate C) | — | pending |
| CRYPTO-INV-008 | Peer proves its registered identity (`Noise_KK`) before sync | 5 (Gate D) | `transcripts.prologueKK` | pending |
| CRYPTO-INV-009 | Every sync message authenticated and bound to the session | 5 (Gate D) | — | pending |
| CRYPTO-INV-010 | Secrets removed from memory on lock, as far as JS permits | 1 (Gate A) | — | partial: `packages/crypto/src/keys.test.ts` › blocks every operation with a key after wipeAll; `identity.test.ts` › loads a stored identity and takes ownership of the private key; `recovery.test.ts` › keeps neither the Recovery KEK nor the keyslot seed; `kdf-worker.test.ts` › derives through the worker, transfers and wipes the password, and terminates it; `packages/vault/src/session.test.ts` › wipes the keys and the state, and refuses every later call; aborts an operation whose commit is in progress; `apps/web/src/app/controller.test.ts` › locks, refuses a wrong password, and unlocks the same vault again; aborts a creation locked before its commit, persisting nothing (D104); `apps/web/src/app/lock-timers.test.ts` (inactivity and hidden-app locks) |
| CRYPTO-INV-011 | No Master Key or recovery secret before SAS on both devices | 4 (Gate C) | — | pending |
| CRYPTO-INV-012 | Unknown formats, versions and record types rejected | 1 (Gate A), then 2, 4, 5 | `negative.envelopes` | 1: `packages/crypto/src/record.test.ts` › negative vectors, header tampering (unknown `recordFormatVersion`); later phases pending |
| CRYPTO-INV-013 | Tombstones never removed; older writes never resurrect | 5 (Gate D) | — | pending |
| CRYPTO-INV-014 | Re-admission proves the same Master Key before any Device record | 4 (Gate C) | `transcripts.readmissionMac` | pending |
| CRYPTO-INV-015 | Nothing exchanged with a retired peer but its retired record; retirement irreversible | 5 (Gate D) | — | pending |
| CRYPTO-INV-016 | Vault Key, Envelope, Device, Item Version never `deleted`; immutability rules | 1 (Gate A), then 5 | `negative.envelopes` (Vault Key with `del`), `records.identityCollision` (D158) | 1: `packages/crypto/src/record.test.ts` › negative vectors (step 4), identity collision; immutability rules (Phase 5) pending |
| CRYPTO-INV-017 | One app window opens the vault; one changes vault databases | 1 (Gate A) | — | partial: `packages/storage/src/locks.test.ts` › is named like the vault database, and a second app window cannot acquire it; take-over reports the loss to the holder; installation guard; `packages/storage/src/cleanup.test.ts` › runs only under the installation guard; skips a replaced database whose Web Lock another app window holds (D154); `apps/web/e2e/vault.spec.ts` › a second app window does not open the vault, and takes it over (D51), on Chromium, Firefox and WebKit; two-window installation-guard browser test pending |
| CRYPTO-INV-018 | Records verified (key, content, derived ID) before merge or persist | 2 (Gate B), 5 (Gate D) | `negative`, `ids` | partial: `packages/crypto/src/record.test.ts` › negative vectors, derived recordId; restore and sync paths pending |
| CRYPTO-INV-019 | Local Config cleartext limited to the allowed fields | 1 (Gate A) | `local` | partial: `tests/vault-storage.test.ts` › persists only sealed records and the allowed Local Config (cleartext keys as stored in IndexedDB); browser test pending |
| CRYPTO-INV-020 | HLC strictly monotonic; no HLC beyond the cap except retirement | 1 (Gate A), then 5 | — | partial: `packages/vault/src/hlc.test.ts` › is strictly monotonic, also when the physical clock stalls or goes back a little; becomes read-only, issuing nothing, while the state is beyond the cap; refuses to issue above a replaced record beyond the cap; issues a retirement even beyond the cap, still monotonic; `packages/vault/src/session.test.ts` › makes the whole vault read-only while the HLC state is beyond the cap (the state committed with each write); sync (Phase 5) pending |
| CRYPTO-INV-021 | PRF KEK only from an assertion with user verification | 1 (Gate A) | `kdf.subkeys` (`bvprfkek`) | partial: `packages/crypto/src/prf.test.ts` › rejects an assertion without the UV flag, with no flags, with truncated authenticator data; Playwright with the virtual authenticator pending |
| CRYPTO-INV-022 | No record beyond the future-clock bound merged; read-only after restore | 2 (Gate B), 5 (Gate D) | — | pending |
| CRYPTO-INV-023 | Local wraps bound to purpose, `vaultId` and `localConfigId` | 1 (Gate A) | `local.mustNotOpen` | `packages/crypto/src/aead.test.ts` › must not open (local wraps); `packages/crypto/src/local-config.test.ts` › rejects the part of another Local Config; `packages/vault/src/session.test.ts` › refuses the encrypted part of another vault’s Local Config as corrupt |

When a test lands, replace **pending** with its path and test name, for example
`packages/crypto/src/aad.test.ts › rejects a ciphertext under another vaultId`.
