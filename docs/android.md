# BlindVault — Android app

> Normative for the Android app; `overview.md` prevails on design. Implements D269, D270, D271,
> D274, D282, D290, D292, D293, D294 and D295. Measurements behind it are in `docs/spikes/android.md`. Terms follow
> `GLOSSARY.md` (app window, Keystore KEK, provider window, privileged browser, passkey).

## 1. Model

The Android app is a full installation of BlindVault, as the extension is (D267, D269): its own
origin (`https://appassets.androidplatform.net`), vault database, Local Config and Device record,
joined to the vault by pairing like any device. It cannot read the PWA's storage in a browser, and
no browser can read its storage.

| Part | Where | Holds keys | Role |
| --- | --- | --- | --- |
| Main window | `MainActivity`, a WebView running the whole `apps/web` app | yes, while unlocked | the app as on the web: unlocks, manages the vault, pairs, syncs, backs up |
| Provider window | `ProviderActivity`, a WebView running `provider.html`, a second entry of the build | yes, for one request | unlocks, shows who asks, takes the user's tap, signs or hands a password, then locks (§7) |
| Shell | `apps/android`, Kotlin | never the Master Key; the Keystore secret only in transit (§5) | serves the build, the bridge, the Keystore, the clipboard, files, the lock signals |
| Credential provider service | `CredentialProviderService`, Kotlin | never | answers Credential Manager with one entry that opens the provider window (§7.2) |
| Autofill service | `AutofillService`, Kotlin | never | answers a fill request with one dataset that opens the provider window (§8) |

Kotlin is limited to the shell, the two services and the Keystore (D269). Every check on the vault's
content, the matching of items and every signature run in the `apps/web` code of a window.

## 2. Package and build

`apps/android` holds the Gradle project and the step that copies `apps/web`'s Android build into it.
`apps/web` stays the only UI: the provider window is an entry of its build, and platform
differences sit behind its ports (D267, D290).

**Ports.** As in the extension (`extension.md` §2), `vite build --mode android` builds the Android
platform, `apps/web/src/platform/android.ts`, and the mode is replaced at build time, so the web
and extension builds carry none of it. It provides:

- no service worker and no update prompt (§10, D282);
- the lock signals of §4;
- the clipboard through the shell (§6.1);
- saving files through the shell (§6.2);
- the Keystore KEK in place of the unlock passkey (§5);
- the first screen's Android text (§11).

**Build.** `pnpm --filter @blindvault/android build`:

