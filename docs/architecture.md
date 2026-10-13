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

## Phase 1 structure

- **Vault session (D163).** `packages/vault` holds the unlocked session: key handles, the HLC, the
  in-memory decrypted state and every domain operation. It writes through a `RecordStore` interface
  it defines; `packages/storage` implements it, and `apps/web` only wires them together. `vault`
  depends on `crypto`; `storage` depends on the encrypted record types from `crypto`.
- **Record store (D163).** `RecordStore` has two calls: `records()`, read once at unlock, and
  `commit()`, which applies records put, records deleted (only pruned and purged Item Versions) and
  the whole new Local Config in one transaction. Every commit re-seals the Local Config encrypted
  part around the current HLC state (D62). The session runs one operation at a time, builds its
  writes from the held state, and applies them in memory only once the commit succeeds; an
  operation that changes nothing commits nothing. A lock aborts the operation in progress.
- **Unlock.** The KEK opens the Master Key wrap (any failure is one `UnlockRejectedError`), the
  Master Key's subkey opens the encrypted part (a failure is a corrupt Local Config), and every
  record is verified as on receipt (`crypto-spec.md` §9.5). A record that fails, an invalid Folder
  or Device value (D59), or a record stored under another key than its header's is kept aside as
  corrupt: never shown, never written.
- **Maintenance.** The automatic purge and the history cut run at unlock and every hour while
  unlocked, against an injectable clock; they issue no HLC, so they run while the vault is
  read-only (D73, D94). A failed pass changes nothing and is retried at the next one.
- **Device identity bytes.** The encrypted part of Local Config holds the identity's private key,
  so `packages/crypto` seals and opens that part (`sealLocalConfigPart`, `openLocalConfigPart`):
  `packages/vault` never reads the private key as bytes, and the opened plaintext is wiped.
- **Envelopes in `crypto`.** The record envelope codec and the verification steps of
  `crypto-spec.md` §9.5 live in `packages/crypto`, since its tests reproduce the vectors.
- **Recovery Phrase at creation (Phase 2, D179).** `VaultController.newRecoveryPhrase` generates
  the phrase into a keyring of its own and hands the UI the words once; the controller keeps only
  the entropy handle, which a lock or a new phrase wipes. `create` makes that keyring the new
  session's, and `VaultSession.create` derives the recovery keys, seals the Recovery Envelope in
  the founding commit and releases the entropy, `K_envelope` and the keyslot private key at once,
  keeping only the public key in the envelope's metadata. The words are a string, which cannot be
  wiped: the creation screen drops them from its state once they are confirmed.
- **Check Recovery Phrase (Phase 2, D180).** The session keeps each Recovery Envelope's stored
  bytes with its metadata. `VaultSession.checkRecoveryPhrase` parses the typed words into a
  keyring of its own, wiped before it returns, and `checkRecoveryEnvelope` in `crypto` derives the
  recovery keys, opens `mk` and compares `K_vaultKeyWrap` of the Master Key it opens with the
  session's, since the session holds no Master Key. Settings empties the field once the words are
  checked.
- **Backup payload in `crypto` (Phase 2).** The `.bvault` payload holds the Master Key's bytes, so
  `packages/crypto` builds and reads the stream and payload of `backup-format.md` §5 and §6
  (`BackupStreamWriter`, `openBackupStream`), as it does the Local Config encrypted part. The file
  format around it, header and keyslots (§2, §3, §7), lives in `packages/backup`, which depends on
  `crypto` only. A payload is parsed only once its final chunk authenticates, and the plaintext is
  wiped either way. The keyslots seal and open the file key in `crypto` too (`sealKeyTo`,
  `openSealedKey`, `wrapKey`); the export password KEK comes from the Argon2id worker at the fixed
  export parameters (`derivePasswordKek`) and lives in a keyring of its own, wiped once the file key
  is wrapped or unwrapped.
