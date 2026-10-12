# BlindVault — Architecture

> Complements `overview.md`, which is normative. This document records how the repository is
> built, which dependencies it uses and why, and what is reused from BlindPass.

## Repository

pnpm workspaces: `apps/web`, `packages/{crypto,vault,storage,sync,backup}` and `tests`. Packages are
named `@blindvault/*`, ESM only, and source-only: each `exports` points at `src/index.ts`, and Vite
and Vitest consume the TypeScript directly. There is no package build step. `tsc -b` type-checks
every project through the references in the root `tsconfig.json`.

**Package boundaries** are enforced twice:

- ESLint `no-restricted-imports` on `packages/crypto/**` rejects `@blindvault/*`, `react` and
  `react-dom` (covered by `tests/boundaries.test.ts`).
- Every package is a composite TypeScript project with `include: ["src", ...]` and no project
  references unless it declares a dependency, so `tsc -b` rejects a relative import that leaves the
  package (TS6059/TS6307).

## Dependencies

Every dependency is listed here with its justification. Versions are pinned exactly in
`package.json` and resolved only once they are at least 14 days old (`minimumReleaseAge`). No
dependency may run install scripts (`onlyBuiltDependencies: []`).

### Development tooling

| Dependency | Where | Justification |
| --- | --- | --- |
| `typescript` 6.0 | root | Strict typing (stack). Held on 6.0 because `typescript-eslint` 8 supports `<6.1`. |
| `eslint`, `@eslint/js`, `typescript-eslint`, `globals` | root | Linting with type information (`strictTypeChecked`) and the package-boundary rule. |
| `prettier` | root | Formatting. Markdown is excluded so the normative docs keep their hand formatting. |
| `@types/node` 24 | root, `apps/web` | Types for config files and tests running in Node. Matches the pinned Node major. |
| `vitest`, `@vitest/coverage-v8` | each package, `tests` | Unit tests (stack) and the 95% coverage gate on `packages/*`. |
| `@playwright/test` | `apps/web` | End-to-end tests on Chromium, Firefox and WebKit (stack). |
| `vite`, `@vitejs/plugin-react` | `apps/web` | Build and dev server (stack). |
| `tailwindcss`, `@tailwindcss/vite` | `apps/web` | Styling (stack). |
| `@types/react`, `@types/react-dom` | `apps/web` | Types for React. |

### Runtime

| Dependency | Where | Justification |
| --- | --- | --- |
| `react`, `react-dom` | `apps/web` | UI (stack). |

Runtime cryptographic, serialization and protocol dependencies are added with their phase. The
ones already chosen are below.

### Phase 0 spikes (`spikes/`, throwaway, deleted)

The spike workspace was deleted after Phase 0 (last version at commit `3f29c12`). What follows
records how it was built.

`libsodium-wrappers-sumo`, `qrcode-generator`, `barcode-detector` and `zxing-wasm` (its WASM served
from the same origin, never a CDN) are dependencies of the throwaway spike workspace only, outside
lint and CI, and are deleted with it after Gate 0. They become product dependencies only when a
phase adds them here with a justification; the spike measures the QR pair the product would use
(`docs/spikes/README.md`).

### Chosen for later phases (Phase 0 selection, Gate 0)

**Noise: copied `noise-protocol` state machine, no runtime dependency (D1, D157).** Evaluated on
2026-10-09:

| Candidate | Outcome |
| --- | --- |
| `noise-protocol` 3.0.2 (emilbayes, ISC) | **Chosen as the source to copy.** Every pattern, including XX and KK, in `25519_ChaChaPoly_BLAKE2b`; primitives injectable through `createHandshake`; prologue and handshake hash exposed. Reproduces the cacophony XX and KK vectors, handshake hash included (first vector per protocol name checked in the evaluation). Unmaintained since 2023, labelled beta, depends on `sodium-universal` and Node `Buffer`: hence copied and rebound to `libsodium-wrappers-sumo` instead of depended on. |
| `noise-handshake` 4.2.0 (holepunchto) | Maintained and matches cacophony XX, but has no KK, and hash and AEAD are hardwired to `sodium-universal`. Adding KK would be a change to protocol code. |
| `salty-crypto` 1.0.0-rc.4 | Clean TS API and ships noise-c/snow vectors, but only BLAKE2s, release candidate, very low usage. |
| `@libp2p/noise` | XX only, SHA-256 hardcoded, coupled to libp2p. |
| `noise-c.wasm` | Archived since 2021. |

Conditions: the copied files keep the ISC notice; the handshake logic is not modified; CI runs the
cacophony and snow vectors for both protocol names; a later maintained library that passes the
same vectors may replace the copy.

**CBOR: `cbor2` with a strict decoder plus a re-encode check (D10).** Evaluated on 2026-10-09 by
decoding malformed inputs:

| Candidate | Outcome |
| --- | --- |
| `cbor2` 2.x (hildjj, MIT, one small dependency `@cto.af/wtf8`, ~14 KB gzip) | **Chosen.** The only candidate whose decoder enforces all of RFC 8949 §4.2: shortest integers and lengths, definite lengths, bytewise-sorted unique map keys, preferred floats. Options: `cde`, `rejectDuplicateKeys`, `rejectLongFloats`, `rejectUndefined`, `rejectSimple`, `ignoreGlobalTags` with no tags; encoding with `cde`. |
| `cborg` 6.x | Strict on integers, lengths, indefinite length and duplicates, but cannot reject unsorted keys or long floats on decode. |
| `@ipld/dag-cbor` | DAG-CBOR, not §4.2: float64 only, length-first key order, no order check. |
| `cbor-x`, `microcbor`, `@levischuck/tiny-cbor` | Lax decoders or no key-order check. |