1. `vite build --mode android` writes `apps/web/dist-android`: no `public/` (its `sw.js`, `404.html`
   and web manifest are the web's), no `_headers`, the entry `index.html` (the main window), and
   with the credential provider (§7) a second one, `provider.html` (the provider window), and `headers.json`, the headers `_headers` sets on `/*`
   (`apps/web/build/pages.ts`), which the shell adds to every response.
2. `apps/android/build/assets.ts` copies it to `app/src/main/assets/web/` (not committed) and writes
   its `asset-manifest.txt` with the web build's format and code (D189), listing every file,
   `headers.json` included, and `app/version.properties` (not committed), the `versionName` and
   `versionCode` below; it prints the manifest's hash.
3. `./gradlew assembleRelease` builds the unsigned APK, `app-release-unsigned.apk`, with no R8
   minification and no baseline profile, so its bytes depend only on the pinned inputs.

**Pinned inputs.** The Gradle wrapper with `distributionSha256Sum`; Gradle's dependency verification
(`gradle/verification-metadata.xml`), with the SHA-256 of every artifact the build resolves; the
Android Gradle Plugin, which compiles Kotlin itself; `compileSdk` and `targetSdk` 36, `minSdk` 34
(D269); the build tools; and the JDK, Temurin 21. `docs/architecture.md` lists each with its
justification; every version is at least 14 days old when it lands, Maven artifacts checked by hand
against the same rule.

**Versions.** `versionName` is the package version (`1.0.0-rc.2`). `versionCode` is
`major × 1,000,000 + minor × 10,000 + patch × 100 + n`, where `n` is the release candidate's number,
or 99 for a release, so every release and candidate installs over the one before.

**Packages.** The release is `io.github.allisson.blindvault` (D274). A debug build adds the suffix
`.debug`, is installed over ADB only, and turns on WebView debugging; the release turns it off.

**Reproducibility.** CI builds the unsigned APK twice, as the web build (`docs/build.md`), and
compares them byte for byte. Signing is §10.

## 3. The WebView

Both windows set up their WebView the same way:

- **Origin.** `WebViewAssetLoader` serves `assets/web/` at `https://appassets.androidplatform.net/`,
  through a path handler of the shell that adds the headers of `headers.json` to every response, so
  the app runs under its real CSP and Trusted Types (D282). Any other URL is answered 404.
- **Navigation.** `shouldOverrideUrlLoading` keeps the WebView on the app's origin. A link to an
  `https:` URL outside it opens in the default browser through `ACTION_VIEW`; any other scheme is
  dropped. `window.open` opens nothing in the WebView.
- **Settings.** JavaScript on; `allowFileAccess` and `allowContentAccess` off; mixed content never;
  no `addJavascriptInterface` (§9). The manifest turns off Safe Browsing
  (`android.webkit.WebView.EnableSafeBrowsing` `false`) and WebView metrics
  (`android.webkit.WebView.MetricsOptOut` `true`): the WebView loads only the app's own origin, and
  neither may send a lookup or a metric about the app.
- **Autofill.** No autofill service, another password manager's or the system's augmented one,
  sees a field of the app, so none offers to save the local password or an item's secret, which
  `autocomplete="off"` does not stop in a WebView. The WebView reports its page's fields to the
  `AutofillManager` it gets from its context, and skips autofill when there is none; the shell
  creates it with a context that answers null for that service. `importantForAutofill` on the
  WebView alone does not stop it: measured on the A54, the session still opened. The WebView is
  also `IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS`, for the framework's own path. The local
  password cannot be filled by another manager either, and the app does not show the warning of
  D175 (D297).
- **Camera.** `onPermissionRequest` grants only `RESOURCE_VIDEO_CAPTURE`, only to the app's origin,
  after the Android `CAMERA` permission is granted at runtime; every other resource is denied. The
  spike read the app's QR codes this way (D282).
- **Files.** `onShowFileChooser` opens `ACTION_OPEN_DOCUMENT` with the input's media types and hands
  the chosen document's URI to the WebView, which reads it for `<input type="file">` (restore,
  import, attachments). Saving is §6.2.

**Manifest.** Permissions `INTERNET` (WebRTC, §11), `CAMERA` and `USE_BIOMETRIC`, and no storage
permission. `allowBackup="false"`, and `dataExtractionRules` exclude every domain from cloud backup
and device transfer, so neither the vault database nor Local Config reaches Google Drive or another
phone; the vault leaves the device only by pairing, sync or `.bvault` (D290). Cleartext traffic is
off (`usesCleartextTraffic="false"`). Both activities set `FLAG_SECURE`: no screenshot, no screen
recording, and a blank thumbnail in Recents.

## 4. Windows, sessions and locks

### 4.1 Main window

- One activity, `MainActivity`, `launchMode="singleTask"`. Its WebView survives rotation and size
  changes (`configChanges` `orientation|screenSize|screenLayout|smallestScreenSize|keyboardHidden|uiMode`),
  so they never lock the vault.
- It unlocks by local password or Keystore KEK (§5). The unlock-passkey settings are absent: WebAuthn
  does not run on the app's origin (D271, D282).
- When Android ends the process, the vault is locked: its keys leave memory with it.
- It is an app window (D51): the provider window takes the vault over from it (§7.1).

### 4.2 Locks

| Lock | Android | Web, as before |
| --- | --- | --- |
| Auto-lock | 1 to 60 min without a touch or a key in the window (D151) | same |
| Hidden-app lock | the activity stopped (`onStop`) for the set time, immediately to 15 min; `onStart` before then resets it; not while the shell's own file picker is open (D294) | the page hidden (D54, D151) |
| Operating-system lock | at once, when the screen turns off (`ACTION_SCREEN_OFF`) | — |
| Manual | the app's Lock | the app's |

The shell reports `onStop`, `onStart` and the screen turning off to the window over the bridge
(§9); the platform port turns them into `LockSignals`. The shell can write to the window only once
the window has written to it, so the port sends `lifecycle-watch` the first time it is used, and
takes the state the shell answers (D293). A lock follows D93 and D263.

The shell's pickers, opening a file (§3) and saving one (§6.2), are system activities in front of the
window, which gets `onStop`. From the call that opens one to its result, the shell does not report
that stop as `hidden`, so a lock set to immediately does not abort the operation the window asked
for (D294). The auto-lock and the screen turning off still lock.

## 5. Keystore KEK (D271, D290, D292)

