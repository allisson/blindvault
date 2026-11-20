# Spikes — protocol

Sections 1 to 5 are the Phase 0 spikes; sections 6 and 7 are the Phase 10 spike (D281).

**Phase 0, ended.** The spike code and its workflow were deleted after the last Phase 0 item (D105); they
remain in the history at commit `3f29c12`. The text below describes the protocol as it was run.

Throwaway measurement pages in `spikes/`, published to `https://allisson.github.io/blindvault/` by
the `Spikes (GitHub Pages)` workflow. They hold no vault data and make no network call apart from
STUN in the pairing spike. Each page ends with a JSON result and a **Copy result** button: paste it
in the conversation, and the result goes to `docs/spikes/<spike>.md` with any `Dn` revision.

The spike origin is a shared `github.io` origin, not the product's dedicated origin (D90). That is
acceptable for throwaway code holding no real data.

Device matrix (overview §18): Windows laptop (Chrome or Edge, Firefox), MacBook Air M1 (Safari,
Chrome, Firefox), Samsung A54 (Chrome), iPhone 14 (Safari).

Local runs: `pnpm --filter @blindvault/spikes dev` serves the pages on the LAN; camera, WebAuthn and
service workers need HTTPS or `localhost`, so phones use the Pages site.

## 1. Signal-less pairing (D4, D136) — `pairing.html`

Already measured locally (desktop engines, `127.0.0.1`, copy/paste, no STUN): every A × B pair of
Chromium, Firefox and WebKit connects, with and without mDNS candidates; payloads of 80–104 bytes,
120–156 base45 characters, QR version 5–7 (error correction M). See `pairing.md`.

| # | Setup | Mode | Measures |
| --- | --- | --- | --- |
| 1 | Mac Safari tab A ↔ Mac Chrome tab B | copy/paste, LAN-only | baseline on real browsers |
| 2 | iPhone (A) ↔ A54 (B), same Wi-Fi | QR both ways, LAN-only, camera not granted before gathering on A | mDNS on same Wi-Fi |
| 3 | same as 2 | "Grant camera before gathering" on both | IP host candidates instead of mDNS |
| 4 | same as 2 | QR, STUN on | srflx candidates, QR size |
| 5 | iPhone on Wi-Fi ↔ A54 on 4G (Wi-Fi off) | QR, STUN on | NAT traversal across networks |
| 6 | 2 and 5 again from the **installed** app on both phones | QR | camera scanning in the installed PWA |
| 7 | Windows Firefox ↔ A54 | copy/paste through any messaging app | cross-engine, copy/paste fallback |

Copy the result from **both** devices after each run, success or failure.

## 2. Argon2id (D9, D126) — `argon2id.html`

On every device of the matrix: button 1, then button 2, copy the result. Then button 3 (1 GiB) on
its own, and copy again; if the tab reloads or crashes, say so. Keep the screen on.

## 3. WebAuthn PRF — `prf.html`

On every device: button 1, then button 2 twice, copy the result. Delete the "BlindVault spike"
passkey afterwards. On the phones, repeat from the installed app.

## 4. Browser storage (D55, D103, D105, D110) — `storage.html`

Devices: MacBook Air M1 (Safari) and Samsung A54 (Chrome, the control). The iPhone run of
2026-10-10 was discarded.

1. **Day 0, Mac and A54:** open the page in a browser tab, press "Write day-0 marker" and "Request
   persistent storage", copy the result. Install the app (macOS Safari: File → Add to Dock; Android
   Chrome: menu → Add to Home screen → Install), open the page there, do the same, copy the result.
   Whether each context sees the other's marker answers D103. "Write day-0 marker" replaces an older
   marker of the same context.
2. **Days 1, 4, 8 and 15:** do not open the site on these two browsers in between (any page of
   `allisson.github.io` counts as a visit). On each day, open the page in each of the four contexts
   and copy the result: a missing marker means the browser deleted the storage.

Gate 0 can close on day 15 at the earliest.

## 5. Service-worker integrity (D63, D142) — `sw.html`

Per browser of the matrix (installed app too on the phones):

1. With the site at `swVersion = N`, open `sw.html` and leave it open.
2. A new deploy with `swVersion = N+1` (`swTakeover = true`) is run from the workflow.
3. Without reloading, press "Check for update" every minute for up to 5 minutes, then copy the
   result. It records whether `updatefound` fired and when, whether the new worker's install ran
   while the page was open, and whether `controllerchange` shows a takeover.
4. Optionally repeat with `swTakeover = false` to see when the new worker activates on its own.

## 6. Phase 10 spike — extension (D272, D281) — `spikes/extension/`