- **Backup export (Phase 2, D181).** `packages/vault` depends on `packages/backup`, which depends
  on `crypto` only: `VaultSession.exportBackup` opens the Master Key wrap with the KEK the caller
  derived again, verifies every stored record as `load` does, and builds the file with the backup
  keyslots and `sealBackup`, all in a keyring of its own, wiped before it returns. The session's
  operation queue takes an asynchronous build for it, since the export password KEK comes from the
  Argon2id worker; a lock during that build rejects with `VaultLockedError` and commits nothing.
  `apps/web` derives the Device KEK, or asks the passkey for the PRF KEK, and hands the file to the
  browser as a download; it never holds the Master Key.
- **Restore validation (Phase 2).** `packages/backup` runs `backup-format.md` §8 steps 3 to 8 in
  `restoreWithPhrase` and `restoreWithPassword`: the keyslot, the stream, the verification of
  every record with the Vault Keys the payload's Master Key unwraps, and the Recovery Envelope
  checks. Every key it uses lives in a keyring of its own, wiped before it returns; only the
  Master Key goes to the caller's keyring, and only on success. It writes nothing: applying the
  records, including the domain checks of D59, belongs to the fresh restore in `packages/vault`.
- **Fresh restore (Phase 2, D33).** `VaultSession.restore` takes a validated backup, reads its
  records with the same `load` as unlock, so a record that fails the content checks of D59
  rejects the whole restore (D61, D64), and writes every envelope as it came with a new Local
  Config in one commit. The device gets a new identity and `localConfigId`, writes no Device
  record (D30), keeps the default preferences, records no backup date (§13.4, a backup of this
  device) and takes the restored envelope's `phraseId` as the last seen. Its HLC starts at the
  clock and receives every restored HLC, so records beyond the bound stay read-only while the vault
  is writable (D39, D109). `apps/web` reads the file with `<input type="file">`, keeps it and then
  the validated backup in memory, and asks for the local password last, as creation does; the
  commit opens the database lazily under the installation guard and the vault lock, and a lock
  before it wipes the backup's Master Key and writes nothing (D104). Replacing a vault the device
  holds (D89, D153) is not offered yet: restore is reached only with no vault.
- **Key handles.** Keys never leave `packages/crypto` as bytes: a key is an opaque object whose
  bytes sit in a private field, used only by `crypto` functions. Every handle is registered in a
  keyring; lock wipes them all with `sodium_memzero`, and any later use throws (CRYPTO-INV-005,
  CRYPTO-INV-010).