The Keystore KEK replaces the unlock passkey on Android: the same place in Settings, the same rules
for setting it up and removing it (D172, D173). It is a change to the key hierarchy, specified in
`crypto-spec.md` §5.3 and §12.

**The Keystore key.** An AES-256-GCM key in the Android Keystore, alias
`blindvault-kek-<localConfigId in hex>`, created with:

- `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`: a BiometricPrompt on every use;
- `setInvalidatedByBiometricEnrollment(true)`: a new enrolled biometric destroys it;
- `setIsStrongBoxBacked(true)` first, and the TEE when the device has no StrongBox, as the A54
  (D282); Settings shows which one holds the key.

Every Keystore message carries `localConfigId` (base64url), from which the shell names the key
(D292).

**Status.** `keystore-status` answers whether a strong biometric is enrolled (`available`) and, when
the key exists, whether StrongBox holds it (`strongBox`, from its `KeyInfo`). The window offers the
setup only when `available`, and Settings shows `strongBox`; nothing of it is stored.

**Construction.** The Master Key never crosses the bridge:

1. **Setup.** The window opens the Master Key wrap with the current local password (D172), before
   any BiometricPrompt, so a wrong password creates no key. It generates
   a random 32-byte Keystore secret, and sends it to the shell (`keystore-seal`). The shell creates
   the key, shows the BiometricPrompt, encrypts the secret, and answers the GCM IV and ciphertext.
   The window derives the Keystore KEK from the secret, wraps the Master Key under it bound to
   `localConfigId` (D121), writes the Keystore KEK state in Local Config's cleartext part, and wipes
   the secret. A setup that fails after the shell answered deletes the key.
2. **Unlock.** The window sends the IV and ciphertext (`keystore-open`); the shell shows the
   BiometricPrompt, decrypts, and answers the secret, which the window turns into the Keystore KEK,
   then wipes.
3. **Removal.** The window removes the Keystore KEK state and asks the shell to delete the key
   (`keystore-delete`). Erase, re-founding and every replacement of the vault remove it too (D120),
   the key by the old `localConfigId`, after the commit. The window does not wait for the answer:
   the key opens nothing once its wrap is gone (D292).
4. **Re-authentication.** As the unlock passkey, the Keystore KEK opens the Master Key wrap again
   for a backup export, a Recovery Phrase regeneration, a re-founding and the start of a pairing
   (D181, D185, D187, D202). "Vault ready" recommends setting it up in the passkey's place (D198).

**Keystore KEK state**, in Local Config (`record-content.md` §9): the IV, the encrypted secret and
the Master Key wrap. Without the Keystore key it opens nothing; with it, only behind the biometric.

**Failures.**

| Shell answer | Window |
| --- | --- |
| `cancelled` | stays on the unlock screen |
| `invalidated` (`KeyPermanentlyInvalidatedException`) | unlocks by password only, says the enrolled biometrics changed, and after the next password unlock in this process removes the state and the key; at a re-authentication, unlocked, removes both at once (D292) |
| `unavailable` (no strong biometric enrolled) | offers no setup; an existing state unlocks by password only, with the reason |

The setup screen states that a lost phone is then protected by its biometric instead of the local
password and Argon2id, as the unlock passkey's does (D75). The Keystore KEK never sets a local
password (D173). It depends on no platform account, so D84 does not apply (D271).

## 6. Clipboard and files

### 6.1 Clipboard

`clipboard-copy` writes through `ClipboardManager` with `ClipDescription.EXTRA_IS_SENSITIVE`, so
Android hides the value in its clipboard preview; the page's `navigator.clipboard` needs the focus,
which a WebView in an app does not reliably have (D282). The clear's timer runs in the shell, which
calls `clearPrimaryClip()` when it ends, with or without the focus, and when the vault locks.
**Limit:** a process Android ends before the timer leaves the value until Android's own clipboard
expiry.

### 6.2 Saving a file

A backup (`.bvault`) or a downloaded attachment is saved through the shell, since a WebView does not
download a `blob:` link:

1. `file-save` `{name, mediaType}`: the shell opens `ACTION_CREATE_DOCUMENT` and answers `ready` or
   `cancelled`.
2. `file-chunk` `{data}`: base64, at most 1 MiB decoded, written in order; answered `ok`.
3. `file-end`: the shell closes the document and answers `saved`.

One save runs at a time; a save asked while another runs is dropped. A lock (the window sends
`file-abort`), or the window leaving, aborts the save and deletes the partial document. An attachment keeps
the sanitized name and `application/octet-stream` (D273, CRYPTO-INV-025).

