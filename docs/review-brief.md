# Cryptographic and protocol review — brief

For the external reviewer of the Release Gate item "External cryptographic and protocol review of
the whole app" (`roadmap.md`, Phase 10, D276). It covers the PWA, attachments, the browser
extension, stored passkeys and the Android app. It says what to review, where the specification and
the code of each part live, what the project already checks, and how to report a finding. It
introduces no decision: `overview.md` prevails.

## The system in one paragraph

BlindVault is a local-first, end-to-end encrypted personal vault that runs in the browser as a PWA.
There is no data server: data lives on the user's devices and in encrypted `.bvault` backups, and
devices sync peer to peer over a WebRTC DataChannel, after a pairing confirmed by a short
authentication string. Every primitive comes from libsodium (`libsodium-wrappers-sumo` 0.8.4); the
Noise handshakes run on a copied, ported `noise-protocol` state machine.

An item can hold attachments, each file encrypted as an immutable blob under a key of its own. The
browser extension (Chrome, Firefox) and the Android app are full installations of the same `apps/web`
build, each a separate device of the vault joined by pairing. The extension fills passwords and
signs with passkeys stored in items; the Android app unlocks with a key held in the Android Keystore
behind a biometric, and answers Credential Manager and autofill requests.

## Scope

**In scope**

| Part | Specification | Code at `3510f97` (lines, excluding tests) |
| --- | --- | --- |
| Primitives, layout encoding, key hierarchy, Argon2id, AEAD, AAD, record format, Vault Key, Recovery Envelope, Local Config wraps, transcripts and MACs, CBOR | `crypto-spec.md` §1–§15 | `packages/crypto/src` (5,366, of which `noise/` 1,178) |
| Noise state machine (copied, D157, D200) | `architecture.md`, "Noise copy as built" | `packages/crypto/src/noise/`, `src/noise.ts` |
| Pairing: payload, `Noise_XX`, commitment and SAS, re-admission | `pairing-protocol.md` | `packages/sync/src` (4,020 for the whole package) |
| Sync: reconnection payload (`Noise_K`), `Noise_KK`, summaries, transfer, merge, retired peers, replay | `sync-protocol.md` | `packages/sync/src`, `packages/vault/src/session.ts`, `merge.ts`, `hlc.ts` |
| Backup: header, keyslots, Argon2id parameters, `secretstream`, restore | `backup-format.md` | `packages/backup/src` (890), `packages/crypto/src/backup-stream.ts`, `keyslot.ts` |
| Verification on receipt and merge rules | `crypto-spec.md` §9.5, `sync-protocol.md` §1 | `packages/vault/src` (6,354 without the import parsers and the Public Suffix List data) |
| Storage boundary: only encrypted records, blobs and Local Config reach IndexedDB (D82) | overview §6, §7, `attachments.md` §4 | `packages/storage/src` (703) |
| Local Config (cleartext and encrypted parts) | `record-content.md` §9, `crypto-spec.md` §12 | `packages/vault/src/local-config.ts`, `packages/crypto/src/local-config.ts` |
| Attachments: blob stream and `blobId`, the `attachment` field, the blob phase of sync and admission, backup format version 2, collection, download (D273, D277–D279) | `attachments.md`, `record-content.md` §4, `sync-protocol.md` §10.1, `pairing-protocol.md` §8–§9, `backup-format.md` | `packages/crypto/src/blob.ts` (129), `packages/sync/src/blobs.ts` and `blob-messages.ts` (321), `packages/vault/src/attachment.ts`, `session.ts`, `packages/storage/src/database.ts`, `apps/web/src/app/attachments.ts` |
| Extension: the session host, RPC senders, matching and the Public Suffix List, filling, locks, the version lock (D267, D270, D282–D287) | `extension.md` §1–§6, §8 | `apps/extension/src` (753), `apps/extension/build` (284), `apps/web/src/extension` (2,191, passkeys included), `apps/web/src/platform/extension*.ts` (320), `packages/vault/src/match.ts`, `psl/psl.ts` |
| Stored passkeys: interception, the `rpId` check, `clientDataJSON`, authenticator data, ES256 and EdDSA, the PKCS#8 layouts, the confirmation window, messages (D268, D288, D289) | `extension.md` §7, `record-content.md` §4 (`passkey`) | `packages/crypto/src/webauthn.ts` (300), `apps/web/src/extension/passkey*.ts`, `apps/extension/src/passkey-main.js`, `passkey-isolated.js`, `background.js` |
| Android Keystore KEK: derivation, the Master Key wrap, the bridge's part, invalidation (D271, D290, D292) | `crypto-spec.md` §5.3, §12, `android.md` §5 | `packages/crypto/src/keystore.ts`, `apps/web/src/app/keystore.ts`, `ShellKeystore.kt` |
| Android shell: the WebView, the bridge, the credential provider, `assetlinks.json` binding, autofill (D269, D290, D297, D301–D304) | `android.md` §3, §6–§9 | `apps/android/app/src/main/java/` (2,219, Kotlin), `apps/web/src/platform/android*.ts`, `apps/web/src/app/provider-flow.ts`, `keystore.ts` (2,043 together) |