- **Argon2id worker.** The worker entry lives in `packages/crypto` and loads its own libsodium;
  `apps/web` starts it through Vite's worker import (`import KdfWorker from
  '@blindvault/crypto/kdf.worker?worker'`, bundled as its own module worker) and hands it to `deriveDeviceKek` or `calibrateDeviceKek`, which take any
  `KdfPort` (tests run the handler in-process). One worker serves one request: the password is
  transferred to it and wiped on both sides, it returns the Device KEK, and the client terminates it.
  Parameters outside the accepted range are refused before the worker starts.
- **Load at unlock.** Unlock decrypts every record into memory. An Item Version's `itemId` is
  encrypted, so versions cannot be found per item without decrypting, and search (D132) needs the
  whole state anyway. A load test (2,000 items × 20 versions) checks the cost in Phase 1.
  - **Load test** (`apps/web/e2e/load.spec.ts`, opt-in: `BV_LOAD_TEST=1 pnpm exec playwright
    test e2e/load.spec.ts --workers=1`). `e2e/load-fixture.ts` builds the vault in Node through
    `VaultSession` (2,000 login items, each edited 20 times: 42,002 records with the Vault Key and
    Device records), the Device KEK coming from the Argon2id worker entry run in-process. The
    spec writes it into the browser's IndexedDB and times the Unlock click to the unlocked vault,
    against an empty vault at the same Argon2id parameters (`opslimit` 3, 64 MiB).
  - **Measured** on 2026-10-12, Apple M1, 16 GB, Playwright 1.63.0 browsers, one browser at a
    time, two runs each:

    | Run | Empty vault | 42,002 records, first | After the fixes below |
    | --- | --- | --- | --- |
    | Chromium | 211–232 ms | 9.2–10.3 s | 8.0 s |
    | Firefox | 316–446 ms | 14.4–15.3 s | 11.7–12.5 s |
    | WebKit | 217–233 ms | 61.1–64.5 s | 6.0–6.5 s |
    | Node, records in memory, `VaultSession.unlock` only | | 11.8 s | 5.8–6.2 s |

    Reading the 42,002 records with `getAll` takes 130–210 ms in every browser; libsodium is about
    3% of the time, and the tree and the search index under 15 ms. Two fixes came out of it:
    - `VaultDatabase.records()` read `IDBRequest.result` once per record, which is quadratic in
      WebKit: with 4,202 records it took 535 ms there, and 15 ms once each `result` is read once
      (`database.test.ts` › reads each request’s result once).
    - `encodeCbor` passes `chunkSize: 256` to cbor2, which allocated a 4 KiB writer for each map
      key it sorts. The encoded bytes do not change (the CBOR and record vectors pass).

    What remains is mostly CBOR: the re-encode check of `crypto-spec.md` §14 on the envelope and
    the content, and `itemContentLength` encoding the item again for the cap (§9.5 step 9). No
    unlock target is set.
- **IndexedDB layout.** Database `blindvault-<vaultId>` (D79) with two object stores: `records`,
  keyed by `[recordType, recordId]` (D158) with no other index, and `localConfig`, holding the one
  Local Config value (`record-content.md` §9). Both are written in one transaction (D82).
- **Storage (`packages/storage`).** It imports only `@blindvault/crypto` (ESLint, covered by
  `tests/boundaries.test.ts`) and never parses records or Local Config. `vaultId` in names is
  lowercase hex, and the vault's Web Lock has its database's name.
  - **Sealed records only.** A record is accepted as `EncryptedRecord`, whose `RecordEnvelope`
    type only `encodeEnvelope` (and so every `seal*` function) produces; `VaultSession`'s
    `StoredRecord` is the same type. A commit also decodes each envelope (steps 1 to 5 of
    `crypto-spec.md` §9.5, nothing decrypted) and refuses one whose header is not its key, before
    any write. Each value is copied before it is written, since IndexedDB stores a view's whole
    underlying buffer.
  - **Commits.** One `readwrite` transaction with `durability: 'strict'`; a request that throws
    aborts it, so nothing queued before it commits. On `versionchange` (erase or upgrade in another
    app window) the connection closes instead of blocking it, and later calls throw
    `StorageClosedError`.
  - **Schema.** `MIGRATIONS[n]` moves version `n` to `n + 1` inside the `versionchange`
    transaction. A database at a higher version than this app knows is refused
    (`UnsupportedSchemaError`), never opened, rewritten or deleted.
  - **Web Locks.** Requests are `ifAvailable`, or `steal` for take-over, so no app window waits
    behind another; a held lock reports a take-over through `lost`, and the app then locks the
    vault (D51). The installation guard is `blindvault-installation` (D97, D108).
  - **Startup cleanup (D89, D96, D154).** Run under the installation guard: deletes every
    `blindvault-<vaultId>` database without Local Config, then each committed database another
    committed one names in `replacesVaultId`, only if its Web Lock is free, and finally clears that
    `replacesVaultId` once the replaced database is gone, read and rewritten in one transaction.
    `apps/web` passes the reader of `replacesVaultId` from `packages/vault`.
  - **Persistence.** `requestPersistence()` and `storageStatus()` wrap `persist()`,
    `persisted()` and `estimate()`, reporting `null` where the browser gives nothing.
- **App window lifecycle (`apps/web/src/app/controller.ts`).** One `VaultController` per app
  window wires `packages/vault` to `packages/storage` and implements no cryptography. At start it
  runs the cleanup under the installation guard, then holds the vault's Web Lock or shows the
  take-over screen (D51); a lost lock locks the vault. Creation holds the installation guard until
  its one commit; every lock bumps an epoch, and a creation or unlock started before it is aborted
  with nothing persisted (D104). The Device record name is "<browser> on <system>" from the user
  agent, which never chooses the layout (D15).
- **Locks while unlocked.** `LockTimers` runs the inactivity lock (user input restarts it) and the
  hidden-app lock (`visibilitychange`, 0 locks at once) independently, from the vault's
  preferences (D54, D151). Ctrl/⌘ + Shift + L locks. Navigation resets to the vault root on lock.
- **Navigation (D167).** An in-memory screen stack: a list (all items, a folder or the trash),
  then at most one detail (an item, its editor, a new item) or Settings; no router. ESLint forbids `history.pushState`,
  `history.replaceState` and writing `location.hash`, `search`, `assign` and `replace` in
  `apps/web/src` (covered by `tests/boundaries.test.ts`); Playwright checks the URL and history
  length after the flows.
- **Layouts (D15).** `useLayout` reads two width media queries (640 and 1024 px); the three shells
  place the same panes and hold no vault or security logic.
- **Password strength (D71).** zxcvbn-ts with the common, English and Portuguese dictionaries,
  loaded on first use; feedback in the UI language; score 4 required before create or change.
- **Item editor (`apps/web/src/app/item-draft.ts`).** The editor holds a draft of text as typed
  and converts it to the session's `ItemInput` with the rules of `record-content.md` §3–§4,
  reported per field; the session checks the content again when it writes. Empty fields are not
  written, title and labels are trimmed, single-line values other than secrets are trimmed, a seed
  phrase is normalized (`normalizeSeedPhrase`) and a bad BIP39 checksum is shown, not refused.
  Editing loads the item's fields in order, then the template roles it lacks, empty, so saving
  untouched content writes nothing (D165). A TOTP field takes an `otpauth://` URI or a bare TOTP
  secret in a masked input, parsed by `parseOtpauthUri` or `parseTotpSecret` into the stored map;
  the URI is not kept, and an empty input keeps the stored value. Panes read the session again
  after each write; the session is the only state.