## 7. Credential provider (D269, D290)

The app is a third-party provider of Credential Manager for passkeys and passwords. It uses
`androidx.credentials` (D290) for the request and response types, the calling app's information and
the privileged-browser check.

### 7.1 Provider window

Every request the user picks opens `ProviderActivity`, which loads `provider.html`:

1. It takes the vault over from the main window (D51, `takeOver`): the main window shows the vault
   opened elsewhere, as for a second app window. The user's choice of BlindVault in the system sheet
   is the gesture.
2. It unlocks with the Keystore KEK or the local password. That unlock is the user verification:
   every assertion and creation reports UV.
3. It shows who asks (§7.3), the `rpId` or the site, and what the request will do.
4. The user's tap on Confirm is the user presence (UP); for a get, the tap on one passkey or login.
5. It answers through the shell (`provider-result`), locks, and finishes.

The window ends with `cancelled` when the user leaves it (`onStop`), presses Back or Cancel, or the
vault locks; it holds no session after its answer. A vault read-only for its clock (D73) answers a
create with an error, as the extension hands it to the browser (`extension.md` §7.2).

### 7.2 Entries

The services hold no session, so they cannot know what the vault holds:

- `onBeginGetCredential` answers one entry per option asked, passkey or password, labeled
  BlindVault, whose `PendingIntent` opens the provider window. When no passkey of the `rpId` exists,
  the window says so after the unlock and answers no credential.
- `onBeginCreateCredential` answers one create entry, BlindVault, for a passkey. Creating a password
  is out of v1 (§12).
- `onClearCredentialState` does nothing: the provider keeps no state.

### 7.3 Who asks

`CallingAppInfo.getOrigin(allowlist)` decides the caller, against the privileged-browser allowlist
the build ships:

- **Privileged browser.** The caller's package and signing certificate are in the allowlist, and the
  browser set an origin: the origin is the site's, and the `rpId` checks of `extension.md` §7.2 apply
  (`https:` origin, an `rpId` equal to its host or a registrable suffix that is not a public suffix,
  §5.5 there). The response uses the browser's `clientDataHash`; the browser builds `clientDataJSON`.
- **App.** No origin set: the caller is a native app. It gets a passkey of an `rpId`, or a password of
  an item, only when the app is bound to that domain (§7.4). `clientDataJSON` is built by the window
  with the origin `android:apk-key-hash:<base64url of the SHA-256 of the app's signing certificate>`.
- **Refused.** An origin set by a caller outside the allowlist, which any app can do, since
  `CREDENTIAL_MANAGER_SET_ORIGIN` is a normal permission: the request gets no credential.

**Allowlist.** Google's published list of privileged browsers
(`https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json`), kept in the repository as
`apps/android/app/src/main/assets/privileged-apps.json`, filtered to its `release` signatures, pinned
by date and SHA-256 in a header file, and updated before each release. The app never fetches it: that
call would tell Google who uses BlindVault.

### 7.4 Binding an app to a domain

An app is bound to a domain when `https://<domain>/.well-known/assetlinks.json`:

- answers `200` with `application/json`, with no redirect, within 10 s and 256 KiB;
- holds a statement with the relation `delegate_permission/common.get_login_creds` whose target is
  `android_app` with the caller's `package_name` and a `sha256_cert_fingerprints` entry equal to the
  SHA-256 of the caller's signing certificate (every signer, when there are several).

The shell fetches it (`provider-assetlinks`), over HTTPS only, from the provider window's request:
for a passkey, the `rpId`; for a password, the host of the URL of the login the user picked. The
answer stays in the window's memory for its request and is never stored. A network failure, a
redirect or a missing statement binds nothing, and the window says which. The fetch tells the site
that its app is used, and carries no vault data (D269).

### 7.5 Passkeys

The window reuses the extension's code for the vault's side (`extension.md` §7.2 to §7.6, D288):
the choice of passkey, authenticator data with UP, UV, BE and BS and `signCount` 0, ES256 and EdDSA,
attestation `none`, `excludeCredentials` answered `InvalidStateError` only after the confirming tap,
a create that saves into a matching Login item or a new one, and the history notice. It differs
only in who asks (§7.3) and in where the confirmation happens (§7.1). `credProps` is answered; no
other extension, `prf` included.

### 7.6 Passwords

A password request lists the Login items that match the caller:

- a privileged browser's origin: the matching of `extension.md` §5;
- an app: the window offers a search over Login items (`extension.md` §4, `search`), and the login
  the user picks is handed over only when the app is bound to the host of its URL (§7.4).

The password is handed to Credential Manager as the response; nothing is written in the vault.

## 8. Autofill (D269, D290)

The app is also an `AutofillService`; Android groups it with the credential provider of the same
package, and the user enables both in Settings › Passwords & accounts.

- `onFillRequest` finds the user name and password fields in the `AssistStructure` (autofill hints,
  input types, HTML attributes), and answers one dataset, BlindVault, whose authentication opens the
  provider window. It answers nothing when the structure holds no such field.
- **Who asks.** The package of the structure's activity, with its signing certificates from
  `PackageManager`. When that package and certificate are in the privileged-browser allowlist (§7.3)
  and the field's `getWebScheme()` is `https`, the request is the site's, with origin
  `https://<getWebDomain()>`. Otherwise it is the app's, and §7.4 applies: a web domain reported by
  any other app is ignored.
- The window lists the matching logins (§7.6), and the user's tap on one answers the dataset with the
  user name and the password for the fields found. The app that asked submits its form, or not;
  BlindVault never does.
- **Out of v1.** `onSaveRequest` (saving a login typed in another app), cards, identities and TOTP
  codes; the compatibility mode for browsers without native autofill (§12).

## 9. Bridge (D290)

- **Transport.** `WebViewCompat.addWebMessageListener`, with the allowed origin
  `https://appassets.androidplatform.net` only, in the main frame only. No `addJavascriptInterface`:
  it exposes its object to every frame and origin the WebView loads.
- **Format.** JSON objects `{v: 1, type, id, ...}`, as the extension's RPC (`extension.md` §4): `type`
  from a closed list per window, every key validated by type and range, an unknown `v`, `type` or key
  refused with an error answer, never acted on. Bytes travel as base64url, except file chunks
  (base64, §6.2). The listener's JavaScript object is `blindvaultShell`; each message is the JSON
  text of one object.
- **Answers.** `{v: 1, id, ok: true, ...}` with the request's `id`, or `{v: 1, id, ok: false, error}`
  with `error` one of `invalid` (the request was refused), `cancelled`, `invalidated`, `unavailable`
  or `failed` (the shell could not do it). The window takes an answer only for a request it has
  pending, and ignores any other message, as it ignores a `lifecycle` with another `state`.
- **Senders.** The shell takes each type only from the window the table names; the provider window's
  types only from a provider window with a request in progress.

| From | `type` | Answer |
| --- | --- | --- |
| window | `keystore-status` `{localConfigId}` | `{available}`, with `strongBox` when the key exists (§5, D292) |
| window | `keystore-seal` `{localConfigId, secret}` | `{iv, sealed, strongBox}`, or `cancelled`, `unavailable` (§5) |
| window | `keystore-open` `{localConfigId, iv, sealed}` | `{secret}`, or `cancelled`, `invalidated`, `unavailable` |
| window | `keystore-delete` `{localConfigId}` | done |
| window | `clipboard-copy` `{text, clearSeconds}`, `clipboard-clear` | done (§6.1) |
| main window | `file-save`, `file-chunk`, `file-end`, `file-abort` | §6.2 |
| window | `build-info` | `{versionName, versionCode, certSha256}` (§10) |
| window | `lifecycle-watch` | `{state: "shown" \| "hidden"}`, the state now (§4.2, D293) |
| shell, to the window | `lifecycle` `{state: "hidden" \| "shown" \| "screen-off"}` | none (§4.2) |
| provider window | `provider-request` | the request: its kind, the caller (§7.3), the options, and for autofill the fields found |
| provider window | `provider-assetlinks` `{domain}` | `bound`, `unbound`, `network` or `redirect` (§7.4) |
| provider window | `provider-result` | none; the shell answers the caller and finishes the activity |

The shell never holds the Master Key, a record key or an item's content: the Keystore secret passes
through it at setup and unlock, and a password, a user name or a signed response passes through it
toward the caller that asked.

## 10. Distribution, signing and updates (D270, D274)

