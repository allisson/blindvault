# Browser matrix (Security Gate)

The browsers and capabilities of overview §16, with what proves each one works in BlindVault itself.
The Security Gate box "Browser matrix tested and recorded" closed without a manual run (D257): a
cell no source covers reads **not checked**.

## Sources

- **auto:** the Playwright suite on the build named below, in Playwright's own engines. It proves
  the app's code path, not the shipped browser: Playwright's WebKit is not Safari, and its camera
  and authenticator are fakes.
- **app vX:** the app itself, by hand on a real device, at that version (D212).
- **spike:** a Phase 0 throwaway page on the real browser, not the app (`docs/spikes/`).
- **not checked:** no run of the current app on that browser (D257); how to check one is below.

## Automated run

| | |
| --- | --- |
| Commit | `d02981e` |
| App | 0.7.3 |
| Playwright | 1.63.0, on macOS 26.6.2 (MacBook Air M1) |
| Engines | Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6 |
| Date | 2026-11-13 |
| Result | `packages/sync` 36 passed; `apps/web` 592 passed, 23 skipped, 0 failed |

The 23 skips, by design: the opt-in load and large-backup specs (2 × 3 engines); the passkey specs
and the passkey recommendation in onboarding in Firefox and WebKit (7 × 2, Chromium-only virtual
authenticator); the coarse-pointer layout in Firefox and WebKit (2, Chromium-only touch emulation);
offline use in WebKit (1, `pwa.spec.ts`).

## Matrix

| Capability | Chromium desktop | Firefox desktop | Safari macOS | Safari iOS | Chromium Android |
| --- | --- | --- | --- | --- | --- |
| IndexedDB | auto; app v0.3.0 | auto | auto (WebKit); not checked | app v0.3.0; not checked | app v0.3.0; not checked |
| Persistent storage | spike; not checked | not checked | spike; not checked | spike; not checked | spike; not checked |
| DataChannel | auto; app v0.3.0 | auto | auto (WebKit); not checked | app v0.3.0; not checked | app v0.3.0; not checked |
| WebAuthn | auto (virtual); not checked | spike; not checked | spike; not checked | spike; not checked | spike; not checked |
| WebAuthn PRF | auto (virtual); spike; not checked | spike; not checked | spike; not checked | spike; not checked | spike; not checked |
| PWA installation | auto (manifest); not checked | not checked | spike (Dock); not checked | app v0.3.0; not checked | spike; not checked |
| Camera | auto (fake); app v0.3.0 | auto (fake) | auto (WebKit, fake); not checked | app v0.3.0; not checked | app v0.3.0; not checked |
| QR scanning | auto (fake); app v0.3.0 | auto (fake) | auto (WebKit, fake); not checked | app v0.3.0; not checked | app v0.3.0; not checked |

What each source covers:

- **auto.** IndexedDB: every spec that creates a vault. DataChannel: `pairing.spec.ts`,
  `sync.spec.ts`, `pairing-stun.spec.ts`. Camera and QR: `pairing-qr.spec.ts`, with a fake camera
  showing the other side's QR. WebAuthn and PRF: `passkey.spec.ts`, Chromium only, with the CDP
  virtual authenticator. PWA: `pwa.spec.ts` checks the manifest, the cache and offline use
  (offline skipped in WebKit), not an install. Persistent storage: `storage-state.spec.ts` drives a
  stubbed `navigator.storage`, so it tests the UI, not the browser.
- **app v0.3.0 (D212).** iPhone 14 installed app (iOS 26.6.2) ↔ Galaxy A54 Chrome 155 tab, QR by
  camera both ways; MacBook Air M1 Chrome 155 tab restored a 42,003-record vault and paired it into
  each phone by QR.
- **spike.** `prf.md`: PRF works on every browser of the matrix and in the installed apps on iOS and
  Android. `storage.md`: `persist()` refused to tabs and granted to installed apps on the Mac (Safari
  Dock app), the iPhone and the A54. `pairing.md`: DataChannel, camera and QR on every phone pair.

## Checking a cell by hand

Not run before 1.0 (D257). To check a cell later, on a release, in each context: Chromium desktop,
Firefox desktop, Safari macOS (tab and Dock app), Safari iOS (installed app), Chrome Android (tab
and installed app). Record the browser version and the result in the matrix.

1. **Install** the app where the browser offers it, and open it.
2. **Create a vault**, lock, unlock: IndexedDB.
3. **Settings › This device:** whether storage reads "kept" (persistent storage).
4. **Set up a passkey** with the platform authenticator, lock, unlock with it: WebAuthn and PRF.
5. **Pair with another device by QR** with the camera: camera, QR scanning and DataChannel.
6. **Sync** once with the paired device.

