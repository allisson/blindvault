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
  before it wipes the backup's Master Key and writes nothing (D104). It records every restored
  `deviceId` as seen, and every retired one as seen as retired, without a notice (D53).
- **Forgotten password reset (Phase 2, D173, D184).** `VaultSession.resetPassword` takes the
  Local Config, the phrase's entropy and the new Device KEK: it opens the held Recovery Envelope's
  `mk` with `openRecoveryEnvelope`, proves the Master Key by opening the encrypted part of Local
  Config, reads every record with the same `load` as unlock, and commits only the new Master Key
  wrap, keeping the PRF wrap. It rejects with `PasswordResetRejectedError` (`no-envelope`,
  `wrong-phrase`, `master-key-mismatch`) and wipes its keyring. `apps/web` offers "Forgot the
  password?" on the unlock screen: the phrase, then the new password, checked for strength (D71);
  a lock during the derivation writes nothing (D104).
- **Replacing the vault by a backup (Phase 2, D89, D153, D183).** The unlock screen offers it
  without unlocking: the same steps as a fresh restore, the erase warning, and a confirmation
  checkbox before the commit. `VaultController.restore(password, { replace: true })` runs in the
  app window that holds the vault's Web Lock (D154), under the installation guard. A backup of
  another vault commits a database of its own, whose Local Config records the replaced `vaultId`
  (`RestoreOptions.replacesVaultId`, D96); the controller then deletes the old database and calls
  `VaultSession.forgetReplacedVault`, and a failure there is left to the startup cleanup. A backup
  of the same vault commits in the existing database with `StorageCommit.clear`, which empties
  both object stores in the transaction that writes the new ones. A lock before the commit leaves
  the old vault intact and locked. The old vault's passkey is then forgotten through
  `signalUnknownCredential`, or the shell says to delete it by hand (D120).
- **Backup merge (Phase 2, D182).** The merge rules of `sync-protocol.md` §1 live in
  `packages/vault`: `merge.ts` holds the pure last-write-wins decisions, and
  `VaultSession.mergeBackup` applies them, so sync calls the same path in Phase 5. The session
  checks the `vaultId` and the Master Key, through `isMasterKeyOf` in `packages/crypto`, then reads
  the backup's records with the same `load` as unlock, under the Vault Keys it holds, and rejects
  the whole merge for a record kept aside, one beyond the bound or one that breaks D42 or D44,
  before computing any write. Conflict losers become Item Versions sealed by this device with
  their own HLC, the history cut runs once over the whole transfer (D137), and one commit writes
  the result with the Local Config. Vault Keys the backup carried for held epochs are released at
  once. `apps/web` opens the file with the same steps as a fresh restore, while unlocked, says a
  backup of another vault is one before the confirmation, and shows the notices of the result
  once; the own-retirement notice (D41) is read from the held Device record.
- **Recovery Phrase regeneration (Phase 2, D185).** `VaultSession.regenerateRecoveryPhrase` takes
  the KEK the caller derived again, as an export does, and the new phrase's entropy: it opens the
  Master Key wrap, derives the recovery keys and seals the new Recovery Envelope in a keyring of its
  own, wiped before it returns, and commits only that envelope with the new `phraseId` as the last
  seen. `regenerationBlock` reports D73, D74, D98 and a vault without an envelope before anything
  is opened; an envelope kept aside as corrupt is replaced. `VaultController` reuses its creation
  phrase slot for the regeneration's entropy, which a lock, a cancel or the commit wipes, and
  shares the re-authentication of the export (`#reauthenticate`). `showingPhrase` tells `App` to
  pause the inactivity timer (`LockTimers.pause`) while the phrase is held (D104). A backup merge
  reports `phraseSuperseded` when it replaces an envelope whose `hlc` carries this device's
  `deviceId` (D145). The UI names a phrase by the first 8 hex digits of its `phraseId`
  (`phraseLabel`), next to its creation date.