- **Release.** The release workflow builds the unsigned APK and attaches it,
  `blindvault-android-<version>-unsigned.apk`, with its `asset-manifest-android.txt`, both attested.
  The maintainer signs it locally with the release key, kept offline and out of CI, with `apksigner`
  (schemes v2 and v3), through `apps/android/build/sign.sh`, which checks the unsigned APK's
  attestation against the tag, the signer against `apps/android/release-cert.sha256`, and that
  `apksigcopier` gives the signed APK back from the unsigned one and the signature. The maintainer
  then attaches `blindvault-android-<version>.apk` and adds its SHA-256 and the certificate's to the
  release body. `docs/build.md` gives the rebuild's commands: build the unsigned APK, copy the
  published signature onto it with `apksigcopier`, and compare the bytes with the published APK.
- **Release key.** RSA 4096, valid 30 years, in a keystore kept offline by the maintainer. Android
  installs an update only under the same key, so its loss ends updates of installed apps: users would
  reinstall, losing the app's data, and restore from a backup or pair again.
- **Updates.** Only by hand: the APK from GitHub Releases, through Obtainium or a self-run F-Droid
  repository (D270). The app never checks for updates. Installing an update ends the running
  process, which locks the vault; the user starts the new version. There is no version lock (D290):
  installing the APK is the user's own confirmation, and Android installs over the app only an APK
  signed by the same key.
- **About** shows the version, the hash of the APK's `asset-manifest.txt` and the SHA-256 of the
  signing certificate, read from `PackageManager`.
- **Developer verification** (D274, D295). The release package is registered in the maintainer's
  Play Console account as an app distributed outside Google Play, with the release certificate's
  SHA-256. The proof that the account holds the key is an APK of the same package, signed with the
  release key, holding only the console's snippet in `assets/adi-registration.properties`
  (`apps/android/build/registration-apk.sh`), uploaded to the console and never published. Android
  checks the registration at install, for direct installs from 2027 (D295); the app makes no call
  for it.

## 11. Onboarding, pairing and sync

- The first screen is the app's (D198), with the three starts. On Android it adds that the app is a
  separate device of the vault, recommends pairing with the PWA or another device, and states that it
  sees new items only after a sync.
- Pairing scans the other device's QR code with the camera (§3) or uses copy/paste; sync is the
  manual flow (D216). WebRTC runs in the WebView (D282), with the STUN list of D209.
- `navigator.storage.persist()` answers `false` in the WebView (D282). The data lives in the app's
  data directory and goes with an uninstall or a clear of the app's data; the backup reminders hold.

## 12. Out of v1

Saving a password, through Credential Manager or `onSaveRequest`; cards, identities and TOTP codes in
autofill; autofill's compatibility mode; the single-tap biometric of Android 15
(`BiometricPromptData`); conditional (inline) suggestions of passkeys; devices below API 34; a tablet
layout beyond the app's own responsive one.

## 13. Tests

- **Kotlin, on the JVM.** The bridge's validation (every type, unknown `v`, `type` and key, a
  provider type outside a request), the allowlist's parsing and matching, `assetlinks.json`'s parsing
  and binding (relation, package, every signer, redirect, size), and `android:apk-key-hash`.
- **Vitest, in `apps/android`.** `build/assets.ts`: the APK's asset manifest and the `versionCode`.
- **Vitest, in `apps/web`.** The Android platform port: lock signals, clipboard, file saving, the
  Keystore KEK's setup, unlock, failures and removal against a fake shell; the provider window's
  flow per caller kind.
- **Crypto.** `packages/crypto` and `packages/vault`: the Keystore KEK's derivation and wrap, with
  negative tests as for D75 and D121 (another purpose, `vaultId` or `localConfigId`; a wrong secret;
  a Local Config with a malformed Keystore KEK state), and vectors in `crypto-v1.json`.
- **CI.** The unsigned APK built twice and compared; no emulator, which has no real biometric.
- **By hand**, on the Samsung A54, recorded in `browser-matrix.md` (Android): install; create, pair
  and sync with the PWA; the Keystore KEK's setup, unlock, and invalidation by a new fingerprint; the
  locks of §4.2, behind the pickers too (D294); FLAG_SECURE; no autofill service offering to save
  the local password or an item's secret (D297); saving a backup and an attachment;
  About; a passkey create and get on `webauthn.io` in Chrome and Firefox; a password filled in Chrome and in an app bound by
  `assetlinks.json`; a refused app that is not bound.

Negative tests, each named in `security-invariants.md` under CRYPTO-INV-028 (Keystore KEK) and
CRYPTO-INV-029 (provider and autofill).

## 14. Threat model

`threat-model.md` A10 (another app on the device), A1 (a stolen phone) and A6 (a modified APK) hold
the entries this document specifies.