As a second barrier against a decoder regression, every decode re-encodes the value with the
deterministic encoder and requires byte equality with the input.

No published security audit was found for any candidate in either category.

## BlindPass inventory

BlindPass (`../blindpass`, v0.11.0) was read on 2026-10-09; nothing there was modified. Reused code
is copied, adapted to the overview, and gets the same tests and review as new code.

### Reuse decisions

| BlindPass module | Decision | Notes |
| --- | --- | --- |
| `packages/crypto/src/lib/sodium.ts` (loader) | Reuse with changes | Same build, `libsodium-wrappers-sumo` 0.8.x. |
| `packages/crypto/src/lib/symmetric.ts` (secretbox) | Do not reuse for vault data | Only the `crypto_secretbox_open_easy` call is copied, for `.blindpass` import (D126). Vault data uses XChaCha20-Poly1305 with AAD. |
| `packages/crypto/src/lib/kdf.ts`, `apps/web/src/workers/kdf.worker.ts` | Reuse with changes | Argon2id in a worker. Add device calibration to about 1 s with a 64 MiB floor (D9); `SENSITIVE` limits only for `.blindpass` import (D126). |
| `packages/crypto/src/lib/asymmetric.ts` (sealed box) | Reuse with changes | Add `crypto_box_seed_keypair` for the recovery keyslot (D16). |
| `packages/crypto/src/keys/recovery.ts` | Reuse BIP39 generation only | BlindPass uses the raw entropy as the wrapping key; BlindVault derives the Recovery KEK with `crypto_kdf` and subkeys (D2). |
| `packages/crypto/src/lib/verification.ts` (BIP39 fingerprint) | Do not reuse | The SAS comes from the Noise handshake hash (D1). |
| `packages/crypto/src/lib/totp.ts` (`otpauth`) | Do not reuse | Own RFC 6238 implementation over WebCrypto HMAC (D127), tested with the RFC 6238 vectors; `otpauth` only as a dev-time cross-check. |
| `packages/vault` item schemas (Zod) | Reuse with changes, Phase 1 | Templates and field types differ (overview §6, D20). Zod is justified here when it is added. |
| `packages/vault/src/export` (`.json`, `.blindpass`) | Reuse decoding only, Phase 6 | BlindPass input format (D123); documented in `docs/blindpass-format.md` when first needed. |
| `apps/web/src/lib/import/parsers/*` (Chrome, LastPass, Bitwarden, Apple Keychain, KeePassXC, Proton Pass, 1Password, Dashlane) | Reuse with changes, Phase 6 | D124, D125. |
| `apps/web/src/lib/biometric/*` (WebAuthn PRF) | Reuse with changes | Add the UV flag check (D75), the BE flag notice (D84) and AAD on the local wrap (D121). |
| `apps/web/src/lib/vaultCache.ts` (raw IndexedDB) | Do not reuse | Different schema (D79, D82). The raw IndexedDB API without a wrapper library is kept as the approach. |
| `@zxcvbn-ts/core` and language packs | Reuse | D71 and D134 need the guess estimate, which it exposes. |
| PWA setup (`vite-plugin-pwa` generateSW, autoUpdate, `skipWaiting`, `clientsClaim`) | Do not reuse | Contradicts D63 and D142. |
| UI stack (TanStack Router and Query, shadcn/Base UI) | Decide in Phase 1 | TanStack Query manages server state, which BlindVault does not have. |
| Server, API schema, PostgreSQL, Redis, Docker, Terraform | Do not reuse | Excluded by `AGENTS.md`. |

### Differences between BlindPass crypto and the overview (the overview wins)

| Topic | BlindPass | BlindVault |
| --- | --- | --- |
| AEAD | `crypto_secretbox` (XSalsa20-Poly1305), no AAD anywhere | XChaCha20-Poly1305 with AAD binding every record (D8, D21) |
| Key derivation | No `crypto_kdf`; the master key wraps keys directly | Master Key used only through `crypto_kdf` subkeys (D23) |
| Hierarchy | password → KEK → master key → (X25519 private key, recovery mnemonic, vault key) → item keys | password → Device KEK → Master Key → Vault Key per `keyEpoch` → record key per record (§5.2) |
| Recovery | 32-byte BIP39 entropy used directly as the secretbox key; mnemonic stored encrypted and a verifier sent to the server | Entropy → `crypto_kdf` → Recovery KEK → envelope and keyslot subkeys; phrase never stored (D2, D16) |
| Argon2id | `SENSITIVE` limits (1 GiB) everywhere | Calibrated to about 1 s with a 64 MiB floor (D9) |
| Serialization | `JSON.stringify`, base64 in JSON | Deterministic CBOR for records, length-prefixed binary for AAD and transcripts (D10) |
| Padding | None | `sodium_pad` to 256-byte blocks (D92) |
| Device identity | X25519 key pair for vault sharing, fingerprint as BIP39 words | Noise static key, `deviceId = BLAKE2b-128(public key)` (D19) |
| PRF wrap | Secretbox of the master key, no AAD | AEAD with `purpose ‖ vaultId ‖ localConfigId` (D121), UV required (D75) |

### Tests and vectors to carry over

- BIP39 vectors and negative cases (`packages/vault/src/item/cryptoWallet/bip39.test.ts`).
- Negative patterns: wrong key, wrong key pair, wrong mnemonic, tampered ciphertext, unknown type
  and version (`packages/crypto`, `packages/vault/src/__tests__`, `export.test.ts`).
- Import parser fixtures and tests (`apps/web/src/lib/import/__tests__/`), Phase 6.
- BlindPass has no known-answer vectors for libsodium primitives and no tamper tests at the
  primitive level; BlindVault writes these new.