- **Restored device and retirement (Phase 2, D30, D41, D119, D186).** `VaultSession.registered`
  says whether the device holds its own Device record; a fresh restore leaves it unregistered.
  `VaultSession.retireDevice` writes the held record retired in one commit, keeping its name, date
  and unknown keys (D59), and adds it to `seenRetiredDevices`; its HLC is above the held record's,
  of now over a record beyond the bound (D74), or `HlcClock.issueRetirement` while the vault is
  read-only (D85). It refuses this device's own record and a retired one
  (`RetirementRefusedError`) and a record not held as a Device (`RecordNotFoundError`). No password
  is asked (D186). `apps/web/src/app/devices.ts` (`devicesOf`) lists the non-retired records, own
  first, counts the retired ones and gives the advice: `readmit` on an unregistered device while
  another non-retired record exists, `only-device` otherwise when no other one exists (D119), which
  the storage-persistence warning will reuse. `VaultController.readmissionNotice` is set by a fresh
  restore with `readmit` advice and cleared by dismiss or lock; Settings › Devices keeps the advice
  while it holds, and retirement asks for a confirmation stating it cannot be undone, is not
  revocation and points to re-founding.
- **Re-founding (Phase 2, D28, D60, D72, D86, D89, D99, D187).** `VaultSession.refound(old, …)`
  takes the options of `create` and `current`, the KEK of the old vault's password or passkey,
  checked by `confirmUser` as a proof only. It shares the founding with `create` (`#found`), reads
  from `old` the Items and Folders that are neither tombstones nor in the trash (`#carried`), and
  writes them in the founding commit under new random IDs and fresh HLCs (`#carry`): a valid record
  has its folder reference rewritten or removed, a read-only item keeps its content map unchanged.
  The Local Config records `replacesVaultId` and keeps the old preferences. Only the Vault Key
  record keeps its `recordId`, which the epoch alone fixes. `rejectedPeers` names the D116 peers.
  `VaultController` holds the proof (`beginRefounding`), the new phrase in its phrase slot
  (`newRefoundingPhrase`, so `showingPhrase` pauses the inactivity lock) and then `refound` runs as
  a creation under the installation guard; after the commit it locks the old session, deletes the
  old database and forgets the old passkey as a replacement does (D96, D120). `afterRefounding`
  shows the next steps. `RefoundVault.tsx` is the Settings flow.
- **Backup reminder (Phase 2, §13.4, D185, D188).** `apps/web/src/app/backup-reminder.ts`
  (`backupReminderOf`) computes from the session's `lastBackupAt` and current Recovery Phrase, and
  the controller's clock, whether a backup is due: `never`, `old-phrase` or `stale` (30 days, fixed
  in v1). A vault without a Recovery Envelope gets none. `VaultController.backupReminder` returns
  it while unlocked; `dismissBackupReminder` hides it for that session until the next lock, so a
  vault that replaces it shows it again, and nothing new is stored. VaultShell shows it with "Make
  a backup", which opens Settings with `focus: 'backup'` on the navigation screen.
- **Asset manifest and reproducible build (Phase 3, D189).** `apps/web/build/asset-manifest.ts` is
  a Vite plugin, applied to `vite build` only: at `buildStart` it refuses a Node other than
  `.nvmrc`'s, and at `closeBundle` it walks `dist/`, writes `asset-manifest.txt` (`manifestOf`, the
  `shasum -a 256` format in byte order, leaving out itself and `sw.js`) and prints the manifest hash.
  It lives in `apps/web/build/`, outside `src/`, since it runs in Node at build time; the Vitest and
  `tsconfig.node.json` includes cover it. The `reproducible` CI job compares two builds made at
  different paths and in different environments. `docs/build.md` is the spec.
- **Service worker and web app manifest (Phase 3, D190).** `apps/web/public/sw.js` is shipped as
  written: plain JavaScript checked by `tsconfig.sw.json` (`checkJs`, WebWorker lib) and linted with
  the service-worker globals. Its install checks the asset manifest's format and each file's
  SHA-256 before writing `blindvault-<manifest hash>`; the `blindvault-state` cache records the
  `installed` and `active` versions, so a running worker reads only its own. `build/sw.test.ts`
  runs the file in `node:vm` against fake caches and network. `src/app/service-worker.ts` registers
  it from `main.tsx` in the production build, through a second Trusted Types policy that vouches for
  `/sw.js` only. `public/manifest.webmanifest` and the icons, drawn by `build/icons.py` (standard
  library only, deterministic), are listed in the asset manifest like any other file.