- **Folders (D14, D171).** The folder pane and the move targets come from the tree the session
  derives, so orphans and cycles show as on every device. A folder's move targets leave out its
  displayed subtree; the session still refuses a cycle or a target in the trash. A folder list
  shows its subfolders, then its items; a new item starts in the folder shown. Trashing or
  restoring a subtree that holds read-only records is refused as a whole, and the UI lists those
  records and why (overview §6). The trash lists folders with Restore only (D143).
- **Duplicate and history (D135, D140, D156, D169).** `VaultSession.duplicateItem` writes the
  current content under a new ID and a fresh HLC, with no history, its title followed by the
  localized suffix the UI passes; it goes in the folder where the tree shows the original, the
  vault root for an orphan. It refuses content from a newer app version, an item in the trash, and
  a title or item the suffix takes past its cap, writing nothing; an item beyond the future-clock
  bound is copied. The history view lists the Item Versions newest first, secrets masked, each
  restorable as a new edit, and says that old values stay until the original is trashed and
  purged, and how to remove them; neither Duplicate nor History is offered in the trash.
- **Passkey unlock (§5.5, D75, D84, D120, D172, `apps/web/src/app/passkey.ts`).** The only
  WebAuthn calls: `create` and `get` with `userVerification: "required"` and the PRF evaluated at
  the PRF input, a random challenge (no server checks it), a random user ID and no attestation.
  Support is detected from `getClientCapabilities()` where the browser has it, otherwise by the
  ceremony. Each ceremony runs first in the click, while its user activation lasts; then the
  controller reads the UV flag and derives the PRF KEK in `@blindvault/crypto` and, at setup,
  checks the local password, and `VaultSession.setPasskey` wraps the Master Key with
  `purpose ‖ vaultId ‖ localConfigId`. A PRF output only at a later get is fetched with a second
  prompt. The setup says what then protects a lost device, and for a backup-eligible credential
  that the vault depends on its platform account. A credential that ends up wrapping nothing, after
  a wrong password, a lock or a failure, and a removed one are signalled with
  `signalUnknownCredential` where the browser has it; otherwise the UI says to delete it by hand.
  Playwright drives it with Chromium's virtual authenticator, which never returns an assertion
  without UV when UV is required, so the test clears the UV flag of a real assertion to stand for a
  client that does not honor it.