A capability a browser lacks must degrade as the overview says, with the app's own message: record
the message as the result.

## Extension

The extension's capabilities (`extension.md` §10, §12, D287), on its Chromium and Firefox packages.

| Capability | Chromium desktop | Firefox desktop |
| --- | --- | --- |
| Package loads, session host opens | auto | by hand 1.0.0-rc.2 |
| Toolbar opens the popup, with the page's matches | not checked | by hand 1.0.0-rc.2 |
| Fill from the popup, no submit | auto (test copy) | by hand 1.0.0-rc.2 |
| Shortcut fills the one match | auto (test copy) | by hand 1.0.0-rc.2 |
| Shortcut opens the popup on several matches | auto (answer only) | by hand 1.0.0-rc.2 |
| User name alone, two-step sign-in | auto (page) | auto (page); by hand 1.0.0-rc.2 |
| Never fills a cross-origin iframe | auto (test copy) | auto (page) |
| Changed build stopped until confirmed (§8.2) | auto | not checked |
| Passkey create and get, each confirmed in the window (§7) | auto (test copy) | by hand 1.0.0-rc.2, passkeys |
| Passkey from a cross-origin frame names the top origin; Cancel, a second request, a lock | auto (test copy) | not checked |
| Passkeys on `webauthn.io`, the switch of Settings › Passkeys | by hand 1.0.0-rc.2, passkeys (test copy) | by hand 1.0.0-rc.2, passkeys |
| "Use another authenticator" hands the call to the browser | not checked | not checked |
| Operating-system lock (`extension.md` §3.2) | not checked | none: Firefox's `idle` never reports `locked` (D311) |

Edge and Brave install the Chrome package from the Chrome Web Store: not checked (`extension.md` §10).

What each source covers:

- **auto.** `apps/extension/e2e`, Chromium only, with the unpacked package. Playwright cannot click
  the toolbar or press a command: the fill tests load a test copy of the package granting the test
  sites, and send the popup's and the service worker's messages from those pages ("test copy"); on
  several matches they check the session host's answer, not that the popup opens ("answer only").
  "page": the function injected into the page, in Chromium, Firefox and WebKit pages,
  `apps/web/e2e/extension-fill.spec.ts`.
- **by hand 1.0.0-rc.2.** Firefox 160.0 on macOS 26.6.2 (MacBook Air M1), on 2026-11-21, at
  `d9da4ba`: the Firefox package installed as a temporary add-on in a new profile, the vault and its
  Login items created through Marionette, then the toolbar, the shortcut (⌘⇧L) and the popup's
  buttons driven by the system's own mouse and keyboard events, on a sign-in page and a two-step
  page served from `http://localhost`. `action.openPopup()` opened the popup after the session
  host's answer. The run found the popup opening scrolled past its header and with a horizontal
  scrollbar, fixed in `d9da4ba`.