- **Update flow (Phase 3, D191).** `sw.js` answers two messages, each on a reply port and one at a
  time: `check` stages the bundle the host serves under `blindvault-<hash>`, checked as at install,
  with the `staged` state entry, and answers its version (`version.txt`, written by
  `build/version.ts`) and manifest hash; `apply` with that hash makes it the active and installed
  cache, and reloads the other windows. `src/app/updates.ts` (`UpdateMonitor`) holds the page side:
  it asks for `check` at startup and on every return to visible, with `registration.update()`,
  applies only when the controller's `updateAllowed` says no flow is in progress (D152), and locks in
  the `updatefound` handler itself. `main.tsx` builds the controller and the monitor before the first
  render and registers the service worker at once. `e2e/update.spec.ts` serves deployments derived
  from `dist` from a host of its own, switched by the test.
- **About screen (Phase 3, D192).** `src/app/build-info.ts` reads `/asset-manifest.txt` once at
  startup (`manifestHash`) and hashes it with `crypto.subtle`, refusing a body that is not a
  manifest, such as the dev server's fallback page. `src/ui/About.tsx` (`AboutBuild`) shows it with
  the version, at the end of Settings and from the footer of every card before unlock. Whether that
  card is open lives in `AboutContext` above the screens, since each status renders its own card.
- **Framed app (Phase 3, D193).** `main.tsx` first asks `framed(window)` (`src/app/frame.ts`,
  `window.self !== window.top`). Inside a frame it renders only `src/ui/Framed.tsx`, a notice with a
  link to the app in its own tab, and builds no controller, Argon2id worker, update monitor or
  service worker registration, and reads no asset manifest.
- **Releases (Phase 3, D194).** `.github/workflows/release.yml` runs on a tag `v<version>`: one
  build, `build/release.ts` (tag against `version.txt`, notes in `docs/releases/<tag>.md`, a
  `## Service worker` section when `sw.js` changed since the previous tag, the release body), the
  attested files, the GitHub Release, the Pages deployment, then a check of the served files
  against the release. It replaces the hand-started preview workflow.
- **Self-hosting (Phase 3, D195).** `deploy/Caddyfile` and `deploy/nginx/blindvault.conf` send
  the CSP of `build/csp.ts` as a header, with `frame-ancestors 'none'`, and the other headers of
  `docs/self-hosting.md`; `build/csp.test.ts` checks both against `build/csp.ts`, which the build
  also uses. `e2e/self-hosting/serve.sh` serves `dist/` with either in Docker, and
  `playwright.self-hosting.config.ts` runs `self-hosting.spec.ts` (excluded from the main suite)
  with the smoke, PWA and About specs against it, in the CI job `self-hosting`.
- **State UI (Phase 3, D196).** `src/app/storage-state.ts` holds the rules: Safari by user agent,
  a plain tab by `display-mode: standalone` and `navigator.standalone`, nearly full at 80% of the
  quota, and the warnings in their order. Its `StorageMonitor`, owned by the controller as
  `controller.storage`, keeps the last `storageStatus()` read for the UI, discards an older read
  that answers last, and asks for persistence only through `keep()`, on a click. The controller
  reads again after each automatic request; `src/ui/StorageState.tsx` reads at unlock and on every
  return to visible, shows the first warning below the vault's header and the "This device"
  section of Settings. The Safari warning before unlock, and the alert both use, live in
  `components.tsx`, with the cards. `e2e/storage-state.spec.ts` replaces `navigator.storage`'s
  answers, the user agent and `matchMedia` before the app loads.
