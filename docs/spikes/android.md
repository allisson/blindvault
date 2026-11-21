# Spike result — Android WebView (D269, D271, D281)

Status: **done** (D282). Measured on the Samsung A54 only (SM-A546E, Android 16, API 36, Android
System WebView 158.0.8127.46), a limit D281 records, on 2026-11-21.

Setup: the debug APK of `spikes/android/` (`docs/spikes/README.md` §7), package
`io.github.allisson.blindvault.spike`, installed over ADB. A script drove the spike page through
the WebView's DevTools socket (`adb forward`); the fingerprint prompts, the fingerprint enrollment
and the camera were handled by hand. Chrome 158 on the same phone ran the comparison page through
`adb reverse`.

## 1. The `apps/web` build

| Check | WebView | Chrome on the A54 |
| --- | --- | --- |
| First screen | reached ("Prévia", the onboarding start) | — |
| Errors (console, load, HTTP) | none | — |
| Argon2id calibration | 3,063 ms, opslimit 13, 64 MiB | 3,897 ms, opslimit 13, 64 MiB |

- The app's CSP and Trusted Types apply: the shell adds the headers of `_headers` to every
  response.
- Port: once the app is opened, its service worker (`sw.js`, scope `/`) controls the whole
  `https://appassets.androidplatform.net` origin and answers every navigation with the app. The
  spike page could be reached again only after unregistering it.

## 2. Storage

| Check | WebView | Chrome on the A54 |
| --- | --- | --- |
| IndexedDB marker written | yes | yes |
| `navigator.storage.persist()` | false | false |
| Web Locks | acquired | acquired |
| Marker after a force-stop and restart of the app | present | — |
| Marker after `adb install -r` of version 2 over version 1 | present (`versionCode` 1 → 2) | — |

## 3. DataChannel and camera

| Check | Result |
| --- | --- |
| `RTCPeerConnection` DataChannel to Chrome on the Mac, signaled through the shell | `pong:ping` |
| Camera through `onPermissionRequest`, QR read by the app's `zxing-wasm` | read in 757 ms, equal to the Mac's nonce |

## 4. Keystore and BiometricPrompt

An AES-GCM key with `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)` and
`setInvalidatedByBiometricEnrollment(true)`, StrongBox requested first. 32 random bytes wrapped and
unwrapped over the JS bridge.

| Step | Prompt | Result |
| --- | --- | --- |
| create | — | StrongBox unavailable (`StrongBoxUnavailableException`), key in the TEE; `KeyInfo` confirms the authentication settings |
| wrap | fingerprint | done |
| first unwrap | fingerprint | same bytes |
| second unwrap | fingerprint | same bytes |
| unwrap after a force-stop of the app | fingerprint | same bytes |
| unwrap after enrolling a new fingerprint | none | `KeyPermanentlyInvalidatedException` when the cipher is initialized |

- The prompt showed on every use.
- A first attempt after "enrolling" did not count: the device still had 2 enrolled fingerprints.
  It was repeated after a third fingerprint was enrolled, then removed.

## 5. WebAuthn PRF in the WebView

The WebView's WebAuthn support set with `WebSettingsCompat.setWebAuthenticationSupport` before each
attempt; `rpId` `appassets.androidplatform.net`.

| Mode | create | get |
| --- | --- | --- |
| app | `NotAllowedError: WebAuthn is not supported on sites with TLS certificate errors.` | same |
| browser | same | same |
| none | `NotSupportedError: Error connecting to Web Authentication service.` (`PublicKeyCredential` undefined) | same |

WebAuthn does not run on the `WebViewAssetLoader` origin in any mode, so D271's premise holds.

## 6. Clipboard

| Check | Result |
| --- | --- |
| Page `navigator.clipboard.writeText`, then `writeText('')` | works only once the WebView has the focus (a real tap); without it, `NotAllowedError: Document is not focused` |
| Native `ClipboardManager` with `EXTRA_IS_SENSITIVE`: copy, read, `clearPrimaryClip()` | works |

## Cleanup

The APK was uninstalled and the test fingerprint removed.