Not run yet. An unpacked MV3 extension built on the Mac with
`pnpm --filter @blindvault/spikes build:extension`, into `spikes/extension/dist/chrome` and
`spikes/extension/dist/firefox`. It holds no vault data. The root of each is the `apps/web` build,
unmodified except that `_headers` is left out: it is a Cloudflare file, and Chrome refuses a file
whose name starts with `_` in an extension. The spike pages are under `spike/`. The extension page
`spike/spike.html` (also linked from the popup) ends with a JSON result and a **Copy result**
button, as in Phase 0; so does the local relying-party page. Results go to
`docs/spikes/extension.md`. Nothing is published: Windows gets `spikes/extension/dist` by a USB
drive or a shared folder.

Load `dist/chrome` in developer mode on Chrome (`chrome://extensions` → Load unpacked), and
`dist/firefox/manifest.json` as a temporary add-on on Firefox (`about:debugging` → Load Temporary
Add-on); on Firefox, check in `about:addons` that the add-on may run on `localhost` and
`webauthn.io`. The local relying party (measure 3) runs with `node rp/serve.mjs` from either dist
folder, Node and no dependency, at `http://localhost:5310/` with its iframe on port 5311. Every
interception opens a confirm window: **Use spike passkey**, **Another authenticator** or
**Cancel**. Devices: MacBook Air M1 and the Windows laptop, Chrome and Firefox on each.

| # | Measure | Pass |
| --- | --- | --- |
| 1 | Session host: on Chrome the offscreen document, on Firefox whether `chrome.offscreen` exists, then the MV3 event page, then an extension tab as fallback. Unlock a throwaway key, close the popup, leave the machine untouched, read the result after 60 minutes. Record also a sleeping machine and a minimized browser. | The key is still held at 60 minutes, with the extension's service worker stopped |
| 2 | The `apps/web` build, unmodified, in an extension tab and in the offscreen document: libsodium init, Argon2id time with the real parameters, `indexedDB.databases()`, and every error (service worker, frame check, `github.io` warning) | libsodium loads under the MV3 CSP with `'wasm-unsafe-eval'`; the errors are listed as ports |
| 3 | Interception on the local relying-party page (`localhost`, a cross-origin iframe on a second port): override before the page's code, origin and frame from `MessageSender` in the top frame and the iframe, a forged page message, "another authenticator" | The override runs first, the origin is never taken from the page, the forged message is ignored, the hand-back reaches the browser's own prompt |
| 4 | A throwaway in-memory ES256 credential registered and used on `webauthn.io`; record `instanceof PublicKeyCredential`, `getClientExtensionResults()` and `toJSON()` on the returned object | `webauthn.io` registers and signs in, on both browsers |
| 5 | WebAuthn PRF from an extension tab or popup: create with `prf.enabled`, two `get`s, a browser restart, a third `get`; record the `rpId` used | The same PRF output all three times; a failure means password-only unlock in the extension |
| 6 | In the session host: an `RTCPeerConnection` DataChannel to an extension tab, IndexedDB, `navigator.storage.persist()`, Web Locks, data surviving a reload of the extension as an update; in the popup or side panel, copying to the clipboard and clearing it | Recorded per browser; a failure reopens the matching part of D267 |

Delete the `webauthn.io` credentials and the PRF credential afterwards.

## 7. Phase 10 spike — Android (D272, D281) — `spikes/android/`

Not run yet. A debug APK, under a package other than the release's (D274), built on the Mac with
the Gradle wrapper and installed on the Samsung A54 with `adb install`. A hand-written Kotlin
WebView serves the unmodified `apps/web` build through `WebViewAssetLoader` at
`https://appassets.androidplatform.net`. The A54 is the only Android device, a limit
`docs/spikes/android.md` records. The page ends with a JSON result and a **Copy result** button;
results go to `docs/spikes/android.md`.

| # | Measure | Pass |
| --- | --- | --- |
| 1 | The build in the WebView: libsodium, Argon2id time against the same build in Chrome on the A54, every error | The app reaches its first screen; the errors are listed as ports |
| 2 | IndexedDB, `navigator.storage.persist()` and Web Locks; a marker written, then the app restarted, then the APK updated with `adb install -r` | The marker survives both |
| 3 | An `RTCPeerConnection` DataChannel to the Mac, and the camera reading a QR code (`onPermissionRequest`) | Both work |
| 4 | A Keystore key (StrongBox where present) requiring a BiometricPrompt on every use: wrap and unwrap 32 bytes over the JS bridge; then enroll a new fingerprint and try again | Each use asks for the biometric; after the new enrollment the key is invalidated |
| 5 | One WebAuthn PRF create and `get` in the WebView | Recorded: a working PRF reopens D271 |
| 6 | Copying to the clipboard and clearing it | Recorded |

Uninstall the APK and remove the test fingerprint afterwards.