**Out of scope** (unless a finding leads there): the UI and its copy, the import parsers other than
`.blindpass` decryption, the build and release pipeline (a separate gate item), the platforms the
threat model trusts (the browser's extension APIs, Android's Keystore, Credential Manager and
WebView), and the documented out-of-scope attackers of `threat-model.md` (compromised OS or
browser, malicious extensions, an unlocked device in hand, the first load).

## Read first

1. `threat-model.md`: assets, trust assumptions, attackers A1–A10 and the status of each threat.
2. `security-invariants.md`: CRYPTO-INV-001 to 029, each with the test that checks it.
3. `crypto-spec.md`, then `pairing-protocol.md`, `sync-protocol.md` and `backup-format.md`.
4. `attachments.md`, `extension.md` and `android.md`, each with its threat-model section.
5. `overview.md` §3 (threat model), §5–§10, and the decision log (§21) for any `Dn` cited.
6. `limitations.md`: what the project tells users it cannot do.

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
- **Blob vectors.** `blob-v1.json`, from the same independent generator, with edited blobs to
  refuse (`attachments.md` §10).
- **The Android shell's rules** in Kotlin unit tests on the JVM: the bridge's validation, the
  privileged-browser allowlist, `assetlinks.json` parsing and binding, autofill's fields and domains
  (`android.md` §13).
- **By hand**, where automation cannot reach: passkeys on `webauthn.io` in the extension (Chrome,
  Firefox) and on Android, the Keystore KEK and its invalidation, autofill, recorded in
  `browser-matrix.md`.

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
11. **Blobs without additional data** (`attachments.md` §2, §9, D278): a random key used for one
    file, held only inside its authenticated item, binds the blob to its identity; a received blob is
    accepted only when its BLAKE2b-256 equals a `blobId` asked for (CRYPTO-INV-025). A blob's length
    reveals its file's size in storage.
12. **Who asks for a passkey or a fill in the extension** (`extension.md` §4, §5.5, §7.2, D283,
    D287): the origin, frame and top origin come only from `MessageSender`, the `rpId` is checked
    against a Public Suffix List pinned in the repository, and the session host acts only on the
    extension's own pages and service worker (CRYPTO-INV-026, 027).
13. **The authenticator the extension emulates** (`extension.md` §7.3, §7.4, D268, D288): UP is the
    click in a `popup`-type window of the extension's origin, UV is reported because the vault is
    unlocked, `signCount` is always 0 with BE and BS set, attestation is `none`; the ES256 key is
    generated extractable, exported once to the fixed PKCS#8 layout and imported non-extractable
    only to sign; a removed or replaced passkey stays in history until it is purged.
14. **The version lock is transparency, not protection** (`extension.md` §8.2, D285): the new code
    shows its own confirmation; what holds is that an update waits until the vault locks.
15. **The Keystore KEK** (`crypto-spec.md` §5.3, `android.md` §5, D271, D292): a change to the key
    hierarchy; the Master Key never crosses the bridge, only a 32-byte Keystore secret released after
    a strong-biometric prompt (CRYPTO-INV-028). A lost phone is then protected by its biometric
    instead of the local password and Argon2id, as with the unlock passkey (D75).
16. **Who asks on Android** (`android.md` §7.3, §7.4, §8, D301, D303, D304): `getOrigin` against the
    shipped privileged-browser allowlist, an app's origin `android:apk-key-hash:` bound to a domain
    by its `assetlinks.json` `get_login_creds` statement, a browser's `clientDataHash` signed as
    given, autofill's web domain trusted only from an allowlisted browser, and the autofill request
    kept in the shell under a random token (CRYPTO-INV-029).