- **Layouts (Phase 3, D15, D197).** `src/ui/VaultShell.tsx` renders the folder tree, the item
  list and the item detail at the same places of one tree in every layout, and only styles or hides
  them, so a resize remounts nothing; Settings hides the panes instead of replacing them. On tablet
  the folder tree is a drawer over the list. `src/app/back-button.ts` keeps one history entry, with
  no state and the same URL, while the navigation is deeper than the root (`Navigation.deeper()`),
  and turns `popstate` into `nav.back()`; it is the only `history.pushState` call the lint rule of
  D167 lets through. `src/app/shortcuts.ts` decides when N starts a new item. `TARGET` gives every
  control, and each checkbox or radio label, 44 px on a coarse pointer. `e2e/layout.spec.ts`
  checks the panes, the lock state, masked secrets and no horizontal overflow at 390, 800 and
  1280 px, state kept across both breakpoints, the drawer, the system's back, N, and, in Chromium
  with `isMobile`, every control's height.
- **Onboarding (Phase 3, §13.3, D198).** `src/ui/Start.tsx` opens with what having no server
  means, then the three starts; the pair start explains today's path (a backup restored here) until
  Phase 4. On a Safari tab (`safariTab()`) the advice to install first comes before the starts, and
  the `VaultHeld` context gives the Safari warning its text for a device with no vault, and hides it while starting. After a
  creation or a restore the controller holds `ready` until `dismissReady()` or a lock, and
  `src/ui/Ready.tsx` shows "Vault ready" in place of the panes, with the recommendations that
  `src/app/ready.ts` (`readyAdvice`) orders; each action opens Settings at a `SettingsFocus`.
  `e2e/create.ts` `startScreen()` passes the install advice, since Playwright's WebKit is Safari in
  a plain tab, and `openVault()` closes "Vault ready"; `e2e/onboarding.spec.ts` covers the first
  screen, the pair start, "Vault ready" after a creation and the Safari advice.
- **Pairing protocol (Phase 4, §8, D199).** `docs/pairing-protocol.md` specifies the payload
  bytes, the connection rebuilt from them, the `Noise_XX` handshake, the commitment, nonces and
  six-digit SAS, the confirmation on both devices, pairing, re-admission, the framed CBOR messages
  inside the Noise channel, timeouts and versions; `docs/sync-protocol.md` §2 adds the full
  transfer both flows run. `packages/sync` implements them in the next Phase 4 tasks, behind the
  transport abstraction, so the protocol tests run without WebRTC.
- **Transport (Phase 4, `packages/sync`).** `src/transport.ts` defines `Transport`: ordered binary
  messages of at most 65,535 bytes (`MAX_MESSAGE_LENGTH`, one Noise transport message), refused on
  sending and closing the transport on receipt; `send` resolves once taken, `receive` returns the
  next message, and `close` is idempotent. After a remote close or an error the messages that
  arrived stay readable, so an `abort` sent just before a close is read; a local close discards
  them. `src/memory.ts` (`memoryPair`) connects two transports in memory, with an `intercept` hook
  that tampers with, drops, duplicates, reorders or injects messages for the Gate C tests, and
  `breakLink`. `src/webrtc.ts` (`dataChannelTransport`) wraps an already open `RTCDataChannel`
  through the structural `DataChannelLike`, accepts only `ArrayBuffer` data, and makes `send` wait
  while more than 1 MiB is buffered, until `bufferedamountlow` at 256 KiB. Its tests run in Node
  against a stand-in channel. An ESLint rule keeps `packages/sync` to `@blindvault/crypto` and away
  from UI code.
