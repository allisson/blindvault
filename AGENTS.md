# AGENTS.md

BlindVault is a local-first, end-to-end encrypted personal vault that runs entirely in the browser as a PWA. There is no data server: data lives only on the user's devices and in encrypted `.bvault` backups, and devices sync peer-to-peer over WebRTC.

This is a security-critical project. Correctness and safety come before speed or feature count.

## Source of truth

Read these before making non-trivial changes:

- `docs/overview.md`: **normative** design (architecture, cryptography, protocols, invariants, UI security, onboarding, testing, decision log D1–D95). It prevails over any other document.
- `docs/roadmap.md`: phases, tasks and gates. Work on the current phase only.
- `docs/security-invariants.md`, `docs/crypto-spec.md`, `docs/pairing-protocol.md`, `docs/sync-protocol.md`, `docs/backup-format.md`, `docs/threat-model.md`: detailed specs, created as the roadmap progresses.
- `GLOSSARY.md`: canonical domain terms. Use them in code, docs and UI copy.

If a task would contradict `docs/overview.md`, stop and explain the conflict instead of implementing it. Design changes are made by updating the overview and recording a new `Dn` decision first.

## BlindPass reference

BlindVault is derived from BlindPass. The BlindPass source code is available locally at:

```
../blindpass   ← adjust to the real path
```

Rules for using it:

- Treat it as a **read-only reference**. Never modify files in the BlindPass directory.
- Never import from it at runtime or link it as a workspace dependency. Reused code is **copied** into the matching BlindVault package.
- Reuse is decided per module and recorded in `docs/architecture.md` (see the BlindPass inventory task in Phase 0). Copied code must be adapted to the overview: if BlindPass differs on a primitive, AAD layout, key hierarchy or serialization, the overview wins and the difference is noted.
- Copied cryptographic code gets the same tests and review as new code. It is not trusted just because it already existed.
- Do not copy the server application, API schema, PostgreSQL, Redis, Docker or Terraform code.
- The BlindPass storage and encryption format is the input for the Phase 6 importer; document it in `docs/blindpass-format.md` when you first need it.

## Current phase

Phase 0 — Foundations and risk spikes. Update this line when a gate passes.

## Repository layout

```
apps/web/            PWA, UI (mobile/tablet/desktop layouts), service worker, onboarding (no direct crypto)
packages/crypto/     libsodium wrappers, key hierarchy, AEAD, AAD serialization
packages/vault/      domain model: items, fields, templates, versions, tombstones
packages/storage/    IndexedDB schema, encrypted record persistence, migrations
packages/sync/       pairing, Noise handshake, WebRTC, QR, sync protocol, HLC, merge
packages/backup/     .bvault format, keyslots, export/import
docs/                specs and decisions
tests/               cross-package, protocol and recovery tests
```

Package boundaries:

- `packages/crypto` has no UI code and imports no other workspace package.
- `packages/vault` never touches IndexedDB or the network.
- `packages/storage` only accepts already-encrypted record types and Local Config (D82).
- `packages/sync` talks to a transport abstraction so protocol tests run without WebRTC.

## Commands

To be defined during Phase 0. Fill in the real commands here once tooling exists (install, dev, build, lint, typecheck, unit tests, a single test file, Playwright).

## Stack

TypeScript (strict), React, Vite, Tailwind, `libsodium-wrappers-sumo`, `@scure/bip39`, zxcvbn, a Noise implementation on libsodium, deterministic CBOR, Vitest, Playwright.

Do not add dependencies without a written justification in `docs/architecture.md`. Security-sensitive dependencies need explicit approval.

## Security rules (non-negotiable)

Never:

- implement custom cryptographic primitives or hand-roll a protocol the overview assigns to Noise;
- replace a specified primitive, protocol or format without explicit approval;
- persist plaintext vault contents, keys or recovery material, including for debugging;
- log keys, secrets, recovery phrases or decrypted item contents;
- add telemetry, analytics or any network call that could carry vault data;
- add a backend or relay server to simplify sync (an optional signaling relay is planned only after v1, see D12);
- silently change the key hierarchy, AAD layout, record format or `.bvault` format;
- weaken or delete a security check or test to make another test pass;
- transfer any key material before SAS confirmation during pairing.

Always:

- bind every ciphertext to its identity through AAD (`recordFormatVersion || recordType || vaultId || recordId || keyEpoch || hlc || deleted`, D21, D32);
- use canonical serialization: fixed length-prefixed binary for AAD and transcripts, strict deterministic CBOR for records and messages;
- version every format and reject unknown or incompatible versions explicitly;
- clear plaintext state and keys on lock.

## How to work

- Write tests first for cryptographic, protocol, storage and backup code. Every security behavior needs negative tests (tampered ciphertext, wrong AAD, wrong key epoch, replay, malformed input).
- Specify a protocol in `docs/` before implementing it.
- Keep changes small and scoped to one package where possible. Read the package's existing code and boundaries before editing.
- When a task maps to a checkbox in `docs/roadmap.md`, tick it in the same change.
- When a test covers a security invariant, record it in `docs/security-invariants.md`.
- If something in the design looks wrong or underspecified, raise it before writing code.

## Definition of Done (security-sensitive changes)

1. Design documented.
2. Relevant invariant identified.
3. Implementation complete.
4. Negative tests exist.
5. Migration implications understood.
6. Protocol or version changes documented.
7. Existing tests pass.
8. No plaintext secret handling introduced.
9. Threat-model implications reviewed.
