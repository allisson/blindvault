# Cryptographic and protocol review — brief

For the external reviewer of the Security Gate item "Cryptographic and protocol review complete,
findings resolved" (`roadmap.md`, Phase 8). It says what to review, where the specification and the
code of each part live, what the project already checks, and how to report a finding. It introduces
no decision: `overview.md` prevails.

## The system in one paragraph

BlindVault is a local-first, end-to-end encrypted personal vault that runs in the browser as a PWA.
There is no data server: data lives on the user's devices and in encrypted `.bvault` backups, and
devices sync peer to peer over a WebRTC DataChannel, after a pairing confirmed by a short
authentication string. Every primitive comes from libsodium (`libsodium-wrappers-sumo` 0.8.4); the
Noise handshakes run on a copied, ported `noise-protocol` state machine.

## Scope

**In scope**

| Part | Specification | Code (lines, excluding tests) |
| --- | --- | --- |
| Primitives, layout encoding, key hierarchy, Argon2id, AEAD, AAD, record format, Vault Key, Recovery Envelope, Local Config wraps, transcripts and MACs, CBOR | `crypto-spec.md` §1–§15 | `packages/crypto/src` (4,493, of which `noise/` 1,178) |
| Noise state machine (copied, D157, D200) | `architecture.md`, "Noise copy as built" | `packages/crypto/src/noise/`, `src/noise.ts` |
| Pairing: payload, `Noise_XX`, commitment and SAS, re-admission | `pairing-protocol.md` | `packages/sync/src` (3,504 for the whole package) |
| Sync: reconnection payload (`Noise_K`), `Noise_KK`, summaries, transfer, merge, retired peers, replay | `sync-protocol.md` | `packages/sync/src`, `packages/vault/src/session.ts`, `merge.ts`, `hlc.ts` |
| Backup: header, keyslots, Argon2id parameters, `secretstream`, restore | `backup-format.md` | `packages/backup/src` (697), `packages/crypto/src/backup-stream.ts`, `keyslot.ts` |
| Verification on receipt and merge rules | `crypto-spec.md` §9.5, `sync-protocol.md` §1 | `packages/vault/src` (5,340 without the import parsers) |
| Storage boundary: only encrypted records and Local Config reach IndexedDB (D82) | overview §6, §7 | `packages/storage/src` (586) |
| Local Config (cleartext and encrypted parts) | `record-content.md` §9, `crypto-spec.md` §12 | `packages/vault/src/local-config.ts`, `packages/crypto/src/local-config.ts` |

**Out of scope** (unless a finding leads there): the UI and its copy, the import parsers other than
`.blindpass` decryption, the build and release pipeline (a separate gate item), and the documented
out-of-scope attackers of `threat-model.md` (compromised OS or browser, malicious extensions, an
unlocked device in hand, the first load).

## Read first

1. `threat-model.md`: assets, trust assumptions, attackers A1–A8 and the status of each threat.
2. `security-invariants.md`: CRYPTO-INV-001 to 024, each with the test that checks it.
3. `crypto-spec.md`, then `pairing-protocol.md`, `sync-protocol.md` and `backup-format.md`.
4. `overview.md` §3 (threat model), §5–§10, and the decision log (§21) for any `Dn` cited.
5. `limitations.md`: what the project tells users it cannot do.

## What the project already checks

- **Test vectors from an independent generator.** `tests/vectors/generate.py` computes the crypto,
  record-content, backup and pairing vectors with Python's `hashlib` and PyNaCl, never the
  TypeScript code (`crypto-spec.md` §15); the TypeScript tests must reproduce them.
- **Noise vectors.** `tests/vectors/noise.py` extracts the official cacophony and snow vectors for
  `Noise_XX`, `Noise_KK` and `Noise_K` in `25519_ChaChaPoly_BLAKE2b`, at pinned commits checked by
  SHA-256; `packages/crypto` reproduces every handshake and transport message in `pnpm test`, and
  `noise-copy.test.ts` checks what they do not reach.