17. **The bridge** (`android.md` §9, D290): `addWebMessageListener` for the app's origin and main
    frame only, closed message types per window, and the secrets that pass through the shell.

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
pnpm --filter @blindvault/extension build   # the extension packages, in apps/extension/dist
pnpm --filter @blindvault/android test:kotlin   # the shell's Kotlin unit tests (JDK 21, Android SDK)
pnpm --filter @blindvault/android build     # the unsigned APK (build tools 36.0.0, platform 36)
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

R-01 to R-11 and the notes N-01 to N-14 come from a pre-review of `27d3fdd` by Claude (Fable 5.2),
asked by the owner. It is not the external review this gate item requires. V-01 was found while
checking those resolutions.

E-, P-, B-, C-, S-, A-, RC- and AND- findings come from a review of `fe017a8` by Claude (Opus 5.5),
asked by the owner. It is not the external review this gate item requires either.

| ID | Severity | Where | Summary | Resolution |
| --- | --- | --- | --- | --- |
| R-01 | medium | `packages/crypto/src/record.ts:300-304`, `packages/vault/src/session.ts:2073-2090` | An Item with a `trashOperationId` of about 1 MiB passed verification, then failed every later merge holding it once it lost a conflict | Fixed: D260 (#215) |
| R-02 | medium | `apps/web/src/App.tsx:47-56` | No lock ran during a creation or a restore: the phrase on screen, or an opened backup that a new local password turns into a vault, stayed without limit | Fixed: D263 (#216) |
| R-03 | medium | `apps/web/src/app/lock-timers.ts:29-53` | Both locks counted only by `setTimeout`, which a frozen page or a suspended device does not run | Fixed: D263 (#216); the timers on real devices are not measured |
| R-04 | low | `packages/vault/src/session.ts:1999-2000`, `packages/sync/src/exchange.ts:57-64` | A retired device forging its record, not retired, under the header of its retirement kept a peer from ever learning of the retirement | Fixed: D261 (#215) |
| R-05 | low | `packages/vault/src/session.ts:1861-1879`, `:1949-1952` | A purged tombstone with a current HLC removed an item's content and history at once, skipping the trash | Fixed: D262 (#215); the variants that look honest are accepted under A5 in `threat-model.md` |
| R-06 | low | `packages/sync/src/transport.ts:77`, `exchange.ts:146-196`, `transfer.ts:87-100` | Unread messages queued without limit: a man-in-the-middle could flood the link while the SAS was shown, and a paired device could declare any `count` | Fixed before authentication: D264 (#217); after it, accepted under A5 in `threat-model.md` |
| R-07 | low | `packages/crypto/src/cbor.ts:47-48` | An array of about 130,000 items overflowed the stack with a `RangeError`, past the `EncodingError` that message decoding refuses | Fixed: the check walks arrays without a spread (#217) |
| R-08 | low | `apps/web/src/app/controller.ts:557`, `:1141` | A Local Config naming another vault pointed the Web Lock and an erase at a database that was not the one opened: the erase reported success and the vault came back | Fixed: a Local Config whose `vaultId` does not name its database is corrupt (#218) |
| R-09 | low | overview §5.6, §6, `threat-model.md` A1 | D121 promised that no Local Config moves between devices of a vault; a whole one opens on another device that unlocks with the same password or a synced passkey | Accepted: D265, a cloned installation as in D87 |
| R-10 | low | `packages/crypto/src/blindpass.ts:67-71`, `apps/web/src/app/controller.ts:796`, `:815` | An authentic `.blindpass` plaintext that is not UTF-8, an Argon2id worker failure and a password with a control character escaped the import, the restore and the export unhandled | Fixed: the first is `not-this-format`; the restore and the export name the others, and a new password with a control character is not acceptable (#218) |
| R-11 | low | `packages/crypto/src/local-config.ts:85-87`, `cbor.ts:91`, `packages/vault/src/session.ts:1502-1512`, `:1685`, `packages/sync/src/transport.ts:96` | Avoidable copies of keys and plaintext were left unwiped or outlived a lock | Fixed: the private key is removed before the copy, the canonical re-encoding is wiped, the export's keyring is wiped by a lock, a lock drops the Local Config state but the preferences and HLC, and a local close wipes unread frames (#218) |
| N-01 | note | `docs/crypto-spec.md` §14, `packages/crypto/src/cbor.test.ts:77` | The spec allowed floats in their shortest form; the decoder refuses an integral one | Spec aligned: D266 |
| N-02 | note | `docs/crypto-spec.md` §6, `apps/web/src/app/strength.ts:57`, `:101` | The spec normalized the password before the strength check; zxcvbn reads it as typed | Spec aligned: D266 |
| N-03 | note | `docs/pairing-protocol.md` §6.4 | A `master-key` behind A's `confirmed` waited unread instead of aborting; CRYPTO-INV-011 held | Spec aligned: D266 |
| N-04 | note | `docs/pairing-protocol.md` §6.3 | A man in the middle can drop the pairing instead of showing different digits on both devices | Spec aligned: D266 |
| N-05 | note | `docs/backup-format.md` §6 | A restore pulls the whole stream before parsing, not envelope by envelope | Spec aligned: D266 |
| N-06 | note | overview D200, `docs/architecture.md` | The role of each CipherState was cited as Noise §5.2; it is in §5 | Spec aligned: D266 |
| N-07 | note | `apps/web/src/ui/ExportPassword.tsx:24-42` | The export password's 10¹⁴ bar is checked by the UI only | Accepted: D266 |
| N-08 | note | `apps/web/src/ui/RestoreVault.tsx:137-139`, `apps/web/src/app/controller.ts:753` | A `.bvault` has no size cap and is read whole into memory | Accepted: D266 |
| N-09 | note | `packages/vault/src/session.ts:1689-1712` | An export does not check that its records restore | Accepted: D266 |
| N-10 | note | `packages/crypto/src/noise/cipher-state.ts:34-38` | A CipherState without a key passed plaintext through; only the transport's wipe flag stood in the way | Fixed: the transport refuses a CipherState without a key (D266) |
| N-11 | note | `packages/vault/src/session.ts` (`#epoch()`) | A holder of the Master Key can push every device to Vault Key epoch 2³² − 1 | Recorded for the rotation design: D266, `crypto-spec.md` §11 |
| N-12 | note | `docs/threat-model.md` | Missing: the unauthenticated STUN list, storage copies after a password change, an old reconnection offer | Documented: D266 |
| N-13 | note | `packages/crypto/src/noise.test.ts:237-239`, `:513-519`, backup vectors | Tests that pass without the check they name, the nonce carry and edited backup headers not covered | Fixed: tests and vectors added (D266) |
| N-14 | note | `packages/sync/src/payload.ts:116-124`, `transfer.ts:59-65`, `apps/web/src/app/controller.ts` (`start()`), `handshake-state.ts:45` | Small items: 0 in a payload list, `known-device` after the Master Key, the first of two vault databases, a token's name | Accepted: D266 |
| V-01 | low | `packages/storage/src/cleanup.ts:105`, `apps/web/src/app/controller.ts` (`start()`) | With a replaced database skipped because another app window held it (D154), startup could open the replaced vault, which the next startup deletes with what was written to it | Fixed: the cleanup lists only the replacement as a vault |
| E-01 | medium | `apps/web/src/extension/host.ts:272`, `apps/web/src/main.tsx:137-139` | Every message the session host took counted as activity, a passkey request any page makes included, so a site could keep the auto-lock from ever firing | Fixed: D305, #293 |
| P-01 | low | `apps/web/src/extension/passkey.ts:157-161` | `excludeCredentials` matched passkeys of any `rpId`, so a site holding a credential ID of another site learned whether the browser had that account | Fixed: D305, #293 |
| P-02 | low | `apps/web/src/ui/Confirm.tsx:178-187`, `:228-237` | Confirm took a click as soon as the window showed, so a page could draw a click onto it | Fixed: D305, #293 |
| P-03 | note | `apps/extension/src/passkey-main.js:248-251` | A call the page aborted left its request pending in the session host, so a later Confirm wrote a passkey the site never registered | Fixed: D305, #293 |
| P-04 | note | `apps/web/src/extension/passkey-host.ts:94-96` | A request pending in a background tab made every other tab's call fail with `NotAllowedError` | Fixed: D305, #293 |
| P-05 | note | `apps/web/src/extension/passkey.ts:84`, `apps/extension/src/background.js:190-196`, `passkey.ts:40-47` | `crossOrigin` without a chain of ancestors, the `sender.url` fallback, an IP address as `rpId`, the extension detectable by a page | Fixed: the fallback and the IP address (D305); accepted: `crossOrigin` and detection (D305), #293 |
| E-03 | note | `apps/web/src/extension/inject.ts:51-58` | Transparent, zero-size fields counted as usable for a fill | Fixed: D305; a field outside the viewport stays usable, #293 |
| B-01 | low | `packages/crypto/src/backup-stream.ts:284-287`, `:319` | The two-pass reader took a `TAG_FINAL` chunk of 65,537 to 65,552 bytes of plaintext, which the rc.1 reader refused: a second encoding of the same payload | Fixed: D306, with vectors from the Python generator, #294 |
| C-01 | low | `packages/crypto/src/record.ts:173-175`, `cbor.ts:85-98`, `backup-stream.ts:34-36`, `packages/backup/src/format.ts:105-107` | CBOR `-0` passed as an unsigned 0, so an envelope's HLC took a second encoding under the same AAD without any key | Fixed: D306, refused in every CBOR value, with vectors, #294 |
| C-02 | note | `libsodium-wrappers-sumo`, `backup-stream.ts:65`, `:291`, `blob.ts:63`, `:92`, `record.ts:395-411` | Copies of keys and plaintext in the WebAssembly heap are freed unwiped; `crypto-spec.md` §1 promised more | Documented: D306, `crypto-spec.md` §1, `limitations.md`, #294 |
| S-01 | low | `packages/sync/src/blobs.ts:122-136`, `exchange.ts:265`, `:273`, `:284` | Two overlapping asks of more than 16,384 missing blobs interleaved their messages, and the honest sync aborted with `protocol-error` at every attempt | Fixed: D307, #295 |
| S-02 | low | `packages/sync/src/blobs.ts:156-161`, `:211-225` | The answering side took an ID asked for again, so a paired peer could make it read and send one blob without bound | Fixed: D307, `protocol-error`, #295 |
| S-03 | note | `apps/web/src/app/pairing.ts:470-475`, `:776-781` | A pairing and a re-admission sent blob units without the check of §6 that `sync-protocol.md` §10.1 asks for | Fixed: D307, #295 |
| S-04 | note | `apps/web/src/app/pairing.ts:574-582` | B in a pairing dropped a blob that did not match without reporting it, which `sync-protocol.md` §10.1 and `pairing-protocol.md` §8 told differently | Spec aligned: D307, #295 |
| A-01 | low | `packages/storage/src/database.ts:370-394`, `packages/vault/src/session.ts:1981-1996`, `:3880-3938` | A held blob that did not match its `blobId` was never repaired, even from a peer holding a good copy, and an export copied it without naming it missing | Fixed: D308, #296 |
| A-02 | note | `packages/vault/src/session.ts:3905-3907`, `:3814-3821`, `:1981` | A blob whose last citation left during a sync survived until the next commit or unlock, and an export carried it | Fixed: D308, #296 |
| AND-1 | note | `ProviderActivity.kt:72`, `:256`, `Provider.kt:184-220` | The shell's `bound` was one flag per request, not tied to the domain of the credential | Fixed: D309, the bound domains against the request's `rpId`, #297 |
| AND-2 | note | `ShellKeystore.kt:4`, `:117-124`, `Bridge.kt:226-227` | "The secret is wiped" said more than the shell does: its base64url `String` survives | Documented: D309, #297 |
| AND-3 | note | `assets/privileged-apps.json`, `ProviderCaller.kt:20-25`, `FillService.kt:86-92` | The privileged allowlist held a debug package and apps that are not browsers, and autofill trusted the `webDomain` of every one of them | Fixed: D309, the debug package left out, autofill trusts browsers only, #297 |
| RC-01 | note (process) | `tests/fresh-restore.test.ts:369-392`, `backup-format.md` §9 | No test restored a `.bvault` exported by a published build: the vectors are rewritten by every run of the generator | Process: D310, `tests/frozen-backups.test.ts`; the files of v1.0.0-rc.4 and v1.0.0 are a Release Gate task, #298 |
| E-02 | low (confirmed) | `apps/web/src/platform/extension-locks.ts:91-101` | The OS lock in the extension relies on `idle` reporting `locked`, which Firefox never does: its `ext-idle.js` (Firefox 161) emits `idle` and `active` only | Accepted: D311, documented in `extension.md` §3.2, §10, `browser-matrix.md` and `limitations.md` |