- **Search (D132, `apps/web/src/app/search.ts`).** An in-memory index built from the derived tree
  while a query runs: titles, tags, the folder names on the item's path, notes and the values of
  every field type but `secret`, `totp` and `seed-phrase`. Text and query are NFKD, without marks,
  lowercase; every term must match. It covers items not in the trash, across folders. The index
  is cleared whenever no search runs and when the shell unmounts on lock; the query is React state
  only, never in `localStorage`, the URL or the history. Ctrl/⌘ + K focuses it.
- **Secrets in the UI (overview §13.2).** Secret, seed-phrase and TOTP-secret values show a
  fixed-length mask until the user reveals them, in every layout; the detail pane is keyed by
  item, so a reveal never carries to another item. In the editor a masked secret is a password
  input, which cannot hold line breaks: a multi-line secret shows the mask until revealed, so
  masking never alters it. Only `http` and `https` URLs get an open link (D83). A TOTP field
  shows its current code unmasked, recomputed with `totpCode` at each time step, and its TOTP
  secret masked (D127).
- **Clipboard (D54, D127, D151, `apps/web/src/app/clipboard.ts`).** A secret, seed phrase, TOTP
  secret or TOTP code is copied only from its Copy button, without being revealed. One guard per
  app window schedules the clear after `clipboardClearSeconds`, refusing a value outside 10–120;
  a newer copy restarts it. Browsers refuse a clipboard write from a page in the background, so a
  timeout that passes without focus clears on the next focus, and a lock clears at once or on the
  next focus the same way. The clear writes an empty string, and a refused clear is dropped: the
  UI says clearing is not guaranteed.
- **Password generator (D128).** The editor's generator calls `generatePassword` or
  `generatePassphrase` from `packages/crypto` and puts the value straight into the field; its
  settings (mode, length, sets, words) are the only thing kept, in `localStorage` under
  `blindvault.generator`, read back with every invalid value replaced by its default.
- **i18n.** UI copy in `en` and `pt-BR` from Phase 1; template role names are localized, so a
  field without a label reads in the viewer's language (D165).

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
| `vitest`, `@vitest/coverage-v8` | each package, `tests`, `apps/web` (`vitest` only) | Unit tests (stack) and the 95% coverage gate on `packages/*`. |
| `@playwright/test` | `apps/web` | End-to-end tests on Chromium, Firefox and WebKit (stack). |
| `vite`, `@vitejs/plugin-react` | `apps/web` | Build and dev server (stack). |
| `tailwindcss`, `@tailwindcss/vite` | `apps/web` | Styling (stack). |
| `@types/react`, `@types/react-dom` | `apps/web` | Types for React. |
| `fake-indexeddb` 6.2.5 | `packages/storage`, `tests`, `apps/web` | An in-memory IndexedDB for Vitest in Node, which has none; the storage tests and the vault-over-IndexedDB test run on it, and Playwright covers real browsers. No runtime dependencies, no install scripts. Test only, never bundled. Phase 1. |

### Runtime