- **by hand 1.0.0-rc.2, passkeys.** On macOS 26.6.2 (MacBook Air M1), on 2026-11-21, at `caf5500`:
  step 7 below on `https://webauthn.io`, each browser with a random user name. The confirmation
  window showed `https://webauthn.io` and Confirm saved the passkey; the next window listed it, and
  Confirm signed in ("You're logged in!"). Firefox 160.0: the Firefox package installed as a
  temporary add-on in a new profile, the switch of Settings › Passkeys clicked with the system's
  mouse; Firefox asked for access to all websites, and once granted both content scripts were
  registered. Chromium 153.0.8010.12 (Playwright's build): the test copy granting `<all_urls>`, so
  the switch and its prompt were not checked there ("test copy"). "Use another authenticator" was
  checked in neither: in Firefox it saves a real passkey in the iCloud Keychain.

To check a cell by hand, on a release's package, in each browser:

1. **Install** the package: Firefox, `about:debugging` › This Firefox › Load Temporary Add-on, the
   archive; Chrome, `chrome://extensions` › Developer mode › Load unpacked, the unzipped archive.
2. **Create a vault** in the session host, and two Login items: one for the sign-in page's URL, one
   for its origin only.
3. **Toolbar:** on the sign-in page, open the popup (in Firefox, under the Extensions button); both
   items show under "On this page". **Fill** one: user name and password filled, the popup closed,
   the form not submitted.
4. **Shortcut** (⌘⇧L, Ctrl+Shift+L elsewhere): with one matching item, it fills; with two, the
   popup opens.
5. **Two-step:** on a page with only a focused email field, Fill writes the user name alone.
6. **Version lock:** load a changed build over the installed one; it asks for confirmation before
   any vault.
7. **Passkeys:** turn on Settings › Passkeys and grant the permission. On `https://webauthn.io`,
   register a random user name: the confirmation window shows `https://webauthn.io`, and Confirm
   saves a new Login item holding the passkey. Authenticate with it: the window lists it, and
   Confirm signs in. "Use another authenticator" hands the call to the browser's own prompt.

Record the browser version and the result in the table above.

## Android

The Android app's capabilities (`android.md` §13), on the Samsung A54 (D281). The credential
provider and autofill rows come with their task.

| Capability | Samsung A54 |
| --- | --- |
| Installs, opens on the first screen (§11) | by hand, test build; by hand 1.0.0-rc.3; by hand 1.0.0-rc.4 |
| Installs as a user does: downloaded in Chrome, opened in the file manager, through Play Protect (§10) | by hand 1.0.0-rc.3 (App Scan Recommended, then judged safe); by hand 1.0.0-rc.4 (the same) |
| Create a vault, lock, unlock by password | by hand, test build; by hand 1.0.0-rc.3 |
| Pair with the PWA by QR (camera) and sync both ways | by hand, test build |
| Keystore KEK: setup, unlock, StrongBox or TEE shown (§5) | by hand, test build (TEE) |
| Keystore KEK: a new fingerprint invalidates it, password unlock removes it (§5) | by hand, test build |
| Auto-lock, hidden-app lock, screen off (§4.2) | by hand, test build |
| Hidden-app lock at immediately: a backup saved and an attachment added through the pickers (D294) | by hand, test build |
| FLAG_SECURE: no screenshot, blank in Recents (§3) | by hand, test build |
| Copy a password: hidden in the clipboard preview, cleared after the set time (§6.1) | by hand, test build |
| Save a backup and an attachment; restore the backup (§6.2) | by hand, test build |
| About: version, manifest hash, certificate SHA-256 equal to the release's (§10) | by hand 1.0.0-rc.3; by hand 1.0.0-rc.4 |
| An update installs over the app and keeps the vault (§10) | by hand 1.0.0-rc.3 (same version); by hand 1.0.0-rc.4 (from 1.0.0-rc.3) |
| Passkey create and get on `webauthn.io` in Chrome and Firefox, through the provider window (§7, D301) | by hand, debug build |
| "Use another authenticator" shows the system sheet again; Cancel, before or after the unlock, and Back end the call (§7.1) | by hand, debug build |
| An app `webauthn.io`'s `assetlinks.json` does not bind gets no password and no passkey; the passkey's refusal comes before the unlock (§7.4, D303) | by hand, debug build |
| Autofill: a password filled in Chrome after the unlock and the tap; an unbound app's native fields filled with nothing; BlindVault's own fields offered nothing (§8, D304) | by hand, debug build |

What each source covers, on Android 16 with WebView 158.0.8127.46, the app driven over ADB and read
with `uiautomator`:

- **by hand, test build.** On 2026-11-23, the unsigned APK of `0058141` signed with a throwaway key.
  Pairing with Chrome 158 on macOS 26.6.2 (MacBook Air M1), by QR both ways, the A54's answer read
  within about 11 s; an item made on each side reached the other. The run found D296 (a later
  answer failed), D297, D298 and D299, fixed before the release.
- **by hand 1.0.0-rc.3.** On 2026-11-24, the release's signed APK. About showed the version, the
  hash of the attached `asset-manifest-android.txt` and the pinned certificate. No later release
  existed, so the update was the same APK installed again (`adb install -r`) over an unlocked vault:
  the process ended, and the app reopened locked with its note. An update to a newer version is
  checked at the next release.
- **by hand 1.0.0-rc.3, as a user installs it.** On 2026-11-26, over the release app installed by
  ADB. Chrome warned on the download, as for any APK. The release's
  `blindvault-android-1.0.0-rc.3-unsigned.apk`, opened in the file manager, did not install: Android
  installs no unsigned APK. The signed `blindvault-android-1.0.0-rc.3.apk`, its SHA-256 the release
  body's, showed Play Protect's App Scan Recommended screen, in Portuguese "A verificação do app é
  recomendada" ("Este app ainda não foi analisado pelo Play Protect"); "Verificar app" sent it to
  Google and answered "Este app parece seguro", and the update installed (`installerPackageName` `com.google.android.packageinstaller`). The ADB
  installs before had skipped Play Protect. The release body now names the APK that installs
  (`build.md`).
- **by hand 1.0.0-rc.4.** On 2026-11-26, over the release app 1.0.0-rc.3, as a user installs it.
  Chrome warned on the download of `blindvault-android-1.0.0-rc.4.apk`, its SHA-256 the release
  body's; the file manager asked to update the app; Play Protect showed "A verificação do app é
  recomendada" again, since the APK was new, and after "Verificar app" answered "Este app parece
  seguro", with the credential provider and the autofill service in the APK; the app updated
  (`versionCode` 1000004, `installerPackageName` `com.google.android.packageinstaller`). It opened
  locked on the 1.0.0-rc.3 vault, and About, read over ADB with `uiautomator`, showed 1.0.0-rc.4, the
  hash of the attached `asset-manifest-android.txt` and the pinned certificate.
- **by hand, debug build.** On 2026-11-24, the debug build of the credential provider's change
  (`io.github.allisson.blindvault.debug`), installed beside the release app, with Chrome
  158.0.8127.42. It was turned on as an additional service in Settings › Passwords, passkeys and
  autofill, another manager staying the preferred one, and picked through the sheet's "Save another
  way" and "Use once". Chrome accepted the registration without `clientDataJSON` and the assertion
  signed over its `clientDataHash`; `webauthn.io` registered the passkey and logged in with it. Cancel
  and Back gave the page `NotAllowedError`. The run found the unlock card's Cancel out of sight,
  fixed before the change landed. Firefox 161.0, the same day and build: the same steps registered
  and logged in on `webauthn.io`, and "Use another authenticator" showed the sheet again. Firefox
  hands the same cancellation to the page as `AbortError` ("ceremony was sent an abort signal"), on
  Cancel before the unlock and on Back after it; the page's own 60 s timeout ends the call the same
  way.
- **by hand, debug build (D303).** On 2026-11-24, the debug build of the change serving apps and
  passwords, and a throwaway debug app, `com.example.bvprobe`, built outside the repository and
  uninstalled after, asking Credential Manager for a password and for a passkey of `webauthn.io`. The
  sheet listed BlindVault for each. The password: after the unlock, the window listed the test vault's
  Login of `https://webauthn.io`, and the tap on it said the app is not bound to `webauthn.io`, whose
  `assetlinks.json` does not name it; Cancel gave the app `GetCredentialCancellationException`. The
  passkey: the window said so before asking for the unlock; "Use another authenticator" showed the
  sheet again. Chrome 158.0.8127.42 still logged in on `webauthn.io` with its passkey. The run found
  `provider.xml` declaring passkeys only, so Android never asked BlindVault for a password; fixed
  before the change landed.
- **by hand, debug build (D304).** On 2026-11-24, the debug build of the autofill change, set as the
  autofill service over ADB in place of the user's manager and set back after, with Chrome
  158.0.8127.42 already on "Autofill using another service". On
  `https://the-internet.herokuapp.com/login`, the tap on the user name field showed the BlindVault
  menu; the window unlocked, named the site, listed the test vault's one matching Login, and the tap on
  it filled the user name and the password, which the page's own Login accepted ("You logged into a
  secure area!"); BlindVault submitted nothing. The throwaway `com.example.bvprobe`, given a native
  user name and password field, got the menu; the window searched the Login items, said the app is not
  bound to `webauthn.io`, and Cancel left both fields empty. The local password field of BlindVault's
  main window opened no autofill session. The run found that Android hides the asking package from
  the service, so `getPackageInfo` failed and no dataset was answered: measured with a throwaway build
  that could see the probe, then fixed with `QUERY_ALL_PACKAGES` before the change landed.

To check it, on a release's signed APK, with a PWA on another device:

1. **Install** as a user does, not over ADB, which skips Play Protect: download the signed APK from
   the release in Chrome and open it in the file manager. Record Play Protect's screen. Open: the
   first screen says the app is a separate device of the vault.
2. **Create a vault**, lock, unlock with the password.
3. **Pair** with the PWA: scan its QR code with the camera, confirm the SAS on both, then sync once
   from each side; an item made on each appears on the other.
4. **Keystore KEK:** Settings › set it up; Settings shows StrongBox or the TEE (the A54 has no
   StrongBox, D282). Lock, unlock with the fingerprint. Enroll a new fingerprint in Android's
   settings: the next unlock asks for the password and says the biometrics changed, and Settings
   no longer shows the Keystore KEK.
5. **Locks:** auto-lock at 1 min without touching; hidden-app lock at 1 min with the app in the
   background, and a return before then keeps it unlocked; screen off locks at once.
6. **Pickers** (D294): hidden-app lock at immediately; Settings › export a backup and save it, and
   add an attachment to an item: both finish unlocked. Leaving the app for the home screen still
   locks it.
7. **FLAG_SECURE:** a screenshot is refused; Recents shows a blank card.
8. **Clipboard:** copy a password; Android's preview hides it; after the clear time it is gone.
9. **Files:** download the attachment; lock, erase the vault, and restore the saved backup.
10. **About:** the version, the manifest hash and the certificate SHA-256 equal the release body's
    Android section (D300) and `release-cert.sha256`.
11. **Update:** install the next APK over it, as in step 1: the vault reopens locked, with its
    items.

Record the Android version, the WebView version and the result in the table above.