- **Pairing payload and connection (Phase 4, `packages/sync`).** `src/base45.ts` is RFC 9285 with
  strict decoding. `src/payload.ts` encodes and decodes the payload v1 of `pairing-protocol.md` §3
  as bytes, with `PayloadError.reason` `version` (the UI asks to update), `malformed`, `wrong-role`
  or `wrong-session`; encoding runs the decoder's checks, so an invalid payload is never shown, and
  the text decoder removes only line breaks and tabs, because the space is a base45 character.
  `src/sdp.ts` reads the payload fields from the gathered local description (UDP host and srflx
  candidates of component 1, srflx first, at most 8) and rebuilds the peer's description from its
  payload. `src/connection.ts` (`startInitiator`, `startResponder`) generates an ECDSA P-256
  certificate per session, stops gathering at `complete`, the first srflx candidate or 10 s, and
  resolves with a `Transport` once the initiator's DataChannel is open; closing the transport waits
  up to 2 s for the channel's own close before closing the connection, because Firefox and WebKit
  otherwise report the close to the peer as an error. The payload's other fields (session ID,
  commitment, "holds a vault", formats) come from the caller. The vectors are in
  `test-vectors/pairing-v1.json`, from `tests/vectors/generate.py`. `connection.ts` needs a
  browser, so it is outside the Vitest coverage and covered by `e2e/connection.spec.ts`: Playwright
  on a page served by Vite from the package source (`playwright.config.ts`, on `127.0.0.1` because
  Playwright's Firefox gathers no candidate on `localhost`), two browser contexts pairing LAN-only by
  the base45 texts in Chromium, Firefox and WebKit, including a fingerprint changed in either
  payload, which never connects. The responder holds a fake camera before it gathers, as the
  scanning device does in QR pairing (D161), so its host candidate is a raw IP address: without
  it, in the Playwright Linux image both sides sent only mDNS names, and WebKit never connected
  while Chromium and Firefox did; the mDNS-only case stays the roadmap's real-device measurement. `@playwright/test` and `vite` are devDependencies of
  `packages/sync` at the versions `apps/web` already uses; the root `test:e2e` runs this suite
  before the app's.
- **Checked password fills (Phase 3).** Playwright's `fill` focuses a field, then types into whatever
  has the focus, without checking. `apps/web/e2e/password.ts` (`fillPassword`) checks the value
  landed and otherwise fails at once, saying whether the field was recreated or the focus moved; it
  never retries, so a screen that drops what was typed still fails. `e2e/fill-password.spec.ts`
  covers both failures. `restore.spec.ts` uses it for its unlocks, where a WebKit run once lost the
  password after Lock without a cause found in 52 repeated runs.
- **Key handles.** Keys never leave `packages/crypto` as bytes: a key is an opaque object whose
  bytes sit in a private field, used only by `crypto` functions. Every handle is registered in a
  keyring; lock wipes them all with `sodium_memzero`, and any later use throws (CRYPTO-INV-005,
  CRYPTO-INV-010).
- **Argon2id worker.** The worker entry lives in `packages/crypto` and loads its own libsodium;
  `apps/web` starts it through Vite's worker import (`import KdfWorker from
  '@blindvault/crypto/kdf.worker?worker'`, bundled as its own module worker) and hands a port to
  `deriveDeviceKek` or `calibrateDeviceKek`, which take any `KdfPort` (tests run the handler
  in-process). One request per port: the password is transferred to the worker and wiped on both
  sides, it returns the Device KEK, and the client terminates the port. Parameters outside the
  accepted range are refused before the worker is asked. Since no code loads after the first unlock
  (D142, D191), `apps/web` starts one worker per window at startup (`SharedKdf` in
  `src/app/kdf.ts`): it serves one request at a time, a terminated port only releases its request,
  and a key that comes back for a released request is zeroed. The strength dictionaries also load
  at startup (`preloadStrength`), and the controller's `start` waits for both.
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

### CI and release

Every GitHub Action is pinned to a commit, with its version in a comment, and every Docker image to a digest.

| Dependency | Where | Justification |
| --- | --- | --- |
| `actions/attest-build-provenance` v4.2.2 | `.github/workflows/release.yml` | Signs the release files with a build provenance attestation (Sigstore, through GitHub), the signing of overview §12 (D194). Anyone can check a file with `gh attestation verify`, with no key of the project to distribute. Phase 3. |
| `nginx` 1.30.5 (Alpine image) | `apps/web/e2e/self-hosting/serve.sh`, CI job `self-hosting` | Serves the build with `deploy/nginx/blindvault.conf` for the self-hosting test (D195). Pinned by digest; the stable line. Test only. Phase 3. |
| `caddy` 2.11.4 (Alpine image) | `apps/web/e2e/self-hosting/serve.sh`, CI job `self-hosting` | Serves the build with `deploy/Caddyfile` for the self-hosting test (D195). Pinned by digest. Test only. Phase 3. |

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