| Dependency | Where | Justification |
| --- | --- | --- |
| `react`, `react-dom` | `apps/web` | UI (stack). |
| `libsodium-wrappers-sumo` 0.8.4 | `packages/crypto` | Every primitive of `crypto-spec.md` §2 (stack, §5.1). The sumo build is needed for `crypto_pwhash` and `crypto_kdf`. Same line as BlindPass. Phase 1. |
| `cbor2` 2.3.0 | `packages/crypto` | Deterministic CBOR with a strict decoder (D10), chosen at Gate 0 (below). Phase 1. |
| `@scure/bip39` 2.4.0 | `packages/crypto`, `packages/vault` | BIP39 encoding of the Recovery Phrase (D2), the passphrase word list (D128) and seed-phrase word checks (stack). Encoding only: its PBKDF2 seed is never used, and its entropy comes from libsodium's RNG, never from its own generator. Its one dependency, `@noble/hashes` 2.4.0, supplies the SHA-256 of the checksum. Same line as BlindPass. Phase 1. |
| `@zxcvbn-ts/core` 3.0.4, `@zxcvbn-ts/language-common` 3.0.4, `-language-en` 3.0.2, `-language-pt-br` 3.0.2 | `apps/web` | Local password strength at score 4 (D71) and the export password guess estimate (D134). Phase 1. |
| `@base-ui/react` 1.x | `apps/web` | Headless, accessible dialog, menu and popover primitives, already used by BlindPass; no styling of its own, so Tailwind stays the only styling layer. Phase 1. |

Each is pinned to an exact version at least 14 days old when its phase adds it. Runtime
cryptographic, serialization and protocol dependencies of later phases are added with their phase.
The ones already chosen are below.

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
| `packages/vault` item schemas (Zod) | Do not reuse | BlindPass has fixed keys per item type; BlindVault has typed fields with roles (D165, `record-content.md`). Content is checked by hand-written validators, not Zod, because unknown keys must be detected and kept byte for byte (D52, D59), which is the central rule. The BlindPass schemas are a reference for field lists only. |
| `packages/vault/src/item/cryptoWallet/bip39.ts` | Reuse with changes, Phase 1 | Word-list and checksum helpers for the seed-phrase field; a bad checksum warns instead of refusing (`record-content.md` §4). |
| `apps/web/src/lib/totp.ts` (`parseOtpauthUri`) | Reuse with changes, Phase 1 | The `otpauth://` parser (D127), moved to `packages/crypto`, writing defaults explicitly. The lenient import parser (`apps/web/src/lib/import/totp.ts`) is copied in Phase 6. |
| `packages/vault/src/export` (`.json`, `.blindpass`) | Reuse decoding only, Phase 6 | BlindPass input format (D123); documented in `docs/blindpass-format.md` when first needed. |
| `apps/web/src/lib/import/parsers/*` (Chrome, LastPass, Bitwarden, Apple Keychain, KeePassXC, Proton Pass, 1Password, Dashlane) | Reuse with changes, Phase 6 | D124, D125. |
| `apps/web/src/lib/biometric/*` (WebAuthn PRF) | Reuse with changes | Add the UV flag check (D75), the BE flag notice (D84) and AAD on the local wrap (D121). |
| `apps/web/src/lib/vaultCache.ts` (raw IndexedDB) | Do not reuse | Different schema (D79, D82). The raw IndexedDB API without a wrapper library is kept as the approach. |
| `@zxcvbn-ts/core` and language packs | Reuse | D71 and D134 need the guess estimate, which it exposes. |
| PWA setup (`vite-plugin-pwa` generateSW, autoUpdate, `skipWaiting`, `clientsClaim`) | Do not reuse | Contradicts D63 and D142. |
| UI stack (TanStack Router and Query, shadcn/Base UI) | Base UI only | No router: navigation state lives in memory, so no vault identifier reaches the URL or history (D167). No TanStack Query, which manages server state BlindVault does not have. State is read with `useSyncExternalStore` over the vault session, with no state library. |
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