- **Invariants.** Every CRYPTO-INV row cites a passing test (`security-invariants.md`).
- **Negative tests** for tampered ciphertext, wrong AAD, wrong key epoch, replay and malformed input,
  per package; cross-package protocol and recovery tests in `tests/`.
- **Coverage** of 95% enforced on `packages/*` (`pnpm test:coverage`).

## Where a reviewer's attention is most useful

These are the constructions the project designed itself or changed from a source. They are listed
for attention, not because a weakness is known.

1. **The Noise port and its one logic fix** (`architecture.md`, D200): `split` assigns the
   CipherStates by role, where the original swapped them in even-length patterns such as KK. Every
   other change is mechanical (libsodium bindings, wiping, asserts) and listed in each file's
   header.
2. **The SAS with a commitment** (`pairing-protocol.md` §6, D199): six digits from the handshake
   hash and both nonces, the initiator's nonce committed in its payload, claimed one guess in 10⁶
   per pairing even when copy/paste lets a man in the middle replace both payloads.
3. **The prologues** binding both pairing payloads and both DTLS fingerprints (`pairing-protocol.md`
   §5), and the `Noise_K` reconnection payload bound into the `Noise_KK` prologue
   (`sync-protocol.md` §4–§5). `Noise_K` itself has no replay protection; `Noise_KK` provides it
   (D17).
4. **The layout encoding** (`crypto-spec.md` §3) and its claim of one encoding per value list, used
   for AAD, MAC inputs, hash inputs and prologues.
5. **The AAD** (`crypto-spec.md` §8) binding `recordFormatVersion`, `recordType`, `vaultId`,
   `recordId`, `keyEpoch`, `hlc` and `deleted`, and record identity as the pair (`recordType`,
   `recordId`) (D158).
6. **The key hierarchy** (`crypto-spec.md` §5): `crypto_kdf` contexts and subkey IDs, the Recovery
   KEK from the BIP39 entropy without PBKDF2, the recovery keyslot key pair from a derived seed (D16).
7. **Verification on receipt** (`crypto-spec.md` §9.5) before any merge, the 24-hour future-clock
   bound (D76), and tombstones (D27).
8. **Passwords:** Argon2id calibrated to about 1 s with a 64 MiB floor and range checks before
   deriving (D9, D78), the export-password bar of 10^14 estimated guesses (D134).
9. **WebAuthn PRF:** the UV flag checked before any derivation (CRYPTO-INV-021), the local wrap bound
   to `localConfigId` (D121).
10. **Accepted limits** to confirm as stated: no revocation and a Master Key never rotated (D11, §20),
    re-founding as the response (D28), best-effort wiping in JavaScript (CRYPTO-INV-010), the
    metadata left visible (§3).

## Running it

Node 26.13.0 and pnpm 10.33.0 through corepack (`AGENTS.md`).

```sh
pnpm install --frozen-lockfile
pnpm test                                   # Vitest in every workspace
pnpm test:coverage                          # with the 95% gate on packages/*
pnpm --filter @blindvault/crypto exec vitest run src/record.test.ts   # one file
uv run tests/vectors/generate.py            # regenerates the vectors, independently of the TypeScript
uv run tests/vectors/noise.py               # downloads and checks the official Noise vectors
pnpm test:e2e                               # Playwright, Chromium, Firefox and WebKit
```

## Reporting a finding

One entry per finding:

- **Severity:** critical (keys or plaintext exposed, or authentication bypassed, under the threat
  model), high, medium, low, or note.
- **Where:** the document and section, or `file:line` at the commit under review.
- **Scenario:** the attacker of `threat-model.md`, what they hold, the steps and the outcome.
- **Suggestion**, if any.

The project records each finding below with its resolution: fixed (with the pull request), accepted
with a reason recorded as a `Dn` decision, or rejected with a reason. The gate item closes when every
finding has one.

## Findings

| ID | Severity | Where | Summary | Resolution |
| --- | --- | --- | --- | --- |
